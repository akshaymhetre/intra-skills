// A plugin version as a ZIP archive with the plugin root at the top. The bytes are deterministic
// (zip.ts), so their sha256 is computed the first time the archive is built and stored on the
// version; marketplace.json lists it without rebuilding.
import { sha256Hex } from "@intra-skills/shared";
import type { Db } from "./db.js";
import { loadFiles } from "./publish.js";
import { buildZip } from "./zip.js";

export function buildArchive(db: Db, versionId: number): Buffer {
  return buildZip(loadFiles(db, versionId).map((f) => ({ path: f.path, mode: f.mode, content: f.content })));
}

/** Store the archive's sha256 once; a stored value is never overwritten. Returns the stored value. */
export function recordArchiveSha(db: Db, versionId: number, sha256: string): string {
  db.prepare("UPDATE versions SET archive_sha256 = ? WHERE id = ? AND archive_sha256 IS NULL").run(sha256, versionId);
  const r = db.prepare("SELECT archive_sha256 FROM versions WHERE id = ?").get(versionId) as { archive_sha256: string | null } | undefined;
  return r?.archive_sha256 ?? sha256;
}

/** The archive and its sha256, recording the sha256 on first build. */
export function pluginArchive(db: Db, versionId: number): { bytes: Buffer; sha256: string } {
  const bytes = buildArchive(db, versionId);
  const sha256 = sha256Hex(bytes);
  recordArchiveSha(db, versionId, sha256);
  return { bytes, sha256 };
}

/** The stored sha256, building the archive once when none is stored yet. */
export function archiveSha(db: Db, versionId: number, stored: string | null): string {
  return stored ?? pluginArchive(db, versionId).sha256;
}
