// Bitbucket Cloud through the REST API 2.0.
// Docs read for every call below: the OpenAPI document that backs the reference,
//   https://developer.atlassian.com/cloud/bitbucket/swagger.v3.json, and the pages built from it:
//   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-refs/        GET/DELETE /refs/branches/{name} (target.hash)
//   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-source/      GET /src/{commit}/{path} (raw file, or paginated listing
//        with max_depth, attributes "executable"/"link"/"subrepository"); POST /src multipart: file fields named by path,
//        `message`, `branch`, `parents`, `files` (a path with no matching file field is deleted)
//   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/ POST/GET/PUT /pullrequests[/{id}] (state OPEN|MERGED|
//        DECLINED|SUPERSEDED, author, merge_commit.hash, participants[].approved, summary.raw, links.html.href),
//        GET /commit/{commit}/pullrequests (needs the "Pull Request Commit Links" indexing: 202 while indexing, 404 when not indexed)
//   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commits/     GET /commits/{revision}?path=
//   https://developer.atlassian.com/cloud/bitbucket/rest/api-group-users/       GET /user, GET /user/workspaces/{w}/permissions/repositories
//   https://developer.atlassian.com/cloud/bitbucket/rest/intro/                 auth (access tokens = Bearer; API tokens = Basic with the
//        Atlassian email; access tokens cannot query permissions), pagination (`next` links)
//   https://support.atlassian.com/bitbucket-cloud/docs/manage-webhooks/         X-Hub-Signature: sha256=<hex HMAC of the raw body>
import { randomBytes } from "node:crypto";
import type { SourceCheck } from "@intra-skills/shared";
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
import { skipped } from "./github.js";

const API = "https://api.bitbucket.org/2.0";

interface SrcEntry {
  type: "commit_file" | "commit_directory";
  path: string;
  attributes?: string[];
}

interface BbAccount {
  nickname?: string;
  username?: string;
  display_name?: string;
}

/** The account name a git identity is matched against: nickname (username is no longer returned). */
export function bitbucketLogin(a: BbAccount | null | undefined): string | null {
  return a?.nickname ?? a?.username ?? null;
}

export class BitbucketProvider implements GitProvider {
  readonly id = "bitbucket-cloud" as const;
  readonly repoLabel: string;
  private readonly urls: ReturnType<typeof webUrls>;

  constructor(private readonly src: ProviderSource) {
    this.urls = webUrls("bitbucket-cloud", src.repo, null);
    this.repoLabel = this.urls.repoLabel;
  }

  private get repoPath(): string {
    const [ws, slug] = this.src.repo.split("/");
    return `/repositories/${encodeURIComponent(ws!)}/${encodeURIComponent(slug!)}`;
  }

  private authHeader(): string {
    const c = this.src.credential;
    if (c.kind === "token") return `Bearer ${c.token}`;
    if (c.kind === "basic") return `Basic ${Buffer.from(`${c.username}:${c.password}`, "utf8").toString("base64")}`;
    throw new HttpError("invalid", "Bitbucket Cloud sources take an access token or a username and API token");
  }

  private async call(
    method: string,
    path: string,
    o: { json?: unknown; body?: Buffer; contentType?: string; allow?: number[] } = {},
  ): Promise<HostResponse> {
    const headers: Record<string, string> = { Accept: "application/json", Authorization: this.authHeader() };
    let body: string | Buffer | undefined;
    if (o.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(o.json);
    } else if (o.body) {
      headers["Content-Type"] = o.contentType!;
      body = o.body;
    }
    const url = path.startsWith("http") ? path : `${API}${path}`;
    if (!url.startsWith(`${API}/`)) throw new HttpError("upstream", "Bitbucket returned a pagination link to another host");
    return hostRequest(url, { method, headers, body, allow: o.allow });
  }

  /** Follow `next` links (never constructed by hand, as the docs ask). */
  private async paged<T>(path: string, maxPages = 50, allow?: number[]): Promise<{ values: T[]; status: number }> {
    const values: T[] = [];
    let next: string | undefined = path;
    let status = 200;
    for (let i = 0; next && i < maxPages; i++) {
      const res = await this.call("GET", next, { allow });
      status = res.status;
      if (res.status !== 200) break;
      const j = res.json<{ values: T[]; next?: string }>();
      values.push(...(j.values ?? []));
      next = j.next;
    }
    return { values, status };
  }

  async headCommit(branch: string): Promise<string | null> {
    const res = await this.call("GET", `${this.repoPath}/refs/branches/${encodeURIComponent(branch)}`, { allow: [404] });
    if (res.status === 404) return null;
    return res.json<{ target: { hash: string } }>().target.hash;
  }

  async listFiles(commit: string, dir: string, maxDepth = 10): Promise<RepoFile[]> {
    const q = new URLSearchParams({ max_depth: String(maxDepth), pagelen: "100" });
    const { values, status } = await this.paged<SrcEntry>(`${this.repoPath}/src/${commit}/${encodePath(dir)}/?${q}`, 50, [404]);
    if (status === 404) return [];
    return values
      .filter((v) => v.type === "commit_file" && !v.attributes?.includes("link") && !v.attributes?.includes("subrepository"))
      .map((v) => ({ path: v.path, mode: v.attributes?.includes("executable") ? 0o755 : 0o644 }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(commit: string, path: string): Promise<Buffer> {
    return (await this.call("GET", `${this.repoPath}/src/${commit}/${encodePath(path)}`)).body;
  }

  async writeBranch(input: WriteBranchInput): Promise<string> {
    const exists = (await this.headCommit(input.branch)) !== null;
    // POST /src on an existing branch asserts parents == branch tip, so a forced rewrite deletes the branch first.
    if (exists && input.force)
      await this.call("DELETE", `${this.repoPath}/refs/branches/${encodeURIComponent(input.branch)}`);
    const { body, contentType } = srcMultipart(input);
    await this.call("POST", `${this.repoPath}/src`, { body, contentType });
    // The 201 has no documented body, so read the new tip back.
    const head = await this.headCommit(input.branch);
    if (!head) throw new HttpError("upstream", `api.bitbucket.org did not create branch ${input.branch}`);
    return head;
  }

  private toInfo(p: any): PullRequestInfo {
    const state: PullRequestInfo["state"] = p.state === "MERGED" ? "merged" : p.state === "OPEN" ? "open" : "closed";
    const approvals = ((p.participants ?? []) as { user?: BbAccount; approved?: boolean }[])
      .filter((x) => x.approved === true)
      .map((x) => bitbucketLogin(x.user))
      .filter((x): x is string => x !== null);
    return {
      number: p.id,
      url: p.links?.html?.href ?? `https://bitbucket.org/${this.src.repo}/pull-requests/${p.id}`,
      state,
      title: p.title ?? "",
      body: p.summary?.raw ?? p.description ?? "",
      author: bitbucketLogin(p.author),
      headBranch: p.source?.branch?.name ?? "",
      baseBranch: p.destination?.branch?.name ?? "",
      mergeCommit: state === "merged" ? (p.merge_commit?.hash ?? null) : null,
      approvals: [...new Set(approvals)],
    };
  }

  async openPullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo> {
    const res = await this.call("POST", `${this.repoPath}/pullrequests`, {
      json: {
        title: input.title,
        description: input.body,
        source: { branch: { name: input.branch } },
        destination: { branch: { name: input.base } },
        close_source_branch: true,
      },
    });
    return this.toInfo(res.json());
  }

  async updatePullRequest(number: number, input: { title: string; body: string }): Promise<void> {
    await this.call("PUT", `${this.repoPath}/pullrequests/${number}`, { json: { title: input.title, description: input.body } });
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    return this.toInfo((await this.call("GET", `${this.repoPath}/pullrequests/${number}`)).json());
  }

  async pullRequestsForCommit(commit: string, baseBranch: string): Promise<CommitPullRequest[]> {
    const { values, status } = await this.paged<any>(`${this.repoPath}/commit/${commit}/pullrequests?pagelen=50`, 4, [202, 404]);
    if (status === 200)
      return values.map((p) => ({ number: p.id, merged: p.state === "MERGED", baseBranch: p.destination?.branch?.name ?? "" }));
    // 202 = still indexing, 404 = the commit links are not indexed for this repo. Fall back to the
    // recently merged pull requests into the base branch whose merge commit is this commit.
    const q = new URLSearchParams({
      state: "MERGED",
      q: `destination.branch.name="${baseBranch.replace(/"/g, "")}"`,
      sort: "-updated_on",
      pagelen: "50",
    });
    const merged = await this.paged<any>(`${this.repoPath}/pullrequests?${q}`, 4);
    return merged.values
      .filter((p) => typeof p.merge_commit?.hash === "string" && hashMatches(p.merge_commit.hash, commit))
      .map((p) => ({ number: p.id, merged: true, baseBranch }));
  }

  async lastCommitForPath(branch: string, path: string): Promise<string | null> {
    const q = new URLSearchParams({ path, pagelen: "1" });
    const res = await this.call("GET", `${this.repoPath}/commits/${encodeURIComponent(branch)}?${q}`);
    return res.json<{ values: { hash: string }[] }>().values[0]?.hash ?? null;
  }

  async whoAmI(): Promise<string | null> {
    // Repository and workspace access tokens act as their own bot user; whether GET /user answers
    // for them is not documented, so a refusal means "unknown", not an error.
    const res = await this.call("GET", "/user", { allow: [401, 403, 404] });
    return res.status === 200 ? bitbucketLogin(res.json<BbAccount>()) : null;
  }

  async checkAccess(): Promise<SourceCheck[]> {
    const checks: SourceCheck[] = [];
    const c = this.src.credential;
    let repoRes: HostResponse;
    try {
      // For access tokens the repository read IS the credential check (they are bound to it).
      const who = c.kind === "basic" ? await this.whoAmI() : null;
      if (c.kind === "basic" && who === null) throw new HttpError("upstream", "api.bitbucket.org refused the username and API token");
      repoRes = await this.call("GET", this.repoPath, { allow: [401, 403, 404] });
      if (repoRes.status === 401) throw new HttpError("upstream", "api.bitbucket.org refused the credential (401)");
      checks.push({ name: "credential", ok: true, message: `accepted${who ? ` as ${who}` : ""}` });
    } catch (e) {
      checks.push({ name: "credential", ok: false, message: (e as Error).message });
      return [...checks, ...skipped(["repo", "branch", "write"])];
    }
    if (repoRes.status !== 200) {
      checks.push({ name: "repo", ok: false, message: `api.bitbucket.org answered ${repoRes.status} for ${this.src.repo}` });
      return [...checks, ...skipped(["branch", "write"])];
    }
    checks.push({ name: "repo", ok: true, message: `${this.src.repo} is readable` });
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
    if (c.kind === "basic") {
      try {
        const [ws] = this.src.repo.split("/");
        const q = new URLSearchParams({ q: `repository.full_name="${this.src.repo}"` });
        const r = await this.call("GET", `/user/workspaces/${encodeURIComponent(ws!)}/permissions/repositories?${q}`);
        const perm = r.json<{ values: { permission: string }[] }>().values[0]?.permission ?? "none";
        const ok = perm === "write" || perm === "admin";
        checks.push({
          name: "write",
          ok,
          message: ok ? `the account has ${perm} access` : `the account has ${perm} access; it needs write to push branches`,
        });
      } catch (e) {
        checks.push({ name: "write", ok: false, message: (e as Error).message });
      }
    } else {
      // Access tokens cannot query permissions (documented). Read granted scopes from the response
      // header when the host sends one; otherwise say plainly that it was not verified.
      const scopes = repoRes.headers.get("x-oauth-scopes");
      if (scopes) {
        const set = new Set(scopes.split(/[,\s]+/).filter(Boolean));
        const ok = (set.has("repository:write") || set.has("repository:admin")) && (set.has("pullrequest:write") || set.has("pullrequest"));
        checks.push({
          name: "write",
          ok,
          message: ok ? "the token can push branches and open pull requests" : `the token has scopes ${scopes}; it needs repository:write and pullrequest:write`,
        });
      } else
        checks.push({
          name: "write",
          ok: true,
          message: "not verifiable for an access token: make sure it has the repository:write and pullrequest:write scopes",
        });
    }
    return checks;
  }

  verifyWebhook(headers: Headers, rawBody: string, secret: string): boolean {
    return verifySignature("bitbucket-cloud", headers, rawBody, secret);
  }

  folderUrl(branch: string, path: string): string {
    return this.urls.folder(branch, path);
  }

  commitUrl(sha: string): string {
    return this.urls.commit(sha);
  }
}

/** Bitbucket may report abbreviated hashes (pattern [0-9a-f]{7,}). */
function hashMatches(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

function quote(s: string): string {
  return s.replace(/["\r\n\\]/g, "_");
}

/**
 * multipart/form-data for POST /src. File fields are named by their absolute repo path (a leading
 * slash keeps a file called "message" from clashing with the metadata field); executables carry
 * x-attributes as in the documented example. Deletions are `files` fields with no matching file.
 */
export function srcMultipart(input: WriteBranchInput, boundary = `intra-${randomBytes(12).toString("hex")}`): {
  body: Buffer;
  contentType: string;
} {
  const parts: Buffer[] = [];
  const field = (name: string, value: string) =>
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${quote(name)}"\r\n\r\n${value}\r\n`, "utf8"));
  field("message", input.message);
  field("branch", input.branch);
  field("parents", input.parent);
  for (const p of input.deletions) field("files", p);
  for (const f of input.files) {
    const base = f.path.slice(f.path.lastIndexOf("/") + 1);
    const attrs = f.mode & 0o111 ? '; x-attributes:"executable"' : "";
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="/${quote(f.path)}"; filename="${quote(base)}"${attrs}\r\nContent-Type: application/octet-stream\r\n\r\n`,
        "utf8",
      ),
      f.content,
      Buffer.from("\r\n", "utf8"),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
