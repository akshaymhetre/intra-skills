// Reading a skill directory into bundle files, and scanning them for secrets before upload.
// The secret patterns live in @intra-skills/shared so the server refuses exactly what the CLI does.
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { IGNORED_NAMES, normalizeMode, sha256Hex, bundleSha256, scanSecrets as scanSharedSecrets, type SecretHit } from "@intra-skills/shared";
import { CliError } from "./errors.js";

export interface LocalFile {
  path: string;
  mode: number;
  data: Buffer;
}

function within(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && rel !== "..");
}

/**
 * Collect every file under `dir` (POSIX relative paths, sorted). Skips IGNORED_NAMES at any depth.
 * Symlinks are followed only when they resolve INSIDE the skill dir; one pointing outside is refused.
 */
export function collectFiles(dir: string): LocalFile[] {
  const root = realpathSync(dir);
  const out: LocalFile[] = [];
  const visited = new Set<string>([root]);
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs).sort()) {
      if (IGNORED_NAMES.has(entry)) continue;
      const full = join(abs, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st = lstatSync(full);
      let real = full;
      if (st.isSymbolicLink()) {
        try {
          real = realpathSync(full);
        } catch {
          throw new CliError(`${relPath} is a broken symlink; remove it or point it at a file inside the skill`, "symlink");
        }
        if (!within(root, real))
          throw new CliError(`${relPath} is a symlink pointing outside the skill directory (${real}); copy the file in instead`, "symlink");
        st = statSync(real);
      }
      if (st.isDirectory()) {
        if (visited.has(real)) continue; // in-dir symlink loop
        visited.add(real);
        walk(real, relPath);
      } else if (st.isFile()) {
        out.push({ path: relPath, mode: normalizeMode(st.mode), data: readFileSync(real) });
      }
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** bundleSha256 over the files currently on disk in `dir` (marker and IGNORED_NAMES excluded). */
export function hashDir(dir: string): string {
  return bundleSha256(collectFiles(dir).map((f) => ({ path: f.path, mode: f.mode, sha256: sha256Hex(f.data) })));
}

export type { SecretHit } from "@intra-skills/shared";

export function isBinary(data: Buffer): boolean {
  return data.subarray(0, 8000).includes(0);
}

/** The shared secret patterns (also run by the server) over local files; binary files are skipped. */
export function scanSecrets(files: LocalFile[]): SecretHit[] {
  return scanSharedSecrets(files.map((f) => ({ path: f.path, text: isBinary(f.data) ? null : f.data.toString("utf8") })));
}
