// SKILL.md parsing and validation against the Agent Skills spec (agentskills.io/specification),
// plus the intra-skills facets carried in `metadata` (a string -> string map per the spec):
//
//   metadata:
//     version: "1.2.0"
//     team: platform
//     areas: "backend, infra"
//     tags: "aws, terraform"
//     tools: "claude, codex, cursor"
//     visibility: private
import { parse as parseYaml, parseDocument } from "yaml";
import { TOOLS, type ToolId, type Visibility } from "./types.js";
import { isValidVersion } from "./semver.js";

export const SKILL_FILE = "SKILL.md";
export const MAX_BUNDLE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 500;
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const TAG_RE = /^[a-z0-9][a-z0-9.+_-]{0,39}$/;
export const TEAM_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface ParsedSkill {
  name: string;
  description: string;
  license: string | null;
  compatibility: string | null;
  version: string | null;
  team: string | null;
  areas: string[];
  /** Tech stacks (react, terraform, python...) from metadata.stacks. */
  stacks: string[];
  tags: string[];
  tools: ToolId[];
  visibility: Visibility | null;
  metadata: Record<string, string>;
  body: string;
}

export interface ValidationIssue {
  level: "error" | "warning";
  field: string;
  message: string;
}

export class SkillParseError extends Error {
  constructor(public issues: ValidationIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join("; "));
    this.name = "SkillParseError";
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function splitFrontmatter(text: string): { frontmatter: string; body: string } | null {
  const m = FRONTMATTER_RE.exec(text.replace(/^﻿/, ""));
  if (!m) return null;
  return { frontmatter: m[1] ?? "", body: m[2] ?? "" };
}

/** Split a comma- or whitespace-separated list, lowercase, dedupe, keep order. */
export function splitList(value: string | undefined | null): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const raw of value.split(/[,\s]+/)) {
    const v = raw.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Parse SKILL.md text. Returns the parsed skill plus every issue found.
 * Errors make a skill unpublishable; warnings are advisory.
 * `dirName`, when given, must equal `name` (spec rule).
 */
export function parseSkillMd(
  text: string,
  dirName?: string,
): { skill: ParsedSkill | null; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const err = (field: string, message: string) => issues.push({ level: "error", field, message });
  const warn = (field: string, message: string) => issues.push({ level: "warning", field, message });

  const split = splitFrontmatter(text);
  if (!split) {
    err("frontmatter", "SKILL.md must start with YAML frontmatter between --- lines");
    return { skill: null, issues };
  }
  let data: unknown;
  try {
    data = parseYaml(split.frontmatter);
  } catch (e) {
    // Agents load SKILL.md leniently (an unquoted colon in the description is common and works in
    // Claude Code), so the registry must not refuse what every tool accepts. Fall back to reading
    // top-level `key: value` lines and say so.
    data = lenientFrontmatter(split.frontmatter);
    warn(
      "frontmatter",
      `not strict YAML (${firstLine((e as Error).message)}); read name and description leniently - quote the description to fix`,
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    err("frontmatter", "frontmatter must be a YAML mapping");
    return { skill: null, issues };
  }
  const fm = data as Record<string, unknown>;

  const name = typeof fm.name === "string" ? fm.name.trim() : "";
  if (!name) err("name", "required");
  else {
    if (name.length > 64) err("name", "max 64 characters");
    if (!NAME_RE.test(name))
      err("name", "lowercase letters, digits and single hyphens only; no leading or trailing hyphen");
    if (dirName !== undefined && dirName !== name)
      err("name", `must match the directory name ("${dirName}")`);
  }

  const description = typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) err("description", "required");
  else if (description.length > 1024) err("description", "max 1024 characters");
  else if (description.length < 40)
    warn("description", "short descriptions trigger poorly; say what it does AND when to use it");

  const license = typeof fm.license === "string" ? fm.license : null;
  let compatibility: string | null = null;
  if (fm.compatibility !== undefined) {
    if (typeof fm.compatibility !== "string" || fm.compatibility.length > 500)
      err("compatibility", "must be a string of at most 500 characters");
    else compatibility = fm.compatibility;
  }

  const metadata: Record<string, string> = {};
  if (fm.metadata !== undefined && fm.metadata !== null) {
    if (typeof fm.metadata !== "object" || Array.isArray(fm.metadata)) {
      err("metadata", "must be a mapping of string keys to string values");
    } else {
      for (const [k, v] of Object.entries(fm.metadata as Record<string, unknown>)) {
        if (typeof v === "string") metadata[k] = v;
        else if (typeof v === "number" || typeof v === "boolean") {
          metadata[k] = String(v);
          warn(`metadata.${k}`, "spec requires string values; quote it");
        } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
          metadata[k] = v.join(", ");
          warn(`metadata.${k}`, "spec requires string values; use a comma-separated string");
        } else warn(`metadata.${k}`, "spec requires string values; nested value ignored by the registry");
      }
    }
  }

  // metadata.version is the spec-compliant home; a top-level `version` is common in the wild.
  const rawVersion = metadata.version?.trim() || (typeof fm.version === "string" ? fm.version.trim() : "") || null;
  let version: string | null = rawVersion;
  if (rawVersion && !isValidVersion(rawVersion)) {
    warn("metadata.version", `"${rawVersion}" is not semver (x.y.z); ignored, the registry version is used`);
    version = null;
  }

  const team = metadata.team?.trim().toLowerCase() || null;
  if (team && !TEAM_RE.test(team)) err("metadata.team", "must be a team slug (lowercase, hyphens)");

  const areas = splitList(metadata.areas ?? metadata.area);
  const tags = splitList(metadata.tags);
  const stacks = splitList(metadata.stacks ?? metadata.stack);
  for (const t of [...areas, ...tags, ...stacks]) if (!TAG_RE.test(t)) err("metadata.tags", `invalid tag "${t}"`);

  let tools: ToolId[] = [...TOOLS];
  if (metadata.tools) {
    const listed = splitList(metadata.tools);
    const bad = listed.filter((t) => !(TOOLS as readonly string[]).includes(t));
    if (bad.length) err("metadata.tools", `unknown tool(s) ${bad.join(", ")}; use ${TOOLS.join(", ")}`);
    tools = listed.filter((t): t is ToolId => (TOOLS as readonly string[]).includes(t));
  }

  let visibility: Visibility | null = null;
  if (metadata.visibility) {
    const v = metadata.visibility.trim().toLowerCase();
    if (v === "org" || v === "private") visibility = v;
    else err("metadata.visibility", 'must be "org" or "private"');
  }

  if (split.body.trim().length === 0) warn("body", "SKILL.md has no instructions after the frontmatter");
  if (split.body.split("\n").length > 500) warn("body", "keep SKILL.md under 500 lines; move detail to references/");

  if (issues.some((i) => i.level === "error")) return { skill: null, issues };
  return {
    skill: {
      name,
      description,
      license,
      compatibility,
      version,
      team,
      areas,
      stacks,
      tags,
      tools,
      visibility,
      metadata,
      body: split.body,
    },
    issues,
  };
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

/** Read top-level `key: value` lines only. Used when the frontmatter is not strict YAML. */
function lenientFrontmatter(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const unquote = (v: string) =>
    (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
  let meta: Record<string, string> | null = null;
  for (const line of text.split(/\r?\n/)) {
    // Direct scalar children of `metadata:` (two-space indent); deeper nesting is skipped.
    const child = /^  ([A-Za-z][\w-]*):[ \t]*(\S.*)$/.exec(line);
    if (meta && child?.[1]) {
      if (!(child[1] in meta)) meta[child[1]] = unquote((child[2] ?? "").trim());
      continue;
    }
    if (/^\s/.test(line)) continue;
    meta = null;
    const m = /^([A-Za-z][\w-]*):[ \t]*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    const v = (m[2] ?? "").trim();
    if (m[1] === "metadata" && v === "") {
      meta = {};
      out.metadata = meta;
      continue;
    }
    if (v === "" || v.startsWith("|") || v.startsWith(">")) continue;
    if (!(m[1] in out)) out[m[1]] = unquote(v);
  }
  return out;
}

/**
 * Flatten SKILL.md frontmatter into display rows (`metadata.x` for one level of nesting).
 * Uses the real YAML parser, falling back to the lenient reader. Browser-safe.
 */
export function frontmatterRows(text: string): { rows: { key: string; value: string }[]; body: string } {
  const split = splitFrontmatter(text);
  if (!split) return { rows: [], body: text };
  let data: Record<string, unknown>;
  try {
    const parsed = parseYaml(split.frontmatter) as unknown;
    data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    data = lenientFrontmatter(split.frontmatter);
  }
  const show = (v: unknown): string =>
    typeof v === "string" ? v.trim() : Array.isArray(v) ? v.map(show).join(", ") : JSON.stringify(v);
  const rows: { key: string; value: string }[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) rows.push({ key: `${k}.${ck}`, value: show(cv) });
    } else rows.push({ key: k, value: show(v) });
  }
  return { rows, body: split.body };
}

/**
 * Validate a bundle's file list: paths, count and size. Which marker file a package needs
 * (SKILL.md, .claude-plugin/plugin.json or RULE.md) is decided by parsePackage in kinds.ts.
 */
export function validateBundleFiles(
  files: { path: string; size: number }[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (files.length > MAX_FILES)
    issues.push({ level: "error", field: "files", message: `too many files (${files.length} > ${MAX_FILES})` });
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > MAX_BUNDLE_BYTES)
    issues.push({ level: "error", field: "files", message: `bundle is ${total} bytes; limit is ${MAX_BUNDLE_BYTES}` });
  const seen = new Set<string>();
  for (const f of files) {
    if (!isSafeRelativePath(f.path))
      issues.push({ level: "error", field: "files", message: `unsafe path "${f.path}"` });
    if (seen.has(f.path))
      issues.push({ level: "error", field: "files", message: `duplicate path "${f.path}"` });
    seen.add(f.path);
  }
  return issues;
}

/** POSIX relative path, no `..`, no absolute, no backslashes, no empty segments. */
export function isSafeRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Return SKILL.md text with metadata.version set to `version`, preserving
 * the rest of the frontmatter and the body. Used by `intra publish --bump`.
 */
export function setSkillMdVersion(text: string, version: string): string {
  const split = splitFrontmatter(text);
  if (!split) throw new SkillParseError([{ level: "error", field: "frontmatter", message: "missing frontmatter" }]);
  const doc = parseDocument(split.frontmatter);
  if (doc.errors.length === 0) {
    doc.setIn(["metadata", "version"], version);
    // lineWidth 0: never re-wrap the author's lines.
    const fm = doc.toString({ lineWidth: 0 }).replace(/\n$/, "");
    return `---\n${fm}\n---\n${split.body}`;
  }
  // Not strict YAML: edit text so the rest of the author's frontmatter stays byte-identical.
  const lines = split.frontmatter.split("\n");
  const metaIdx = lines.findIndex((l) => /^metadata:\s*$/.test(l));
  const entry = `  version: "${version}"`;
  if (metaIdx === -1) lines.push("metadata:", entry);
  else {
    let i = metaIdx + 1;
    let replaced = false;
    for (; i < lines.length && /^\s+\S/.test(lines[i] ?? ""); i++) {
      if (/^  version:/.test(lines[i] ?? "")) {
        lines[i] = entry;
        replaced = true;
        break;
      }
    }
    if (!replaced) lines.splice(metaIdx + 1, 0, entry);
  }
  return `---\n${lines.join("\n")}\n---\n${split.body}`;
}

/** Files that never belong in a published bundle. */
export const IGNORED_NAMES = new Set([".DS_Store", ".git", "node_modules", ".intra-skill.json", "Thumbs.db"]);
