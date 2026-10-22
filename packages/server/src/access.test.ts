import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, simple } from "./test/harness.js";

let h: Harness;
let alice: string; // creator
let bob: string; // outsider
let carol: string; // member of team "sec"
beforeEach(async () => {
  h = new Harness();
  alice = await h.user("alice");
  bob = await h.user("bob");
  carol = await h.user("carol");
  await h.team("sec", { carol: "member" });
  await h.team("ops", { bob: "member" });
  const pub = await h.publish(alice, "secret", "1.0.0", simple("secret", { meta: { visibility: "private" } }));
  expect(pub.status).toBe(201);
  await h.publish(alice, "secret", "1.1.0", simple("secret", { body: "changed\n" }));
});
afterEach(() => h.close());

const SKILL_ROUTES = [
  "/api/skills/secret",
  "/api/skills/secret/versions/1.0.0",
  "/api/skills/secret/versions/latest",
  "/api/skills/secret/versions/1.0.0/bundle",
  "/api/skills/secret/versions/1.0.0/files/SKILL.md",
  "/api/skills/secret/diff?from=1.0.0&to=1.1.0",
  "/api/skills/secret/resolve?range=^1.0.0",
  "/api/skills/secret/grants",
];

async function names(token: string): Promise<string[]> {
  const r = await h.call("GET", "/api/skills", { token });
  return r.json.skills.map((s: { name: string }) => s.name);
}

describe("private skills", () => {
  it("the creator reads every route; an outsider gets 404 on every route and no list entry", async () => {
    for (const p of SKILL_ROUTES) {
      const r = await h.call("GET", p, { token: alice });
      expect(r.status, `creator ${p}`).toBe(200);
    }
    expect(await names(alice)).toEqual(["secret"]);

    for (const p of SKILL_ROUTES) {
      const r = await h.call("GET", p, { token: bob });
      expect(r.status, `outsider ${p}`).toBe(404);
      expect(r.json.error.code).toBe("not_found");
    }
    expect(await names(bob)).toEqual([]);
    // the same 404 as a skill that never existed
    expect((await h.call("GET", "/api/skills/never", { token: bob })).json.error.code).toBe("not_found");

    // mutations also 404 for the outsider
    expect((await h.publish(bob, "secret", "2.0.0", simple("secret"))).status).toBe(404);
    expect((await h.call("PATCH", "/api/skills/secret", { token: bob, body: { tags: ["x"] } })).status).toBe(404);
    expect(
      (await h.call("POST", "/api/skills/secret/versions/1.0.0/yank", { token: bob, body: { reason: "x" } })).status,
    ).toBe(404);
    expect((await h.call("PUT", "/api/skills/secret/grants", { token: bob, body: [] })).status).toBe(404);

    // admins read it; the private skill does not inflate the outsider's audit view
    expect((await h.call("GET", "/api/skills/secret", { token: h.adminToken })).status).toBe(200);
    expect((await h.call("GET", "/api/audit", { token: bob })).json).toEqual([]);
    expect((await h.call("GET", "/api/audit", { token: alice })).json.length).toBe(2);
  });

  it("a team read grant makes it readable but not publishable; a write grant allows publish", async () => {
    expect((await h.call("GET", "/api/skills/secret", { token: carol })).status).toBe(404);
    const g = await h.call("PUT", "/api/skills/secret/grants", {
      token: alice,
      body: [{ principalType: "team", principal: "sec", permission: "read" }],
    });
    expect(g.status).toBe(200);
    expect(g.json).toEqual([{ principalType: "team", principal: "sec", permission: "read" }]);

    const d = await h.call("GET", "/api/skills/secret", { token: carol });
    expect(d.status).toBe(200);
    expect(d.json.permissions).toEqual({ canWrite: false, canAdmin: false });
    expect(d.json.grants).toBeNull();
    expect(await names(carol)).toEqual(["secret"]);
    expect((await h.call("GET", "/api/skills/secret/versions/1.1.0/bundle", { token: carol })).status).toBe(200);

    const denied = await h.publish(carol, "secret", "1.2.0", simple("secret"));
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe("forbidden");
    expect((await h.call("GET", "/api/skills/secret/grants", { token: carol })).status).toBe(403);
    expect(
      (await h.call("POST", "/api/skills/secret/versions/1.0.0/yank", { token: carol, body: {} })).status,
    ).toBe(403);

    await h.call("PUT", "/api/skills/secret/grants", {
      token: alice,
      body: [{ principalType: "team", principal: "sec", permission: "write" }],
    });
    const allowed = await h.publish(carol, "secret", "1.2.0", simple("secret"));
    expect(allowed.status).toBe(201);
    expect(allowed.json.publishedBy).toBe("carol");
    // write is not admin: carol cannot change visibility or grants
    expect((await h.call("PATCH", "/api/skills/secret", { token: carol, body: { visibility: "org" } })).status).toBe(403);
    expect((await h.call("PUT", "/api/skills/secret/grants", { token: carol, body: [] })).status).toBe(403);
    expect((await h.call("PATCH", "/api/skills/secret", { token: carol, body: { tags: ["hush"] } })).status).toBe(200);
  });

  it("a user grant works and unknown principals are 400", async () => {
    const g = await h.call("PUT", "/api/skills/secret/grants", {
      token: alice,
      body: [{ principalType: "user", principal: "bob", permission: "read" }],
    });
    expect(g.status).toBe(200);
    expect((await h.call("GET", "/api/skills/secret", { token: bob })).status).toBe(200);
    const bad = await h.call("PUT", "/api/skills/secret/grants", {
      token: alice,
      body: [{ principalType: "team", principal: "ghosts", permission: "read" }],
    });
    expect(bad.status).toBe(400);
    // the failed PUT left the earlier grant in place
    expect((await h.call("GET", "/api/skills/secret", { token: bob })).status).toBe(200);
  });

  it("owning-team members read and write; a maintainer administers; plain member does not", async () => {
    const moved = await h.call("PATCH", "/api/skills/secret", { token: alice, body: { team: "ops" } });
    expect(moved.status).toBe(200);
    expect(moved.json.team).toBe("ops");
    const asBob = await h.call("GET", "/api/skills/secret", { token: bob });
    expect(asBob.status).toBe(200);
    expect(asBob.json.permissions).toEqual({ canWrite: true, canAdmin: false });
    expect((await h.call("PATCH", "/api/skills/secret", { token: bob, body: { visibility: "org" } })).status).toBe(403);
    await h.call("PUT", "/api/teams/ops/members/bob", { token: h.adminToken, body: { role: "maintainer" } });
    const nowAdmin = await h.call("PATCH", "/api/skills/secret", { token: bob, body: { visibility: "org" } });
    expect(nowAdmin.status).toBe(200);
    expect(nowAdmin.json.visibility).toBe("org");
    expect(await names(carol)).toEqual(["secret"]);
  });

  it("only admins delete skills", async () => {
    expect((await h.call("DELETE", "/api/skills/secret", { token: alice })).status).toBe(403);
    expect((await h.call("DELETE", "/api/skills/secret", { token: h.adminToken })).status).toBe(204);
    expect((await h.call("GET", "/api/skills/secret", { token: alice })).status).toBe(404);
    const audit = await h.call("GET", "/api/audit?target=secret", { token: h.adminToken });
    expect(audit.json[0].action).toBe("skill.delete");
  });

  it("team skillCount counts only skills the caller can read", async () => {
    await h.call("PATCH", "/api/skills/secret", { token: alice, body: { team: "sec" } });
    const asCarol = await h.call("GET", "/api/teams/sec", { token: carol });
    expect(asCarol.json.skillCount).toBe(1);
    const asBob = await h.call("GET", "/api/teams/sec", { token: bob });
    expect(asBob.json.skillCount).toBe(0);
  });
});
