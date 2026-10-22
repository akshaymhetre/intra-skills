// In-memory git host for tests: branches, commits, pull requests and reviews. TEST ONLY: nothing in
// the API can select it; a test passes `host.factory` as AppOptions.providerFactory.
import type { GitProviderId, SourceCheck } from "@intra-skills/shared";
import { HttpError } from "../http.js";
import {
  type CommitPullRequest,
  type GitProvider,
  type ProviderFactory,
  type ProviderSource,
  type PullRequestInfo,
  type RepoFile,
  type WriteBranchInput,
  verifySignature,
  webUrls,
} from "./provider.js";

interface FakeFile {
  mode: number;
  content: Buffer;
}

interface FakeCommit {
  sha: string;
  parents: string[];
  files: Map<string, FakeFile>;
  message: string;
}

export interface FakePr {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  author: string;
  state: "open" | "merged" | "closed";
  mergeCommit: string | null;
  /** Commits on the head branch since it forked from base. */
  commits: string[];
  /** Chronological review log. */
  reviews: { user: string; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" }[];
}

export class FakeGitHost {
  readonly commits = new Map<string, FakeCommit>();
  readonly branches = new Map<string, string>();
  /** Where each branch forked from (its parent at creation), for merges. */
  readonly forkPoints = new Map<string, string>();
  readonly prs = new Map<number, FakePr>();
  /** Every write the registry made: "writeBranch <branch>", "openPullRequest <branch>", ... */
  readonly writes: string[] = [];
  private seq = 0;
  /** The account the registry's credential acts as. */
  login: string;
  /** Make checkAccess report no write access. */
  readOnly = false;

  constructor(o: { login?: string; baseBranch?: string } = {}) {
    this.login = o.login ?? "intra-bot";
    const root = this.newCommit([], new Map([["README.md", { mode: 0o644, content: Buffer.from("# skills\n") }]]), "init");
    this.branches.set(o.baseBranch ?? "main", root);
  }

  private newCommit(parents: string[], files: Map<string, FakeFile>, message: string): string {
    const sha = (++this.seq).toString(16).padStart(40, "0");
    this.commits.set(sha, { sha, parents, files, message });
    return sha;
  }

  head(branch: string): string {
    const h = this.branches.get(branch);
    if (!h) throw new Error(`fake: no branch ${branch}`);
    return h;
  }

  filesAt(ref: string): Map<string, FakeFile> {
    const c = this.commits.get(this.branches.get(ref) ?? ref);
    if (!c) throw new Error(`fake: no commit ${ref}`);
    return c.files;
  }

  /** Text of a file on a branch, or null. */
  text(branch: string, path: string): string | null {
    return this.filesAt(branch).get(path)?.content.toString("utf8") ?? null;
  }

  /** Push a commit straight to a branch (creating it from `from` when missing), as a person would. */
  push(branch: string, files: Record<string, string | Buffer>, deletions: string[] = [], from = "main"): string {
    const parent = this.branches.get(branch) ?? this.head(from);
    if (!this.branches.has(branch)) this.forkPoints.set(branch, parent);
    const next = new Map(this.commits.get(parent)!.files);
    for (const [p, c] of Object.entries(files)) next.set(p, { mode: 0o644, content: Buffer.from(c) });
    for (const p of deletions) next.delete(p);
    const sha = this.newCommit([parent], next, `push to ${branch}`);
    this.branches.set(branch, sha);
    for (const pr of this.prs.values()) if (pr.state === "open" && pr.head === branch) pr.commits.push(sha);
    return sha;
  }

  /** A pull request opened by a person on the host (not through the registry). */
  openPr(o: { head: string; base?: string; author: string; title?: string; body?: string }): number {
    const n = this.prs.size + 1;
    const fork = this.forkPoints.get(o.head);
    this.prs.set(n, {
      number: n,
      title: o.title ?? o.head,
      body: o.body ?? "",
      head: o.head,
      base: o.base ?? "main",
      author: o.author,
      state: "open",
      mergeCommit: null,
      commits: this.branchCommits(o.head, fork),
      reviews: [],
    });
    return n;
  }

  private branchCommits(branch: string, stop: string | undefined): string[] {
    const out: string[] = [];
    let cur: string | undefined = this.branches.get(branch);
    while (cur && cur !== stop) {
      out.unshift(cur);
      cur = this.commits.get(cur)?.parents[0];
      if (out.length > 1000) break;
    }
    return out;
  }

  approve(n: number, user: string): void {
    this.pr(n).reviews.push({ user, state: "APPROVED" });
  }

  requestChanges(n: number, user: string): void {
    this.pr(n).reviews.push({ user, state: "CHANGES_REQUESTED" });
  }

  comment(n: number, user: string): void {
    this.pr(n).reviews.push({ user, state: "COMMENTED" });
  }

  /** Merge commit on base: base head plus the head branch's changes since it forked. */
  merge(n: number): string {
    const pr = this.pr(n);
    if (pr.state !== "open") throw new Error(`fake: PR ${n} is ${pr.state}`);
    const fork = this.forkPoints.get(pr.head);
    const before = fork ? this.commits.get(fork)!.files : new Map<string, FakeFile>();
    const after = this.filesAt(pr.head);
    const next = new Map(this.filesAt(pr.base));
    for (const [p, f] of after) {
      const b = before.get(p);
      if (!b || !b.content.equals(f.content) || b.mode !== f.mode) next.set(p, f);
    }
    for (const p of before.keys()) if (!after.has(p)) next.delete(p);
    const sha = this.newCommit([this.head(pr.base), this.head(pr.head)], next, `Merge pull request #${n}`);
    this.branches.set(pr.base, sha);
    pr.state = "merged";
    pr.mergeCommit = sha;
    return sha;
  }

  close(n: number): void {
    this.pr(n).state = "closed";
  }

  pr(n: number): FakePr {
    const p = this.prs.get(n);
    if (!p) throw new Error(`fake: no PR ${n}`);
    return p;
  }

  /** PR opened on a branch, newest first. */
  prForBranch(branch: string): FakePr | undefined {
    return [...this.prs.values()].reverse().find((p) => p.head === branch);
  }

  readonly factory: ProviderFactory = (src) => new FakeProvider(this, src);

  // ---------- operations the provider calls ----------

  writeBranch(input: WriteBranchInput): string {
    const exists = this.branches.has(input.branch);
    if (exists && !input.force && this.branches.get(input.branch) !== input.parent)
      throw new HttpError("upstream", "fake: branch moved (not a fast-forward)");
    const base = this.commits.get(input.parent);
    if (!base) throw new HttpError("upstream", "fake: unknown parent");
    const next = new Map(base.files);
    for (const p of input.deletions) {
      if (!next.has(p)) throw new HttpError("upstream", `fake: cannot delete missing ${p}`);
      next.delete(p);
    }
    for (const f of input.files) next.set(f.path, { mode: f.mode, content: f.content });
    const sha = this.newCommit([input.parent], next, input.message);
    if (!exists || input.force) this.forkPoints.set(input.branch, input.parent);
    this.branches.set(input.branch, sha);
    for (const pr of this.prs.values()) if (pr.state === "open" && pr.head === input.branch) pr.commits.push(sha);
    this.writes.push(`writeBranch ${input.branch}`);
    return sha;
  }

  lastCommitForPath(branch: string, path: string): string | null {
    const prefix = path.replace(/\/+$/, "") + "/";
    const slice = (files: Map<string, FakeFile>) =>
      JSON.stringify(
        [...files]
          .filter(([p]) => p.startsWith(prefix) || p === path)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([p, f]) => [p, f.mode, f.content.toString("base64")]),
      );
    let cur: string | undefined = this.branches.get(branch);
    while (cur) {
      const c = this.commits.get(cur)!;
      const parent = c.parents[0] ? this.commits.get(c.parents[0])!.files : new Map<string, FakeFile>();
      if (slice(c.files) !== slice(parent)) return cur;
      cur = c.parents[0];
    }
    return null;
  }

  /**
   * When false, commit-to-pull-request lookups answer nothing, the way GitHub's index does for a
   * second or so after a merge (seen live on 2026-10-16).
   */
  commitIndexReady = true;

  pullRequestsForCommit(commit: string): CommitPullRequest[] {
    if (!this.commitIndexReady) return [];
    return [...this.prs.values()]
      .filter((p) => p.mergeCommit === commit || p.commits.includes(commit))
      .map((p) => ({ number: p.number, merged: p.state === "merged", baseBranch: p.base }));
  }

  info(n: number, src: ProviderSource): PullRequestInfo {
    const p = this.pr(n);
    const latest = new Map<string, string>();
    for (const r of p.reviews) if (r.state !== "COMMENTED") latest.set(r.user, r.state);
    return {
      number: p.number,
      url:
        src.provider === "github"
          ? `https://github.com/${src.repo}/pull/${p.number}`
          : `https://bitbucket.org/${src.repo}/pull-requests/${p.number}`,
      state: p.state,
      title: p.title,
      body: p.body,
      author: p.author,
      headBranch: p.head,
      baseBranch: p.base,
      mergeCommit: p.mergeCommit,
      approvals: [...latest].filter(([, s]) => s === "APPROVED").map(([u]) => u),
    };
  }
}

class FakeProvider implements GitProvider {
  readonly id: GitProviderId;
  readonly repoLabel: string;
  private readonly urls: ReturnType<typeof webUrls>;

  constructor(
    private readonly host: FakeGitHost,
    private readonly src: ProviderSource,
  ) {
    this.id = src.provider;
    this.urls = webUrls(src.provider, src.repo, src.apiUrl);
    this.repoLabel = this.urls.repoLabel;
  }

  async headCommit(branch: string): Promise<string | null> {
    return this.host.branches.get(branch) ?? null;
  }

  async listFiles(commit: string, dir: string): Promise<RepoFile[]> {
    const prefix = dir ? dir.replace(/\/+$/, "") + "/" : "";
    return [...this.host.filesAt(commit)]
      .filter(([p]) => p.startsWith(prefix))
      .map(([path, f]) => ({ path, mode: f.mode }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async readFile(commit: string, path: string): Promise<Buffer> {
    const f = this.host.filesAt(commit).get(path);
    if (!f) throw new HttpError("upstream", `fake: no ${path}`);
    return f.content;
  }

  async writeBranch(input: WriteBranchInput): Promise<string> {
    return this.host.writeBranch(input);
  }

  async openPullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo> {
    const n = this.host.openPr({ head: input.branch, base: input.base, author: this.host.login, title: input.title, body: input.body });
    this.host.writes.push(`openPullRequest ${input.branch}`);
    return this.host.info(n, this.src);
  }

  async updatePullRequest(number: number, input: { title: string; body: string }): Promise<void> {
    const p = this.host.pr(number);
    p.title = input.title;
    p.body = input.body;
    this.host.writes.push(`updatePullRequest ${number}`);
  }

  async getPullRequest(number: number): Promise<PullRequestInfo> {
    return this.host.info(number, this.src);
  }

  async pullRequestsForCommit(commit: string): Promise<CommitPullRequest[]> {
    return this.host.pullRequestsForCommit(commit);
  }

  async lastCommitForPath(branch: string, path: string): Promise<string | null> {
    return this.host.lastCommitForPath(branch, path);
  }

  async whoAmI(): Promise<string | null> {
    return this.host.login;
  }

  async checkAccess(): Promise<SourceCheck[]> {
    const branch = this.host.branches.has(this.src.baseBranch);
    return [
      { name: "credential", ok: true, message: `accepted as ${this.host.login}` },
      { name: "repo", ok: true, message: `${this.src.repo} is readable` },
      { name: "branch", ok: branch, message: branch ? "exists" : `branch ${this.src.baseBranch} does not exist` },
      { name: "write", ok: !this.host.readOnly, message: this.host.readOnly ? "no push access" : "can push" },
    ];
  }

  verifyWebhook(headers: Headers, rawBody: string, secret: string): boolean {
    return verifySignature(this.src.provider, headers, rawBody, secret);
  }

  folderUrl(branch: string, path: string): string {
    return this.urls.folder(branch, path);
  }

  commitUrl(sha: string): string {
    return this.urls.commit(sha);
  }
}
