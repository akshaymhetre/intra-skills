import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, tx, type Db } from "./db.js";
import { createApp } from "./app.js";
import { createToken } from "./auth.js";
import { createUser } from "./routes/users.js";
import { ensureSetupToken, SETUP_TOKEN_FILE } from "./setup.js";
import { Harness } from "./test/harness.js";

// A database with NO users, which the shared Harness cannot give (it always creates an admin).
class Fresh {
  dir = mkdtempSync(join(tmpdir(), "srv-setup-"));
  db: Db = openDb(join(this.dir, "registry.db"));
  app = createApp(this.db, { webDir: null });
  close() {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }
  async call(method: string, path: string, o: { token?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = {};
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await this.app.request(path, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }
}

describe("first-admin setup", () => {
  let f: Fresh;
  beforeEach(() => {
    f = new Fresh();
  });
  afterEach(() => f.close());

  it("reports needsSetup publicly and in /api/meta", async () => {
    expect((await f.call("GET", "/api/setup")).json).toEqual({ needsSetup: true });
    const meta = await f.call("GET", "/api/meta");
    expect(meta.status).toBe(200);
    expect(meta.json).toMatchObject({
      name: "intra-skills",
      publicUrl: "http://localhost",
      needsSetup: true,
      publishMode: "direct",
      mcpUrl: "http://localhost/api/mcp",
    });
    expect(typeof meta.json.version).toBe("string");
  });

  it("writes the setup token to a 0600 file and returns the same token until setup is done", () => {
    const t1 = ensureSetupToken(f.db, f.dir);
    expect(t1).toMatch(/^ist_[A-Za-z0-9_-]{43}$/);
    const file = join(f.dir, SETUP_TOKEN_FILE);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8").trim()).toBe(t1);
    expect(ensureSetupToken(f.db, f.dir)).toBe(t1);
  });

  it("refuses a wrong token (403) and refuses when no token file exists", async () => {
    const body = { handle: "ada", displayName: "Ada" };
    expect((await f.call("POST", "/api/setup", { body: { ...body, setupToken: "ist_x" } })).status).toBe(403);
    const real = ensureSetupToken(f.db, f.dir)!;
    const wrong = real.slice(0, -1) + (real.endsWith("A") ? "B" : "A");
    const r = await f.call("POST", "/api/setup", { body: { ...body, setupToken: wrong } });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("forbidden");
    expect((await f.call("POST", "/api/setup", { body })).status).toBe(403);
  });

  it("creates the admin once with the right token, sets the cookie, and the token works", async () => {
    const setupToken = ensureSetupToken(f.db, f.dir)!;
    const r = await f.call("POST", "/api/setup", {
      body: { setupToken, handle: "Ada", displayName: " Ada Lovelace ", orgName: "Acme" },
    });
    expect(r.status).toBe(201);
    expect(r.json.user).toMatchObject({ handle: "ada", displayName: "Ada Lovelace", role: "admin", gitIdentities: [] });
    expect(r.json.token).toMatch(/^isk_/);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`isk_session=${r.json.token}`);
    expect(cookie).toContain("HttpOnly");
    expect((await f.call("GET", "/api/me", { token: r.json.token })).json.handle).toBe("ada");
    expect(existsSync(join(f.dir, SETUP_TOKEN_FILE))).toBe(false);
    expect((await f.call("GET", "/api/meta")).json).toMatchObject({ name: "Acme", needsSetup: false });

    const again = await f.call("POST", "/api/setup", { body: { setupToken, handle: "eve", displayName: "Eve" } });
    expect(again.status).toBe(409);
    expect(ensureSetupToken(f.db, f.dir)).toBeNull();
  });

  it("refuses setup (409) once a real user exists, and removes a leftover token file", async () => {
    const setupToken = ensureSetupToken(f.db, f.dir)!;
    tx(f.db, () => createUser(f.db, { handle: "init-admin", displayName: "Init", role: "admin" }));
    const r = await f.call("POST", "/api/setup", { body: { setupToken, handle: "eve", displayName: "Eve" } });
    expect(r.status).toBe(409);
    expect(ensureSetupToken(f.db, f.dir)).toBeNull();
    expect(existsSync(join(f.dir, SETUP_TOKEN_FILE))).toBe(false);
  });

  it("validates the handle and org name before creating anything", async () => {
    const setupToken = ensureSetupToken(f.db, f.dir)!;
    expect((await f.call("POST", "/api/setup", { body: { setupToken, handle: "bad handle", displayName: "X" } })).status).toBe(400);
    expect(
      (await f.call("POST", "/api/setup", { body: { setupToken, handle: "ok", displayName: "X", orgName: "x".repeat(81) } })).status,
    ).toBe(400);
    expect((await f.call("GET", "/api/setup")).json.needsSetup).toBe(true);
  });

  it("a system user does not count as set up, cannot sign in, and is not listed", async () => {
    const id = Number(
      f.db
        .prepare("INSERT INTO users (handle, display_name, role, created_at, system) VALUES ('git-sync', 'Git sync', 'admin', ?, 1)")
        .run(new Date().toISOString()).lastInsertRowid,
    );
    const { token } = createToken(f.db, id, "should never work");
    expect((await f.call("GET", "/api/setup")).json.needsSetup).toBe(true);
    expect((await f.call("GET", "/api/me", { token })).status).toBe(401);
    expect((await f.call("POST", "/api/auth/login", { body: { token } })).status).toBe(401);
    const setupToken = ensureSetupToken(f.db, f.dir)!;
    const r = await f.call("POST", "/api/setup", { body: { setupToken, handle: "ada", displayName: "Ada" } });
    expect(r.status).toBe(201);
    const users = await f.call("GET", "/api/users", { token: r.json.token });
    expect(users.json.map((u: { handle: string }) => u.handle)).toEqual(["ada"]);
  });
});

describe("settings", () => {
  let h: Harness;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    h = new Harness();
    for (const k of ["INTRA_SKILLS_ORG_NAME", "INTRA_SKILLS_PUBLIC_URL", "INTRA_SKILLS_STALE_DAYS", "INTRA_SKILLS_POLL_SECONDS"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    h.close();
  });

  it("is admin only", async () => {
    const m = await h.user("mia");
    expect((await h.call("GET", "/api/settings", { token: m })).status).toBe(403);
    expect((await h.call("PATCH", "/api/settings", { token: m, body: { name: "x" } })).status).toBe(403);
  });

  it("reads defaults, patches valid values and audits the change", async () => {
    const g = await h.call("GET", "/api/settings", { token: h.adminToken });
    expect(g.json).toEqual({ settings: { name: "intra-skills", publicUrl: "", staleDays: 90, pollSeconds: 60 }, pinned: [] });
    const p = await h.call("PATCH", "/api/settings", {
      token: h.adminToken,
      body: { name: " Acme ", publicUrl: "https://skills.acme.test/", staleDays: 30, pollSeconds: 15 },
    });
    expect(p.status).toBe(200);
    expect(p.json.settings).toEqual({ name: "Acme", publicUrl: "https://skills.acme.test", staleDays: 30, pollSeconds: 15 });
    expect((await h.call("GET", "/api/meta")).json).toMatchObject({ publicUrl: "https://skills.acme.test", mcpUrl: "https://skills.acme.test/api/mcp" });
    const audit = await h.call("GET", "/api/audit", { token: h.adminToken });
    expect(audit.json.some((e: { action: string }) => e.action === "settings.update")).toBe(true);
  });

  it("refuses invalid values", async () => {
    const bad = [
      { publicUrl: "ftp://x.test" },
      { publicUrl: "https://x.test/skills" },
      { publicUrl: "https://x.test?a=1" },
      { publicUrl: "not a url" },
      { staleDays: 0 },
      { staleDays: 3651 },
      { staleDays: 1.5 },
      { pollSeconds: 14 },
      { pollSeconds: 86401 },
      { name: "" },
      { name: "x".repeat(81) },
      { unknown: 1 },
    ];
    for (const body of bad) {
      const r = await h.call("PATCH", "/api/settings", { token: h.adminToken, body });
      expect(r.status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.call("GET", "/api/settings", { token: h.adminToken })).json.settings.staleDays).toBe(90);
  });

  it("reports env-pinned keys, lets the env win, and refuses to store a pinned key", async () => {
    process.env.INTRA_SKILLS_PUBLIC_URL = "https://pinned.acme.test";
    const g = await h.call("GET", "/api/settings", { token: h.adminToken });
    expect(g.json.pinned).toEqual(["publicUrl"]);
    expect(g.json.settings.publicUrl).toBe("https://pinned.acme.test");
    const p = await h.call("PATCH", "/api/settings", { token: h.adminToken, body: { publicUrl: "https://other.test" } });
    expect(p.status).toBe(409);
    expect(p.json.error.message).toContain("INTRA_SKILLS_PUBLIC_URL");
    expect((await h.call("PATCH", "/api/settings", { token: h.adminToken, body: { staleDays: 7 } })).status).toBe(200);
  });
});

describe("git identities", () => {
  let h: Harness;
  beforeEach(() => {
    h = new Harness();
  });
  afterEach(() => h.close());

  it("replaces the caller's identities and shows them on every user response", async () => {
    const m = await h.user("mia");
    const r = await h.call("PUT", "/api/me/git-identities", {
      token: m,
      body: [
        { provider: "github", username: "mia-gh" },
        { provider: "bitbucket-cloud", username: "mia.bb" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.json.gitIdentities).toEqual([
      { provider: "bitbucket-cloud", username: "mia.bb" },
      { provider: "github", username: "mia-gh" },
    ]);
    const r2 = await h.call("PUT", "/api/me/git-identities", { token: m, body: [{ provider: "github", username: "mia2" }] });
    expect(r2.json.gitIdentities).toEqual([{ provider: "github", username: "mia2" }]);
    const users = await h.call("GET", "/api/users", { token: m });
    expect(users.json.find((u: { handle: string }) => u.handle === "mia").gitIdentities).toEqual([{ provider: "github", username: "mia2" }]);
    expect((await h.call("PUT", "/api/me/git-identities", { token: m, body: [] })).json.gitIdentities).toEqual([]);
  });

  it("refuses bad input and a username linked to someone else (case-insensitive)", async () => {
    const m = await h.user("mia");
    const n = await h.user("noah");
    await h.call("PUT", "/api/me/git-identities", { token: m, body: [{ provider: "github", username: "Shared" }] });
    const taken = await h.call("PUT", "/api/me/git-identities", { token: n, body: [{ provider: "github", username: "shared" }] });
    expect(taken.status).toBe(409);
    const bad = [
      [{ provider: "gitlab", username: "x" }],
      [{ provider: "github", username: "-starts-with-dash" }],
      [{ provider: "github", username: "a".repeat(100) }],
      [
        { provider: "github", username: "a" },
        { provider: "github", username: "b" },
      ],
      { provider: "github", username: "x" },
    ];
    for (const body of bad) expect((await h.call("PUT", "/api/me/git-identities", { token: n, body })).status, JSON.stringify(body)).toBe(400);
    // Nothing was half-applied by the refused requests.
    expect((await h.call("GET", "/api/me", { token: n })).json.gitIdentities).toEqual([]);
  });

  it("lets an admin set another user's identities; members cannot", async () => {
    const m = await h.user("mia");
    await h.user("noah");
    expect((await h.call("PUT", "/api/users/noah/git-identities", { token: m, body: [] })).status).toBe(403);
    const r = await h.call("PUT", "/api/users/noah/git-identities", {
      token: h.adminToken,
      body: [{ provider: "github", username: "noah-gh" }],
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ handle: "noah", gitIdentities: [{ provider: "github", username: "noah-gh" }] });
    expect((await h.call("PUT", "/api/users/ghost/git-identities", { token: h.adminToken, body: [] })).status).toBe(404);
  });
});
