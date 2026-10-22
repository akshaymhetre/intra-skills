// Every filesystem location the CLI touches. All of them are computed at CALL time from the
// environment, never captured at import, so tests (and users) can redirect HOME and
// INTRA_SKILLS_HOME without the CLI ever writing to the real ~/.claude, ~/.agents or ~/.cursor.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TOOL_DIRS, type ToolId } from "@intra-skills/shared";

export function homeDir(): string {
  return process.env.HOME || homedir();
}

/** `$INTRA_SKILLS_HOME`, default `~/.intra-skills`. */
export function intraHome(): string {
  const h = process.env.INTRA_SKILLS_HOME;
  return h ? resolve(h) : join(homeDir(), ".intra-skills");
}

export const configPath = (): string => join(intraHome(), "config.json");
export const installedPath = (): string => join(intraHome(), "installed.json");
export const storeRoot = (): string => join(intraHome(), "store");
export const storePath = (name: string, version: string): string => join(storeRoot(), name, version);
export const backupRoot = (): string => join(intraHome(), "backup");
/** Which registries' Claude Code plugin marketplaces are connected. Never holds a key. */
export const pluginStatePath = (): string => join(intraHome(), "plugins.json");

export const LOCKFILE = "skills.lock.json";
export const MARKER = ".intra-skill.json";

/** Directory a tool reads global skills from, e.g. `~/.claude/skills`. */
export function globalToolDir(tool: ToolId): string {
  return join(homeDir(), TOOL_DIRS[tool].global);
}

/** Directory a tool reads project skills from, e.g. `<root>/.claude/skills`. */
export function projectToolDir(root: string, tool: ToolId): string {
  return join(root, TOOL_DIRS[tool].project);
}

/** Nearest ancestor of `start` (inclusive) containing `.git`, else `start` itself. */
export function findProjectRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
