// Content hashing for skill bundles. Node-only (node:crypto).
// The bundle hash is defined over sorted (path, mode, sha256(content)) triples, so it is
// independent of file order and identical on the server and in the CLI.
import { createHash } from "node:crypto";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function bundleSha256(files: { path: string; mode: number; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\0${normalizeMode(f.mode).toString(8)}\0${f.sha256}\n`);
  return sha256Hex(lines.join(""));
}

/** Only the executable bit is meaningful across machines: 0o755 or 0o644. */
export function normalizeMode(mode: number): number {
  return mode & 0o111 ? 0o755 : 0o644;
}
