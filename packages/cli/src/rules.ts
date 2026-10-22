// Rules. The registry stores RULE.md as written; intra renders it per tool into the PROJECT:
//   cursor  .cursor/rules/<name>.mdc        (Cursor reads project rules only from here; user rules are not files)
//   claude  .claude/rules/<name>.md
//   codex   one managed block in the project's root AGENTS.md
// Ownership is by content hash: the lockfile records the sha256 of what intra wrote, and a file
// (or AGENTS.md block) whose content does not match is never overwritten or deleted without --force,
// which backs it up first.
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  parsePackage,
  removeAgentsBlock,
  renderAgentsBlock,
  renderClaudeRule,
  renderCursorRule,
  sha256Hex,
  upsertAgentsBlock,
  RULE_FILE,
  type RuleSpec,
  type ToolId,
} from "@intra-skills/shared";
import type { Api } from "./api.js";
import { CliError } from "./errors.js";
import type { LockEntry, RenderedFile } from "./lockfile.js";
import { backupRoot } from "./paths.js";
import { tmpName, verifyBundle } from "./store.js";

export const RULE_TARGETS: ToolId[] = ["claude", "codex", "cursor"];
export const AGENTS_MD = "AGENTS.md";

/** Project-relative path a tool reads this rule from. */
export function rulePath(tool: ToolId, name: string): string {
  if (tool === "cursor") return `.cursor/rules/${name}.mdc`;
  if (tool === "claude") return `.claude/rules/${name}.md`;
  return AGENTS_MD;
}

export interface RuleContent {
  name: string;
  version: string;
  description: string;
  rule: RuleSpec;
  ruleMd: string;
}

/** The exact text intra writes for a tool: a whole file (cursor, claude) or the AGENTS.md block (codex). */
export function renderFor(tool: ToolId, c: RuleContent): string {
  if (tool === "cursor") return renderCursorRule(c.description, c.rule, c.ruleMd);
  if (tool === "claude") return renderClaudeRule(c.rule, c.ruleMd);
  return renderAgentsBlock(c.name, c.version, c.description, c.rule, c.ruleMd);
}

/** The markers of a rule's AGENTS.md block, read off the shared renderer so the two cannot drift. */
function blockMarkers(name: string): { start: string; end: string } {
  const lines = renderAgentsBlock(name, "0.0.0", "", { globs: [], alwaysApply: false, mode: "agent" }, "x").split("\n");
  const first = lines[0]!;
  return { start: first.slice(0, first.indexOf(" begin") + " begin".length), end: lines[lines.length - 1]! };
}

/** This rule's block in an AGENTS.md text, markers included; null when absent. */
export function readAgentsBlock(text: string, name: string): string | null {
  const { start, end } = blockMarkers(name);
  const s = text.indexOf(`${start} `);
  if (s < 0) return null;
  const e = text.indexOf(end, s);
  return e < 0 ? null : text.slice(s, e + end.length);
}

export type RuleTargetState =
  | { kind: "missing" }
  /** On disk and byte-identical to what intra recorded writing. */
  | { kind: "ours"; current: string }
  /** intra wrote it and someone edited it since. */
  | { kind: "modified"; current: string }
  /** Present, but intra has no record of writing it. */
  | { kind: "foreign"; current: string };

function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function ruleTargetState(root: string, tool: ToolId, name: string, recorded: RenderedFile | undefined): RuleTargetState {
  const file = readText(join(root, rulePath(tool, name)));
  const current = tool === "codex" ? (file === null ? null : readAgentsBlock(file, name)) : file;
  if (current === null) return { kind: "missing" };
  if (!recorded) return { kind: "foreign", current };
  return sha256Hex(Buffer.from(current, "utf8")) === recorded.sha256 ? { kind: "ours", current } : { kind: "modified", current };
}

let stamp: string | null = null;
/** Copy a file aside before it is overwritten (AGENTS.md is shared, so it is copied, never moved). */
function backupCopy(p: string, label: string): string {
  stamp ??= new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupRoot(), stamp, label);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(p, dest);
  return dest;
}

function writeAtomic(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true });
  const tmp = join(dirname(p), tmpName(".rule"));
  writeFileSync(tmp, text);
  renameSync(tmp, p);
}

/** Download, verify and parse a rule version into what the renderers take. */
export async function fetchRule(api: Api, name: string, version: string, expectSha256?: string): Promise<{ content: RuleContent; sha256: string }> {
  const bundle = await api.bundle(name, version);
  const files = verifyBundle(bundle, { name, version, sha256: expectSha256 });
  const { pkg, issues } = parsePackage(
    files.map((f) => ({ path: f.path, text: f.data.includes(0) ? null : f.data.toString("utf8") })),
    name,
  );
  if (!pkg || pkg.kind !== "rule" || !pkg.rule)
    throw new CliError(
      `${name}@${version} is not a valid rule${issues.length ? `: ${issues.filter((i) => i.level === "error").map((i) => i.message).join("; ")}` : ""}`,
      "invalid_rule",
    );
  const ruleMd = files.find((f) => f.path === RULE_FILE)!.data.toString("utf8");
  return { content: { name, version, description: pkg.skill.description, rule: pkg.rule, ruleMd }, sha256: bundle.sha256 };
}

export interface RuleInstallResult {
  name: string;
  version: string;
  sha256: string;
  targets: ToolId[];
  /** Absolute paths written. */
  paths: string[];
  backups: string[];
  rendered: Partial<Record<ToolId, RenderedFile>>;
}

/**
 * Render one rule version into a project. Every ownership check runs BEFORE anything is written.
 * `repair` (sync) restores files intra wrote that were edited since, backing each up first;
 * `force` also takes over files intra has no record of.
 */
export async function installRule(opts: {
  api: Api;
  name: string;
  version: string;
  root: string;
  targets: ToolId[];
  prev: LockEntry | undefined;
  force: boolean;
  repair?: boolean;
  expectSha256?: string;
}): Promise<RuleInstallResult> {
  const { api, name, version, root, targets, prev, force } = opts;
  const { content, sha256 } = await fetchRule(api, name, version, opts.expectSha256);
  const plan = targets.map((tool) => {
    const desired = renderFor(tool, content);
    const state = ruleTargetState(root, tool, name, prev?.rendered?.[tool]);
    const differs = state.kind !== "missing" && state.current !== desired;
    const takeover = differs && (state.kind === "foreign" || state.kind === "modified");
    const allowed = !takeover || force || (opts.repair === true && state.kind === "modified");
    return { tool, desired, state, takeover, allowed, path: join(root, rulePath(tool, name)) };
  });
  const blocked = plan.filter((p) => !p.allowed);
  if (blocked.length) {
    const what = blocked.map((b) => (b.tool === "codex" ? `the ${name} block in ${b.path}` : b.path));
    throw new CliError(
      `refusing to overwrite ${what.join(", ")}: ${blocked.some((b) => b.state.kind === "modified") ? "changed since intra wrote it" : "not written by intra"}. ` +
        `Move it away, or re-run with --force to back it up to ${backupRoot()}/<timestamp>/`,
      "unmanaged_target",
      1,
      { paths: blocked.map((b) => b.path) },
    );
  }
  const backups: string[] = [];
  const rendered: Partial<Record<ToolId, RenderedFile>> = {};
  for (const p of plan) {
    if (p.takeover) backups.push(backupCopy(p.path, `project-${p.tool}/${rulePath(p.tool, name).replace(/\//g, "_")}`));
    if (p.tool === "codex") {
      const existing = readText(p.path) ?? "";
      writeAtomic(p.path, upsertAgentsBlock(existing, name, p.desired));
    } else writeAtomic(p.path, p.desired);
    rendered[p.tool] = { path: rulePath(p.tool, name), sha256: sha256Hex(Buffer.from(p.desired, "utf8")) };
  }
  return { name, version, sha256, targets, paths: plan.map((p) => p.path), backups, rendered };
}

/**
 * Remove a rule's rendered files and AGENTS.md block. Only content that still matches what intra
 * wrote is removed; anything else is reported and left alone unless `force`.
 */
export function removeRule(root: string, name: string, entry: LockEntry | undefined, targets: ToolId[], force: boolean): { removed: { target: ToolId; path: string }[]; left: { target: ToolId; label: string }[] } {
  const removed: { target: ToolId; path: string }[] = [];
  const left: { target: ToolId; label: string }[] = [];
  for (const tool of targets) {
    const p = join(root, rulePath(tool, name));
    const st = ruleTargetState(root, tool, name, entry?.rendered?.[tool]);
    if (st.kind === "missing") continue;
    if (st.kind !== "ours" && !force) {
      left.push({ target: tool, label: tool === "codex" ? `the ${name} block in ${p}` : p });
      continue;
    }
    if (tool === "codex") {
      const next = removeAgentsBlock(readText(p) ?? "", name);
      if (next.trim() === "") rmSync(p, { force: true });
      else writeAtomic(p, next);
    } else rmSync(p, { force: true });
    removed.push({ target: tool, path: p });
  }
  return { removed, left };
}

export interface RuleDrift {
  action: "install" | "reinstall";
  target: ToolId;
  path: string;
  reason: string;
}

/** Pure read: what differs between a locked rule and the project's files. */
export function planRuleSync(root: string, name: string, e: LockEntry): RuleDrift[] {
  const out: RuleDrift[] = [];
  for (const tool of e.targets) {
    const path = join(root, rulePath(tool, name));
    const rec = e.rendered?.[tool];
    const st = ruleTargetState(root, tool, name, rec);
    if (!rec) out.push({ action: "install", target: tool, path, reason: "not rendered yet" });
    else if (st.kind === "missing") out.push({ action: "install", target: tool, path, reason: tool === "codex" ? "the AGENTS.md block is missing" : "missing" });
    else if (st.kind !== "ours")
      out.push({ action: "reinstall", target: tool, path, reason: tool === "codex" ? "the AGENTS.md block was edited by hand" : "the rendered file was edited by hand" });
  }
  return out;
}
