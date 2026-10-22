// Placing a verified skill into tool directories, safely.
// Global: symlink <home>/<tool dir>/<name> -> store. Project: a copy plus a marker file.
// A path we did not create (not a link into our store, no marker) is never overwritten:
// refused, or with --force moved to $INTRA_SKILLS_HOME/backup/<timestamp>/.
import { cpSync, lstatSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TOOL_DIRS, type ToolId } from "@intra-skills/shared";
import type { Api } from "./api.js";
import { CliError } from "./errors.js";
import { backupRoot, globalToolDir, projectToolDir, storeRoot } from "./paths.js";
import { ensureStore, readMarker, tmpName, verifyBundle, writeFilesTo, type DecodedFile } from "./store.js";

export type Scope = { kind: "global" } | { kind: "project"; root: string };

export type TargetState =
  | { kind: "missing" }
  | { kind: "link"; target: string; dangling: boolean } // managed: symlink into our store
  | { kind: "managed-dir"; version: string | null } // managed: directory carrying our marker
  | { kind: "unmanaged" };

export function targetPath(scope: Scope, tool: ToolId, name: string): string {
  return join(scope.kind === "global" ? globalToolDir(tool) : projectToolDir(scope.root, tool), name);
}

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep);
}

export function classify(p: string, name: string): TargetState {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return { kind: "missing" };
  }
  if (st.isSymbolicLink()) {
    const target = resolve(dirname(p), readlinkSync(p));
    if (!isInside(storeRoot(), target)) return { kind: "unmanaged" };
    let dangling = false;
    try {
      lstatSync(target);
    } catch {
      dangling = true;
    }
    return { kind: "link", target, dangling };
  }
  if (st.isDirectory()) {
    const marker = readMarker(p);
    if (marker && marker.name === name) return { kind: "managed-dir", version: marker.version };
  }
  return { kind: "unmanaged" };
}

export const isManaged = (s: TargetState): boolean => s.kind === "link" || s.kind === "managed-dir";

let backupStamp: string | null = null;
/** Move an unmanaged path aside rather than deleting it. Returns where it went. */
export function backup(p: string, label: string): string {
  backupStamp ??= new Date().toISOString().replace(/[:.]/g, "-");
  const dest = join(backupRoot(), backupStamp, label);
  mkdirSync(dirname(dest), { recursive: true });
  try {
    renameSync(p, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    cpSync(p, dest, { recursive: true, verbatimSymlinks: true });
    rmSync(p, { recursive: true, force: true });
  }
  return dest;
}

/** Remove a managed target (link or marked dir). Never call on an unmanaged path. */
export function removeManaged(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** Point `link` at `target`, replacing a managed link atomically (symlink + rename). */
export function swapLink(link: string, target: string, state: TargetState): void {
  mkdirSync(dirname(link), { recursive: true });
  if (state.kind === "managed-dir") removeManaged(link);
  const tmp = join(dirname(link), tmpName(`.${relative(dirname(link), link)}`));
  symlinkSync(target, tmp, "dir");
  renameSync(tmp, link);
}

/** Replace a managed (or missing) directory with a fresh copy via temp dir + rename. */
export function swapDir(dest: string, files: DecodedFile[], marker: Parameters<typeof writeFilesTo>[2], state: TargetState): void {
  mkdirSync(dirname(dest), { recursive: true });
  const base = relative(dirname(dest), dest);
  const tmp = join(dirname(dest), tmpName(`.${base}`));
  writeFilesTo(tmp, files, marker);
  if (state.kind === "missing") {
    renameSync(tmp, dest);
    return;
  }
  const old = join(dirname(dest), tmpName(`.${base}.old`));
  renameSync(dest, old);
  renameSync(tmp, dest);
  rmSync(old, { recursive: true, force: true });
}

export interface InstallResult {
  name: string;
  version: string;
  sha256: string;
  targets: ToolId[];
  paths: string[];
  backups: string[];
}

export interface InstallOptions {
  api: Api;
  name: string;
  version: string;
  targets: ToolId[];
  scope: Scope;
  force: boolean;
  /** Global only: copy files (with a marker) instead of symlinking into the store. */
  copy?: boolean;
  /** Pin from a lockfile: the bundle must hash to exactly this. */
  expectSha256?: string;
}

/**
 * Download, verify and place one exact version. Every check (integrity, unmanaged targets)
 * runs BEFORE anything is written, so a refusal leaves the disk untouched.
 */
export async function installVersion(opts: InstallOptions): Promise<InstallResult> {
  const { api, name, version, targets, scope, force } = opts;
  const bundle = await api.bundle(name, version);
  const files = verifyBundle(bundle, { name, version, sha256: opts.expectSha256 });

  const plan = targets.map((tool) => {
    const p = targetPath(scope, tool, name);
    return { tool, path: p, state: classify(p, name) };
  });
  const blocked = plan.filter((t) => t.state.kind === "unmanaged");
  if (blocked.length && !force) {
    throw new CliError(
      `refusing to overwrite ${blocked.map((b) => b.path).join(", ")}: not installed by intra. ` +
        `Move it away, or re-run with --force to back it up to ${backupRoot()}/<timestamp>/`,
      "unmanaged_target",
      1,
      { paths: blocked.map((b) => b.path) },
    );
  }

  const marker = { name, version, sha256: bundle.sha256, registry: api.registry };
  const backups: string[] = [];
  const store = scope.kind === "global" && !opts.copy ? ensureStore(files, marker) : null;
  for (const t of plan) {
    let state = t.state;
    if (state.kind === "unmanaged") {
      backups.push(backup(t.path, `${scope.kind}-${t.tool}/${name}`));
      state = { kind: "missing" };
    }
    if (store) swapLink(t.path, store, state);
    else swapDir(t.path, files, marker, state);
  }
  return { name, version, sha256: bundle.sha256, targets, paths: plan.map((p) => p.path), backups };
}

export function cursorDuplicateNote(targets: ToolId[]): string | null {
  if (targets.includes("cursor") && (targets.includes("claude") || targets.includes("codex")))
    return `note: Cursor also reads ${TOOL_DIRS.claude.project} and ${TOOL_DIRS.codex.project}, so it will see this skill more than once.`;
  return null;
}

/** Parse `name`, `name@1.2.0`, `name@^1`, `name@latest`. */
export function parseSpec(spec: string): { name: string; range: string | null } {
  const at = spec.indexOf("@", 1);
  if (at === -1) return { name: spec, range: null };
  return { name: spec.slice(0, at), range: spec.slice(at + 1) || null };
}
