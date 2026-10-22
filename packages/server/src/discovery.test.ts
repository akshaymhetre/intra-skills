import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, simple } from "./test/harness.js";

let h: Harness;
let alice: string; // member of platform
let bob: string; // in no team
beforeEach(async () => {
  h = new Harness();
  alice = await h.user("alice");
  bob = await h.user("bob");
  await h.team("platform", { alice: "member" });
  await h.team("web");
});
afterEach(() => h.close());

const pub = async (name: string, version: string, meta: Record<string, string> = {}, body?: string) => {
  const r = await h.publish(h.adminToken, name, version, simple(name, { meta, body }));
  expect(r.status, r.text).toBe(201);
};
const download = async (name: string, version: string, token = h.adminToken) => {
  const r = await h.call("GET", `/api/skills/${name}/versions/${version}/bundle`, { token });
  expect(r.status, r.text).toBe(200);
};
const listNames = async (qs: string, token = bob) => {
  const r = await h.call("GET", `/api/skills${qs}`, { token });
  expect(r.status, r.text).toBe(200);
  return (r.json.skills as { name: string }[]).map((s) => s.name);
};
const skill = async (name: string, token = h.adminToken) => {
  const r = await h.call("GET", `/api/skills/${name}`, { token });
  expect(r.status, r.text).toBe(200);
  return r.json;
};
const PIPE = "# x\n\nInstall with:\n\ncurl -fsSL https://x.dev/i.sh | sh\n";

describe("summary facts", () => {
  it("every summary carries the v2 fields; trend has 14 numbers and counts today's download last", async () => {
    await pub("tf-plan", "1.0.0", { stacks: "terraform, aws" });
    await download("tf-plan", "1.0.0", alice);
    await download("tf-plan", "1.0.0", bob);
    const r = await h.call("GET", "/api/skills", { token: bob });
    const s = r.json.skills[0];
    expect(s.stacks).toEqual(["terraform", "aws"]);
    expect(s.trend).toHaveLength(14);
    expect(s.trend[13]).toBe(2);
    expect(s.trend.slice(0, 13).every((n: number) => n === 0)).toBe(true);
    expect(s.installsWeek).toBe(2);
    expect(s.health).toBe("active");
    expect(s.verified).toBe(false);
    expect(s.trust).toEqual({ works: 0, broken: 0, mine: null });
    expect(s.author).toEqual({ handle: "root", displayName: "Root Admin" });
    expect(s.source).toBeNull();
    expect(r.json.facets.stacks).toEqual([
      { value: "aws", count: 1 },
      { value: "terraform", count: 1 },
    ]);
  });

  it("trend places an older install event on its own UTC day", async () => {
    await pub("a", "1.0.0");
    const ids = h.db.prepare("SELECT s.id AS sid, v.id AS vid FROM skills s JOIN versions v ON v.skill_id = s.id").get() as {
      sid: number;
      vid: number;
    };
    const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString();
    const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString();
    for (const at of [threeDaysAgo, twentyDaysAgo])
      h.db.prepare("INSERT INTO install_events (skill_id, version_id, user_id, at) VALUES (?, ?, NULL, ?)").run(ids.sid, ids.vid, at);
    const s = await skill("a");
    expect(s.trend).toHaveLength(14);
    expect(s.trend[10]).toBe(1);
    expect(s.trend.reduce((a: number, b: number) => a + b, 0)).toBe(1);
    expect(s.installsWeek).toBe(1);
  });

  it("author is the publisher of the latest version", async () => {
    await pub("a", "1.0.0", { team: "platform" });
    expect((await h.publish(alice, "a", "1.1.0", simple("a", { meta: { team: "platform" } }))).status).toBe(201);
    expect((await skill("a")).author).toEqual({ handle: "alice", displayName: "ALICE" });
  });

  it("health is stale when the latest live version is older than staleDays", async () => {
    await pub("old", "1.0.0");
    await pub("fresh", "1.0.0");
    h.db.prepare("UPDATE versions SET published_at = ? WHERE skill_id = (SELECT id FROM skills WHERE name = 'old')").run(
      "2020-01-01T00:00:00.000Z",
    );
    expect((await skill("old")).health).toBe("stale");
    expect((await skill("fresh")).health).toBe("active");
    expect(await listNames("?health=stale")).toEqual(["old"]);
    expect(await listNames("?health=active")).toEqual(["fresh"]);
    expect((await h.call("GET", "/api/skills?health=bogus", { token: bob })).status).toBe(400);
  });

  it("sort=trending orders by installs this week, then downloads, then name", async () => {
    for (const n of ["a", "b", "c", "d"]) await pub(n, "1.0.0");
    await download("c", "1.0.0");
    await download("c", "1.0.0");
    await download("b", "1.0.0");
    // d: an old download only (counts in downloads, not this week).
    await download("d", "1.0.0");
    h.db.prepare("UPDATE install_events SET at = '2020-01-01T00:00:00.000Z' WHERE skill_id = (SELECT id FROM skills WHERE name = 'd')").run();
    expect(await listNames("?sort=trending")).toEqual(["c", "b", "d", "a"]);
  });

  it("stack= filters with OR and PATCH accepts stacks", async () => {
    await pub("tf", "1.0.0", { stacks: "terraform" });
    await pub("rx", "1.0.0", { stacks: "react" });
    await pub("none", "1.0.0");
    expect(await listNames("?stack=terraform&stack=react&sort=name")).toEqual(["rx", "tf"]);
    const p = await h.call("PATCH", "/api/skills/none", { token: h.adminToken, body: { stacks: ["Go", "go"] } });
    expect(p.status, p.text).toBe(200);
    expect(p.json.stacks).toEqual(["go"]);
    expect(await listNames("?stack=go")).toEqual(["none"]);
    expect((await h.call("PATCH", "/api/skills/none", { token: h.adminToken, body: { stacks: ["bad value"] } })).status).toBe(400);
    expect((await h.call("PATCH", "/api/skills/none", { token: bob, body: { stacks: ["go"] } })).status).toBe(403);
  });
});

describe("verification", () => {
  it("verified holds across a version with no new ask behavior and drops on one that adds it", async () => {
    await pub("v", "1.0.0");
    const r = await h.call("POST", "/api/skills/v/verify", { token: h.adminToken });
    expect(r.status, r.text).toBe(200);
    expect(r.json.verified).toBe(true);
    expect(r.json.verification).toMatchObject({ version: "1.0.0", by: { handle: "root", displayName: "Root Admin" } });
    expect(await listNames("?verified=1")).toEqual(["v"]);

    await pub("v", "1.1.0", {}, "# v\n\nSteps that only read files.\n");
    expect((await skill("v")).verified).toBe(true);

    await pub("v", "1.2.0", {}, PIPE);
    const d = await skill("v");
    expect(d.versions[0].behaviors.some((b: { id: string; tier: string }) => b.tier === "ask")).toBe(true);
    expect(d.verified).toBe(false);
    expect(d.verification.version).toBe("1.0.0");
    expect(await listNames("?verified=1")).toEqual([]);

    // Re-verifying the latest makes it verified again; unverify clears it.
    const again = await h.call("POST", "/api/skills/v/verify", { token: h.adminToken, body: { version: "1.2.0" } });
    expect(again.json.verified).toBe(true);
    const un = await h.call("DELETE", "/api/skills/v/verify", { token: h.adminToken });
    expect(un.status).toBe(200);
    expect(un.json.verified).toBe(false);
    expect(un.json.verification).toBeNull();
    const actions = (h.db.prepare("SELECT action FROM audit WHERE target = 'v' AND action LIKE 'skill.%verify' ORDER BY id").all() as {
      action: string;
    }[]).map((a) => a.action);
    expect(actions).toEqual(["skill.verify", "skill.verify", "skill.unverify"]);
  });

  it("verifying an unknown version is 400", async () => {
    await pub("v", "1.0.0");
    expect((await h.call("POST", "/api/skills/v/verify", { token: h.adminToken, body: { version: "9.9.9" } })).status).toBe(400);
  });

  it("the review queue lists unverified live skills oldest update first, admins only", async () => {
    await pub("one", "1.0.0");
    await pub("two", "1.0.0");
    await pub("three", "1.0.0", { visibility: "private" });
    await h.call("POST", "/api/skills/two/verify", { token: h.adminToken });
    const r = await h.call("GET", "/api/review", { token: h.adminToken });
    expect(r.status).toBe(200);
    expect(r.json.map((s: { name: string }) => s.name)).toEqual(["one", "three"]);
    expect((await h.call("GET", "/api/review", { token: alice })).status).toBe(403);
    expect((await h.call("POST", "/api/skills/one/verify", { token: alice })).status).toBe(403);
    expect((await h.call("DELETE", "/api/skills/two/verify", { token: alice })).status).toBe(403);
  });
});

describe("votes", () => {
  it("a vote replaces the caller's previous one and delete removes it", async () => {
    await pub("s", "1.0.0");
    let r = await h.call("PUT", "/api/skills/s/vote", { token: alice, body: { works: true, note: "fine\non my repo" } });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toEqual({ works: 1, broken: 0, mine: "works" });
    r = await h.call("PUT", "/api/skills/s/vote", { token: bob, body: { works: false } });
    expect(r.json).toEqual({ works: 1, broken: 1, mine: "broken" });
    r = await h.call("PUT", "/api/skills/s/vote", { token: alice, body: { works: false, note: "broke" } });
    expect(r.json).toEqual({ works: 0, broken: 2, mine: "broken" });

    const votes = await h.call("GET", "/api/skills/s/votes", { token: bob });
    expect(votes.status).toBe(200);
    expect(votes.json).toHaveLength(2);
    expect(votes.json[0]).toMatchObject({ user: { handle: "alice" }, works: false, note: "broke", version: "1.0.0" });
    expect((await skill("s", bob)).trust).toEqual({ works: 0, broken: 2, mine: "broken" });

    r = await h.call("DELETE", "/api/skills/s/vote", { token: alice });
    expect(r.json).toEqual({ works: 0, broken: 1, mine: null });
    expect((await h.call("PUT", "/api/skills/s/vote", { token: alice, body: { works: "yes" } })).status).toBe(400);
    expect((await h.call("PUT", "/api/skills/s/vote", { token: alice, body: { works: true, note: "x".repeat(281) } })).status).toBe(400);
  });

  it("a private skill cannot be voted on or have its votes read by a non-reader", async () => {
    await pub("secret", "1.0.0", { team: "platform", visibility: "private" });
    expect((await h.call("PUT", "/api/skills/secret/vote", { token: bob, body: { works: true } })).status).toBe(404);
    expect((await h.call("GET", "/api/skills/secret/votes", { token: bob })).status).toBe(404);
    expect((await h.call("PUT", "/api/skills/secret/vote", { token: alice, body: { works: true } })).status).toBe(200);
  });
});

describe("collections", () => {
  beforeEach(async () => {
    await pub("open-a", "1.0.0");
    await pub("open-b", "1.0.0");
    await pub("secret", "1.0.0", { team: "platform", visibility: "private" });
  });

  it("a team member creates, reads, replaces and deletes a collection", async () => {
    const put = await h.call("PUT", "/api/collections/platform/starter", {
      token: alice,
      body: { title: "Starter", description: "first day", skills: ["open-b", "secret", "open-b", "open-a"] },
    });
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject({ team: "platform", slug: "starter", title: "Starter", createdBy: "alice" });
    expect(put.json.skills).toEqual(["open-b", "secret", "open-a"]);

    // A non-member reads it without the private skill.
    const got = await h.call("GET", "/api/collections/platform/starter", { token: bob });
    expect(got.status).toBe(200);
    expect(got.json.skills).toEqual(["open-b", "open-a"]);
    const list = await h.call("GET", "/api/collections?team=platform", { token: bob });
    expect(list.json).toHaveLength(1);
    expect(list.json[0].skills).toEqual(["open-b", "open-a"]);
    expect((await h.call("GET", "/api/collections?team=web", { token: bob })).json).toEqual([]);

    const rep = await h.call("PUT", "/api/collections/platform/starter", { token: h.adminToken, body: { title: "Two", skills: ["open-a"] } });
    expect(rep.status).toBe(200);
    expect(rep.json).toMatchObject({ title: "Two", skills: ["open-a"], createdBy: "alice" });

    expect((await h.call("DELETE", "/api/collections/platform/starter", { token: bob })).status).toBe(403);
    expect((await h.call("DELETE", "/api/collections/platform/starter", { token: alice })).status).toBe(204);
    expect((await h.call("GET", "/api/collections/platform/starter", { token: alice })).status).toBe(404);
    const actions = (h.db.prepare("SELECT action FROM audit WHERE kind = 'collection' ORDER BY id").all() as { action: string }[]).map(
      (a) => a.action,
    );
    expect(actions).toEqual(["collection.put", "collection.put", "collection.delete"]);
  });

  it("refuses an unreadable or missing skill, a non-member, a bad slug and too many skills", async () => {
    const bad = await h.call("PUT", "/api/collections/web/x", { token: h.adminToken, body: { title: "x", skills: ["nope"] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toContain("nope");
    // bob joins web, so he may edit web collections, but cannot list platform's private skill.
    await h.call("PUT", "/api/teams/web/members/bob", { token: h.adminToken, body: { role: "member" } });
    const priv = await h.call("PUT", "/api/collections/web/x", { token: bob, body: { title: "x", skills: ["open-a", "secret"] } });
    expect(priv.status).toBe(400);
    expect(priv.json.error.message).toContain("secret");
    expect((await h.call("PUT", "/api/collections/platform/x", { token: bob, body: { title: "x", skills: [] } })).status).toBe(403);
    expect((await h.call("PUT", "/api/collections/web/Bad_Slug", { token: bob, body: { title: "x", skills: [] } })).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `s${i}`);
    expect((await h.call("PUT", "/api/collections/web/x", { token: bob, body: { title: "x", skills: many } })).status).toBe(400);
  });
});

describe("home", () => {
  it("returns the caller's team skills, trending, recent, stacks and totals without private leaks", async () => {
    await pub("plat-owned", "1.0.0", { team: "platform", stacks: "terraform" });
    await pub("granted", "1.0.0", { team: "web" });
    await pub("other", "1.0.0", { stacks: "react" });
    await pub("secret", "1.0.0", { team: "web", visibility: "private", stacks: "go" });
    const g = await h.call("PUT", "/api/skills/granted/grants", {
      token: h.adminToken,
      body: [{ principalType: "team", principal: "platform", permission: "read" }],
    });
    expect(g.status, g.text).toBe(200);
    await download("other", "1.0.0");
    await download("secret", "1.0.0");
    await h.call("PUT", "/api/collections/platform/kit", { token: alice, body: { title: "Kit", skills: ["plat-owned"] } });

    const r = await h.call("GET", "/api/home", { token: alice });
    expect(r.status, r.text).toBe(200);
    const home = r.json;
    expect(home.teams).toEqual([{ slug: "platform", name: "PLATFORM" }]);
    expect(home.teamSkills.map((s: { name: string }) => s.name).sort()).toEqual(["granted", "plat-owned"]);
    expect(home.trending[0].name).toBe("other");
    const names = (l: { name: string }[]) => l.map((s) => s.name);
    expect(names(home.trending)).not.toContain("secret");
    expect(names(home.recent)).not.toContain("secret");
    expect(home.recent).toHaveLength(3);
    expect(home.stacks).toEqual([
      { value: "react", count: 1 },
      { value: "terraform", count: 1 },
    ]);
    expect(home.collections.map((c: { slug: string }) => c.slug)).toEqual(["kit"]);
    expect(home.proposals).toEqual({ open: 0, mine: [] });
    expect(home.reviewQueue).toBe(0);
    // The private skill's download does not show in the week total.
    expect(home.totals).toEqual({ skills: 3, teams: 2, installsWeek: 1, kinds: { skill: 3, plugin: 0, rule: 0 } });

    const admin = (await h.call("GET", "/api/home", { token: h.adminToken })).json;
    expect(admin.reviewQueue).toBe(4);
    expect(admin.totals.installsWeek).toBe(2);
    expect(admin.teamSkills).toEqual([]);

    // bob is in no team and has no grants.
    const bobHome = (await h.call("GET", "/api/home", { token: bob })).json;
    expect(bobHome.teamSkills).toEqual([]);
    expect(bobHome.teams).toEqual([]);
  });
});

describe("suggest", () => {
  const tfRepo = { files: ["infra/main.tf", "infra/vars.tf", "README.md"], packages: [] };

  it("ranks a terraform skill for a repo with two .tf files", async () => {
    await pub("tf-plan", "1.0.0", { stacks: "terraform, aws", team: "platform" });
    await pub("tf-tagged", "1.0.0", { tags: "terraform" });
    await pub("react-review", "1.0.0", { stacks: "react" });
    await pub("tf-old", "1.0.0", { stacks: "terraform" });
    await h.call("PATCH", "/api/skills/tf-old", { token: h.adminToken, body: { deprecated: "use tf-plan" } });
    await pub("tf-secret", "1.0.0", { stacks: "terraform", team: "web", visibility: "private" });
    await h.call("POST", "/api/skills/tf-plan/verify", { token: h.adminToken });

    const r = await h.call("POST", "/api/suggest", { token: alice, body: tfRepo });
    expect(r.status, r.text).toBe(200);
    expect(r.json.stacks).toEqual(["terraform"]);
    expect(r.json.skills.map((x: { skill: { name: string } }) => x.skill.name)).toEqual(["tf-plan", "tf-tagged"]);
    const top = r.json.skills[0];
    expect(top.score).toBe(3 + 2 + 1);
    expect(top.reasons).toEqual(["matches terraform", "owned by your team platform", "verified"]);
    expect(r.json.skills[1]).toMatchObject({ score: 1, reasons: ["matches terraform"] });

    // The admin can read the private one; bob cannot.
    const admin = await h.call("POST", "/api/suggest", { token: h.adminToken, body: tfRepo });
    expect(admin.json.skills.map((x: { skill: { name: string } }) => x.skill.name)).toContain("tf-secret");
  });

  it("returns nothing for a repo with no matching stack, and validates the body", async () => {
    await pub("tf-plan", "1.0.0", { stacks: "terraform" });
    const r = await h.call("POST", "/api/suggest", { token: bob, body: { files: ["README.md", "notes.txt"], packages: [] } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ stacks: [], skills: [] });
    expect((await h.call("POST", "/api/suggest", { token: bob, body: { files: "main.tf", packages: [] } })).status).toBe(400);
    expect((await h.call("POST", "/api/suggest", { token: bob, body: { files: [1], packages: [] } })).status).toBe(400);
    expect((await h.call("POST", "/api/suggest", { token: bob, body: { files: ["x".repeat(501)], packages: [] } })).status).toBe(400);
    const tooMany = Array.from({ length: 5001 }, (_, i) => `f${i}.tf`);
    expect((await h.call("POST", "/api/suggest", { token: bob, body: { files: tooMany, packages: [] } })).status).toBe(400);
    const pkgs = Array.from({ length: 2001 }, (_, i) => `p${i}`);
    expect((await h.call("POST", "/api/suggest", { token: bob, body: { files: [], packages: pkgs } })).status).toBe(400);
  });
});

describe("private skills never leak through counts", () => {
  it("list facets and totals exclude a private skill for a non-reader", async () => {
    await pub("open", "1.0.0", { stacks: "go" });
    await pub("secret", "1.0.0", { team: "platform", visibility: "private", stacks: "go" });
    const r = await h.call("GET", "/api/skills?stack=go", { token: bob });
    expect(r.json.total).toBe(1);
    expect(r.json.facets.stacks).toEqual([{ value: "go", count: 1 }]);
    expect((await h.call("GET", "/api/review", { token: h.adminToken })).json).toHaveLength(2);
  });
});
