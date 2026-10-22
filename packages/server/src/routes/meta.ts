// Registry metadata (public), first-admin setup (public, setup token), org settings (admin)
// and the caller's own git identities.
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  GIT_PROVIDERS,
  type GitIdentity,
  type GitProviderId,
  type OrgSettings,
  type RegistryMeta,
  type SetupRequest,
} from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import { type AppEnv, SESSION_COOKIE } from "../auth.js";
import type { Actor } from "../access.js";
import { type AppOptions, SERVER_VERSION } from "../app.js";
import { checkHandle, conflict, forbidden, invalid, jsonArrayBody, jsonBody, reqString } from "../http.js";
import { audit, getUser } from "../model.js";
import { envPinned, getSettings, marketplaceName, needsSetup, publicUrl, publishMode, putSettings, secureCookie } from "../settings.js";
import { checkSetupToken, consumeSetupToken } from "../setup.js";
import { createUser } from "./users.js";

const SESSION_MAX_AGE = 30 * 24 * 60 * 60;
const SETTING_ENV: Record<keyof OrgSettings, string> = {
  name: "INTRA_SKILLS_ORG_NAME",
  publicUrl: "INTRA_SKILLS_PUBLIC_URL",
  staleDays: "INTRA_SKILLS_STALE_DAYS",
  pollSeconds: "INTRA_SKILLS_POLL_SECONDS",
};
export const GIT_USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$/;

function orgName(v: unknown, key: string): string {
  if (typeof v !== "string") throw invalid(`${key} must be a string`);
  const s = v.trim();
  if (s.length < 1 || s.length > 80) throw invalid(`${key} must be 1-80 characters`);
  return s;
}

/** An http(s) origin with no path, query or credentials; "" clears it (the request origin is used). */
function checkPublicUrl(v: unknown): string {
  if (typeof v !== "string") throw invalid("publicUrl must be a string");
  const s = v.trim().replace(/\/+$/, "");
  if (s === "") return "";
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw invalid("publicUrl must be an http(s) URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw invalid("publicUrl must be an http(s) URL");
  if (u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== ""))
    throw invalid("publicUrl must be an origin without a path, e.g. https://skills.example.com");
  return u.origin;
}

function intIn(v: unknown, key: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
    throw invalid(`${key} must be an integer from ${min} to ${max}`);
  return v;
}

/** Validate a git identity list: one per provider, usernames in the host's shape. */
export function parseGitIdentities(body: unknown[]): GitIdentity[] {
  if (body.length > GIT_PROVIDERS.length) throw invalid(`at most one identity per provider (${GIT_PROVIDERS.join(", ")})`);
  const out: GitIdentity[] = [];
  for (const raw of body) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("each identity must be {provider, username}");
    const o = raw as Record<string, unknown>;
    const provider = o.provider as GitProviderId;
    if (!GIT_PROVIDERS.includes(provider)) throw invalid(`provider must be one of ${GIT_PROVIDERS.join(", ")}`);
    if (typeof o.username !== "string" || !GIT_USERNAME_RE.test(o.username.trim()))
      throw invalid(`invalid ${provider} username`);
    if (out.some((i) => i.provider === provider)) throw invalid(`only one ${provider} identity is allowed`);
    out.push({ provider, username: o.username.trim() });
  }
  return out;
}

/** Replace a user's git identities. A username linked to another user is a 409 (it would let them approve as each other). */
export function replaceGitIdentities(db: Db, actor: Actor, userId: number, handle: string, ids: GitIdentity[]): void {
  tx(db, () => {
    for (const i of ids) {
      const other = db
        .prepare("SELECT u.handle FROM git_identities g JOIN users u ON u.id = g.user_id WHERE g.provider = ? AND g.username = ? AND g.user_id != ?")
        .get(i.provider, i.username, userId) as { handle: string } | undefined;
      if (other) throw conflict(`${i.provider} username "${i.username}" is already linked to another user`);
    }
    db.prepare("DELETE FROM git_identities WHERE user_id = ?").run(userId);
    const ins = db.prepare("INSERT INTO git_identities (user_id, provider, username) VALUES (?, ?, ?)");
    for (const i of ids) ins.run(userId, i.provider, i.username);
    audit(db, actor, "user.update", "user", handle, { gitIdentities: ids });
  });
}

export function metaRoutes(db: Db, opts: AppOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/meta", (c) => {
    const url = publicUrl(db, c.req.url);
    const body: RegistryMeta = {
      name: getSettings(db).name,
      publicUrl: url,
      version: SERVER_VERSION,
      needsSetup: needsSetup(db),
      publishMode: publishMode(db),
      mcpUrl: `${url}/api/mcp`,
      marketplaceName: marketplaceName(db),
    };
    return c.json(body);
  });

  r.get("/setup", (c) => c.json({ needsSetup: needsSetup(db) }));

  r.post("/setup", async (c) => {
    if (!needsSetup(db)) throw conflict("setup is already done; sign in with a token instead");
    const body = await jsonBody(c);
    const presented = typeof body.setupToken === "string" ? body.setupToken.trim() : "";
    if (!presented || !checkSetupToken(db, presented)) throw forbidden("invalid setup token");
    const req: SetupRequest = {
      setupToken: presented,
      handle: checkHandle(reqString(body, "handle", 64).trim().toLowerCase()),
      displayName: reqString(body, "displayName", 100).trim(),
      orgName: body.orgName === undefined || body.orgName === "" ? undefined : orgName(body.orgName, "orgName"),
    };
    const { userId, token } = tx(db, () => {
      // Re-check inside the write lock: two racing setups must not both create an admin.
      if (!needsSetup(db)) throw conflict("setup is already done; sign in with a token instead");
      const out = createUser(db, { handle: req.handle, displayName: req.displayName, role: "admin" });
      if (req.orgName !== undefined) putSettings(db, { name: req.orgName });
      audit(db, null, "user.create", "user", req.handle, { role: "admin", displayName: req.displayName, via: "setup" });
      return out;
    });
    consumeSetupToken(db);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
      secure: secureCookie(db, c.req.url, opts.secureCookies),
    });
    return c.json({ user: getUser(db, userId), token }, 201);
  });

  const settingsBody = () => ({ settings: getSettings(db), pinned: envPinned() });

  r.get("/settings", (c) => {
    if (c.get("actor").role !== "admin") throw forbidden("only admins can read settings");
    return c.json(settingsBody());
  });

  r.patch("/settings", async (c) => {
    const actor = c.get("actor");
    if (actor.role !== "admin") throw forbidden("only admins can change settings");
    const body = await jsonBody(c);
    const patch: Partial<OrgSettings> = {};
    for (const key of Object.keys(body)) {
      if (!(key in SETTING_ENV)) throw invalid(`unknown setting "${key}"`);
      const v = body[key];
      if (key === "name") patch.name = orgName(v, "name");
      else if (key === "publicUrl") patch.publicUrl = checkPublicUrl(v);
      else if (key === "staleDays") patch.staleDays = intIn(v, "staleDays", 1, 3650);
      else if (key === "pollSeconds") patch.pollSeconds = intIn(v, "pollSeconds", 15, 86400);
    }
    // A stored value under an env pin would silently do nothing, so say why instead.
    const pinned = envPinned().filter((k) => k in patch);
    if (pinned.length)
      throw conflict(`${pinned.join(", ")} ${pinned.length > 1 ? "are" : "is"} pinned by ${pinned.map((k) => SETTING_ENV[k]).join(", ")}`);
    if (Object.keys(patch).length)
      tx(db, () => {
        putSettings(db, patch);
        audit(db, actor, "settings.update", "settings", "org", patch);
      });
    return c.json(settingsBody());
  });

  r.put("/me/git-identities", async (c) => {
    const actor = c.get("actor");
    const ids = parseGitIdentities(await jsonArrayBody(c));
    replaceGitIdentities(db, actor, actor.id, actor.handle, ids);
    return c.json(getUser(db, actor.id));
  });

  return r;
}
