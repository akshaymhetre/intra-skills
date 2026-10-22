// GitHub and Bitbucket Cloud clients against a stubbed fetch: the exact requests sent, built from
// the documented shapes (see the doc URLs at the top of github.ts and bitbucket.ts).
import { createVerify, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubProvider, latestApprovals } from "./git/github.js";
import { BitbucketProvider, srcMultipart } from "./git/bitbucket.js";
import { verifySignature, type ProviderSource } from "./git/provider.js";
import { discoverFolders } from "./git/discover.js";
import { decryptSecret, encryptSecret } from "./git/crypto.js";
import { randomBytes } from "node:crypto";

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | Buffer | undefined;
}

type Route = (c: Call) => { status?: number; json?: unknown; body?: string; headers?: Record<string, string> } | undefined;

let calls: Call[];
let routes: Route[];

beforeEach(() => {
  calls = [];
  routes = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const c: Call = { method: init.method ?? "GET", url, headers, body: init.body as string | Buffer | undefined };
    calls.push(c);
    for (const r of routes) {
      const out = r(c);
      if (out)
        return new Response(out.status === 204 ? null : out.json !== undefined ? JSON.stringify(out.json) : (out.body ?? ""), {
          status: out.status ?? 200,
          headers: { "content-type": "application/json", ...(out.headers ?? {}) },
        });
    }
    return new Response(JSON.stringify({ message: `no stub for ${c.method} ${url}` }), { status: 599 });
  });
});
afterEach(() => vi.unstubAllGlobals());

const on = (method: string, url: string, res: ReturnType<Route>) =>
  routes.push((c) => (c.method === method && c.url === url ? res : undefined));
const json = (c: Call) => JSON.parse(String(c.body));

const GH: ProviderSource = {
  id: "src_x",
  provider: "github",
  repo: "acme/skills",
  baseBranch: "main",
  apiUrl: null,
  credential: { kind: "token", token: "ghp_test" },
};
const API = "https://api.github.com/repos/acme/skills";

describe("GitHub", () => {
  it("writes a branch with one added and one deleted file via the git data API", async () => {
    const gh = new GitHubProvider(GH);
    on("GET", `${API}/git/commits/p0`, { json: { tree: { sha: "t0" } } });
    on("POST", `${API}/git/blobs`, { status: 201, json: { sha: "b1" } });
    on("POST", `${API}/git/trees`, { status: 201, json: { sha: "t1" } });
    on("POST", `${API}/git/commits`, { status: 201, json: { sha: "c1" } });
    on("GET", `${API}/git/ref/heads/intra/x-1.0.0`, { status: 404, json: { message: "Not Found" } });
    on("POST", `${API}/git/refs`, { status: 201, json: { ref: "refs/heads/intra/x-1.0.0", object: { sha: "c1" } } });
    const sha = await gh.writeBranch({
      branch: "intra/x-1.0.0",
      parent: "p0",
      files: [{ path: "skills/x/SKILL.md", mode: 0o644, content: Buffer.from("hello") }],
      deletions: ["skills/x/old.txt"],
      message: "x 1.0.0",
      force: true,
    });
    expect(sha).toBe("c1");
    expect(calls.map((c) => `${c.method} ${c.url.replace(API, "")}`)).toEqual([
      "GET /git/commits/p0",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "GET /git/ref/heads/intra/x-1.0.0",
      "POST /git/refs",
    ]);
    for (const c of calls) {
      expect(c.headers.authorization).toBe("Bearer ghp_test");
      expect(c.headers.accept).toBe("application/vnd.github+json");
      expect(c.headers["x-github-api-version"]).toBe("2022-11-28");
    }
    expect(json(calls[1]!)).toEqual({ content: Buffer.from("hello").toString("base64"), encoding: "base64" });
    expect(json(calls[2]!)).toEqual({
      base_tree: "t0",
      tree: [
        { path: "skills/x/SKILL.md", mode: "100644", type: "blob", sha: "b1" },
        { path: "skills/x/old.txt", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(json(calls[3]!)).toEqual({ message: "x 1.0.0", tree: "t1", parents: ["p0"] });
    expect(json(calls[5]!)).toEqual({ ref: "refs/heads/intra/x-1.0.0", sha: "c1" });

    // Second push to an existing branch moves the ref with PATCH.
    calls.length = 0;
    routes.splice(4, 1, (c) => (c.method === "GET" && c.url === `${API}/git/ref/heads/intra/x-1.0.0` ? { json: { object: { sha: "c1" } } } : undefined));
    on("PATCH", `${API}/git/refs/heads/intra/x-1.0.0`, { json: { object: { sha: "c1" } } });
    await gh.writeBranch({ branch: "intra/x-1.0.0", parent: "p0", files: [], deletions: [], message: "m", force: false });
    expect(calls.at(-1)!.method).toBe("PATCH");
    expect(json(calls.at(-1)!)).toEqual({ sha: "c1", force: false });
  });

  it("opens a pull request and reduces reviews to latest approvals", async () => {
    const gh = new GitHubProvider(GH);
    on("POST", `${API}/pulls`, {
      status: 201,
      json: { number: 7, html_url: "https://github.com/acme/skills/pull/7", state: "open", merged: false, merged_at: null, title: "t", body: "b", user: { login: "intra-bot" }, head: { ref: "intra/x-1.0.0" }, base: { ref: "main" } },
    });
    const pr = await gh.openPullRequest({ branch: "intra/x-1.0.0", base: "main", title: "t", body: "b" });
    expect(json(calls[0]!)).toEqual({ title: "t", head: "intra/x-1.0.0", base: "main", body: "b" });
    expect(pr).toMatchObject({ number: 7, state: "open", author: "intra-bot", url: "https://github.com/acme/skills/pull/7" });

    on("GET", `${API}/pulls/7`, {
      json: { number: 7, html_url: "u", state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: "m1", user: { login: "intra-bot" }, head: { ref: "h" }, base: { ref: "main" } },
    });
    on("GET", `${API}/pulls/7/reviews?per_page=100`, {
      json: [
        { user: { login: "bob" }, state: "APPROVED" },
        { user: { login: "carol" }, state: "APPROVED" },
        { user: { login: "carol" }, state: "CHANGES_REQUESTED" },
        { user: { login: "dave" }, state: "CHANGES_REQUESTED" },
        { user: { login: "dave" }, state: "APPROVED" },
        { user: { login: "dave" }, state: "COMMENTED" },
        { user: null, state: "APPROVED" },
      ],
    });
    const got = await gh.getPullRequest(7);
    expect(got).toMatchObject({ state: "merged", mergeCommit: "m1", approvals: ["bob", "dave"] });
  });

  it("follows Link rel=next for reviews", async () => {
    const gh = new GitHubProvider(GH);
    on("GET", `${API}/pulls/1`, { json: { number: 1, state: "open", merged: false, user: { login: "a" } } });
    on("GET", `${API}/pulls/1/reviews?per_page=100`, {
      json: [{ user: { login: "bob" }, state: "APPROVED" }],
      headers: { link: `<${API}/pulls/1/reviews?per_page=100&page=2>; rel="next"` },
    });
    on("GET", `${API}/pulls/1/reviews?per_page=100&page=2`, { json: [{ user: { login: "bob" }, state: "DISMISSED" }] });
    expect((await gh.getPullRequest(1)).approvals).toEqual([]);
  });

  it("authenticates as a GitHub App installation with an RS256 JWT and caches the token", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const gh = new GitHubProvider({ ...GH, apiUrl: "https://ghe.acme.test/api/v3", credential: { kind: "github-app", appId: "123", installationId: "42", privateKey: pem } });
    const base = "https://ghe.acme.test/api/v3";
    on("POST", `${base}/app/installations/42/access_tokens`, {
      status: 201,
      json: { token: "ghs_inst", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: { contents: "write", pull_requests: "write" } },
    });
    on("GET", `${base}/repos/acme/skills/git/ref/heads/main`, { json: { object: { sha: "h1" } } });
    expect(await gh.headCommit("main")).toBe("h1");
    expect(await gh.headCommit("main")).toBe("h1");
    expect(calls.filter((c) => c.url.endsWith("/access_tokens"))).toHaveLength(1);
    const jwt = calls[0]!.headers.authorization!.replace("Bearer ", "");
    const [hd, pl, sig] = jwt.split(".");
    expect(JSON.parse(Buffer.from(hd!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(pl!, "base64url").toString());
    expect(claims.iss).toBe("123");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    const v = createVerify("RSA-SHA256");
    v.update(`${hd}.${pl}`);
    expect(v.verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
    expect(calls[1]!.headers.authorization).toBe("Bearer ghs_inst");
  });

  it("surfaces host errors as upstream errors naming host and status, without the token", async () => {
    const gh = new GitHubProvider(GH);
    on("GET", `${API}/git/ref/heads/main`, { status: 401, json: { message: "Bad credentials" } });
    const err = await gh.headCommit("main").catch((e) => e);
    expect(err.code).toBe("upstream");
    expect(err.message).toContain("api.github.com answered 401");
    expect(err.message).toContain("Bad credentials");
    expect(err.message).not.toContain("ghp_test");
  });

  it("verifies X-Hub-Signature-256 with the documented test vector", () => {
    const headers = new Headers({
      "X-Hub-Signature-256": "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    });
    expect(verifySignature("github", headers, "Hello, World!", "It's a Secret to Everybody")).toBe(true);
    expect(verifySignature("github", headers, "Hello, World?", "It's a Secret to Everybody")).toBe(false);
    expect(verifySignature("github", headers, "Hello, World!", "")).toBe(false);
  });

  it("keeps only decisive reviews when reducing approvals", () => {
    expect(latestApprovals([{ user: { login: "A" }, state: "APPROVED" }, { user: { login: "a" }, state: "COMMENTED" }])).toEqual(["A"]);
  });
});

const BB: ProviderSource = {
  id: "src_y",
  provider: "bitbucket-cloud",
  repo: "acme/skills",
  baseBranch: "main",
  apiUrl: null,
  credential: { kind: "basic", username: "ops@acme.test", password: "api-token" },
};
const BBAPI = "https://api.bitbucket.org/2.0/repositories/acme/skills";

function parseMultipart(body: Buffer, boundary: string): { name: string; filename: string | null; disposition: string; value: Buffer }[] {
  const text = body.toString("latin1");
  return text
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head, ...rest] = part.replace(/^\r\n/, "").split("\r\n\r\n");
      const disposition = head!.split("\r\n").find((l) => l.startsWith("Content-Disposition"))!;
      const value = Buffer.from(rest.join("\r\n\r\n").replace(/\r\n$/, ""), "latin1");
      return {
        name: /name="([^"]*)"/.exec(disposition)![1]!,
        filename: /filename="([^"]*)"/.exec(disposition)?.[1] ?? null,
        disposition,
        value,
      };
    });
}

describe("Bitbucket Cloud", () => {
  it("writes a branch with one added and one deleted file via POST /src multipart", async () => {
    const bb = new BitbucketProvider(BB);
    let created = false;
    routes.push((c) =>
      c.method === "GET" && c.url === `${BBAPI}/refs/branches/intra%2Fx-1.0.0`
        ? created
          ? { json: { name: "intra/x-1.0.0", target: { hash: "c1" } } }
          : { status: 404, json: { type: "error", error: { message: "not found" } } }
        : undefined,
    );
    routes.push((c) => (c.method === "POST" && c.url === `${BBAPI}/src` ? ((created = true), { status: 201, body: "" }) : undefined));
    const sha = await bb.writeBranch({
      branch: "intra/x-1.0.0",
      parent: "p0",
      files: [
        { path: "skills/x/SKILL.md", mode: 0o644, content: Buffer.from("hello") },
        { path: "skills/x/run.sh", mode: 0o755, content: Buffer.from("#!/bin/sh\n") },
      ],
      deletions: ["skills/x/old.txt"],
      message: "x 1.0.0",
      force: false,
    });
    expect(sha).toBe("c1");
    expect(calls.map((c) => `${c.method} ${c.url.replace(BBAPI, "")}`)).toEqual([
      "GET /refs/branches/intra%2Fx-1.0.0",
      "POST /src",
      "GET /refs/branches/intra%2Fx-1.0.0",
    ]);
    const post = calls[1]!;
    expect(post.headers.authorization).toBe(`Basic ${Buffer.from("ops@acme.test:api-token").toString("base64")}`);
    const boundary = /boundary=(.+)$/.exec(post.headers["content-type"]!)![1]!;
    expect(post.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const parts = parseMultipart(post.body as Buffer, boundary);
    expect(parts.map((p) => [p.name, p.filename, p.value.toString()])).toEqual([
      ["message", null, "x 1.0.0"],
      ["branch", null, "intra/x-1.0.0"],
      ["parents", null, "p0"],
      ["files", null, "skills/x/old.txt"],
      ["/skills/x/SKILL.md", "SKILL.md", "hello"],
      ["/skills/x/run.sh", "run.sh", "#!/bin/sh\n"],
    ]);
    expect(parts[5]!.disposition).toContain('x-attributes:"executable"');
    expect(parts[4]!.disposition).not.toContain("x-attributes");
  });

  it("deletes the branch first when a forced rewrite targets an existing branch", async () => {
    const bb = new BitbucketProvider({ ...BB, credential: { kind: "token", token: "bb-access" } });
    on("GET", `${BBAPI}/refs/branches/b`, { json: { target: { hash: "old" } } });
    on("DELETE", `${BBAPI}/refs/branches/b`, { status: 204, body: "" });
    on("POST", `${BBAPI}/src`, { status: 201, body: "" });
    await bb.writeBranch({ branch: "b", parent: "p0", files: [], deletions: [], message: "m", force: true });
    expect(calls.map((c) => c.method)).toEqual(["GET", "DELETE", "POST", "GET"]);
    expect(calls[0]!.headers.authorization).toBe("Bearer bb-access");
  });

  it("opens a pull request and reads approvals from participants", async () => {
    const bb = new BitbucketProvider(BB);
    on("POST", `${BBAPI}/pullrequests`, {
      status: 201,
      json: { id: 3, title: "t", state: "OPEN", author: { nickname: "intra-bot" }, source: { branch: { name: "intra/x-1.0.0" } }, destination: { branch: { name: "main" } }, links: { html: { href: "https://bitbucket.org/acme/skills/pull-requests/3" } }, participants: [] },
    });
    const pr = await bb.openPullRequest({ branch: "intra/x-1.0.0", base: "main", title: "t", body: "b" });
    expect(json(calls[0]!)).toEqual({
      title: "t",
      description: "b",
      source: { branch: { name: "intra/x-1.0.0" } },
      destination: { branch: { name: "main" } },
      close_source_branch: true,
    });
    expect(pr).toMatchObject({ number: 3, state: "open", author: "intra-bot", url: "https://bitbucket.org/acme/skills/pull-requests/3" });

    on("GET", `${BBAPI}/pullrequests/3`, {
      json: {
        id: 3,
        state: "MERGED",
        merge_commit: { hash: "abc1234def" },
        author: { nickname: "intra-bot" },
        summary: { raw: "body <!-- intra-skills:proposal=prp_1 -->" },
        participants: [
          { user: { nickname: "bob" }, role: "REVIEWER", approved: true, state: "approved" },
          { user: { nickname: "carol" }, role: "REVIEWER", approved: false, state: "changes_requested" },
          { user: { nickname: "dave" }, role: "PARTICIPANT", approved: true, state: "approved" },
        ],
      },
    });
    const got = await bb.getPullRequest(3);
    expect(got).toMatchObject({ state: "merged", mergeCommit: "abc1234def", approvals: ["bob", "dave"], body: "body <!-- intra-skills:proposal=prp_1 -->" });
  });

  it("falls back to merged pull requests when commit links are not indexed", async () => {
    const bb = new BitbucketProvider(BB);
    on("GET", `${BBAPI}/commit/abc1234def0/pullrequests?pagelen=50`, { status: 404, json: { error: { message: "not indexed" } } });
    routes.push((c) =>
      c.url.startsWith(`${BBAPI}/pullrequests?`)
        ? { json: { values: [{ id: 9, state: "MERGED", merge_commit: { hash: "abc1234def0" } }, { id: 8, merge_commit: { hash: "fff" } }] } }
        : undefined,
    );
    expect(await bb.pullRequestsForCommit("abc1234def0", "main")).toEqual([{ number: 9, merged: true, baseBranch: "main" }]);
    const q = new URL(calls[1]!.url).searchParams;
    expect(q.get("state")).toBe("MERGED");
    expect(q.get("q")).toBe('destination.branch.name="main"');
  });

  it("lists files with max_depth and follows next links", async () => {
    const bb = new BitbucketProvider(BB);
    on("GET", `${BBAPI}/src/c1/skills/?max_depth=4&pagelen=100`, {
      json: {
        values: [
          { type: "commit_directory", path: "skills/a" },
          { type: "commit_file", path: "skills/a/SKILL.md", attributes: [] },
        ],
        next: `${BBAPI}/src/c1/skills/?max_depth=4&pagelen=100&page=2`,
      },
    });
    on("GET", `${BBAPI}/src/c1/skills/?max_depth=4&pagelen=100&page=2`, {
      json: { values: [{ type: "commit_file", path: "skills/a/run.sh", attributes: ["executable"] }, { type: "commit_file", path: "skills/a/l", attributes: ["link"] }] },
    });
    expect(await bb.listFiles("c1", "skills", 4)).toEqual([
      { path: "skills/a/run.sh", mode: 0o755 },
      { path: "skills/a/SKILL.md", mode: 0o644 },
    ]);
  });

  it("verifies X-Hub-Signature with the documented test vector", () => {
    const headers = new Headers({ "X-Hub-Signature": "sha256=a4771c39fbe90f317c7824e83ddef3caae9cb3d976c214ace1f2937e133263c9" });
    expect(verifySignature("bitbucket-cloud", headers, "Hello World!", "It's a Secret to Everybody")).toBe(true);
    expect(verifySignature("github", headers, "Hello World!", "It's a Secret to Everybody")).toBe(false);
  });

  it("builds a parseable multipart body for a file named like a metadata field", () => {
    const { body, contentType } = srcMultipart(
      { branch: "b", parent: "p", files: [{ path: "message", mode: 0o644, content: Buffer.from("x") }], deletions: [], message: "m", force: false },
      "BOUND",
    );
    expect(contentType).toBe("multipart/form-data; boundary=BOUND");
    expect(parseMultipart(body, "BOUND").map((p) => p.name)).toEqual(["message", "branch", "parents", "/message"]);
  });
});

describe("package folders", () => {
  const f = (path: string) => ({ path, mode: 0o644 });
  const roots = { root: "skills", plugins_root: "plugins", rules_root: "rules" };

  it("finds SKILL.md 1-3 levels under root, not nested inside another skill", () => {
    expect(
      discoverFolders(
        [f("skills/a/SKILL.md"), f("skills/a/sub/SKILL.md"), f("skills/g/b/SKILL.md"), f("skills/1/2/3/4/SKILL.md"), f("other/c/SKILL.md"), f("skills/SKILL.md")],
        "skills",
        "skill",
        roots,
      ),
    ).toEqual({ folders: ["skills/a", "skills/g/b"], skipped: [] });
  });

  it("finds plugins exactly one level under pluginsRoot and rules up to three under rulesRoot", () => {
    const p = discoverFolders(
      [f("plugins/p/.claude-plugin/plugin.json"), f("plugins/p/skills/s/SKILL.md"), f("plugins/a/b/.claude-plugin/plugin.json")],
      "plugins",
      "plugin",
      roots,
    );
    expect(p).toEqual({ folders: ["plugins/p"], skipped: [] });
    const r = discoverFolders([f("rules/r/RULE.md"), f("rules/x/y/z/RULE.md"), f("rules/w/SKILL.md")], "rules", "rule", roots);
    expect(r.folders).toEqual(["rules/r", "rules/x/y/z"]);
    expect(r.skipped.map((s) => s.path)).toEqual(["rules/w"]);
  });
});

describe("credential encryption", () => {
  const key = randomBytes(32);

  it("round-trips and binds the context", () => {
    const enc = encryptSecret(key, "ghp_secret", "credential:src_a");
    expect(enc).not.toContain("ghp_secret");
    expect(Buffer.from(enc, "base64").length).toBe(12 + 16 + "ghp_secret".length);
    expect(decryptSecret(key, enc, "credential:src_a")).toBe("ghp_secret");
    expect(encryptSecret(key, "ghp_secret", "credential:src_a")).not.toBe(enc); // random IV
    expect(() => decryptSecret(key, enc, "credential:src_b")).toThrow();
    expect(() => decryptSecret(randomBytes(32), enc, "credential:src_a")).toThrow();
  });

  it("detects tampering", () => {
    const raw = Buffer.from(encryptSecret(key, "hello world", "c"), "base64");
    raw[raw.length - 1]! ^= 1;
    expect(() => decryptSecret(key, raw.toString("base64"), "c")).toThrow();
    const tag = Buffer.from(encryptSecret(key, "hello world", "c"), "base64");
    tag[14]! ^= 1;
    expect(() => decryptSecret(key, tag.toString("base64"), "c")).toThrow();
    expect(() => decryptSecret(key, "AAAA", "c")).toThrow();
  });
});
