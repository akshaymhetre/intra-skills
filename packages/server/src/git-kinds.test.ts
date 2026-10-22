// Plugins and rules through git sources: each kind under its own root, proposals written to the
// root of their kind, and folders whose marker does not match their root skipped with a reason.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeGitHost } from "./git/fake.js";
import { Harness, bundle, skillMd } from "./test/harness.js";
import { userIdByHandle } from "./model.js";

let host: FakeGitHost;
let h: Harness;
let alice: string;

const CRED = { kind: "token", token: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" };

function link(handle: string, username: string): void {
  h.db.prepare("INSERT INTO git_identities (user_id, provider, username) VALUES (?, 'github', ?)").run(userIdByHandle(h.db, handle), username);
}

function manifest(name: string, version: string): string {
  return JSON.stringify({ name, description: `The ${name} plugin adds a hello command.`, version });
}

function pluginFiles(name: string, version: string) {
  return bundle({ ".claude-plugin/plugin.json": manifest(name, version), "commands/hello.md": "Say hello.\n" });
}

function ruleMd(name: string, version: string): string {
  return `---\nname: ${name}\ndescription: Keep every TypeScript file in this project strict and readonly by default.\nalwaysApply: true\nmetadata:\n  version: "${version}"\n---\nPrefer readonly arrays.\n`;
}

async function createSource(extra: Record<string, unknown> = {}) {
  const r = await h.call("POST", "/api/sources", {
    token: h.adminToken,
    body: { provider: "github", repo: "acme/skills", credential: CRED, ...extra },
  });
  expect(r.status, r.text).toBe(201);
  return r.json as { id: string; root: string; pluginsRoot: string; rulesRoot: string };
}

const sync = (id: string) => h.call("POST", `/api/sources/${id}/sync`, { token: h.adminToken });
const propose = (name: string, version: string, files: unknown) =>
  h.call("POST", `/api/skills/${name}/proposals`, { token: alice, body: { version, files, changelog: "first" } });

beforeEach(async () => {
  host = new FakeGitHost();
  h = new Harness({ providerFactory: host.factory });
  alice = await h.user("alice");
  await h.user("bob");
  link("alice", "alice-gh");
  link("bob", "bob-gh");
});
afterEach(() => h.close());

describe("source roots per kind", () => {
  it("defaults to plugins and rules, and PATCH changes them", async () => {
    const src = await createSource();
    expect(src).toMatchObject({ root: "skills", pluginsRoot: "plugins", rulesRoot: "rules" });
    const p = await h.call("PATCH", `/api/sources/${src.id}`, { token: h.adminToken, body: { pluginsRoot: "/claude/plugins/", rulesRoot: "guides" } });
    expect(p.status, p.text).toBe(200);
    expect(p.json).toMatchObject({ pluginsRoot: "claude/plugins", rulesRoot: "guides" });
  });

  it("refuses an unsafe root, a root shared by two kinds, and a root inside another", async () => {
    const bad = async (body: Record<string, unknown>) =>
      (await h.call("POST", "/api/sources", { token: h.adminToken, body: { provider: "github", repo: "acme/x", credential: CRED, ...body } })).status;
    expect(await bad({ pluginsRoot: "../up" })).toBe(400);
    expect(await bad({ rulesRoot: 5 })).toBe(400);
    expect(await bad({ pluginsRoot: "skills" })).toBe(400);
    expect(await bad({ rulesRoot: "plugins" })).toBe(400);
    expect(await bad({ pluginsRoot: "skills/plugins" })).toBe(400);
    const src = await createSource();
    const clash = await h.call("PATCH", `/api/sources/${src.id}`, { token: h.adminToken, body: { root: "rules" } });
    expect(clash.status).toBe(400);
    expect(clash.json.error.message).toContain("separate folders");
  });
});

describe("proposals per kind", () => {
  it("a plugin proposal lands under plugins/<name>/ and publishes after an approved merge", async () => {
    const src = await createSource();
    const p = await propose("greeter", "1.0.0", pluginFiles("greeter", "1.0.0"));
    expect(p.status, p.text).toBe(201);
    expect(p.json).toMatchObject({ skill: "greeter", packageKind: "plugin", kind: "new", status: "open" });
    const pr = host.pr(1);
    expect(pr.title).toBe("New plugin: greeter 1.0.0");
    expect(pr.body).toContain("- Plugin: `greeter` (new plugin)");
    expect(host.text("intra/greeter-1.0.0", "plugins/greeter/.claude-plugin/plugin.json")).toContain('"name":"greeter"');
    expect(host.text("intra/greeter-1.0.0", "skills/greeter/.claude-plugin/plugin.json")).toBeNull();
    expect(h.db.prepare("SELECT package_kind FROM proposals WHERE id = ?").get(p.json.id)).toEqual({ package_kind: "plugin" });

    host.approve(1, "bob-gh");
    host.merge(1);
    const s = await sync(src.id);
    expect(s.json.ok, s.text).toBe(true);
    expect(s.json.ingested).toEqual(["greeter@1.0.0"]);
    const d = await h.call("GET", "/api/skills/greeter", { token: alice });
    expect(d.json).toMatchObject({ kind: "plugin", source: { path: "plugins/greeter" } });
    expect((await h.call("GET", `/api/proposals/${p.json.id}`, { token: alice })).json.status).toBe("published");

    // An update lands in the same folder and is titled without "New".
    const u = await propose("greeter", "1.1.0", pluginFiles("greeter", "1.1.0"));
    expect(u.status, u.text).toBe(201);
    expect(host.pr(2).title).toBe("greeter 1.1.0");
    expect(host.text("intra/greeter-1.1.0", "plugins/greeter/.claude-plugin/plugin.json")).toContain('"version":"1.1.0"');
  });

  it("a rule proposal lands under rules/<name>/RULE.md and publishes", async () => {
    const src = await createSource();
    const p = await propose("strict-ts", "1.0.0", bundle({ "RULE.md": ruleMd("strict-ts", "1.0.0") }));
    expect(p.status, p.text).toBe(201);
    expect(p.json.packageKind).toBe("rule");
    expect(host.pr(1).title).toBe("New rule: strict-ts 1.0.0");
    expect(host.text("intra/strict-ts-1.0.0", "rules/strict-ts/RULE.md")).toContain("Prefer readonly arrays.");
    host.approve(1, "bob-gh");
    host.merge(1);
    const s = await sync(src.id);
    expect(s.json.ingested).toEqual(["strict-ts@1.0.0"]);
    const v = await h.call("GET", "/api/skills/strict-ts/versions/1.0.0", { token: alice });
    expect(v.json.rule).toEqual({ globs: [], alwaysApply: true, mode: "always" });
  });

  it("a skill proposal still says New skill and lands under skills/", async () => {
    await createSource();
    const p = await propose("deploy-check", "1.0.0", bundle({ "SKILL.md": skillMd("deploy-check", { meta: { version: "1.0.0" } }) }));
    expect(p.status, p.text).toBe(201);
    expect(p.json.packageKind).toBe("skill");
    expect(host.pr(1).title).toBe("New skill: deploy-check 1.0.0");
  });

  it("refuses a proposal that changes a package's kind (409) and a plugin without its version", async () => {
    await createSource({ minApprovals: 0 });
    const p = await propose("greeter", "1.0.0", pluginFiles("greeter", "1.0.0"));
    host.merge(p.json.pullRequest.number);
    const src = (await h.call("GET", "/api/sources", { token: h.adminToken })).json[0];
    expect((await sync(src.id)).json.ingested).toEqual(["greeter@1.0.0"]);
    const r = await propose("greeter", "2.0.0", bundle({ "RULE.md": ruleMd("greeter", "2.0.0") }));
    expect(r.status).toBe(409);
    const nov = await propose(
      "unversioned",
      "1.0.0",
      bundle({ ".claude-plugin/plugin.json": JSON.stringify({ name: "unversioned", description: "A plugin with no version field at all." }), "commands/a.md": "A.\n" }),
    );
    expect(nov.status).toBe(422);
    expect(nov.json.error.details[0].field).toBe("plugin.json version");
  });
});

describe("sync discovery per kind", () => {
  it("reads each kind under its own root and skips a folder whose marker belongs to another kind", async () => {
    const src = await createSource({ minApprovals: 0 });
    host.push("feat", {
      "plugins/hand-plugin/.claude-plugin/plugin.json": manifest("hand-plugin", "1.0.0"),
      "plugins/hand-plugin/commands/hi.md": "Hi.\n",
      // A plugin's own skills are part of the plugin, not packages of their own.
      "plugins/hand-plugin/skills/inner/SKILL.md": skillMd("inner", { meta: { version: "1.0.0" } }),
      "plugins/lost-skill/SKILL.md": skillMd("lost-skill", { meta: { version: "1.0.0" } }),
      "skills/lost-plugin/.claude-plugin/plugin.json": manifest("lost-plugin", "1.0.0"),
      "skills/lost-plugin/commands/hi.md": "Hi.\n",
      "skills/real/SKILL.md": skillMd("real", { meta: { version: "1.0.0" } }),
      "rules/team/hand-rule/RULE.md": ruleMd("hand-rule", "1.0.0"),
      "rules/lost/SKILL.md": skillMd("lost", { meta: { version: "1.0.0" } }),
      // Deeper than exactly <pluginsRoot>/<name>/: not a plugin folder.
      "plugins/group/deep/.claude-plugin/plugin.json": manifest("deep", "1.0.0"),
    });
    host.merge(host.openPr({ head: "feat", author: "bob-gh" }));
    const s = await sync(src.id);
    expect(s.json.ok, s.text).toBe(true);
    expect([...s.json.ingested].sort()).toEqual(["hand-plugin@1.0.0", "hand-rule@1.0.0", "real@1.0.0"]);
    expect(s.json.skipped).toContainEqual({
      path: "plugins/lost-skill",
      reason: "has SKILL.md, which makes it a skill, but plugins/ holds plugins; move it under skills/ (the source's root)",
    });
    expect(s.json.skipped).toContainEqual({
      path: "skills/lost-plugin",
      reason: "has .claude-plugin/plugin.json, which makes it a plugin, but skills/ holds skills; move it under plugins/ (the source's pluginsRoot)",
    });
    expect(s.json.skipped).toContainEqual({
      path: "rules/lost",
      reason: "has SKILL.md, which makes it a skill, but rules/ holds rules; move it under skills/ (the source's root)",
    });
    const paths = (s.json.skipped as { path: string }[]).map((x) => x.path);
    expect(paths).not.toContain("plugins/hand-plugin/skills/inner");
    expect(paths).not.toContain("plugins/group/deep");
    expect((await h.call("GET", "/api/skills/inner", { token: alice })).status).toBe(404);
    expect((await h.call("GET", "/api/skills/hand-plugin", { token: alice })).json).toMatchObject({ kind: "plugin", source: { path: "plugins/hand-plugin" } });
    expect((await h.call("GET", "/api/skills/hand-rule", { token: alice })).json).toMatchObject({ kind: "rule", source: { path: "rules/team/hand-rule" } });
  });

  it("a plugin without a version in plugin.json is skipped with a reason", async () => {
    const src = await createSource({ minApprovals: 0 });
    host.push("feat", {
      "plugins/nov/.claude-plugin/plugin.json": JSON.stringify({ name: "nov", description: "No version here at all." }),
      "plugins/nov/commands/hi.md": "Hi.\n",
    });
    host.merge(host.openPr({ head: "feat", author: "bob-gh" }));
    const s = await sync(src.id);
    expect(s.json.skipped).toContainEqual({ path: "plugins/nov", reason: "no version in .claude-plugin/plugin.json" });
  });
});
