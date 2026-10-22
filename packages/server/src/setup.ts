// First-admin setup from the browser. While no real (non-system) user exists, the server keeps a
// one-time setup token in <data>/setup-token (mode 0600) and prints a link carrying it.
// The FILE is the single source of truth: POST /api/setup reads it next to the database, so the
// token survives restarts and nothing about it lands in the settings table (which GET /settings returns).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "./db.js";
import { needsSetup } from "./settings.js";

export const SETUP_TOKEN_FILE = "setup-token";
const SETUP_TOKEN_RE = /^ist_[A-Za-z0-9_-]{43}$/;

function tokenFile(dataDir: string): string {
  return join(dataDir, SETUP_TOKEN_FILE);
}

/** The data dir of a file-backed database (the folder registry.db lives in); null for :memory:. */
export function dataDirOf(db: Db): string | null {
  const loc = db.location();
  return loc ? dirname(loc) : null;
}

function readToken(file: string): string | null {
  try {
    const t = readFileSync(file, "utf8").trim();
    return SETUP_TOKEN_RE.test(t) ? t : null;
  } catch {
    return null;
  }
}

/**
 * While no admin exists: return the one-time setup token, creating it (and <dataDir>/setup-token,
 * mode 0600) on first call. Returns null once setup is done.
 */
export function ensureSetupToken(db: Db, dataDir: string): string | null {
  const file = tokenFile(dataDir);
  if (!needsSetup(db)) {
    // A leftover file (setup done by `init`, or a crash before the delete) must not stay usable.
    rmSync(file, { force: true });
    return null;
  }
  const existing = readToken(file);
  if (existing) {
    chmodSync(file, 0o600);
    return existing;
  }
  rmSync(file, { force: true });
  const token = `ist_${randomBytes(32).toString("base64url")}`;
  writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return token;
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time check of a presented setup token against <data>/setup-token. False when there is none. */
export function checkSetupToken(db: Db, presented: string): boolean {
  const dir = dataDirOf(db);
  if (!dir) return false;
  const expected = readToken(tokenFile(dir));
  if (!expected) return false;
  // Compare fixed-length digests so neither the content nor the length leaks through timing.
  return timingSafeEqual(digest(presented), digest(expected));
}

/** Setup succeeded: the token is spent. */
export function consumeSetupToken(db: Db): void {
  const dir = dataDirOf(db);
  if (dir && existsSync(tokenFile(dir))) rmSync(tokenFile(dir), { force: true });
}
