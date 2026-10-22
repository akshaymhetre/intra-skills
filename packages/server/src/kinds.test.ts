// Package kinds through HTTP: direct publish of plugins and rules, the kind filter, marketplace keys,
// the Claude Code marketplace and its deterministic plugin archives, and the MCP and agent documents.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@intra-skills/shared";
import { Harness, bundle, simple } from "./test/harness.js";
import { marketplaceSlug, putSettings } from "./settings.js";
import { buildZip } from "./zip.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => h.close());

function pluginFiles(name: string, version: string, o: { team?: string; visibility?: string; keywords?: string[] } = {}) {
  const manifest = {
    name,
    description: `The ${name} plugin adds a hello command for the ${name} work.`,
    version,
    keywords: o.keywords ?? ["greeting"],
    metadata: { ...(o.team ? { team: o.team } : {}), ...(o.visibility ? { visibility: o.visibility } : {}), stacks: ["node"] },
  };
  return bundle(
    {
      ".claude-plugin/plugin.json": JSON.stringify(manifest, null, 2),
      "commands/hello.md": "---\ndescription: Say hello\n---\nSay hello to the user.\n",
      "hooks/hooks.json": JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "./bin/fmt" }] }] } }),
      "bin/fmt": "#!/bin/sh\necho formatted\n",
      "README.md": `# ${name}\n\nA plugin.\n`,
    },
    { "bin/fmt": 0o755 },
  );
}

function ruleFiles(name: string, version: string, extra = "globs: \"src/**/*.ts\"\n") {
  return bundle({
    "RULE.md": `---\nname: ${name}\ndescription: Use strict TypeScript conventions for every file under src in this project.\n${extra}metadata:\n  version: "${version}"\n---\n# ${name}\n\nPrefer readonly arrays.\n`,
  });
}

const key = async (token: string, body?: unknown) =>
  h.call("POST", "/api/tokens/marketplace", { token, ...(body === undefined ? {} : { body }) });

/** A minimal ZIP reader over the central directory, so the test does not trust the writer. */
function readZip(buf: Buffer): { path: string; mode: number; data: Buffer; versionMadeBy: number }[] {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  const cdSize = buf.readUInt32LE(end + 12);
  let p = buf.readUInt32LE(end + 16);
  expect(p + cdSize).toBe(end);
  const out = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const versionMadeBy = buf.readUInt16LE(p + 4);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38);
    const off = buf.readUInt32LE(p + 42);
    const path = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    expect([method, time, date, elen, clen]).toEqual([8, 0, 0x21, 0, 0]);
    expect(buf.readUInt32LE(off)).toBe(0x04034b50);
    const lnlen = buf.readUInt16LE(off + 26);
    expect(buf.readUInt16LE(off + 28)).toBe(0); // no extra field in the local header either
    const data = inflateRawSync(buf.subarray(off + 30 + lnlen, off + 30 + lnlen + csize));
    expect(data.length).toBe(usize);
    expect(crc32(data) >>> 0).toBe(crc);
    out.push({ path, mode: (ext >>> 16) & 0o7777, data, versionMadeBy });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

describe("publishing each kind directly", () => {
  it("publishes a plugin with its components and structural behaviors", async () => {
    const r = await h.publish(h.adminToken, "greeter", "1.0.0", pluginFiles("greeter", "1.0.0"));
    expect(r.status, r.text).toBe(201);
    expect(r.json.plugin).toMatchObject({ commands: ["hello"], hooks: ["PostToolUse"], bin: ["fmt"] });
    const ids = (r.json.behaviors as { id: string; tier: string }[]).map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(["plugin-hooks", "plugin-bin"]));
    // bin/ files are covered by plugin-bin and not listed again one by one as scripts.
    expect((r.json.behaviors as { id: string; file: string }[]).filter((b) => b.id === "script" && b.file.startsWith("bin/"))).toEqual([]);
    const d = await h.call("GET", "/api/skills/greeter", { token: h.adminToken });
    expect(d.json).toMatchObject({ kind: "plugin", tools: ["claude"], stacks: ["node"] });
    expect(d.json.tags).toContain("greeting");
  });

  it("publishes a rule with its RuleSpec", async () => {
    const r = await h.publish(h.adminToken, "strict-ts", "1.0.0", ruleFiles("strict-ts", "1.0.0"));
    expect(r.status, r.text).toBe(201);
    expect(r.json.rule).toEqual({ globs: ["src/**/*.ts"], alwaysApply: false, mode: "globs" });
    expect(r.json.plugin).toBeNull();
    const d = await h.call("GET", "/api/skills/strict-ts", { token: h.adminToken });
    expect(d.json.kind).toBe("rule");
  });

  it("refuses a version that changes the kind (409) and a folder with two markers (422)", async () => {
    expect((await h.publish(h.adminToken, "shape", "1.0.0", simple("shape"))).status).toBe(201);
    const r = await h.publish(h.adminToken, "shape", "2.0.0", pluginFiles("shape", "2.0.0"));
    expect(r.status).toBe(409);
    expect(r.json.error.message).toContain("is a skill");
    const both = [...pluginFiles("dual", "1.0.0"), ...ruleFiles("dual", "1.0.0")];
    expect((await h.publish(h.adminToken, "dual", "1.0.0", both)).status).toBe(422);
  });
});

describe("kind filter", () => {
  beforeEach(async () => {
    expect((await h.publish(h.adminToken, "a-skill", "1.0.0", simple("a-skill"))).status).toBe(201);
    expect((await h.publish(h.adminToken, "a-plugin", "1.0.0", pluginFiles("a-plugin", "1.0.0"))).status).toBe(201);
    expect((await h.publish(h.adminToken, "a-rule", "1.0.0", ruleFiles("a-rule", "1.0.0"))).status).toBe(201);
  });

  it("filters by one or more kinds; every summary carries kind; facets count kinds", async () => {
    const all = await h.call("GET", "/api/skills?sort=name", { token: h.adminToken });
    expect(all.json.skills.map((s: { name: string; kind: string }) => `${s.name}:${s.kind}`)).toEqual([
      "a-plugin:plugin",
      "a-rule:rule",
      "a-skill:skill",
    ]);
    const plugins = await h.call("GET", "/api/skills?kind=plugin", { token: h.adminToken });
    expect(plugins.json.skills.map((s: { name: string }) => s.name)).toEqual(["a-plugin"]);
    // Facets for kind ignore the kind filter itself, so the other kinds stay selectable.
    expect(plugins.json.facets.kinds).toEqual(
      expect.arrayContaining([
        { value: "plugin", count: 1 },
        { value: "rule", count: 1 },
        { value: "skill", count: 1 },
      ]),
    );
    const two = await h.call("GET", "/api/skills?kind=rule&kind=skill&sort=name", { token: h.adminToken });
    expect(two.json.skills.map((s: { name: string }) => s.name)).toEqual(["a-rule", "a-skill"]);
  });

  it("an unknown kind is 400", async () => {
    const r = await h.call("GET", "/api/skills?kind=widget", { token: h.adminToken });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain("skill, plugin, rule");
  });
});

describe("marketplace keys", () => {
  it("creates a key with the default name; it appears in /api/tokens and reads only the marketplace", async () => {
    const r = await key(h.adminToken);
    expect(r.status, r.text).toBe(201);
    expect(r.json.meta.name).toBe("Claude Code plugins");
    expect(r.json.marketplaceName).toBe("intra-skills");
    expect(r.json.marketplaceUrl).toBe(`http://localhost/marketplace.json?key=${r.json.token}`);
    const named = await key(h.adminToken, { name: "laptop" });
    expect(named.json.meta.name).toBe("laptop");
    const list = await h.call("GET", "/api/tokens", { token: h.adminToken });
    expect(list.json.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining([r.json.meta.id, named.json.meta.id]));

    const refused = await h.call("GET", "/api/skills", { token: r.json.token });
    expect(refused.status).toBe(401);
    expect(refused.json.error.message).toBe("this key only reads the plugin marketplace");
    // Nor by cookie, nor to sign in, nor to mint more keys.
    expect((await h.call("GET", "/api/me", { cookie: `isk_session=${r.json.token}` })).status).toBe(401);
    const login = await h.call("POST", "/api/auth/login", { body: { token: r.json.token } });
    expect(login.status).toBe(401);
    expect(login.json.error.message).toBe("this key only reads the plugin marketplace");
    expect((await key(r.json.token)).status).toBe(401);
    expect((await h.call("POST", "/api/tokens", { token: r.json.token, body: { name: "x" } })).status).toBe(401);
    expect((await h.call("POST", "/api/mcp", { token: r.json.token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status).toBe(401);

    expect((await h.call("GET", r.json.marketplaceUrl.replace("http://localhost", ""))).status).toBe(200);
  });

  it("an over-long name is 400", async () => {
    expect((await key(h.adminToken, { name: "x".repeat(101) })).status).toBe(400);
  });
});

describe("Claude Code marketplace", () => {
  let mk: string;
  beforeEach(async () => {
    await h.team("platform");
    expect((await h.publish(h.adminToken, "greeter", "1.0.0", pluginFiles("greeter", "1.0.0", { team: "platform" }))).status).toBe(201);
    expect((await h.publish(h.adminToken, "greeter", "1.1.0", pluginFiles("greeter", "1.1.0", { team: "platform" }))).status).toBe(201);
    expect((await h.publish(h.adminToken, "secret-plugin", "1.0.0", pluginFiles("secret-plugin", "1.0.0", { visibility: "private" }))).status).toBe(201);
    expect((await h.publish(h.adminToken, "old-plugin", "1.0.0", pluginFiles("old-plugin", "1.0.0"))).status).toBe(201);
    expect((await h.call("PATCH", "/api/skills/old-plugin", { token: h.adminToken, body: { deprecated: "use greeter" } })).status).toBe(200);
    expect((await h.publish(h.adminToken, "a-skill", "1.0.0", simple("a-skill"))).status).toBe(201);
    expect((await h.publish(h.adminToken, "a-rule", "1.0.0", ruleFiles("a-rule", "1.0.0"))).status).toBe(201);
    mk = (await key(h.adminToken)).json.token;
  });

  it("lists readable, live, non-deprecated plugins with the archive URL and the sha256 of its bytes", async () => {
    const r = await h.call("GET", `/marketplace.json?key=${mk}`);
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json).toMatchObject({ name: "intra-skills", owner: { name: "intra-skills" } });
    expect(r.json.plugins.map((p: { name: string }) => p.name)).toEqual(["greeter", "secret-plugin"]);
    const g = r.json.plugins[0];
    expect(g).toMatchObject({ name: "greeter", version: "1.1.0", category: "platform", keywords: ["greeting"], source: { source: "archive" } });
    expect(g.tags).toContain("greeting");
    expect(g.source.url).toBe(`http://localhost/api/plugins/greeter/1.1.0.zip?key=${mk}`);
    const zip = await h.app.request(g.source.url.replace("http://localhost", ""));
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-type")).toBe("application/zip");
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(sha256Hex(bytes)).toBe(g.source.sha256);
    const stored = h.db.prepare("SELECT archive_sha256 FROM versions WHERE version = '1.1.0'").get() as { archive_sha256: string };
    expect(stored.archive_sha256).toBe(g.source.sha256);

    // A Bearer header works too, and so does a full token.
    expect((await h.call("GET", "/marketplace.json", { token: mk })).status).toBe(200);
    expect((await h.call("GET", `/marketplace.json?key=${h.adminToken}`)).status).toBe(200);
  });

  it("the archive puts the plugin root at the top, keeps modes, and is byte-identical across builds", async () => {
    const a = Buffer.from(await (await h.app.request(`/api/plugins/greeter/1.0.0.zip?key=${mk}`)).arrayBuffer());
    const b = Buffer.from(await (await h.app.request(`/api/plugins/greeter/1.0.0.zip?key=${mk}`)).arrayBuffer());
    expect(a.equals(b)).toBe(true);
    const entries = readZip(a);
    expect(entries.map((e) => e.path)).toEqual([".claude-plugin/plugin.json", "README.md", "bin/fmt", "commands/hello.md", "hooks/hooks.json"]);
    expect(entries.find((e) => e.path === "bin/fmt")!.mode).toBe(0o755);
    expect(entries.find((e) => e.path === "README.md")!.mode).toBe(0o644);
    expect(entries[0]!.versionMadeBy >> 8).toBe(3);
    expect(JSON.parse(entries[0]!.data.toString("utf8")).name).toBe("greeter");
  });

  it("an archive download counts as an install event", async () => {
    await h.app.request(`/api/plugins/greeter/1.1.0.zip?key=${mk}`);
    const d = await h.call("GET", "/api/skills/greeter", { token: h.adminToken });
    expect(d.json.downloads).toBe(1);
    expect(d.json.installsWeek).toBe(1);
  });

  it("refuses no key, a bad key, and a revoked key", async () => {
    expect((await h.call("GET", "/marketplace.json")).status).toBe(401);
    expect((await h.call("GET", "/api/plugins/greeter/1.1.0.zip")).status).toBe(401);
    expect((await h.call("GET", `/marketplace.json?key=isk_${"a".repeat(32)}`)).status).toBe(401);
    const tokens = (await h.call("GET", "/api/tokens", { token: h.adminToken })).json as { id: string; name: string }[];
    const id = tokens.find((t) => t.name === "Claude Code plugins")!.id;
    expect((await h.call("DELETE", `/api/tokens/${id}`, { token: h.adminToken })).status).toBe(204);
    expect((await h.call("GET", `/marketplace.json?key=${mk}`)).status).toBe(401);
    expect((await h.call("GET", `/api/plugins/greeter/1.1.0.zip?key=${mk}`)).status).toBe(401);
  });

  it("hides a private plugin from a non-member: absent from the list, its archive 404", async () => {
    const eve = await h.user("eve");
    const ek = (await key(eve)).json.token;
    const r = await h.call("GET", `/marketplace.json?key=${ek}`);
    expect(r.json.plugins.map((p: { name: string }) => p.name)).toEqual(["greeter"]);
    expect((await h.call("GET", `/api/plugins/secret-plugin/1.0.0.zip?key=${ek}`)).status).toBe(404);
    expect((await h.call("GET", `/api/plugins/secret-plugin/1.0.0.zip?key=${mk}`)).status).toBe(200);
  });

  it("unknown plugin, unknown version, a non-plugin package and a non-zip path are 404", async () => {
    expect((await h.call("GET", `/api/plugins/nope/1.0.0.zip?key=${mk}`)).status).toBe(404);
    expect((await h.call("GET", `/api/plugins/greeter/9.9.9.zip?key=${mk}`)).status).toBe(404);
    expect((await h.call("GET", `/api/plugins/a-skill/1.0.0.zip?key=${mk}`)).status).toBe(404);
    expect((await h.call("GET", `/api/plugins/greeter/1.1.0.tar?key=${mk}`)).status).toBe(404);
  });

  it("uses the org name as the marketplace name and owner", async () => {
    putSettings(h.db, { name: "Acme Corp" });
    const r = await h.call("GET", `/marketplace.json?key=${mk}`);
    expect(r.json).toMatchObject({ name: "acme-corp", owner: { name: "Acme Corp" } });
    expect((await h.call("GET", "/api/meta")).json.marketplaceName).toBe("acme-corp");
  });
});

describe("marketplaceSlug", () => {
  it("lowercases, replaces runs outside [a-z0-9._-] with -, trims -", () => {
    expect(marketplaceSlug("Acme Corp")).toBe("acme-corp");
    expect(marketplaceSlug("  R&D / Tools!! ")).toBe("r-d-tools");
    expect(marketplaceSlug("acme.internal_v2")).toBe("acme.internal_v2");
  });

  it("falls back to intra-skills when empty, reserved, or not starting with a letter or digit", () => {
    for (const n of ["", "!!!", "Claude-Tools", "anthropic", "Anthropic Labs", "official-plugins", "claudeai-x", "npm", "GitHub", "gh", "uv", "pip", "cargo", ".hidden", "_x"])
      expect(marketplaceSlug(n), n).toBe("intra-skills");
    expect(marketplaceSlug("ghost")).toBe("ghost");
    expect(marketplaceSlug("claude")).toBe("claude");
  });
});

describe("buildZip", () => {
  const entries = [
    { path: "b.txt", mode: 0o644, content: Buffer.from("bee\n") },
    { path: "a/run.sh", mode: 0o755, content: Buffer.from("#!/bin/sh\necho hi\n") },
    { path: "empty", mode: 0o644, content: Buffer.alloc(0) },
  ];

  it("is deterministic regardless of input order", () => {
    expect(buildZip(entries).equals(buildZip([...entries].reverse()))).toBe(true);
    expect(readZip(buildZip(entries)).map((e) => e.path)).toEqual(["a/run.sh", "b.txt", "empty"]);
  });

  it("refuses duplicate paths", () => {
    expect(() => buildZip([entries[0]!, entries[0]!])).toThrow(/duplicate/);
  });

  it("is read by unzip, with modes and contents intact", (ctx) => {
    let has = true;
    try {
      execFileSync("unzip", ["-v"], { stdio: "ignore" });
    } catch {
      has = false;
    }
    if (!has) return ctx.skip();
    const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
    try {
      const file = join(dir, "x.zip");
      writeFileSync(file, buildZip(entries));
      const list = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
      for (const e of entries) expect(list).toContain(e.path);
      expect(list).toContain("01-01-1980 00:00");
      execFileSync("unzip", ["-tq", file]);
      const zipinfo = execFileSync("unzip", ["-Z", file], { encoding: "utf8" });
      expect(zipinfo).toMatch(/-rwxr-xr-x.*a\/run\.sh/);
      expect(zipinfo).toMatch(/-rw-r--r--.*b\.txt/);
      expect(execFileSync("unzip", ["-p", file, "a/run.sh"], { encoding: "utf8" })).toBe("#!/bin/sh\necho hi\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("MCP and agent documents per kind", () => {
  const mcp = (token: string, name: string, args: unknown) =>
    h.call("POST", "/api/mcp", {
      token,
      body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
      headers: { Accept: "application/json, text/event-stream" },
    });

  beforeEach(async () => {
    putSettings(h.db, { name: "Acme" });
    expect((await h.publish(h.adminToken, "greeter", "1.0.0", pluginFiles("greeter", "1.0.0"))).status).toBe(201);
    expect((await h.publish(h.adminToken, "strict-ts", "1.0.0", ruleFiles("strict-ts", "1.0.0"))).status).toBe(201);
    expect((await h.publish(h.adminToken, "a-skill", "1.0.0", simple("a-skill"))).status).toBe(201);
  });

  it("search_skills filters by kind and refuses an unknown one", async () => {
    const r = await mcp(h.adminToken, "search_skills", { kind: "plugin" });
    expect(r.json.result.structuredContent.skills.map((s: { name: string; kind: string }) => `${s.name}:${s.kind}`)).toEqual(["greeter:plugin"]);
    expect((await mcp(h.adminToken, "search_skills", { kind: "widget" })).json.result.isError).toBe(true);
  });

  it("get_skill answers per kind", async () => {
    const p = (await mcp(h.adminToken, "get_skill", { name: "greeter" })).json.result;
    expect(p.isError).toBe(false);
    expect(p.structuredContent).toMatchObject({
      kind: "plugin",
      installCommand: "claude plugin install greeter@acme",
      setupCommand: "intra plugins connect",
      runCommand: null,
      document: { path: "README.md" },
    });
    expect(p.content[0].text).toContain("intra plugins connect");
    expect(p.content[0].text).toContain("commands: hello");
    const r = (await mcp(h.adminToken, "get_skill", { name: "strict-ts" })).json.result;
    expect(r.structuredContent).toMatchObject({ kind: "rule", installCommand: "intra install strict-ts@1.0.0 --project", runCommand: null });
    expect(r.structuredContent.document.text).toContain("Prefer readonly arrays.");
    expect(r.content[0].text).toContain("src/**/*.ts");
    const s = (await mcp(h.adminToken, "get_skill", { name: "a-skill" })).json.result;
    expect(s.structuredContent).toMatchObject({ kind: "skill", installCommand: "intra install a-skill@1.0.0", runCommand: "intra run a-skill@1.0.0" });
  });

  it("install_command answers per kind", async () => {
    const p = (await mcp(h.adminToken, "install_command", { name: "greeter" })).json.result;
    expect(p.structuredContent).toEqual({ kind: "plugin", command: "claude plugin install greeter@acme", runCommand: null, setupCommand: "intra plugins connect" });
    const pp = (await mcp(h.adminToken, "install_command", { name: "greeter", project: true })).json.result;
    expect(pp.structuredContent.command).toBe("claude plugin install greeter@acme --scope project");
    expect((await mcp(h.adminToken, "install_command", { name: "greeter@^1" })).json.result.isError).toBe(true);
    expect((await mcp(h.adminToken, "install_command", { name: "greeter", tools: ["cursor"] })).json.result.isError).toBe(true);
    const r = (await mcp(h.adminToken, "install_command", { name: "strict-ts" })).json.result;
    expect(r.structuredContent).toEqual({ kind: "rule", command: "intra install strict-ts --project", runCommand: null, setupCommand: null });
  });

  it("agent documents describe plugins and rules with the CLI's commands", async () => {
    for (const path of ["/agent.md", "/SKILL.md"]) {
      const t = (await h.call("GET", path)).text;
      expect(t, path).toContain("intra plugins connect");
      expect(t, path).toContain("claude plugin install <plugin>@acme");
      expect(t, path).toContain("intra install <rule>");
      expect(t, path).toContain("--kind skill|plugin|rule");
    }
    const llms = (await h.call("GET", "/llms.txt")).text;
    expect(llms).toContain("/marketplace.json");
    expect(llms).toContain("claude plugin install <plugin>@acme");
  });
});
