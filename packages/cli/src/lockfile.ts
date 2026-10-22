// skills.lock.json (project) and installed.json (global). Stable key order, trailing newline.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PackageKind, ToolId } from "@intra-skills/shared";
import { CliError } from "./errors.js";
import { installedPath, LOCKFILE } from "./paths.js";

/** A file intra rendered for a rule, path relative to the project root, and the sha256 of what it wrote. */
export interface RenderedFile {
  path: string;
  /** For AGENTS.md: the sha256 of this rule's block only, not of the whole file. */
  sha256: string;
}

export interface LockEntry {
  /** Absent means "skill", so lockfiles written before package kinds read (and re-serialize) unchanged. */
  kind?: PackageKind;
  range: string;
  version: string;
  sha256: string;
  targets: ToolId[];
  /** Plugins: the Claude Code scope it was installed at. */
  scope?: "user" | "project";
  /** Rules: what intra wrote for each target, so a file it did not write is never overwritten. */
  rendered?: Partial<Record<ToolId, RenderedFile>>;
}

export interface Lockfile {
  lockfileVersion: 1;
  registry: string;
  skills: Record<string, LockEntry>;
}

export interface InstalledEntry extends LockEntry {
  installedAt: string;
}

export type Installed = Record<string, InstalledEntry>;

function readJson<T>(p: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(p, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(`${p} is not valid JSON; fix or delete it`, "corrupt");
  }
}

function sortedKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k] as T]));
}

const TOOL_ORDER: ToolId[] = ["claude", "codex", "cursor"];
export const sortTargets = (t: ToolId[]): ToolId[] => TOOL_ORDER.filter((x) => t.includes(x));

export const kindOf = (e: { kind?: PackageKind }): PackageKind => e.kind ?? "skill";

/** One entry in stable key order; `kind` is written only for non-skills. */
export function serializeEntry(e: LockEntry): LockEntry {
  const out: LockEntry = { ...(e.kind && e.kind !== "skill" ? { kind: e.kind } : {}), range: e.range, version: e.version, sha256: e.sha256, targets: sortTargets(e.targets) };
  if (e.scope) out.scope = e.scope;
  if (e.rendered) {
    const r: Partial<Record<ToolId, RenderedFile>> = {};
    for (const t of TOOL_ORDER) if (e.rendered[t]) r[t] = { path: e.rendered[t]!.path, sha256: e.rendered[t]!.sha256 };
    out.rendered = r;
  }
  return out;
}

export const lockfilePath = (root: string): string => join(root, LOCKFILE);

export function readLockfile(root: string): Lockfile | null {
  const data = readJson<Lockfile>(lockfilePath(root));
  if (!data) return null;
  if (data.lockfileVersion !== 1) throw new CliError(`${lockfilePath(root)} has unsupported lockfileVersion ${String(data.lockfileVersion)}`, "corrupt");
  return { lockfileVersion: 1, registry: data.registry, skills: data.skills ?? {} };
}

export function serializeLockfile(lock: Lockfile): string {
  const skills: Record<string, LockEntry> = {};
  for (const [name, e] of Object.entries(sortedKeys(lock.skills)))
    skills[name] = serializeEntry(e);
  return JSON.stringify({ lockfileVersion: 1, registry: lock.registry, skills }, null, 2) + "\n";
}

export function writeLockfile(root: string, lock: Lockfile): void {
  writeFileSync(lockfilePath(root), serializeLockfile(lock));
}

export function readInstalled(): Installed {
  return readJson<Installed>(installedPath()) ?? {};
}

export function writeInstalled(data: Installed): void {
  const out: Installed = {};
  for (const [name, e] of Object.entries(sortedKeys(data)))
    out[name] = { ...serializeEntry(e), installedAt: e.installedAt };
  mkdirSync(dirname(installedPath()), { recursive: true });
  writeFileSync(installedPath(), JSON.stringify(out, null, 2) + "\n");
}
