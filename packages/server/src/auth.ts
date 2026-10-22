// Tokens (isk_ + 32 base62 chars), the auth middleware and the cookie CSRF guard.
// Tokens are stored only as sha256 + a 12-char display prefix and are never logged.
import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { sha256Hex, type ApiToken } from "@intra-skills/shared";
import type { Db } from "./db.js";
import type { Actor } from "./access.js";
import { HttpError } from "./http.js";
import { loadActorById } from "./model.js";

export const SESSION_COOKIE = "isk_session";
export const CSRF_HEADER = "X-Requested-With";
export const CSRF_VALUE = "intra-skills";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const TOKEN_RE = /^isk_[0-9A-Za-z]{32}$/;

export type AppEnv = { Variables: { actor: Actor; authVia: "bearer" | "cookie" } };

/** n unbiased base62 characters (rejection sampling over random bytes). */
export function randomBase62(n: number): string {
  let out = "";
  while (out.length < n) {
    for (const b of randomBytes(n * 2)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === n) break;
    }
  }
  return out;
}

export function generateToken(): string {
  return `isk_${randomBase62(32)}`;
}

interface TokenRow {
  id: string;
  user_id: number;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  scope?: "full" | "marketplace";
}

export function toApiToken(r: TokenRow): ApiToken {
  return { id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at, scope: r.scope ?? "full" };
}

export type TokenScope = "full" | "marketplace";

/** Refusal for a marketplace key presented anywhere but the marketplace routes. */
export const MARKETPLACE_ONLY = "this key only reads the plugin marketplace";

/** Insert a token for a user; returns the plaintext (shown once) and its metadata. */
export function createToken(db: Db, userId: number, name: string, scope: TokenScope = "full"): { token: string; meta: ApiToken } {
  const token = generateToken();
  const id = `tok_${randomBase62(16)}`;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO tokens (id, user_id, name, prefix, hash, created_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    userId,
    name,
    token.slice(0, 12),
    sha256Hex(token),
    now,
    scope,
  );
  return { token, meta: { id, name, prefix: token.slice(0, 12), createdAt: now, lastUsedAt: null, scope } };
}

export function listTokens(db: Db, userId: number): ApiToken[] {
  return (
    db
      .prepare("SELECT * FROM tokens WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at, id")
      .all(userId) as unknown as TokenRow[]
  ).map(toApiToken);
}

/** Look up an unrevoked token by hash with its scope; bumps last_used_at at most once a minute. */
export function authenticateTokenScoped(db: Db, token: string): { actor: Actor; scope: TokenScope } | null {
  if (!TOKEN_RE.test(token)) return null;
  // System users (git-sync and friends) act inside the server only: a token for one never signs in.
  const row = db
    .prepare(
      "SELECT t.id, t.user_id, t.last_used_at, t.scope FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.hash = ? AND t.revoked_at IS NULL AND u.system = 0",
    )
    .get(sha256Hex(token)) as { id: string; user_id: number; last_used_at: string | null; scope: TokenScope } | undefined;
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) >= 60_000)
    db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
  const actor = loadActorById(db, row.user_id);
  return actor ? { actor, scope: row.scope } : null;
}

/**
 * A full-scope token's actor, or null when unknown or revoked. A marketplace key is a 401 with its
 * own message: it authenticates only the marketplace routes, which call authenticateTokenScoped.
 */
export function authenticateToken(db: Db, token: string): Actor | null {
  const r = authenticateTokenScoped(db, token);
  if (!r) return null;
  if (r.scope !== "full") throw new HttpError("unauthenticated", MARKETPLACE_ONLY);
  return r.actor;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function authMiddleware(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    let actor: Actor | null = null;
    let via: "bearer" | "cookie" = "bearer";
    if (header !== undefined) {
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      actor = m ? authenticateToken(db, m[1]!) : null;
    } else {
      const cookie = getCookie(c, SESSION_COOKIE);
      if (cookie) {
        actor = authenticateToken(db, cookie);
        via = "cookie";
      }
    }
    if (!actor) throw new HttpError("unauthenticated", "missing or invalid credentials");
    if (via === "cookie" && !SAFE_METHODS.has(c.req.method) && c.req.header(CSRF_HEADER) !== CSRF_VALUE)
      throw new HttpError("csrf", `cookie-authenticated requests must send ${CSRF_HEADER}: ${CSRF_VALUE}`);
    c.set("actor", actor);
    c.set("authVia", via);
    await next();
  };
}
