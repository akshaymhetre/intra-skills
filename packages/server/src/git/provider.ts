// The contract between the registry and a git host. sync.ts and the proposal flow only ever talk
// to a GitProvider; github.ts, bitbucket.ts and (in tests) fake.ts implement it.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { GitCredentialInput, GitProviderId, SourceCheck } from "@intra-skills/shared";
import { HttpError } from "../http.js";

/** What a provider client needs to reach one repository. The credential is already decrypted. */
export interface ProviderSource {
  id: string;
  provider: GitProviderId;
  /** owner/name (GitHub) or workspace/repo-slug (Bitbucket Cloud). */
  repo: string;
  baseBranch: string;
  /** GitHub Enterprise Server API base, e.g. https://ghe.acme.internal/api/v3; null = public host. */
  apiUrl: string | null;
  credential: GitCredentialInput;
}

export type ProviderFactory = (source: ProviderSource) => GitProvider;

/** A regular file in the repository. `path` is relative to the repository root. */
export interface RepoFile {
  path: string;
  /** 0o644 or 0o755. */
  mode: number;
}

export interface WriteFile {
  /** Relative to the repository root. */
  path: string;
  mode: number;
  content: Buffer;
}

export interface WriteBranchInput {
  branch: string;
  /** Commit the new commit builds on. */
  parent: string;
  files: WriteFile[];
  /** Repository-root paths to delete; each must exist at `parent`. */
  deletions: string[];
  message: string;
  /** Move an existing branch to the new commit even when it is not a fast-forward. */
  force: boolean;
}

export type PullRequestState = "open" | "merged" | "closed";

export interface PullRequestInfo {
  number: number;
  url: string;
  state: PullRequestState;
  title: string;
  body: string;
  /** Username of the author on the host, or null when the host does not say. */
  author: string | null;
  headBranch: string;
  baseBranch: string;
  /** The commit the merge put on the base branch; null until merged (or when the host omits it). */
  mergeCommit: string | null;
  /** Distinct reviewers whose latest review state is an approval, as host usernames. */
  approvals: string[];
}

export interface CommitPullRequest {
  number: number;
  merged: boolean;
  baseBranch: string;
}

export interface GitProvider {
  readonly id: GitProviderId;
  /** Head commit of a branch, or null when the branch does not exist. */
  headCommit(branch: string): Promise<string | null>;
  /**
   * Every regular file under `dir` at `commit`, recursively (Bitbucket stops at `maxDepth`
   * directory levels). Missing directory = []. Symlinks and submodules are left out.
   */
  listFiles(commit: string, dir: string, maxDepth?: number): Promise<RepoFile[]>;
  readFile(commit: string, path: string): Promise<Buffer>;
  /** Commit files and deletions on top of `parent` and point `branch` at it. Returns the new commit. */
  writeBranch(input: WriteBranchInput): Promise<string>;
  openPullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo>;
  updatePullRequest(number: number, input: { title: string; body: string }): Promise<void>;
  getPullRequest(number: number): Promise<PullRequestInfo>;
  /** Pull requests that contain or introduced `commit`. */
  pullRequestsForCommit(commit: string, baseBranch: string): Promise<CommitPullRequest[]>;
  /** The newest commit on `branch` that changed anything under `path`, or null. */
  lastCommitForPath(branch: string, path: string): Promise<string | null>;
  /** The username the registry acts as on the host, or null when the host cannot say. */
  whoAmI(): Promise<string | null>;
  /** Read-only checks for POST /sources/:id/test. Never writes to the host. */
  checkAccess(): Promise<SourceCheck[]>;
  verifyWebhook(headers: Headers, rawBody: string, secret: string): boolean;
  folderUrl(branch: string, path: string): string;
  commitUrl(sha: string): string;
  /** Host and path used in GitInfo.repo, e.g. github.com/acme/skills. */
  readonly repoLabel: string;
}

// ---------- web URLs (no credential needed) ----------

/** Browser base for a GitHub API base: api.github.com -> github.com; GHES strips /api/v3. */
export function githubWebBase(apiUrl: string | null): string {
  if (!apiUrl) return "https://github.com";
  return apiUrl.replace(/\/+$/, "").replace(/\/api\/v3$/, "");
}

export function encodePath(p: string): string {
  return p
    .split("/")
    .filter((s) => s !== "")
    .map(encodeURIComponent)
    .join("/");
}

export function webUrls(provider: GitProviderId, repo: string, apiUrl: string | null) {
  if (provider === "github") {
    const base = `${githubWebBase(apiUrl)}/${repo}`;
    return {
      repoLabel: `${new URL(githubWebBase(apiUrl)).host}/${repo}`,
      folder: (branch: string, path: string) => `${base}/tree/${encodePath(branch)}/${encodePath(path)}`,
      commit: (sha: string) => `${base}/commit/${sha}`,
    };
  }
  const base = `https://bitbucket.org/${repo}`;
  return {
    repoLabel: `bitbucket.org/${repo}`,
    folder: (branch: string, path: string) => `${base}/src/${encodeURIComponent(branch)}/${encodePath(path)}`,
    commit: (sha: string) => `${base}/commits/${sha}`,
  };
}

// ---------- webhook signatures ----------

/** Header carrying `sha256=<hex HMAC of the raw body>`: GitHub X-Hub-Signature-256, Bitbucket Cloud X-Hub-Signature. */
export const SIGNATURE_HEADER: Record<GitProviderId, string> = {
  github: "x-hub-signature-256",
  "bitbucket-cloud": "x-hub-signature",
};

export function verifySignature(provider: GitProviderId, headers: Headers, rawBody: string, secret: string): boolean {
  if (!secret) return false;
  const given = headers.get(SIGNATURE_HEADER[provider]) ?? "";
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- HTTP ----------

export const HOST_TIMEOUT_MS = 20_000;

export interface HostResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  json<T = any>(): T;
}

/**
 * One request to a git host. Non-2xx (except the statuses in `allow`) becomes
 * HttpError("upstream") naming the host and status; credentials never appear in the message.
 */
export async function hostRequest(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string | Buffer; allow?: number[] },
): Promise<HostResponse> {
  const host = new URL(url).host;
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers: init.headers,
      body: init.body as BodyInit | undefined,
      signal: AbortSignal.timeout(HOST_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (e) {
    const why = (e as Error).name === "TimeoutError" ? `no answer within ${HOST_TIMEOUT_MS / 1000}s` : (e as Error).message;
    throw new HttpError("upstream", `${host} could not be reached: ${why}`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  const out: HostResponse = {
    status: res.status,
    headers: res.headers,
    body,
    json: () => JSON.parse(body.toString("utf8") || "null"),
  };
  if ((res.status >= 200 && res.status < 300) || init.allow?.includes(res.status)) return out;
  throw new HttpError("upstream", `${host} answered ${res.status} for ${init.method ?? "GET"} ${new URL(url).pathname}${hostMessage(body)}`);
}

function hostMessage(body: Buffer): string {
  try {
    const j = JSON.parse(body.toString("utf8")) as { message?: unknown; error?: { message?: unknown } };
    const m = typeof j?.message === "string" ? j.message : typeof j?.error?.message === "string" ? j.error.message : "";
    return m ? `: ${m.slice(0, 300)}` : "";
  } catch {
    return "";
  }
}
