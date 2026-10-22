// A consistent copy of a data directory while the server keeps running: SQLite's online backup of
// registry.db (a plain file copy can catch the database mid-write) plus secret.key, which the
// stored git credentials cannot be decrypted without. Restore = stop the server, put both back.
import { DatabaseSync, backup } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

export interface BackupResult {
  database: string;
  /** null when the key comes from INTRA_SKILLS_SECRET_KEY instead of a file. */
  secretKey: string | null;
}

export async function backupDataDir(dataDir: string, toDir: string): Promise<BackupResult> {
  const source = join(dataDir, "registry.db");
  if (!existsSync(source)) throw new Error(`no registry.db in ${dataDir}`);
  if (existsSync(toDir) && readdirSync(toDir).length > 0) throw new Error(`${toDir} is not empty; pick a new folder`);
  mkdirSync(toDir, { recursive: true, mode: 0o700 });
  const database = join(toDir, "registry.db");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, database);
  } finally {
    db.close();
  }
  chmodSync(database, 0o600);
  const keyFile = join(dataDir, "secret.key");
  let secretKey: string | null = null;
  if (existsSync(keyFile)) {
    secretKey = join(toDir, "secret.key");
    copyFileSync(keyFile, secretKey);
    chmodSync(secretKey, 0o600);
  }
  return { database, secretKey };
}

/**
 * Put a backup back into a data directory. The server must be stopped first. A stale
 * registry.db-wal left beside the restored file would be replayed onto it, so both SQLite side
 * files go; the database is copied in under a temporary name and renamed, so a failed copy never
 * leaves half a database behind.
 */
export function restoreDataDir(fromDir: string, dataDir: string): BackupResult {
  const source = join(fromDir, "registry.db");
  if (!existsSync(source)) throw new Error(`no registry.db in ${fromDir}`);
  const check = new DatabaseSync(source, { readOnly: true });
  try {
    const ok = check.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (ok.integrity_check !== "ok") throw new Error(`${source} fails SQLite's integrity check: ${ok.integrity_check}`);
  } finally {
    check.close();
  }
  mkdirSync(dataDir, { recursive: true });
  const database = join(dataDir, "registry.db");
  const temp = `${database}.restoring`;
  copyFileSync(source, temp);
  chmodSync(temp, 0o600);
  for (const side of ["-wal", "-shm"]) rmSync(database + side, { force: true });
  renameSync(temp, database);
  let secretKey: string | null = null;
  const key = join(fromDir, "secret.key");
  if (existsSync(key)) {
    secretKey = join(dataDir, "secret.key");
    copyFileSync(key, secretKey);
    chmodSync(secretKey, 0o600);
  }
  return { database, secretKey };
}
