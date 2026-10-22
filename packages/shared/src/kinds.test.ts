import { describe, expect, it } from "vitest";
import {
  agentsBlockVersion,
  detectKind,
  parsePackage,
  pluginBehaviors,
  removeAgentsBlock,
  renderAgentsBlock,
  renderClaudeRule,
  renderCursorRule,
  upsertAgentsBlock,
} from "./kinds.js";

const plugin = (manifest: Record<string, unknown>, extra: Record<string, string | null> = {}) => [
  { path: ".claude-plugin/plugin.json", text: JSON.stringify(manifest) },
  ...Object.entries(extra).map(([path, text]) => ({ path, text })),
];

const ruleMd = (fm: string, body = "Always use the shared logger, never console.log.\n") =>
  `---\nname: use-logger\ndescription: Logging conventions for backend services in this repo.\n${fm}metadata:\n  version: "1.0.0"\n  team: platform\n---\n${body}`;

describe("detectKind", () => {
  it("recognises each marker and refuses none or several", () => {
    expect(detectKind(["SKILL.md"]).kind).toBe("skill");
    expect(detectKind([".claude-plugin/plugin.json", "commands/x.md"]).kind).toBe("plugin");
    expect(detectKind(["RULE.md"]).kind).toBe("rule");
    expect(detectKind(["README.md"]).kind).toBeNull();
    expect(detectKind(["SKILL.md", "RULE.md"]).issue).toMatch(/more than one/);
  });
});

describe("plugins", () => {
  it("parses facets from plugin.json and finds every component", () => {
    const { pkg, issues } = parsePackage(
      plugin(
        { name: "deploy-tools", version: "1.2.0", description: "Deploy commands and a release reviewer.", keywords: ["deploys"], metadata: { team: "platform", stacks: ["aws", "docker"] } },
        {
          "commands/status.md": "Show status",
          "agents/reviewer.md": "Review",
          "skills/rollback/SKILL.md": "---\nname: rollback\ndescription: x\n---\n",
          "hooks/hooks.json": JSON.stringify({ hooks: { PreToolUse: [], PostToolUse: [] } }),
          ".mcp.json": JSON.stringify({ mcpServers: { api: { command: "node", args: ["server.js"] }, docs: { url: "https://docs.example.com/mcp" } } }),
          "bin/deployctl": "#!/bin/sh\n",
          "monitors/monitors.json": JSON.stringify([{ name: "deploy-status", command: "x", description: "y" }]),
          "README.md": "# Deploy tools\n",
        },
      ),
      "deploy-tools",
    );
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(pkg?.kind).toBe("plugin");
    expect(pkg?.skill).toMatchObject({ name: "deploy-tools", version: "1.2.0", team: "platform", stacks: ["aws", "docker"], tags: ["deploys"], tools: ["claude"] });
    expect(pkg?.skill.body).toBe("# Deploy tools\n");
    const c = pkg!.plugin!.components;
    expect(c).toMatchObject({ commands: ["status"], agents: ["reviewer"], skills: ["rollback"], hooks: ["PostToolUse", "PreToolUse"], bin: ["deployctl"], monitors: ["deploy-status"] });
    expect(c.mcpServers.map((m) => `${m.name}:${m.transport}`)).toEqual(["api:stdio", "docs:remote"]);
    const b = pluginBehaviors(c);
    expect(b.filter((x) => x.tier === "ask").map((x) => x.id).sort()).toEqual(["plugin-bin", "plugin-hooks", "plugin-mcp-process", "plugin-monitors"]);
    expect(b.find((x) => x.id === "plugin-mcp-remote")?.tier).toBe("info");
  });

  it("refuses a name that does not match the folder, a missing description, and an empty plugin", () => {
    const r = parsePackage(plugin({ name: "other", version: "1.0.0" }), "deploy-tools");
    expect(r.pkg).toBeNull();
    const msgs = r.issues.map((i) => `${i.field}: ${i.message}`).join("\n");
    expect(msgs).toMatch(/must match the folder name/);
    expect(msgs).toMatch(/description: required/);
    expect(msgs).toMatch(/no skills, commands/);
  });

  it("refuses invalid JSON in plugin.json", () => {
    const r = parsePackage([{ path: ".claude-plugin/plugin.json", text: "{nope" }], "x");
    expect(r.issues[0]?.message).toMatch(/not valid JSON/);
  });
});

describe("rules", () => {
  it("parses globs as a list or comma string and picks the mode", () => {
    const a = parsePackage([{ path: "RULE.md", text: ruleMd('globs:\n  - "src/**/*.ts"\n  - "lib/**"\n') }], "use-logger");
    expect(a.pkg?.rule).toEqual({ globs: ["src/**/*.ts", "lib/**"], alwaysApply: false, mode: "globs" });
    const b = parsePackage([{ path: "RULE.md", text: ruleMd('globs: "src/**/*.ts, lib/**"\n') }], "use-logger");
    expect(b.pkg?.rule?.globs).toEqual(["src/**/*.ts", "lib/**"]);
    expect(parsePackage([{ path: "RULE.md", text: ruleMd("alwaysApply: true\n") }], "use-logger").pkg?.rule?.mode).toBe("always");
    expect(parsePackage([{ path: "RULE.md", text: ruleMd("") }], "use-logger").pkg?.rule?.mode).toBe("agent");
  });

  it("refuses patterns outside the project and a rule with no body", () => {
    expect(parsePackage([{ path: "RULE.md", text: ruleMd('globs: ["../etc/*"]\n') }], "use-logger").pkg).toBeNull();
    expect(parsePackage([{ path: "RULE.md", text: ruleMd("", "") }], "use-logger").pkg).toBeNull();
  });

  it("renders for Cursor, Claude Code and AGENTS.md", () => {
    const md = ruleMd('globs: ["src/**/*.ts"]\n');
    const rule = parsePackage([{ path: "RULE.md", text: md }], "use-logger").pkg!.rule!;
    expect(renderCursorRule("Logging conventions.", rule, md)).toBe(
      '---\ndescription: "Logging conventions."\nglobs: src/**/*.ts\nalwaysApply: false\n---\nAlways use the shared logger, never console.log.\n',
    );
    expect(renderClaudeRule(rule, md)).toBe('---\npaths:\n  - "src/**/*.ts"\n---\nAlways use the shared logger, never console.log.\n');
    const always = { globs: [], alwaysApply: true, mode: "always" as const };
    expect(renderClaudeRule(always, md)).toBe("Always use the shared logger, never console.log.\n");

    const block = renderAgentsBlock("use-logger", "1.0.0", "Logging conventions.", rule, md);
    const doc = upsertAgentsBlock("# Project\n\nOur notes.\n", "use-logger", block);
    expect(doc.startsWith("# Project\n\nOur notes.\n\n<!-- intra-skills:rule use-logger begin 1.0.0")).toBe(true);
    expect(agentsBlockVersion(doc, "use-logger")).toBe("1.0.0");
    const v2 = upsertAgentsBlock(doc, "use-logger", renderAgentsBlock("use-logger", "1.1.0", "Logging conventions.", rule, md));
    expect(agentsBlockVersion(v2, "use-logger")).toBe("1.1.0");
    expect(v2.match(/intra-skills:rule use-logger begin/g)).toHaveLength(1);
    expect(removeAgentsBlock(v2, "use-logger")).toBe("# Project\n\nOur notes.\n\n");
    expect(removeAgentsBlock("# Nothing here\n", "use-logger")).toBe("# Nothing here\n");
  });
});
