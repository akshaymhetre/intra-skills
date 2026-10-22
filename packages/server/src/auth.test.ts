import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@intra-skills/shared";
import { Harness, simple } from "./test/harness.js";
import { putSettings } from "./settings.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => h.close());

describe("health and identity", () => {
  it("health needs no auth and reports the package version", async () => {
    const r = await h.call("GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, version: "0.1.0" });
  });

  it("me returns the admin; no credentials is 401 unauthenticated", async () => {
    const ok = await h.call("GET", "/api/me", { token: h.adminToken });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ handle: "root", role: "admin", displayName: "Root Admin", teams: [] });
    const anon = await h.call("GET", "/api/me");
    expect(anon.status).toBe(401);
    expect(anon.json.error.code).toBe("unauthenticated");
    const bad = await h.call("GET", "/api/me", { token: "isk_" + "a".repeat(32) });
    expect(bad.status).toBe(401);
  });

  it("unknown api routes are JSON 404s", async () => {
    const r = await h.call("GET", "/api/nope", { token: h.adminToken });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });

  it("serves a not-built page at / when the console is missing", async () => {
    const r = await h.call("GET", "/some/spa/route");
    expect(r.status).toBe(200);
    expect(r.text).toContain("web console is not built");
  });
});

describe("users and teams", () => {
  it("admin creates a user whose first token works; members cannot create users", async () => {
    const r = await h.call("POST", "/api/users", {
      token: h.adminToken,
      body: { handle: "alice", displayName: "Alice A" },
    });
    expect(r.status).toBe(201);
    expect(r.json.user).toMatchObject({ handle: "alice", displayName: "Alice A", role: "member", teams: [] });
    expect(r.json.token).toMatch(/^isk_[0-9A-Za-z]{32}$/);
    const me = await h.call("GET", "/api/me", { token: r.json.token });
    expect(me.json.handle).toBe("alice");

    const denied = await h.call("POST", "/api/users", { token: r.json.token, body: { handle: "eve", displayName: "E" } });
    expect(denied.status).toBe(403);
    const dup = await h.call("POST", "/api/users", { token: h.adminToken, body: { handle: "alice", displayName: "A" } });
    expect(dup.status).toBe(409);
    const badHandle = await h.call("POST", "/api/users", { token: h.adminToken, body: { handle: "../x", displayName: "A" } });
    expect(badHandle.status).toBe(400);

    const users = await h.call("GET", "/api/users", { token: r.json.token });
    expect(users.json.map((u: { handle: string }) => u.handle)).toEqual(["alice", "root"]);
  });

  it("teams: create, members, maintainer may manage, member may not", async () => {
    const aliceTok = await h.user("alice");
    const bobTok = await h.user("bob");
    const created = await h.call("POST", "/api/teams", {
      token: h.adminToken,
      body: { slug: "platform", name: "Platform", description: "infra folks" },
    });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ slug: "platform", name: "Platform", memberCount: 0, skillCount: 0, members: [] });

    const add = await h.call("PUT", "/api/teams/platform/members/alice", { token: h.adminToken, body: { role: "maintainer" } });
    expect(add.status).toBe(200);
    expect(add.json.members).toEqual([{ handle: "alice", displayName: "ALICE", role: "maintainer" }]);

    // maintainer alice adds bob; bob (member) cannot rename the team
    const addBob = await h.call("PUT", "/api/teams/platform/members/bob", { token: aliceTok, body: { role: "member" } });
    expect(addBob.status).toBe(200);
    expect(addBob.json.memberCount).toBe(2);
    const rename = await h.call("PATCH", "/api/teams/platform", { token: aliceTok, body: { name: "Platform Eng" } });
    expect(rename.status).toBe(200);
    expect(rename.json.name).toBe("Platform Eng");
    const bobRename = await h.call("PATCH", "/api/teams/platform", { token: bobTok, body: { name: "x" } });
    expect(bobRename.status).toBe(403);

    const me = await h.call("GET", "/api/me", { token: bobTok });
    expect(me.json.teams).toEqual([{ slug: "platform", role: "member" }]);

    const rm = await h.call("DELETE", "/api/teams/platform/members/bob", { token: aliceTok });
    expect(rm.status).toBe(200);
    expect(rm.json.members.map((m: { handle: string }) => m.handle)).toEqual(["alice"]);
    const rmAgain = await h.call("DELETE", "/api/teams/platform/members/bob", { token: aliceTok });
    expect(rmAgain.status).toBe(404);

    const memberCreate = await h.call("POST", "/api/teams", { token: aliceTok, body: { slug: "x", name: "X" } });
    expect(memberCreate.status).toBe(403);
    const list = await h.call("GET", "/api/teams", { token: bobTok });
    expect(list.json).toHaveLength(1);
    expect(list.json[0]).toMatchObject({ slug: "platform", memberCount: 1 });
  });

  it("admin can promote a user; the last admin cannot be demoted", async () => {
    await h.user("alice");
    const up = await h.call("PATCH", "/api/users/alice", { token: h.adminToken, body: { role: "admin" } });
    expect(up.status).toBe(200);
    expect(up.json.role).toBe("admin");
    await h.call("PATCH", "/api/users/alice", { token: h.adminToken, body: { role: "member" } });
    const last = await h.call("PATCH", "/api/users/root", { token: h.adminToken, body: { role: "member" } });
    expect(last.status).toBe(409);
  });
});

describe("tokens", () => {
  it("create, list, revoke; a revoked token is 401; only hashes are stored", async () => {
    const created = await h.call("POST", "/api/tokens", { token: h.adminToken, body: { name: "laptop" } });
    expect(created.status).toBe(201);
    const tok = created.json.token as string;
    expect(tok).toMatch(/^isk_[0-9A-Za-z]{32}$/);
    expect(created.json.meta).toMatchObject({ name: "laptop", prefix: tok.slice(0, 12), lastUsedAt: null });

    const use = await h.call("GET", "/api/me", { token: tok });
    expect(use.status).toBe(200);

    const list = await h.call("GET", "/api/tokens", { token: tok });
    expect(list.json.map((t: { name: string }) => t.name).sort()).toEqual(["initial", "laptop"]);
    const laptop = list.json.find((t: { name: string }) => t.name === "laptop");
    expect(laptop.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(list.json)).not.toContain(tok);

    const stored = h.db.prepare("SELECT hash, prefix FROM tokens WHERE id = ?").get(created.json.meta.id) as {
      hash: string;
      prefix: string;
    };
    expect(stored.hash).toBe(sha256Hex(tok));

    const del = await h.call("DELETE", `/api/tokens/${created.json.meta.id}`, { token: h.adminToken });
    expect(del.status).toBe(204);
    const after = await h.call("GET", "/api/me", { token: tok });
    expect(after.status).toBe(401);
    const list2 = await h.call("GET", "/api/tokens", { token: h.adminToken });
    expect(list2.json.map((t: { name: string }) => t.name)).toEqual(["initial"]);
  });

  it("cannot revoke another user's token", async () => {
    const aliceTok = await h.user("alice");
    const mine = await h.call("GET", "/api/tokens", { token: h.adminToken });
    const r = await h.call("DELETE", `/api/tokens/${mine.json[0].id}`, { token: aliceTok });
    expect(r.status).toBe(404);
    expect((await h.call("GET", "/api/me", { token: h.adminToken })).status).toBe(200);
  });
});

describe("cookie auth and CSRF", () => {
  it("the cookie is Secure behind a TLS proxy: the request is http but the public URL is https", async () => {
    const plain = await h.call("POST", "/api/auth/login", { body: { token: h.adminToken } });
    expect(plain.headers.get("set-cookie") ?? "").not.toMatch(/Secure/i);
    putSettings(h.db, { publicUrl: "https://skills.example.com" });
    const proxied = await h.call("POST", "/api/auth/login", { body: { token: h.adminToken } });
    expect(proxied.headers.get("set-cookie") ?? "").toMatch(/;\s*Secure/i);
  });

  it("login sets an httpOnly cookie; cookie GET works; cookie mutation needs X-Requested-With", async () => {
    const login = await h.call("POST", "/api/auth/login", { body: { token: h.adminToken } });
    expect(login.status).toBe(200);
    expect(login.json.handle).toBe("root");
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`isk_session=${h.adminToken}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain("Max-Age=2592000");
    const cookie = `isk_session=${h.adminToken}`;

    const me = await h.call("GET", "/api/me", { cookie });
    expect(me.status).toBe(200);

    const withHeader = await h.call("POST", "/api/teams", {
      cookie,
      headers: { "X-Requested-With": "intra-skills" },
      body: { slug: "web", name: "Web" },
    });
    expect(withHeader.status).toBe(201);

    const noHeader = await h.call("POST", "/api/teams", { cookie, body: { slug: "web2", name: "Web2" } });
    expect(noHeader.status).toBe(403);
    expect(noHeader.json.error.code).toBe("csrf");
    const teams = await h.call("GET", "/api/teams", { cookie });
    expect(teams.json.map((t: { slug: string }) => t.slug)).toEqual(["web"]);

    // Bearer-authenticated mutations need no CSRF header.
    const bearer = await h.call("POST", "/api/teams", { token: h.adminToken, body: { slug: "web3", name: "W" } });
    expect(bearer.status).toBe(201);
  });

  it("login with a bad token is 401 and sets no cookie; logout clears the cookie", async () => {
    const bad = await h.call("POST", "/api/auth/login", { body: { token: "isk_nope" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("set-cookie")).toBeNull();
    const out = await h.call("POST", "/api/auth/logout", {
      cookie: `isk_session=${h.adminToken}`,
      headers: { "X-Requested-With": "intra-skills" },
    });
    expect(out.status).toBe(204);
    expect(out.headers.get("set-cookie")).toMatch(/isk_session=;.*Max-Age=0/);
  });
});

describe("limits", () => {
  it("rejects bodies over 8 MB with 413", async () => {
    const small = await h.publish(h.adminToken, "tiny", "1.0.0", simple("tiny"));
    expect(small.status).toBe(201);
    const big = "x".repeat(8 * 1024 * 1024 + 10);
    const r = await h.call("POST", "/api/skills/tiny/versions", {
      token: h.adminToken,
      rawBody: big,
      headers: { "Content-Type": "application/json", "Content-Length": String(big.length) },
    });
    expect(r.status).toBe(413);
    expect(r.json.error.code).toBe("too_large");
  });
});
