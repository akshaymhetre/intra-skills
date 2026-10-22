// End to end through HTTP with an in-memory git host: proposals, pull requests, approvals, sync.
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHost } from "./git/fake.js";
import { GitService } from "./git/service.js";
import { randomBytes } from "node:crypto";
import { Harness, bundle, simple, skillMd } from "./test/harness.js";
import { userIdByHandle } from "./model.js";

let host: FakeGitHost;
let h: Harness;
let alice: string;
let bob: string;
let carol: string;

const CRED = { kind: "token", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" };

function link(handle: string, username: string, provider = "github"): void {
  h.db.prepare("INSERT INTO git_identities (user_id, provider, username) VALUES (?, ?, ?)").run(
    userIdByHandle(h.db, handle),
    provider,
    username,
  );
}

async function createSource(extra: Record<string, unknown> = {}) {
  const r = await h.call("POST", "/api/sources", {
    token: h.adminToken,
    body: { provider: "github", repo: "acme/skills", credential: CRED, ...extra },
  });
  expect(r.status, r.text).toBe(201);
  return r.json as { id: string };
}

const sync = (id: string) => h.call("POST", `/api/sources/${id}/sync`, { token: h.adminToken });

function files(name: string, version: string, body?: string) {
  return simple(name, { meta: { version }, body: body ?? `# ${name}\n\nStep one.\nStep two.\n` });
}

beforeEach(async () => {
  host = new FakeGitHost();
  h = new Harness({ providerFactory: host.factory });
  alice = await h.user("alice");
  bob = await h.user("bob");
  carol = await h.user("carol");
  link("alice", "alice-gh");
  link("bob", "bob-gh");
});
afterEach(() => h.close());

describe("publish mode", () => {
  it("direct POST /versions is refused once an enabled source exists", async () => {
    expect((await h.publish(alice, "a", "1.0.0", files("a", "1.0.0"))).status).toBe(201);
    await createSource();
    const r = await h.publish(alice, "b", "1.0.0", files("b", "1.0.0"));
    expect(r.status).toBe(403);
    expect(r.json.error.details).toEqual({ publishMode: "pull-request" });
  });

  it("a proposal without git sources is 409", async () => {
    const r = await h.call("POST", "/api/skills/a/proposals", { token: alice, body: { version: "1.0.0", files: files("a", "1.0.0") } });
    expect(r.status).toBe(409);
  });
});

describe("proposal to version", () => {
  it("opens a PR, refuses self-approval, publishes after another reviewer approves", async () => {
    const src = await createSource();
    const p1 = await h.call("POST", "/api/skills/deploy-check/proposals", {
      token: alice,
      body: { version: "1.0.0", files: files("deploy-check", "1.0.0"), changelog: "first cut", visibility: "org" },
    });
    expect(p1.status, p1.text).toBe(201);
    expect(p1.json).toMatchObject({
      skill: "deploy-check",
      version: "1.0.0",
      kind: "new",
      proposer: { handle: "alice" },
      sourceId: src.id,
      branch: "intra/deploy-check-1.0.0",
      status: "open",
      pullRequest: { number: 1 },
    });
    const pr = host.pr(1);
    expect(pr.title).toBe("New skill: deploy-check 1.0.0");
    expect(pr.body).toContain("`alice`");
    expect(pr.body).toContain("`alice-gh`");
    expect(pr.body).toContain("first cut");
    expect(pr.body).toContain(`<!-- intra-skills:proposal=${p1.json.id} -->`);
    expect(host.text("intra/deploy-check-1.0.0", "skills/deploy-check/SKILL.md")).toContain("name: deploy-check");
    // proposal_files reference blobs
    const pf = h.db.prepare("SELECT path, sha256 FROM proposal_files WHERE proposal_id = ?").all(p1.json.id) as { sha256: string }[];
    expect(pf).toHaveLength(1);
    expect(h.db.prepare("SELECT count(*) AS n FROM blobs WHERE sha256 = ?").get(pf[0]!.sha256)).toEqual({ n: 1 });

    // Sync while open: nothing published.
    let s = await sync(src.id);
    expect(s.json.ingested).toEqual([]);
    expect((await h.call("GET", "/api/skills/deploy-check", { token: alice })).status).toBe(404);
    let got = await h.call("GET", `/api/proposals/${p1.json.id}`, { token: alice });
    expect(got.json.status).toBe("open");
    expect(got.json.statusMessage).toMatch(/Waiting for 1 approval/);

    // The proposer approves their own PR, it is merged: refused.
    host.approve(1, "alice-gh");
    host.merge(1);
    s = await sync(src.id);
    expect(s.json.ingested).toEqual([]);
    expect(s.json.skipped).toContainEqual({
      path: "skills/deploy-check",
      reason: "needs 1 approval from someone other than the proposer",
    });
    got = await h.call("GET", `/api/proposals/${p1.json.id}`, { token: alice });
    expect(got.json.status).toBe("failed");
    expect(got.json.statusMessage).toBe("needs 1 approval from someone other than the proposer");
    expect((await h.call("GET", "/api/skills/deploy-check", { token: alice })).status).toBe(404);

    // A fresh PR (new content), approved by someone else.
    const p2 = await h.call("POST", "/api/skills/deploy-check/proposals", {
      token: alice,
      body: { version: "1.0.0", files: files("deploy-check", "1.0.0", "# deploy-check\n\nStep one, reviewed.\n"), changelog: "reviewed" },
    });
    expect(p2.status, p2.text).toBe(201);
    expect(p2.json.id).not.toBe(p1.json.id);
    expect(p2.json.pullRequest.number).toBe(2);
    host.approve(2, "bob-gh");
    host.merge(2);
    s = await sync(src.id);
    expect(s.json.ok, s.text).toBe(true);
    expect(s.json.ingested).toEqual(["deploy-check@1.0.0"]);

    got = await h.call("GET", `/api/proposals/${p2.json.id}`, { token: alice });
    expect(got.json.status).toBe("published");
    const d = await h.call("GET", "/api/skills/deploy-check", { token: alice });
    expect(d.status).toBe(200);
    expect(d.json.versions[0]).toMatchObject({
      version: "1.0.0",
      publishedBy: "alice",
      changelog: "reviewed",
      git: { repo: "github.com/acme/skills", dirty: false, pullRequest: { number: 2, url: "https://github.com/acme/skills/pull/2" } },
    });
    expect(d.json.source).toMatchObject({
      sourceId: src.id,
      provider: "github",
      repo: "acme/skills",
      path: "skills/deploy-check",
      webUrl: "https://github.com/acme/skills/tree/main/skills/deploy-check",
    });
    const audits = h.db.prepare("SELECT action FROM audit WHERE action = 'source.sync'").all();
    expect(audits).toHaveLength(1);

    // Same version again (a later unrelated commit forces a full read): idempotent.
    host.push("main", { "README.md": "# changed\n" });
    s = await sync(src.id);
    expect(s.json.ingested).toEqual([]);
    expect(s.json.skipped).toEqual([]);
    expect((await h.call("GET", "/api/skills/deploy-check", { token: alice })).json.versions).toHaveLength(1);
  });

  it("a second proposal by the same proposer updates the branch; by someone else is 409", async () => {
    await createSource();
    const p1 = await h.call("POST", "/api/skills/fmt/proposals", { token: alice, body: { version: "1.0.0", files: bundle({ "SKILL.md": skillMd("fmt", { meta: { version: "1.0.0" } }), "old.txt": "old\n" }) } });
    expect(p1.status).toBe(201);
    const p2 = await h.call("POST", "/api/skills/fmt/proposals", {
      token: alice,
      body: { version: "1.0.1", files: files("fmt", "1.0.1"), changelog: "second" },
    });
    expect(p2.status, p2.text).toBe(200);
    expect(p2.json.id).toBe(p1.json.id);
    expect(p2.json).toMatchObject({ version: "1.0.1", changelog: "second", branch: "intra/fmt-1.0.0" });
    expect(host.text("intra/fmt-1.0.0", "skills/fmt/old.txt")).toBeNull();
    expect(host.text("intra/fmt-1.0.0", "skills/fmt/SKILL.md")).toContain('version: "1.0.1"');
    expect(host.prs.size).toBe(1);
    expect(host.pr(1).title).toBe("New skill: fmt 1.0.1");

    const p3 = await h.call("POST", "/api/skills/fmt/proposals", { token: bob, body: { version: "1.0.2", files: files("fmt", "1.0.2") } });
    expect(p3.status).toBe(409);
  });

  it("closing an unmerged PR makes the proposal closed", async () => {
    const src = await createSource();
    const p = await h.call("POST", "/api/skills/x/proposals", { token: alice, body: { version: "1.0.0", files: files("x", "1.0.0") } });
    host.close(1);
    const r = await h.call("POST", `/api/proposals/${p.json.id}/refresh`, { token: alice });
    expect(r.json.status).toBe("closed");
    await sync(src.id);
    expect((await h.call("GET", `/api/proposals/${p.json.id}`, { token: alice })).json.status).toBe("closed");
  });

  it("refuses without a git identity, and refuses secrets before touching the host", async () => {
    await createSource();
    const noId = await h.call("POST", "/api/skills/x/proposals", { token: carol, body: { version: "1.0.0", files: files("x", "1.0.0") } });
    expect(noId.status).toBe(403);
    expect(noId.json.error.message).toMatch(/Settings/);
    expect(noId.json.error.details).toEqual({ reason: "no_git_identity", provider: "github" });

    const leaky = await h.call("POST", "/api/skills/x/proposals", {
      token: alice,
      body: {
        version: "1.0.0",
        files: simple("x", { meta: { version: "1.0.0" } }, { "notes.md": "key: AKIAABCDEFGHIJKLMNOP\n" }),
      },
    });
    expect(leaky.status).toBe(422);
    expect(leaky.json.error.details[0]).toMatchObject({ field: "notes.md:1" });
    expect(leaky.text).not.toContain("AKIAABCDEFGHIJKLMNOP");
    expect(host.writes).toEqual([]);
    expect([...host.branches.keys()]).toEqual(["main"]);

    const noVersion = await h.call("POST", "/api/skills/x/proposals", { token: alice, body: { version: "1.0.0", files: simple("x") } });
    expect(noVersion.status).toBe(422);
    expect(host.writes).toEqual([]);
  });

  it("an existing skill needs write to propose; unreadable private skill is 404", async () => {
    await h.publish(alice, "mine", "1.0.0", files("mine", "1.0.0"));
    await h.publish(alice, "secret", "1.0.0", files("secret", "1.0.0"), { visibility: "private" });
    await createSource();
    const r = await h.call("POST", "/api/skills/mine/proposals", { token: bob, body: { version: "1.1.0", files: files("mine", "1.1.0") } });
    expect(r.status).toBe(403);
    const r2 = await h.call("POST", "/api/skills/secret/proposals", { token: bob, body: { version: "1.1.0", files: files("secret", "1.1.0") } });
    expect(r2.status).toBe(404);
    const old = await h.call("POST", "/api/skills/mine/proposals", { token: alice, body: { version: "0.9.0", files: files("mine", "0.9.0") } });
    expect(old.status).toBe(409);
    const ok = await h.call("POST", "/api/skills/mine/proposals", { token: alice, body: { version: "1.1.0", files: files("mine", "1.1.0") } });
    expect(ok.status).toBe(201);
    expect(ok.json.kind).toBe("update");
    expect(host.pr(1).title).toBe("mine 1.1.0");
  });
});

describe("commit index lag after a merge", () => {
  it("publishes a proposal's merge even before the host links the commit to its pull request", async () => {
    const src = await createSource({ minApprovals: 0 });
    const p = await h.call("POST", "/api/skills/lagged/proposals", { token: alice, body: { version: "1.0.0", files: files("lagged", "1.0.0") } });
    expect(p.status, p.text).toBe(201);
    host.commitIndexReady = false;
    host.merge(p.json.pullRequest.number);
    const s = await sync(src.id);
    expect(s.json.ingested, s.text).toEqual(["lagged@1.0.0"]);
    expect((await h.call("GET", `/api/proposals/${p.json.id}`, { token: alice })).json.status).toBe("published");
  });

  it("a hand-made pull request the index has not caught up with is retried on the next poll, not failed", async () => {
    h.close();
    host = new FakeGitHost();
    h = new Harness({ providerFactory: host.factory });
    const git = new GitService(h.db, { secretKey: randomBytes(32), providerFactory: host.factory });
    h.app = (await import("./app.js")).createApp(h.db, { webDir: null, git });
    const src = await createSource({ minApprovals: 0 });
    host.push("hand-made", { "skills/handy/SKILL.md": skillMd("handy", { meta: { version: "1.0.0" } }) });
    const n = host.openPr({ head: "hand-made", author: "someone-gh" });
    host.commitIndexReady = false;
    host.merge(n);
    let s = await git.sync(src.id); // poller-style: not a full read
    expect(s.ingested).toEqual([]);
    expect(s.skipped).toEqual([{ path: "skills/handy", reason: "not merged through a pull request" }]);
    host.commitIndexReady = true;
    s = await git.sync(src.id); // same head commit: must look again rather than short-circuit
    expect(s.ingested).toEqual(["handy@1.0.0"]);
    await git.stop();
  });
});

describe("hand-made pull requests", () => {
  it("publishes as the linked registry user, or as git-sync when unlinked", async () => {
    const src = await createSource();
    host.push("feat-a", { "skills/a-skill/SKILL.md": skillMd("a-skill", { meta: { version: "1.0.0" } }) });
    host.openPr({ head: "feat-a", author: "bob-gh" });
    host.approve(1, "alice-gh");
    host.merge(1);
    host.push("feat-b", { "skills/b-skill/SKILL.md": skillMd("b-skill", { meta: { version: "2.0.0" } }) });
    host.openPr({ head: "feat-b", author: "stranger" });
    host.approve(2, "alice-gh");
    host.merge(2);
    host.push("feat-c", { "skills/c-skill/SKILL.md": skillMd("c-skill") });
    host.openPr({ head: "feat-c", author: "stranger" });
    host.approve(3, "alice-gh");
    host.merge(3);
    host.push("main", { "skills/d-skill/SKILL.md": skillMd("d-skill", { meta: { version: "1.0.0" } }) });

    const s = await sync(src.id);
    expect(s.json.ingested.sort()).toEqual(["a-skill@1.0.0", "b-skill@2.0.0"]);
    expect(s.json.skipped).toContainEqual({ path: "skills/c-skill", reason: "no metadata.version" });
    expect(s.json.skipped).toContainEqual({ path: "skills/d-skill", reason: "not merged through a pull request" });
    const a = await h.call("GET", "/api/skills/a-skill", { token: alice });
    expect(a.json.versions[0].publishedBy).toBe("bob");
    const b = await h.call("GET", "/api/skills/b-skill", { token: alice });
    expect(b.json.versions[0].publishedBy).toBe("git-sync");
    const sys = h.db.prepare("SELECT system FROM users WHERE handle = 'git-sync'").get();
    expect(sys).toEqual({ system: 1 });
    expect((await h.call("GET", "/api/users", { token: h.adminToken })).json.map((u: { handle: string }) => u.handle)).not.toContain(
      "git-sync",
    );
    const st = await h.call("GET", `/api/sources/${src.id}`, { token: h.adminToken });
    expect(st.json.lastSync.ingested.sort()).toEqual(["a-skill@1.0.0", "b-skill@2.0.0"]);
  });

  it("the author's own approval never counts", async () => {
    const src = await createSource();
    host.push("feat", { "skills/s/SKILL.md": skillMd("s", { meta: { version: "1.0.0" } }) });
    host.openPr({ head: "feat", author: "bob-gh" });
    host.approve(1, "bob-gh");
    host.approve(1, "intra-bot");
    host.merge(1);
    const s = await sync(src.id);
    expect(s.json.ingested).toEqual([]);
    expect(s.json.skipped[0].reason).toMatch(/needs 1 approval/);
  });
});

describe("sources", () => {
  it("never returns credentials or webhook secrets", async () => {
    const secret = "whsec-0123456789abcdef";
    const src = await createSource({ webhookSecret: secret });
    const app = await h.call("POST", "/api/sources", {
      token: h.adminToken,
      body: {
        provider: "bitbucket-cloud",
        repo: "acme/skills",
        credential: { kind: "basic", username: "ops@acme.test", password: "ATATT3xFfGF0secretpassword123" },
      },
    });
    expect(app.status, app.text).toBe(201);
    for (const path of ["/api/sources", `/api/sources/${src.id}`, `/api/sources/${app.json.id}`]) {
      const r = await h.call("GET", path, { token: h.adminToken });
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(CRED.token);
      expect(r.text).not.toContain(CRED.token.slice(4, 20));
      expect(r.text).not.toContain("ATATT3xFfGF0secretpassword123");
      expect(r.text).not.toContain(secret);
    }
    const one = (await h.call("GET", `/api/sources/${src.id}`, { token: h.adminToken })).json;
    expect(one).toMatchObject({
      isDefault: true,
      root: "skills",
      baseBranch: "main",
      minApprovals: 1,
      credential: { kind: "token", set: true, hint: "ghp_...6789" },
      webhook: { url: `http://localhost/api/hooks/${src.id}`, secretSet: true },
    });
    expect(src.id).toMatch(/^src_[0-9A-Za-z]{12}$/);
    expect((await h.call("GET", `/api/sources/${app.json.id}`, { token: h.adminToken })).json.isDefault).toBe(false);
    // stored encrypted
    const row = h.db.prepare("SELECT credential_enc FROM git_sources WHERE id = ?").get(src.id) as { credential_enc: string };
    expect(row.credential_enc).not.toContain("ghp_");
  });

  it("validates input and is admin only", async () => {
    const bad = (body: Record<string, unknown>) => h.call("POST", "/api/sources", { token: h.adminToken, body: { provider: "github", repo: "acme/skills", credential: CRED, ...body } });
    expect((await bad({ repo: "nope" })).status).toBe(400);
    expect((await bad({ root: "../x" })).status).toBe(400);
    expect((await bad({ apiUrl: "http://ghe.acme.test/api/v3" })).status).toBe(400);
    expect((await bad({ minApprovals: 11 })).status).toBe(400);
    expect((await bad({ provider: "fake" })).status).toBe(400);
    expect((await bad({ credential: { kind: "basic", username: "a", password: "b" } })).status).toBe(400);
    expect((await bad({ credential: undefined })).status).toBe(400);
    expect((await h.call("GET", "/api/sources", { token: alice })).status).toBe(403);
    const ok = await bad({ apiUrl: "https://ghe.acme.test/api/v3/" });
    expect(ok.json.apiUrl).toBe("https://ghe.acme.test/api/v3");
    expect((await bad({ apiUrl: "https://ghe.acme.test/api/v3/" })).status).toBe(409);
  });

  it("test endpoint reports host checks", async () => {
    const src = await createSource();
    const r = await h.call("POST", `/api/sources/${src.id}/test`, { token: h.adminToken });
    expect(r.json.ok).toBe(true);
    host.readOnly = true;
    const r2 = await h.call("POST", `/api/sources/${src.id}/test`, { token: h.adminToken });
    expect(r2.json.ok).toBe(false);
    expect(r2.json.checks.find((c: { name: string }) => c.name === "write").ok).toBe(false);
  });

  it("disabling the only source returns to direct publishing", async () => {
    const src = await createSource();
    const p = await h.call("PATCH", `/api/sources/${src.id}`, { token: h.adminToken, body: { enabled: false } });
    expect(p.json.enabled).toBe(false);
    expect((await h.publish(alice, "b", "1.0.0", files("b", "1.0.0"))).status).toBe(201);
  });
});

describe("webhooks", () => {
  const sign = (secret: string, body: string) => "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

  it("401 for bad or missing signatures and for sources with no secret, 202 when signed", async () => {
    const secret = "whsec-0123456789abcdef";
    const src = await createSource({ webhookSecret: secret });
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const post = (headers: Record<string, string>, id = src.id) =>
      h.call("POST", `/api/hooks/${id}`, { rawBody: body, headers: { "Content-Type": "application/json", ...headers } });
    expect((await post({})).status).toBe(401);
    expect((await post({ "X-Hub-Signature-256": sign("wrong-secret-0000000", body) })).status).toBe(401);
    expect((await post({ "X-Hub-Signature-256": sign(secret, body) }, "src_nope")).status).toBe(401);
    const ok = await post({ "X-Hub-Signature-256": sign(secret, body) });
    expect(ok.status).toBe(202);
    expect(ok.json).toEqual({ queued: true });

    const open = await createSource({ repo: "acme/other" });
    expect((await post({ "X-Hub-Signature-256": sign("", body) }, open.id)).status).toBe(401);
  });

  it("a signed webhook syncs in the background", async () => {
    const secret = "whsec-0123456789abcdef";
    const src = await createSource({ webhookSecret: secret });
    host.push("feat", { "skills/w/SKILL.md": skillMd("w", { meta: { version: "1.0.0" } }) });
    host.openPr({ head: "feat", author: "bob-gh" });
    host.approve(1, "alice-gh");
    host.merge(1);
    const body = "{}";
    const r = await h.call("POST", `/api/hooks/${src.id}`, { rawBody: body, headers: { "X-Hub-Signature-256": sign(secret, body) } });
    expect(r.status).toBe(202);
    // The background run and an explicit one never overlap; this waits for the queued follow-up.
    for (let i = 0; i < 50; i++) {
      const s = await h.call("GET", `/api/sources/${src.id}`, { token: h.adminToken });
      if (s.json.lastSync) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect((await h.call("GET", "/api/skills/w", { token: alice })).json.versions[0].publishedBy).toBe("bob");
  });
});

describe("visibility of proposals", () => {
  it("members see readable skills' proposals and their own; home counts them", async () => {
    await createSource();
    await h.call("POST", "/api/skills/hidden/proposals", { token: alice, body: { version: "1.0.0", files: files("hidden", "1.0.0"), visibility: "private" } });
    await h.call("POST", "/api/skills/shown/proposals", { token: alice, body: { version: "1.0.0", files: files("shown", "1.0.0") } });
    const bobList = await h.call("GET", "/api/proposals", { token: bob });
    expect(bobList.json.map((p: { skill: string }) => p.skill)).toEqual(["shown"]);
    const mine = await h.call("GET", "/api/proposals?mine=1", { token: alice });
    expect(mine.json).toHaveLength(2);
    const adminList = await h.call("GET", "/api/proposals?status=open", { token: h.adminToken });
    expect(adminList.json).toHaveLength(2);
    const id = mine.json.find((p: { skill: string }) => p.skill === "hidden").id;
    expect((await h.call("GET", `/api/proposals/${id}`, { token: bob })).status).toBe(404);
    expect((await h.call("GET", "/api/proposals?status=bogus", { token: bob })).status).toBe(400);
  });
});

describe("git service", () => {
  it("never overlaps syncs of one source, polls, and stop() waits for a running sync", async () => {
    const { GitService } = await import("./git/service.js");
    const { randomBytes } = await import("node:crypto");
    const src = await createSource();
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const slow = (s: Parameters<typeof host.factory>[0]) => {
      const p = host.factory(s);
      const head = p.headCommit.bind(p);
      p.headCommit = async (b: string) => {
        active++;
        runs++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return head(b);
      };
      return p;
    };
    // A second service on the same database with its own key: re-encrypt the credential under it.
    const key = randomBytes(32);
    const svc = new GitService(h.db, { secretKey: key, providerFactory: slow });
    h.db.prepare("UPDATE git_sources SET credential_enc = ? WHERE id = ?").run(svc.encryptCredential(src.id, CRED as never), src.id);
    const all = await Promise.all([svc.sync(src.id), svc.sync(src.id), svc.sync(src.id)]);
    expect(maxActive).toBe(1);
    expect(runs).toBe(2); // the running one plus one queued follow-up that the third call joined
    expect(all.every((s) => s.ok)).toBe(true);

    h.db.prepare("INSERT INTO settings (key, value) VALUES ('pollSeconds', '0.03') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    runs = 0;
    svc.start();
    svc.start(); // idempotent
    while (runs === 0) await new Promise((r) => setTimeout(r, 5));
    await svc.stop();
    expect(active).toBe(0);
    const after = runs;
    await new Promise((r) => setTimeout(r, 80));
    expect(runs).toBe(after);
  });
});
