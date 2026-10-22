// Bundle verification and the global content store ($INTRA_SKILLS_HOME/store/<name>/<version>).
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bundleSha256,
  isSafeRelativePath,
  normalizeMode,
  sha256Hex,
  validateBundleFiles,
  type Bundle,
} from "@intra-skills/shared";
import { CliError } from "./errors.js";
import { MARKER, storePath } from "./paths.js";

export interface DecodedFile {
  path: string;
  mode: number;
  data: Buffer;
}

export interface Marker {
  name: string;
  version: string;
  sha256: string;
  registry: string;
}

/**
 * Recompute every file's sha256 and the bundle sha256 and compare with what the registry claimed
 * (and, when given, with what a lockfile pinned). Refuses on any mismatch or unsafe path.
 */
export function verifyBundle(bundle: Bundle, expect: { name: string; version: string; sha256?: string }): DecodedFile[] {
  if (bundle.name !== expect.name || bundle.version !== expect.version)
    throw new CliError(
      `registry returned ${bundle.name}@${bundle.version} when ${expect.name}@${expect.version} was asked for; refusing`,
      "integrity",
    );
  const files: DecodedFile[] = bundle.files.map((f) => ({
    path: f.path,
    mode: normalizeMode(f.mode),
    data: Buffer.from(f.contentBase64, "base64"),
  }));
  const issues = validateBundleFiles(files.map((f) => ({ path: f.path, size: f.data.length }))).filter((i) => i.level === "error");
  if (issues.length)
    throw new CliError(`${expect.name}@${expect.version} bundle is invalid: ${issues.map((i) => i.message).join("; ")}`, "integrity");
  for (const f of files)
    if (!isSafeRelativePath(f.path)) throw new CliError(`bundle contains unsafe path "${f.path}"; refusing`, "integrity");
  const actual = bundleSha256(files.map((f) => ({ path: f.path, mode: f.mode, sha256: sha256Hex(f.data) })));
  if (actual !== bundle.sha256)
    throw new CliError(
      `integrity check failed for ${expect.name}@${expect.version}: registry says sha256 ${bundle.sha256}, content hashes to ${actual}; nothing was installed`,
      "integrity",
    );
  if (expect.sha256 && expect.sha256 !== actual)
    throw new CliError(
      `integrity check failed for ${expect.name}@${expect.version}: lockfile pins sha256 ${expect.sha256}, registry content hashes to ${actual}; nothing was installed`,
      "integrity",
    );
  return files;
}

/** Write `files` + marker into a NEW directory `dir` (which must not exist). */
export function writeFilesTo(dir: string, files: DecodedFile[], marker: Marker): void {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const p = join(dir, ...f.path.split("/"));
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.data, { mode: f.mode });
    chmodSync(p, f.mode);
  }
  writeFileSync(join(dir, MARKER), JSON.stringify(marker, null, 2) + "\n");
}

export function readMarker(dir: string): Marker | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as Marker;
    return typeof m.name === "string" && typeof m.version === "string" ? m : null;
  } catch {
    return null;
  }
}

export function tmpName(prefix: string): string {
  return `${prefix}.intra-tmp-${randomBytes(4).toString("hex")}`;
}

/** Extract a verified bundle into the store via temp dir + atomic rename. Idempotent. */
export function ensureStore(files: DecodedFile[], marker: Marker): string {
  const dest = storePath(marker.name, marker.version);
  const existing = existsSync(dest) ? readMarker(dest) : null;
  if (existing && existing.sha256 === marker.sha256) return dest;
  const tmp = join(dirname(dest), tmpName(`.${marker.version}`));
  writeFilesTo(tmp, files, marker);
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true }); // corrupt or partial entry
  try {
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    if (!existsSync(dest)) throw err; // someone else won the race otherwise
  }
  return dest;
}
