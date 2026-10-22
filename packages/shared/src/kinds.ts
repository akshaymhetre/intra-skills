// Package kinds: a registry package is a skill, a Claude Code plugin, or a rule. All three share
// versions, teams, stacks, visibility, pull-request publishing and trust; this module holds what
// differs: how each is recognised, parsed, scanned for risky behavior, and (for rules) rendered
// into each tool's own format. Browser-safe: no node imports.
//
// Formats, read from the vendors' docs on 2026-10-16:
//   Claude Code plugins  https://code.claude.com/docs/en/plugins-reference  (.claude-plugin/plugin.json,
//                        skills/ commands/ agents/ hooks/hooks.json .mcp.json .lsp.json bin/ monitors/)
//   Claude Code rules    https://code.claude.com/docs/en/memory  (.claude/rules/*.md, `paths:` frontmatter)
//   Cursor rules         https://cursor.com/docs/context/rules  (.cursor/rules/*.mdc: description, globs, alwaysApply)
//   Codex                AGENTS.md (plain markdown, no per-rule files)
import { parse as parseYaml } from "yaml";
import type { Behavior } from "./types.js";
import { NAME_RE, SKILL_FILE, TAG_RE, TEAM_RE, parseSkillMd, splitFrontmatter, splitList, type ParsedSkill, type ValidationIssue } from "./skill.js";
import { isValidVersion } from "./semver.js";

export type { PackageKind, PluginComponents, McpServerInfo, RuleSpec } from "./types.js";
import type { PackageKind, PluginComponents, McpServerInfo, RuleSpec } from "./types.js";
export const KINDS: readonly PackageKind[] = ["skill", "plugin", "rule"] as const;
export const KIND_LABELS: Record<PackageKind, string> = { skill: "Skill", plugin: "Plugin", rule: "Rule" };

export const RULE_FILE = "RULE.md";
export const PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

/** The file that marks a package's kind, at the package root. */
export const KIND_MARKER: Record<PackageKind, string> = { skill: SKILL_FILE, plugin: PLUGIN_MANIFEST, rule: RULE_FILE };

/** Which kind a set of package-relative paths is. null = none or more than one marker. */
export function detectKind(paths: string[]): { kind: PackageKind | null; issue: string | null } {
  const set = new Set(paths);
  const found = KINDS.filter((k) => set.has(KIND_MARKER[k]));
  if (found.length === 1) return { kind: found[0]!, issue: null };
  if (found.length === 0)
    return { kind: null, issue: `no ${SKILL_FILE}, ${PLUGIN_MANIFEST} or ${RULE_FILE} at the top of the folder` };
  return { kind: null, issue: `the folder has more than one kind marker (${found.map((k) => KIND_MARKER[k]).join(", ")}); a package is one kind` };
}

// ---------- plugins ----------

export interface ParsedPackage {
  kind: PackageKind;
  /** Facets and identity, in the same shape for every kind. `body` is what the console renders as the readme. */
  skill: ParsedSkill;
  plugin: { components: PluginComponents; manifest: Record<string, unknown> } | null;
  rule: RuleSpec | null;
}

export interface PackageFile {
  path: string;
  /** Text content, or null for binary files. */
  text: string | null;
}

function strList(v: unknown): string[] {
  if (typeof v === "string") return splitList(v);
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [];
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

function under(paths: string[], dir: string, ext?: string): string[] {
  return paths.filter((p) => p.startsWith(dir) && (!ext || p.endsWith(ext)));
}

function readJson(files: PackageFile[], path: string, issues: ValidationIssue[]): Record<string, unknown> | null {
  const f = files.find((x) => x.path === path);
  if (!f) return null;
  if (f.text === null) {
    issues.push({ level: "error", field: path, message: "must be UTF-8 text" });
    return null;
  }
  try {
    const v = JSON.parse(f.text) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a JSON object");
    return v as Record<string, unknown>;
  } catch (e) {
    issues.push({ level: "error", field: path, message: `not valid JSON: ${(e as Error).message}` });
    return null;
  }
}

function hookEvents(v: unknown): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  const map = o.hooks && typeof o.hooks === "object" && !Array.isArray(o.hooks) ? (o.hooks as Record<string, unknown>) : o;
  return Object.keys(map).filter((k) => /^[A-Z][A-Za-z]+$/.test(k));
}

function mcpFrom(v: unknown): McpServerInfo[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  const o = v as Record<string, unknown>;
  const map = o.mcpServers && typeof o.mcpServers === "object" && !Array.isArray(o.mcpServers) ? (o.mcpServers as Record<string, unknown>) : o;
  const out: McpServerInfo[] = [];
  for (const [name, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== "object") continue;
    const c = cfg as Record<string, unknown>;
    if (typeof c.url === "string") out.push({ name, transport: "remote", target: c.url });
    else if (typeof c.command === "string")
      out.push({ name, transport: "stdio", target: [c.command, ...(Array.isArray(c.args) ? c.args.filter((a) => typeof a === "string") : [])].join(" ") });
  }
  return out;
}

/** Components in the standard layout plus what plugin.json declares inline or elsewhere. */
export function pluginComponents(files: PackageFile[], manifest: Record<string, unknown>, issues: ValidationIssue[] = []): PluginComponents {
  const paths = files.map((f) => f.path);
  const skills = [...new Set(under(paths, "skills/").filter((p) => p.endsWith("/SKILL.md")).map((p) => p.split("/")[1]!))];
  const cmdPaths = under(paths, "commands/", ".md");
  const commands = cmdPaths.map((p) => baseName(p).replace(/\.md$/, ""));
  if (manifest.commands && typeof manifest.commands === "object" && !Array.isArray(manifest.commands))
    for (const k of Object.keys(manifest.commands as object)) if (!commands.includes(k)) commands.push(k);
  const agents = under(paths, "agents/", ".md").map((p) => baseName(p).replace(/\.md$/, ""));
  const hooks = new Set<string>(hookEvents(readJson(files, "hooks/hooks.json", issues)));
  for (const e of hookEvents(manifest.hooks)) hooks.add(e);
  const mcp = [...mcpFrom(readJson(files, ".mcp.json", issues)), ...mcpFrom(manifest.mcpServers)];
  const lsp = Object.keys(readJson(files, ".lsp.json", issues) ?? {});
  const bin = under(paths, "bin/").map(baseName);
  // monitors.json is an array, so it is read here rather than through readJson (objects only).
  const monitors: string[] = [];
  const monFile = files.find((f) => f.path === "monitors/monitors.json");
  if (monFile?.text) {
    try {
      const arr = JSON.parse(monFile.text) as unknown;
      if (Array.isArray(arr)) for (const m of arr) if (m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string") monitors.push((m as { name: string }).name);
    } catch (e) {
      issues.push({ level: "error", field: "monitors/monitors.json", message: `not valid JSON: ${(e as Error).message}` });
    }
  }
  const outputStyles = under(paths, "output-styles/", ".md").map((p) => baseName(p).replace(/\.md$/, ""));
  return {
    skills,
    commands,
    agents,
    hooks: [...hooks].sort(),
    mcpServers: mcp,
    lspServers: lsp,
    bin,
    monitors,
    outputStyles,
  };
}

/** What a plugin's structure lets it do without being asked; added to the line scan's behaviors. */
export function pluginBehaviors(c: PluginComponents): Behavior[] {
  const out: Behavior[] = [];
  if (c.hooks.length)
    out.push({ id: "plugin-hooks", tier: "ask", label: "Runs commands automatically on agent events", file: "hooks/hooks.json", line: null, match: c.hooks.join(", ") });
  for (const m of c.mcpServers)
    out.push(
      m.transport === "stdio"
        ? { id: "plugin-mcp-process", tier: "ask", label: "Starts a local MCP server process", file: ".mcp.json", line: null, match: `${m.name}: ${m.target}`.slice(0, 120) }
        : { id: "plugin-mcp-remote", tier: "info", label: "Connects to a remote MCP server", file: ".mcp.json", line: null, match: `${m.name}: ${m.target}`.slice(0, 120) },
    );
  if (c.bin.length) out.push({ id: "plugin-bin", tier: "ask", label: "Puts executables on the agent's PATH", file: "bin/", line: null, match: c.bin.join(", ").slice(0, 120) });
  if (c.monitors.length)
    out.push({ id: "plugin-monitors", tier: "ask", label: "Runs background monitor processes", file: "monitors/monitors.json", line: null, match: c.monitors.join(", ").slice(0, 120) });
  if (c.lspServers.length)
    out.push({ id: "plugin-lsp", tier: "info", label: "Starts a language server", file: ".lsp.json", line: null, match: c.lspServers.join(", ").slice(0, 120) });
  return out;
}

function parsePlugin(files: PackageFile[], dirName: string, issues: ValidationIssue[]): ParsedPackage | null {
  const err = (field: string, message: string) => issues.push({ level: "error", field, message });
  const manifest = readJson(files, PLUGIN_MANIFEST, issues);
  if (!manifest) return null;
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (!name) err("plugin.json name", "required");
  else if (name.length > 64 || !NAME_RE.test(name)) err("plugin.json name", "lowercase letters, digits and single hyphens only");
  else if (name !== dirName) err("plugin.json name", `must match the folder name ("${dirName}")`);
  const description = typeof manifest.description === "string" ? manifest.description.trim() : "";
  if (!description) err("plugin.json description", "required: it is what people and agents read to decide whether to install");
  const rawVersion = typeof manifest.version === "string" ? manifest.version.trim() : "";
  const version = rawVersion && isValidVersion(rawVersion) ? rawVersion : null;
  if (rawVersion && !version) err("plugin.json version", `"${rawVersion}" is not semver (x.y.z)`);
  const meta = manifest.metadata && typeof manifest.metadata === "object" && !Array.isArray(manifest.metadata) ? (manifest.metadata as Record<string, unknown>) : {};
  const team = typeof meta.team === "string" ? meta.team.trim().toLowerCase() || null : null;
  if (team && !TEAM_RE.test(team)) err("plugin.json metadata.team", "must be a team slug");
  const areas = strList(meta.areas);
  const stacks = strList(meta.stacks);
  const tags = [...new Set([...strList(meta.tags), ...strList(manifest.keywords)])];
  for (const t of [...areas, ...stacks, ...tags]) if (!TAG_RE.test(t)) err("plugin.json metadata", `invalid tag "${t}"`);
  const visibility = meta.visibility === "private" || meta.visibility === "org" ? meta.visibility : null;
  const components = pluginComponents(files, manifest, issues);
  const total = Object.values(components).reduce((n, v) => n + (v as unknown[]).length, 0);
  if (total === 0) err("components", "the plugin has no skills, commands, agents, hooks or servers");
  const readme = files.find((f) => /^readme\.md$/i.test(f.path))?.text ?? "";
  const stringMeta: Record<string, string> = {};
  for (const [k, v] of Object.entries(meta)) if (typeof v === "string") stringMeta[k] = v;
  if (issues.some((i) => i.level === "error")) return null;
  return {
    kind: "plugin",
    skill: {
      name,
      description,
      license: typeof manifest.license === "string" ? manifest.license : null,
      compatibility: null,
      version,
      team,
      areas,
      stacks,
      tags,
      // A plugin installs into Claude Code only.
      tools: ["claude"],
      visibility,
      metadata: stringMeta,
      body: readme || description,
    },
    plugin: { components, manifest },
    rule: null,
  };
}

// ---------- rules ----------

function parseRule(files: PackageFile[], dirName: string, issues: ValidationIssue[]): ParsedPackage | null {
  const f = files.find((x) => x.path === RULE_FILE);
  if (!f || f.text === null) {
    issues.push({ level: "error", field: RULE_FILE, message: "must be UTF-8 text" });
    return null;
  }
  const res = parseSkillMd(f.text, dirName);
  issues.push(...res.issues.map((i) => (i.field === "frontmatter" ? { ...i, message: i.message.replace("SKILL.md", RULE_FILE) } : i)));
  if (!res.skill) return null;
  const split = splitFrontmatter(f.text);
  let fm: Record<string, unknown> = {};
  try {
    const d = split ? (parseYaml(split.frontmatter) as unknown) : null;
    if (d && typeof d === "object" && !Array.isArray(d)) fm = d as Record<string, unknown>;
  } catch {
    /* parseSkillMd already warned and read it leniently */
  }
  const globsRaw = fm.globs ?? fm.paths;
  const globs = typeof globsRaw === "string" ? globsRaw.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(globsRaw) ? globsRaw.filter((g): g is string => typeof g === "string").map((g) => g.trim()).filter(Boolean) : [];
  if (globs.length > 50) issues.push({ level: "error", field: "globs", message: "at most 50 patterns" });
  for (const g of globs)
    if (g.length > 200 || g.startsWith("/") || g.includes("..")) issues.push({ level: "error", field: "globs", message: `"${g}" must be a relative pattern inside the project` });
  if (fm.alwaysApply !== undefined && typeof fm.alwaysApply !== "boolean") issues.push({ level: "error", field: "alwaysApply", message: "must be true or false" });
  const alwaysApply = fm.alwaysApply === true;
  if (alwaysApply && globs.length) issues.push({ level: "warning", field: "globs", message: "ignored because alwaysApply is true" });
  if (!res.skill.body.trim()) issues.push({ level: "error", field: RULE_FILE, message: "the rule has no body" });
  if (issues.some((i) => i.level === "error")) return null;
  const mode: RuleSpec["mode"] = alwaysApply ? "always" : globs.length ? "globs" : "agent";
  return {
    kind: "rule",
    skill: { ...res.skill, tools: res.skill.tools.length ? res.skill.tools : ["claude", "codex", "cursor"] },
    plugin: null,
    rule: { globs: alwaysApply ? [] : globs, alwaysApply, mode },
  };
}

/** Recognise and parse any package. `dirName` must equal the declared name. */
export function parsePackage(files: PackageFile[], dirName: string): { pkg: ParsedPackage | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const { kind, issue } = detectKind(files.map((f) => f.path));
  if (!kind) {
    issues.push({ level: "error", field: "files", message: issue! });
    return { pkg: null, issues };
  }
  if (kind === "skill") {
    const f = files.find((x) => x.path === SKILL_FILE)!;
    if (f.text === null) {
      issues.push({ level: "error", field: SKILL_FILE, message: "must be UTF-8 text" });
      return { pkg: null, issues };
    }
    const r = parseSkillMd(f.text, dirName);
    issues.push(...r.issues);
    return { pkg: r.skill && !r.issues.some((i) => i.level === "error") ? { kind, skill: r.skill, plugin: null, rule: null } : null, issues };
  }
  const pkg = kind === "plugin" ? parsePlugin(files, dirName, issues) : parseRule(files, dirName, issues);
  return { pkg, issues };
}

// ---------- rendering a rule for each tool ----------

function ruleBody(text: string): string {
  return (splitFrontmatter(text)?.body ?? text).replace(/^\s+/, "");
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

/** Cursor: `.cursor/rules/<name>.mdc`. */
export function renderCursorRule(description: string, rule: RuleSpec, ruleMd: string): string {
  const fm = [
    "---",
    `description: ${yamlString(description)}`,
    ...(rule.globs.length ? [`globs: ${rule.globs.join(",")}`] : []),
    `alwaysApply: ${rule.alwaysApply}`,
    "---",
  ];
  return `${fm.join("\n")}\n${ruleBody(ruleMd)}`;
}

/**
 * Claude Code: `.claude/rules/<name>.md`. A rule with globs becomes path-scoped; any other rule
 * loads every session, because Claude Code has no "agent decides" mode for rules.
 */
export function renderClaudeRule(rule: RuleSpec, ruleMd: string): string {
  const body = ruleBody(ruleMd);
  if (!rule.globs.length) return body;
  return `---\npaths:\n${rule.globs.map((g) => `  - ${yamlString(g)}`).join("\n")}\n---\n${body}`;
}

const blockStart = (name: string) => `<!-- intra-skills:rule ${name} begin`;
const blockEnd = (name: string) => `<!-- intra-skills:rule ${name} end -->`;

/** Codex (and any AGENTS.md reader): one marked block per rule, which the CLI can update or remove. */
export function renderAgentsBlock(name: string, version: string, description: string, rule: RuleSpec, ruleMd: string): string {
  const scope = rule.globs.length ? `Applies to files matching: ${rule.globs.map((g) => `\`${g}\``).join(", ")}.\n\n` : "";
  return [
    `${blockStart(name)} ${version} (managed by intra; change the rule in the registry, not here) -->`,
    `## ${name}`,
    "",
    description,
    "",
    `${scope}${ruleBody(ruleMd).trimEnd()}`,
    blockEnd(name),
  ].join("\n");
}

/** Insert or replace one rule's block in an AGENTS.md, leaving everything else untouched. */
export function upsertAgentsBlock(existing: string, name: string, block: string): string {
  const start = existing.indexOf(blockStart(name));
  const endTag = blockEnd(name);
  const end = start >= 0 ? existing.indexOf(endTag, start) : -1;
  if (start >= 0 && end >= 0) return existing.slice(0, start) + block + existing.slice(end + endTag.length);
  const sep = existing.length === 0 ? "" : existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return `${existing}${sep}${block}\n`;
}

/** Remove one rule's block; returns the text unchanged when the block is absent. */
export function removeAgentsBlock(existing: string, name: string): string {
  const start = existing.indexOf(blockStart(name));
  const endTag = blockEnd(name);
  const end = start >= 0 ? existing.indexOf(endTag, start) : -1;
  if (start < 0 || end < 0) return existing;
  return (existing.slice(0, start) + existing.slice(end + endTag.length)).replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

/** The version stamped in an AGENTS.md block, or null when the rule has no block there. */
export function agentsBlockVersion(existing: string, name: string): string | null {
  const re = new RegExp(`${blockStart(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\S+)`);
  return re.exec(existing)?.[1] ?? null;
}
