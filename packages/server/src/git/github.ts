// GitHub (github.com and GitHub Enterprise Server via apiUrl) through the REST API.
// Docs read for every call below (raw markdown via docs.github.com/api/article/body?pathname=...):
//   https://docs.github.com/en/rest/git/refs        GET /git/ref/heads/{b}, POST /git/refs, PATCH /git/refs/heads/{b} (force)
//   https://docs.github.com/en/rest/git/commits     GET + POST /git/commits (tree, parents)
//   https://docs.github.com/en/rest/git/trees       GET /git/trees/{sha}[?recursive=1] (truncated), POST with base_tree, sha:null deletes
//   https://docs.github.com/en/rest/git/blobs       POST /git/blobs {content, encoding:"base64"}, GET (content base64)
//   https://docs.github.com/en/rest/pulls/pulls     POST/GET/PATCH /pulls; state, merged, merged_at, merge_commit_sha, user.login
//   https://docs.github.com/en/rest/pulls/reviews   GET /pulls/{n}/reviews (chronological, per_page max 100)
//   https://docs.github.com/en/rest/commits/commits GET /commits?sha=&path=&per_page=, GET /commits/{sha}/pulls
//   https://docs.github.com/en/rest/branches/branches GET /branches/{branch}
//   https://docs.github.com/en/rest/repos/repos     GET /repos/{o}/{r} -> permissions.push
//   https://docs.github.com/en/rest/users/users     GET /user
//   https://docs.github.com/en/rest/apps/apps       GET /app (slug), POST /app/installations/{id}/access_tokens (token, expires_at, permissions)
//   https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
//   https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries  X-Hub-Signature-256
//   https://docs.github.com/en/rest/about-the-rest-api/api-versions  (2022-11-28: supported to 2028 and on older GHES)
//   https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api  Link rel="next"
import { createSign } from "node:crypto";
import type { GitCredentialInput, SourceCheck } from "@intra-skills/shared";
import { HttpError } from "../http.js";
import {
  type CommitPullRequest,
  type GitProvider,
  type HostResponse,
  type ProviderSource,
  type PullRequestInfo,
  type RepoFile,
  type WriteBranchInput,
  encodePath,
  hostRequest,
  verifySignature,
  webUrls,
} from "./provider.js";

const API_VERSION = "2022-11-28";

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString("base64url");
}

/** RS256 JWT for a GitHub App: iat 60 s in the past (clock drift), exp under the 10 minute cap. */
export function appJwt(appId: string, privateKeyPem: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: appId }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(privateKeyPem))}`;
}

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

type AppCred = Extract<GitCredentialInput, { kind: "github-app" }>;

export class GitHubProvider implements GitProvider {
  readonly id = "github" as const;
  readonly repoLabel: string;
  private readonly api: string;
  private readonly urls: ReturnType<typeof webUrls>;
  private installation: { token: string; expiresAt: number; permissions: Record<string, string> } | null = null;
  /** commit + "\n" + dir -> files with blob shas; commits are immutable, so this never goes stale. */
  private readonly treeCache = new Map<string, Map<string, { mode: number; sha: string }>>();

  constructor(private readonly src: ProviderSource) {
    this.api = (src.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.urls = webUrls("github", src.repo, src.apiUrl);
    this.repoLabel = this.urls.repoLabel;
  }

  private get repoPath(): string {
    const [owner, name] = this.src.repo.split("/");
    return `/repos/${encodeURIComponent(owner!)}/${encodeURIComponent(name!)}`;
  }

  private async authHeader(): Promise<string> {
    const c = this.src.credential;
    if (c.kind === "token") return `Bearer ${c.token}`;
    if (c.kind === "github-app") return `Bearer ${await this.installationToken(c)}`;
    throw new HttpError("invalid", "GitHub sources take a token or a GitHub App credential");
  }

  /** Installation tokens live one hour; reuse one until five minutes before it expires. */
  private async installationToken(c: AppCred): Promise<string> {
    if (this.installation && this.installation.expiresAt - Date.now() > 5 * 60_000) return this.installation.token;
    const res = await hostRequest(`${this.api}/app/installations/${encodeURIComponent(c.installationId)}/access_tokens`, {
      method: "POST",
      headers: this.baseHeaders(`Bearer ${appJwt(c.appId, c.privateKey)}`),
    });
    const j = res.json<{ token: string; expires_at: string; permissions?: Record<string, string> }>();
    this.installation = { token: j.token, expiresAt: Date.parse(j.expires_at), permissions: j.permissions ?? {} };
    return j.token;
  }

  private baseHeaders(auth: string): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "intra-skills",
      Authorization: auth,
    };
  }

  private async call(method: string, path: string, body?: unknown, allow?: number[]): Promise<HostResponse> {
    const headers = this.baseHeaders(await this.authHeader());
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const url = path.startsWith("http") ? path : `${this.api}${path}`;
    return hostRequest(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), allow });
  }

  /** Follow Link rel="next" until done (capped so a runaway listing cannot loop forever). */
  private async paged<T>(path: string, maxPages = 20): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = path;
    for (let i = 0; next && i < maxPages; i++) {
      const res = await this.call("GET", next);
      out.push(...res.json<T[]>());
      const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
      next = m ? m[1]! : null;
    }
    return out;
  }

  async headCommit(branch: string): Promise<string | null> {
    const res = await this.call("GET", `${this.repoPath}/git/ref/heads/${encodePath(branch)}`, undefined, [404]);
    if (res.status === 404) return null;
    return res.json<{ object: { sha: string } }>().object.sha;
  }

  private async commitTree(commit: string): Promise<string> {
    const res = await this.call("GET", `${this.repoPath}/git/commits/${commit}`);
    return res.json<{ tree: { sha: string } }>().tree.sha;
  }

  /** Regular files under dir at commit, keyed by repo-root path. */
  private async tree(commit: string, dir: string): Promise<Map<string, { mode: number; sha: string }>> {
    const key = `${commit}\n${dir}`;
    const hit = this.treeCache.get(key);
    if (hit) return hit;
    let sha = await this.commitTree(commit);
    // Walk down to dir one level at a time, so a large monorepo never needs one recursive listing of everything.
    for (const seg of dir.split("/").filter(Boolean)) {
      const res = await this.call("GET", `${this.repoPath}/git/trees/${sha}`);
      const entry = res.json<{ tree: TreeEntry[] }>().tree.find((e) => e.path === seg && e.type === "tree");
      if (!entry) {
        const empty = new Map<string, { mode: number; sha: string }>();
        this.treeCache.set(key, empty);
        return empty;
      }
      sha = entry.sha;
    }
    const res = await this.call("GET", `${this.repoPath}/git/trees/${sha}?recursive=1`);
    const j = res.json<{ tree: TreeEntry[]; truncated: boolean }>();
    if (j.truncated) throw new HttpError("upstream", `${new URL(this.api).host} truncated the file listing of ${dir || "/"}`);
    const prefix = dir ? `${dir.replace(/\/+$/, "")}/` : "";
    const out = new Map<string, { mode: number; sha: string }>();
    for (const e of j.tree) {
      // 100644 file, 100755 executable; 120000 symlink and 160000 submodule are not bundle files.
      if (e.type !== "blob" || (e.mode !== "100644" && e.mode !== "100755")) continue;
      out.set(prefix + e.path, { mode: e.mode === "100755" ? 0o755 : 0o644, sha: e.sha });
    }
    this.treeCache.set(key, out);
    return out;
  }

  async listFiles(commit: string, dir: string): Promise<RepoFile[]> {
    const t = await this.tree(commit, dir);
    return [...t.entries()].map(([path, f]) => ({ path, mode: f.mode })).sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(commit: string, path: string): Promise<Buffer> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    let entry: { sha: string } | undefined;
    for (const [key, t] of this.treeCache) if (key.startsWith(`${commit}\n`) && t.has(path)) entry = t.get(path);
    entry ??= (await this.tree(commit, dir)).get(path);
    if (!entry) throw new HttpError("upstream", `${path} does not exist at ${commit.slice(0, 12)}`);
    const res = await this.call("GET", `${this.repoPath}/git/blobs/${entry.sha}`);
    const j = res.json<{ content: string; encoding: string }>();
    return Buffer.from(j.content.replace(/\s+/g, ""), "base64");
  }

  async writeBranch(input: WriteBranchInput): Promise<string> {
    const baseTree = await this.commitTree(input.parent);
    const tree: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    for (const f of input.files) {
      const blob = await this.call("POST", `${this.repoPath}/git/blobs`, {
        content: f.content.toString("base64"),
        encoding: "base64",
      });
      tree.push({ path: f.path, mode: f.mode & 0o111 ? "100755" : "100644", type: "blob", sha: blob.json<{ sha: string }>().sha });
    }
    for (const path of input.deletions) tree.push({ path, mode: "100644", type: "blob", sha: null });
    const newTree = await this.call("POST", `${this.repoPath}/git/trees`, { base_tree: baseTree, tree });
    const commit = await this.call("POST", `${this.repoPath}/git/commits`, {
      message: input.message,
      tree: newTree.json<{ sha: string }>().sha,
      parents: [input.parent],
    });
    const sha = commit.json<{ sha: string }>().sha;
    if ((await this.headCommit(input.branch)) === null)
      await this.call("POST", `${this.repoPath}/git/refs`, { ref: `refs/heads/${input.branch}`, sha });
    else await this.call("PATCH", `${this.repoPath}/git/refs/heads/${encodePath(input.branch)}`, { sha, force: input.force });
    return sha;
  }

  private toInfo(p: any, approvals: string[]): PullRequestInfo {
    const merged = p.merged === true || (typeof p.merged_at === "string" && p.merged_at !== "");
    return {
      number: p.number,
      url: p.html_url,
      state: merged ? "merged" : p.state === "closed" ? "closed" : "open",
      title: p.title ?? "",
      body: p.body ?? "",
      author: p.user?.login ?? null,
      headBranch: p.head?.ref ?? "",
      baseBranch: p.base?.ref ?? "",
      mergeCommit: merged ? (p.merge_commit_sha ?? null) : null,
      approvals,
    };
  }

  async openPullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo> {
    const res = await this.call("POST", `${this.repoPath}/pulls`, {
      title: input.title,
      head: input.branch,
      base: input.base,
      body: input.body,
    });
    return this.toInfo(res.json(), []);
  }

  async updatePullRequest(number: number, input: { title: string; body: string }): Promise<void> {
    await this.call("PATCH", `${this.repoPath}/pulls/${number}`, { title: input.title, body: input.body });
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    const p = (await this.call("GET", `${this.repoPath}/pulls/${number}`)).json();
    const reviews = await this.paged<{ user: { login: string } | null; state: string }>(
      `${this.repoPath}/pulls/${number}/reviews?per_page=100`,
    );
    return this.toInfo(p, latestApprovals(reviews));
  }

  async pullRequestsForCommit(commit: string): Promise<CommitPullRequest[]> {
    const list = await this.paged<{ number: number; merged_at: string | null; base?: { ref: string } }>(
      `${this.repoPath}/commits/${commit}/pulls?per_page=100`,
      3,
    );
    return list.map((p) => ({ number: p.number, merged: p.merged_at !== null && p.merged_at !== undefined, baseBranch: p.base?.ref ?? "" }));
  }

  async lastCommitForPath(branch: string, path: string): Promise<string | null> {
    const q = new URLSearchParams({ sha: branch, path, per_page: "1" });
    const list = (await this.call("GET", `${this.repoPath}/commits?${q}`)).json<{ sha: string }[]>();
    return list[0]?.sha ?? null;
  }

  async whoAmI(): Promise<string | null> {
    const c = this.src.credential;
    if (c.kind === "github-app") {
      // An installation token cannot read GET /user; the App's own JWT reads its slug. GitHub shows
      // the App's actions as "<slug>[bot]".
      const res = await hostRequest(`${this.api}/app`, { headers: this.baseHeaders(`Bearer ${appJwt(c.appId, c.privateKey)}`) });
      const slug = res.json<{ slug?: string }>().slug;
      return slug ? `${slug}[bot]` : null;
    }
    return (await this.call("GET", "/user")).json<{ login: string }>().login;
  }

  async checkAccess(): Promise<SourceCheck[]> {
    const checks: SourceCheck[] = [];
    const c = this.src.credential;
    let identity: string | null;
    try {
      identity = await this.whoAmI();
      if (c.kind === "github-app") await this.authHeader();
      checks.push({ name: "credential", ok: true, message: `accepted${identity ? ` as ${identity}` : ""}` });
    } catch (e) {
      checks.push({ name: "credential", ok: false, message: (e as Error).message });
      return [...checks, ...skipped(["repo", "branch", "write"])];
    }
    let repo: { permissions?: { push?: boolean } };
    try {
      repo = (await this.call("GET", this.repoPath)).json();
      checks.push({ name: "repo", ok: true, message: `${this.src.repo} is readable` });
    } catch (e) {
      checks.push({ name: "repo", ok: false, message: (e as Error).message });
      return [...checks, ...skipped(["branch", "write"])];
    }
    try {
      const head = await this.headCommit(this.src.baseBranch);
      checks.push(
        head
          ? { name: "branch", ok: true, message: `${this.src.baseBranch} is at ${head.slice(0, 12)}` }
          : { name: "branch", ok: false, message: `branch ${this.src.baseBranch} does not exist` },
      );
    } catch (e) {
      checks.push({ name: "branch", ok: false, message: (e as Error).message });
    }
    if (c.kind === "github-app") {
      const perms = this.installation?.permissions ?? {};
      const ok = perms.contents === "write" && perms.pull_requests === "write";
      checks.push({
        name: "write",
        ok,
        message: ok
          ? "the App can push branches and open pull requests"
          : `the App needs Contents and Pull requests write permission (has contents: ${perms.contents ?? "none"}, pull requests: ${perms.pull_requests ?? "none"})`,
      });
    } else {
      const ok = repo.permissions?.push === true;
      checks.push({
        name: "write",
        ok,
        message: ok
          ? "the token can push branches and open pull requests"
          : "the token has no push access to this repository",
      });
    }
    return checks;
  }

  verifyWebhook(headers: Headers, rawBody: string, secret: string): boolean {
    return verifySignature("github", headers, rawBody, secret);
  }

  folderUrl(branch: string, path: string): string {
    return this.urls.folder(branch, path);
  }

  commitUrl(sha: string): string {
    return this.urls.commit(sha);
  }
}

/**
 * Reviewers whose latest decisive review is APPROVED. A COMMENTED (or PENDING) review after an
 * approval does not withdraw it on GitHub, so only APPROVED, CHANGES_REQUESTED and DISMISSED count.
 */
export function latestApprovals(reviews: { user: { login: string } | null; state: string }[]): string[] {
  const latest = new Map<string, string>();
  for (const r of reviews) {
    if (!r.user?.login) continue;
    if (r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED" && r.state !== "DISMISSED") continue;
    latest.set(r.user.login.toLowerCase(), r.state === "APPROVED" ? r.user.login : "");
  }
  return [...latest.values()].filter((v) => v !== "");
}

export function skipped(names: string[]): SourceCheck[] {
  return names.map((name) => ({ name, ok: false, message: "skipped: an earlier check failed" }));
}
