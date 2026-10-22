// Package kinds in the CLI: rules rendered into a project, plugins through a fake `claude`.
// Every test runs with a temp HOME and INTRA_SKILLS_HOME, and INTRA_CLAUDE_BIN points at a script
// that records its arguments, so the real ~/.claude and the real `claude` are never touched.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderAgentsBlock, renderClaudeRule, renderCursorRule, upsertAgentsBlock, type PublishRequest, type RuleSpec } from "@intra-skills/shared";
import { main } from "./cli.js";
import { defaultCtx } from "./command.js";
import { FakeRegistry, TOKEN } from "./__tests__/fake-registry.js";

let reg: FakeRegistry;
let tmp: string;
let home: string;
let ihome: string;
let proj: string;
let claudeLog: string;
const saved = { ...process.env };

beforeAll(async () => {
  reg = new FakeRegistry();
  await reg.start();
});
afterAll(async () => {
  await reg.stop();
});

/** A stand-in for the Claude Code CLI: one line per call, arguments separated by \x1f, then its cwd. */
function fakeClaude(dir: string, exit = 0): string {
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\n{ for a in "$@"; do printf '%s\\037' "$a"; done; printf '@cwd=%s\\n' "$PWD"; } >> '${claudeLog}'\n` +
      (exit ? `echo "fake claude failed" >&2\n` : "") +
      `exit ${exit}\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function calls(): { args: string[]; cwd: string }[] {
  if (!existsSync(claudeLog)) return [];
  return readFileSync(claudeLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [args, cwd] = line.split("@cwd=");
      return { args: args!.split("\x1f").filter((a, i, all) => i < all.length - 1 || a !== ""), cwd: cwd! };
    });
}

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "intra-kinds-")));
  home = join(tmp, "home");
  ihome = join(home, ".intra-skills");
  proj = join(tmp, "proj");
  claudeLog = join(tmp, "claude.log");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(join(tmp, "bin"));
  process.env.HOME = home;
  process.env.INTRA_SKILLS_HOME = ihome;
  process.env.NO_COLOR = "1";
  process.env.INTRA_CLAUDE_BIN = fakeClaude(join(tmp, "bin"));
  delete process.env.INTRA_SKILLS_TOKEN;
  delete process.env.INTRA_SKILLS_REGISTRY;
  reg.reset();
  const r = await run(["login", "--registry", reg.url, "--token", TOKEN]);
  expect(r.code, r.stderr).toBe(0);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  process.env = { ...saved };
});

async function run(argv: string[], cwd = tmp) {
  let stdout = "";
  let stderr = "";
  const stdin = Readable.from([]) as Readable & { isTTY?: boolean };
  const code = await main(
    argv,
    { stdout: { write: (s: string) => (stdout += s) }, stderr: { write: (s: string) => (stderr += s) }, stdin, cwd },
    (out, io) => ({ ...defaultCtx(out, io), sleep: async () => undefined }),
  );
  return { code, stdout, stderr };
}

const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const lock = () => JSON.parse(read(proj, "skills.lock.json"));
const desc = (name: string) => `Seeded fixture rule ${name} for the CLI tests.`;
const GLOBS: RuleSpec = { globs: ["src/**/*.ts"], alwaysApply: false, mode: "globs" };

describe("rules", () => {
  it("install writes all three targets with exactly what the shared renderers produce, and locks their hashes", async () => {
    reg.seedRule("ts-style", "1.0.0", { globs: ["src/**/*.ts"] });
    const md = FakeRegistry.ruleMd("ts-style", "1.0.0", { globs: ["src/**/*.ts"] });
    const r = await run(["install", "ts-style", "--project", proj, "--json"]);
    expect(r.code, r.stdout).toBe(0);
    expect(read(proj, ".cursor/rules/ts-style.mdc")).toBe(renderCursorRule(desc("ts-style"), GLOBS, md));
    expect(read(proj, ".claude/rules/ts-style.md")).toBe(renderClaudeRule(GLOBS, md));
    expect(read(proj, "AGENTS.md")).toBe(upsertAgentsBlock("", "ts-style", renderAgentsBlock("ts-style", "1.0.0", desc("ts-style"), GLOBS, md)));
    const e = lock().skills["ts-style"];
    expect(e).toMatchObject({ kind: "rule", range: "^1.0.0", version: "1.0.0", targets: ["claude", "codex", "cursor"] });
    expect(Object.keys(e)).toEqual(["kind", "range", "version", "sha256", "targets", "rendered"]);
    expect(e.rendered.cursor.path).toBe(".cursor/rules/ts-style.mdc");
    expect(e.rendered.codex.path).toBe("AGENTS.md");
    expect(existsSync(join(home, ".claude"))).toBe(false); // nothing global
    expect(JSON.parse(r.stdout).installed[0]).toMatchObject({ name: "ts-style", kind: "rule", version: "1.0.0" });
  });

  it("without --project says so and uses the nearest project; --global is refused; --to narrows", async () => {
    reg.seedRule("plain-rule", "1.0.0");
    mkdirSync(join(proj, "src"));
    const r = await run(["install", "plain-rule", "--to", "cursor", "--json"], join(proj, "src"));
    expect(r.code, r.stdout).toBe(0);
    expect(JSON.parse(r.stdout).notes[0]).toMatch(/rules always install into a project; using .*proj/);
    expect(existsSync(join(proj, ".cursor/rules/plain-rule.mdc"))).toBe(true);
    expect(existsSync(join(proj, ".claude/rules/plain-rule.md"))).toBe(false);
    expect(existsSync(join(proj, "AGENTS.md"))).toBe(false);
    const human = await run(["install", "plain-rule", "--to", "cursor"], join(proj, "src"));
    expect(human.stdout).toMatch(/note: rules always install into a project/);
    const g = await run(["install", "plain-rule", "--global", "--json"], proj);
    expect(g.code).toBe(1);
    expect(JSON.parse(g.stdout).failed[0].error).toMatch(/rules are project files/);
  });

  it("a second rule keeps the first rule's AGENTS.md block, and remove leaves everything else in AGENTS.md intact", async () => {
    reg.seedRule("rule-one", "1.0.0");
    reg.seedRule("rule-two", "1.0.0", { alwaysApply: true });
    const mine = "# Our agents\n\nHand-written notes that intra must keep.\n";
    writeFileSync(join(proj, "AGENTS.md"), mine);
    expect((await run(["install", "rule-one", "--project", proj])).code).toBe(0);
    expect((await run(["install", "rule-two", "--project", proj])).code).toBe(0);
    const agents = read(proj, "AGENTS.md");
    expect(agents.startsWith(mine)).toBe(true);
    expect(agents).toContain("intra-skills:rule rule-one begin 1.0.0");
    expect(agents).toContain("intra-skills:rule rule-two begin 1.0.0");
    const rm = await run(["remove", "rule-one", "--project", proj, "--json"]);
    expect(rm.code, rm.stdout).toBe(0);
    const after = read(proj, "AGENTS.md");
    expect(after.startsWith(mine)).toBe(true);
    expect(after).not.toContain("rule-one");
    expect(after).toContain("intra-skills:rule rule-two begin");
    expect(existsSync(join(proj, ".cursor/rules/rule-one.mdc"))).toBe(false);
    expect(existsSync(join(proj, ".claude/rules/rule-one.md"))).toBe(false);
    expect(existsSync(join(proj, ".cursor/rules/rule-two.mdc"))).toBe(true);
    expect(Object.keys(lock().skills)).toEqual(["rule-two"]);
    expect(JSON.parse(rm.stdout).removed.map((x: { target: string }) => x.target).sort()).toEqual(["claude", "codex", "cursor"]);
  });

  it("refuses to overwrite a .mdc it did not write, writes nothing else, and --force backs it up", async () => {
    reg.seedRule("ts-style", "1.0.0");
    mkdirSync(join(proj, ".cursor/rules"), { recursive: true });
    writeFileSync(join(proj, ".cursor/rules/ts-style.mdc"), "my own rule\n");
    const r = await run(["install", "ts-style", "--project", proj]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/refusing to overwrite .*ts-style\.mdc: not written by intra/);
    expect(read(proj, ".cursor/rules/ts-style.mdc")).toBe("my own rule\n");
    expect(existsSync(join(proj, ".claude/rules/ts-style.md"))).toBe(false);
    expect(existsSync(join(proj, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(proj, "skills.lock.json"))).toBe(false);
    const f = await run(["install", "ts-style", "--project", proj, "--force", "--json"]);
    expect(f.code, f.stdout).toBe(0);
    const backup = JSON.parse(f.stdout).installed[0].backups[0] as string;
    expect(backup.startsWith(join(ihome, "backup"))).toBe(true);
    expect(readFileSync(backup, "utf8")).toBe("my own rule\n");
    expect(read(proj, ".cursor/rules/ts-style.mdc")).toContain("alwaysApply: false");
  });

  it("remove keeps a rendered file that was edited by hand unless --force", async () => {
    reg.seedRule("ts-style", "1.0.0");
    expect((await run(["install", "ts-style", "--project", proj, "--to", "claude"])).code).toBe(0);
    writeFileSync(join(proj, ".claude/rules/ts-style.md"), "edited\n");
    const r = await run(["remove", "ts-style", "--project", proj]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/left .*ts-style\.md alone/);
    expect(read(proj, ".claude/rules/ts-style.md")).toBe("edited\n");
    expect(lock().skills["ts-style"].targets).toEqual(["claude"]);
    expect((await run(["remove", "ts-style", "--project", proj, "--force"])).code).toBe(0);
    expect(existsSync(join(proj, ".claude/rules/ts-style.md"))).toBe(false);
    expect(lock().skills).toEqual({});
  });

  it("sync --frozen detects a hand-edited rendered file and AGENTS.md block; sync restores both", async () => {
    reg.seedRule("ts-style", "1.0.0");
    expect((await run(["install", "ts-style", "--project", proj])).code).toBe(0);
    expect((await run(["sync", "--frozen", "--project", proj])).code).toBe(0);
    const good = read(proj, ".claude/rules/ts-style.md");
    writeFileSync(join(proj, ".claude/rules/ts-style.md"), good + "\nsneaky extra line\n");
    writeFileSync(join(proj, "AGENTS.md"), read(proj, "AGENTS.md").replace("Always do", "Never do"));
    const frozen = await run(["sync", "--frozen", "--project", proj, "--json"]);
    expect(frozen.code).toBe(1);
    const changes = JSON.parse(frozen.stdout).changes.map((c: { action: string; target: string; kind: string }) => `${c.kind}:${c.action}:${c.target}`);
    expect(changes.sort()).toEqual(["rule:reinstall:claude", "rule:reinstall:codex"]);
    const fixed = await run(["sync", "--project", proj]);
    expect(fixed.code, fixed.stdout + fixed.stderr).toBe(0);
    expect(fixed.stdout).toMatch(/backed up the edited file/);
    expect(read(proj, ".claude/rules/ts-style.md")).toBe(good);
    expect(read(proj, "AGENTS.md")).toContain("Always do");
    expect((await run(["sync", "--frozen", "--project", proj])).code).toBe(0);
  });

  it("update re-renders every target at the new version; list shows the kind", async () => {
    reg.seedRule("ts-style", "1.0.0");
    expect((await run(["install", "ts-style", "--project", proj])).code).toBe(0);
    reg.seedRule("ts-style", "1.1.0");
    const u = await run(["update", "--project", proj, "--json"]);
    expect(u.code, u.stdout).toBe(0);
    expect(JSON.parse(u.stdout).updated).toEqual([{ name: "ts-style", from: "1.0.0", to: "1.1.0" }]);
    expect(read(proj, ".cursor/rules/ts-style.mdc")).toContain("(1.1.0)");
    expect(read(proj, "AGENTS.md")).toContain("intra-skills:rule ts-style begin 1.1.0");
    expect(lock().skills["ts-style"].version).toBe("1.1.0");
    expect((await run(["sync", "--frozen", "--project", proj])).code).toBe(0);
    const l = await run(["list", "--project", proj, "--json"]);
    expect(JSON.parse(l.stdout).skills[0]).toMatchObject({ name: "ts-style", kind: "rule", problems: [] });
    const human = await run(["list", "--project", proj, "--offline"]);
    expect(human.stdout).toMatch(/ts-style\s+rule\s+1\.1\.0/);
  });
});

describe("plugins", () => {
  it("install connects the marketplace, then installs at user scope, and never touches ~/.claude/skills", async () => {
    reg.seedPlugin("release-tools", "1.2.0");
    const r = await run(["install", "release-tools", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const c = calls().map((x) => x.args);
    expect(c).toEqual([
      ["plugin", "marketplace", "add", `${reg.url}/marketplace.json?key=${[...reg.marketplaceKeys.values()][0]}`, "--scope", "user"],
      ["plugin", "install", "release-tools@acme-skills", "--scope", "user"],
    ]);
    expect(reg.requests.find((q) => q.path === "/api/tokens/marketplace")?.method).toBe("POST");
    const installed = JSON.parse(read(ihome, "installed.json"));
    expect(installed["release-tools"]).toMatchObject({ kind: "plugin", version: "1.2.0", scope: "user", targets: ["claude"] });
    expect(existsSync(join(home, ".claude/skills"))).toBe(false);
    expect(existsSync(join(ihome, "store"))).toBe(false);
    // The key lives only in Claude Code's settings: none of intra's files holds it.
    const key = [...reg.marketplaceKeys.values()][0]!;
    for (const f of readdirSync(ihome)) if (f.endsWith(".json")) expect(read(ihome, f)).not.toContain(key);
    expect(JSON.parse(read(ihome, "plugins.json")).registries[reg.url].marketplaceName).toBe("acme-skills");
    expect(JSON.parse(r.stdout).installed[0]).toMatchObject({ name: "release-tools", kind: "plugin", scope: "claude user" });
    // Connected once: a second plugin does not mint another key.
    reg.seedPlugin("other-tools", "0.1.0");
    expect((await run(["install", "other-tools"])).code).toBe(0);
    expect(reg.marketplaceKeys.size).toBe(1);
    expect(calls().map((x) => x.args).slice(2)).toEqual([["plugin", "install", "other-tools@acme-skills", "--scope", "user"]]);
  });

  it("--project installs at project scope from the project root and records it in the lockfile", async () => {
    reg.seedPlugin("release-tools", "1.2.0");
    const r = await run(["install", "release-tools", "--project", proj, "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const last = calls().at(-1)!;
    expect(last.args).toEqual(["plugin", "install", "release-tools@acme-skills", "--scope", "project"]);
    expect(last.cwd).toBe(proj);
    expect(lock().skills["release-tools"]).toMatchObject({ kind: "plugin", scope: "project", version: "1.2.0" });
    expect(JSON.parse(r.stdout).notes.join(" ")).toMatch(/each teammate runs `intra plugins connect` once/);
    expect((await run(["sync", "--frozen", "--project", proj])).code).toBe(0); // plugins are Claude Code's
  });

  it("remove runs claude plugin uninstall; update runs claude plugin update", async () => {
    reg.seedPlugin("release-tools", "1.0.0");
    expect((await run(["install", "release-tools"])).code).toBe(0);
    reg.seedPlugin("release-tools", "1.1.0");
    const u = await run(["update", "--json"]);
    expect(u.code, u.stdout).toBe(0);
    expect(calls().at(-1)!.args).toEqual(["plugin", "update", "release-tools@acme-skills"]);
    expect(JSON.parse(read(ihome, "installed.json"))["release-tools"].version).toBe("1.1.0");
    const rm = await run(["remove", "release-tools", "--json"]);
    expect(rm.code, rm.stdout).toBe(0);
    expect(calls().at(-1)!.args).toEqual(["plugin", "uninstall", "release-tools@acme-skills", "--scope", "user"]);
    expect(JSON.parse(read(ihome, "installed.json"))).toEqual({});
  });

  it("update holds a plugin version that adds a hook until --yes", async () => {
    reg.seedPlugin("release-tools", "1.0.0");
    expect((await run(["install", "release-tools"])).code).toBe(0);
    reg.seedPlugin("release-tools", "1.1.0", { "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [] } }) });
    const u = await run(["update", "--json"]);
    expect(JSON.parse(u.stdout).skipped[0].reason).toMatch(/Runs commands automatically on agent events/);
    expect(calls().some((x) => x.args[1] === "update")).toBe(false);
  });

  it("a failing claude reports its message and records nothing; the unused key is revoked", async () => {
    process.env.INTRA_CLAUDE_BIN = fakeClaude(join(tmp, "bin"), 1);
    reg.seedPlugin("release-tools", "1.0.0");
    const r = await run(["plugins", "connect", "--json"]);
    expect(r.code).toBe(1);
    const doc = JSON.parse(r.stdout);
    expect(doc.error.message).toMatch(/fake claude failed/);
    expect(doc.error.message).not.toMatch(/isk_mkt/); // the key is masked
    expect(reg.marketplaceKeys.size).toBe(0);
    expect(existsSync(join(ihome, "plugins.json"))).toBe(false);
  });

  it("with no claude on PATH, connect prints the exact command and exits 0; install refuses without minting a key", async () => {
    delete process.env.INTRA_CLAUDE_BIN;
    process.env.PATH = join(tmp, "empty-path");
    reg.seedPlugin("release-tools", "1.0.0");
    const r = await run(["plugins", "connect"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const key = [...reg.marketplaceKeys.values()][0]!;
    expect(r.stdout).toContain(`claude plugin marketplace add '${reg.url}/marketplace.json?key=${key}' --scope user`);
    expect(r.stdout).toMatch(/not on PATH/);
    const j = await run(["plugins", "connect", "--json"]);
    expect(JSON.parse(j.stdout)).toMatchObject({ ok: true, status: "manual", connected: false, marketplaceName: "acme-skills" });
    expect(existsSync(join(ihome, "plugins.json"))).toBe(false);
    const before = reg.marketplaceKeys.size;
    const i = await run(["install", "release-tools", "--json"]);
    expect(i.code).toBe(1);
    expect(JSON.parse(i.stdout).failed[0].error).toMatch(/`claude`\) was not found on PATH/);
    expect(reg.marketplaceKeys.size).toBe(before);
    expect(calls()).toEqual([]);
  });

  it("setup connects the marketplace when claude is on PATH, and not with --no-plugins", async () => {
    const s = await run(["setup", "--no-plugins", "--json"]);
    expect(s.code, s.stdout).toBe(0);
    expect(JSON.parse(s.stdout).plugins).toEqual({ status: "skipped", reason: "--no-plugins" });
    expect(calls()).toEqual([]);
    const r = await run(["setup", "--json"]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).plugins).toMatchObject({ status: "connected", marketplaceName: "acme-skills" });
    expect(calls().map((x) => x.args.slice(0, 3))).toEqual([["plugin", "marketplace", "add"]]);
    const again = await run(["setup", "--json"]);
    expect(JSON.parse(again.stdout).plugins.status).toBe("already-connected");
  });
});

describe("authoring kinds", () => {
  it("init --kind plugin and --kind rule scaffold packages that pass validate", async () => {
    for (const kind of ["plugin", "rule"]) {
      const i = await run(["init", `my-${kind}`, "--kind", kind, "--team", "platform", "--json"]);
      expect(i.code, i.stdout).toBe(0);
      const v = await run(["validate", join(tmp, `my-${kind}`), "--json"]);
      expect(v.code, v.stdout).toBe(0);
      const doc = JSON.parse(v.stdout);
      expect(doc.valid).toBe(true);
      expect(doc.skills[0]).toMatchObject({ kind, version: "0.1.0" });
      expect(doc.skills[0].issues.map((x: { message: string }) => x.message).join(" ")).toMatch(/TODO placeholder/);
    }
    const manifest = JSON.parse(read(tmp, "my-plugin/.claude-plugin/plugin.json"));
    expect(manifest).toMatchObject({ name: "my-plugin", version: "0.1.0", metadata: { team: "platform" } });
    expect(manifest.description).toMatch(/^TODO/);
    expect(existsSync(join(tmp, "my-plugin/commands/my-plugin.md"))).toBe(true);
    const rule = read(tmp, "my-rule/RULE.md");
    expect(rule).toMatch(/globs:\n {2}- "src\/\*\*\/\*\.ts"/);
    expect(rule).toMatch(/alwaysApply: false/);
    expect(rule).toMatch(/version: "0\.1\.0"/);
    expect((await run(["init", "my-plugin", "--kind", "plugin"])).code).toBe(1); // refuses to overwrite
    expect((await run(["init", "x-y", "--kind", "widget"])).code).toBe(2);
  });

  it("publish of a plugin sends the plugin.json version, and --bump rewrites plugin.json", async () => {
    expect((await run(["init", "release-tools", "--kind", "plugin"])).code).toBe(0);
    const dir = join(tmp, "release-tools");
    const p = await run(["publish", dir, "--json"]);
    expect(p.code, p.stdout).toBe(0);
    expect(JSON.parse(p.stdout).results[0]).toMatchObject({ kind: "plugin", version: "0.1.0", status: "published" });
    const bump = await run(["publish", dir, "--bump", "minor"]);
    expect(bump.code, bump.stdout + bump.stderr).toBe(0);
    expect(JSON.parse(read(dir, ".claude-plugin/plugin.json")).version).toBe("0.2.0");
    const posts = reg.requests.filter((q) => q.method === "POST" && q.path === "/api/skills/release-tools/versions");
    const body = posts.at(-1)!.body as PublishRequest;
    expect(body.version).toBe("0.2.0");
    const sent = body.files.find((f) => f.path === ".claude-plugin/plugin.json")!;
    expect(JSON.parse(Buffer.from(sent.contentBase64, "base64").toString("utf8")).version).toBe("0.2.0");
    expect(body.files.map((f) => f.path)).toEqual([".claude-plugin/plugin.json", "commands/release-tools.md"]);
    expect(reg.skills.get("release-tools")!.kind).toBe("plugin");
  });

  it("validate refuses a folder with no kind marker and one with two", async () => {
    mkdirSync(join(tmp, "empty-pkg"));
    writeFileSync(join(tmp, "empty-pkg/README.md"), "hi");
    const r = await run(["validate", join(tmp, "empty-pkg"), "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).skills[0].issues[0].message).toMatch(/no SKILL\.md, \.claude-plugin\/plugin\.json or RULE\.md/);
    expect((await run(["init", "both-kinds", "--kind", "rule"])).code).toBe(0);
    writeFileSync(join(tmp, "both-kinds/SKILL.md"), "---\nname: both-kinds\ndescription: x\n---\n");
    const two = await run(["validate", join(tmp, "both-kinds"), "--json"]);
    expect(JSON.parse(two.stdout).skills[0].issues[0].message).toMatch(/more than one kind marker/);
  });
});

describe("discovery and collections", () => {
  it("search --kind filters and shows the kind; info shows the kind, the components and how to install", async () => {
    reg.seed("alpha", "1.0.0");
    reg.seedPlugin("release-tools", "1.0.0");
    reg.seedRule("ts-style", "1.0.0", { globs: ["src/**/*.ts"] });
    const s = await run(["search", "--kind", "plugin", "--json"]);
    expect(JSON.parse(s.stdout).skills.map((x: { name: string }) => x.name)).toEqual(["release-tools"]);
    expect(reg.requests.some((q) => q.path === "/api/skills?kind=plugin")).toBe(true);
    const all = await run(["search"]);
    expect(all.stdout).toMatch(/release-tools\s+plugin\s+1\.0\.0/);
    expect(all.stdout).toMatch(/ts-style\s+rule/);
    expect((await run(["search", "--kind", "nope"])).code).toBe(2);
    const i = await run(["info", "release-tools"]);
    expect(i.stdout).toMatch(/kind\s+plugin \(Claude Code\)/);
    expect(i.stdout).toMatch(/commands\s+\/release-tools/);
    expect(i.stdout).toMatch(/install\s+intra install release-tools/);
    const ri = await run(["info", "ts-style"]);
    expect(ri.stdout).toMatch(/applies\s+applies to files matching src\/\*\*\/\*\.ts/);
    const wrong = await run(["info", "ts-style", "--kind", "skill", "--json"]);
    expect(wrong.code).toBe(1);
    expect(JSON.parse(wrong.stdout).error.message).toBe("ts-style is a rule, not a skill");
  });

  it("install @team/collection handles a skill, a rule and a plugin together", async () => {
    reg.seed("alpha", "1.0.0");
    reg.seedRule("ts-style", "1.0.0");
    reg.seedPlugin("release-tools", "1.0.0");
    reg.collections.set("platform/starter", {
      team: "platform",
      slug: "starter",
      title: "Starter kit",
      description: "",
      skills: ["alpha", "ts-style", "release-tools"],
      createdBy: "ada",
      updatedAt: "2026-01-01T00:00:00Z",
    });
    const r = await run(["install", "@platform/starter", "--project", proj, "--json"]);
    expect(r.code, r.stdout).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.installed.map((x: { name: string; kind: string }) => `${x.kind}:${x.name}`)).toEqual(["skill:alpha", "rule:ts-style", "plugin:release-tools"]);
    expect(existsSync(join(proj, ".claude/skills/alpha/SKILL.md"))).toBe(true);
    expect(existsSync(join(proj, ".claude/rules/ts-style.md"))).toBe(true);
    expect(calls().at(-1)!.args).toEqual(["plugin", "install", "release-tools@acme-skills", "--scope", "project"]);
    const l = lock().skills;
    expect([l.alpha.kind, l["ts-style"].kind, l["release-tools"].kind]).toEqual([undefined, "rule", "plugin"]);
  });

  it("every new command's --json prints exactly one document and nothing on stderr", async () => {
    reg.seedRule("ts-style", "1.0.0");
    reg.seedPlugin("release-tools", "1.0.0");
    const argvs = [
      ["plugins", "status", "--json"],
      ["plugins", "connect", "--json"],
      ["plugins", "connect", "--json"],
      ["install", "ts-style", "--project", proj, "--json"],
      ["install", "release-tools", "--json"],
      ["list", "--json"],
      ["list", "--project", proj, "--kind", "rule", "--json"],
      ["update", "--project", proj, "--json"],
      ["sync", "--frozen", "--project", proj, "--json"],
      ["search", "--kind", "rule", "--json"],
      ["info", "release-tools", "--json"],
      ["init", "new-rule", "--kind", "rule", "--json"],
      ["validate", join(tmp, "new-rule"), "--json"],
      ["remove", "ts-style", "--project", proj, "--json"],
      ["remove", "release-tools", "--json"],
    ];
    for (const argv of argvs) {
      const r = await run(argv);
      expect(r.code, `${argv.join(" ")}: ${r.stdout}`).toBe(0);
      expect(r.stderr, argv.join(" ")).toBe("");
      expect(JSON.parse(r.stdout).ok, argv.join(" ")).toBe(true);
    }
  });
});
