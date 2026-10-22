// Org settings: stored in the `settings` table, editable by admins, overridden by env vars at boot.
// Env wins so a deployment can pin values (for example the public URL behind a proxy).
import type { OrgSettings, PublishMode } from "@intra-skills/shared";
import type { Db } from "./db.js";

const DEFAULTS: OrgSettings = { name: "intra-skills", publicUrl: "", staleDays: 90, pollSeconds: 60 };

const ENV: Record<keyof OrgSettings, string> = {
  name: "INTRA_SKILLS_ORG_NAME",
  publicUrl: "INTRA_SKILLS_PUBLIC_URL",
  staleDays: "INTRA_SKILLS_STALE_DAYS",
  pollSeconds: "INTRA_SKILLS_POLL_SECONDS",
};

function stored(db: Db): Partial<OrgSettings> {
  const out: Record<string, unknown> = {};
  for (const r of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[])
    out[r.key] = JSON.parse(r.value);
  return out as Partial<OrgSettings>;
}

/** Keys an env var currently pins; the console shows them read-only. */
export function envPinned(): (keyof OrgSettings)[] {
  return (Object.keys(ENV) as (keyof OrgSettings)[]).filter((k) => process.env[ENV[k]] !== undefined && process.env[ENV[k]] !== "");
}

export function getSettings(db: Db): OrgSettings {
  const s: OrgSettings = { ...DEFAULTS, ...stored(db) };
  const e = process.env;
  if (e[ENV.name]) s.name = e[ENV.name]!;
  if (e[ENV.publicUrl]) s.publicUrl = e[ENV.publicUrl]!;
  if (e[ENV.staleDays] && Number.isInteger(Number(e[ENV.staleDays]))) s.staleDays = Number(e[ENV.staleDays]);
  if (e[ENV.pollSeconds] && Number.isInteger(Number(e[ENV.pollSeconds]))) s.pollSeconds = Number(e[ENV.pollSeconds]);
  s.publicUrl = s.publicUrl.replace(/\/+$/, "");
  return s;
}

export function putSettings(db: Db, patch: Partial<OrgSettings>): void {
  const up = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) up.run(k, JSON.stringify(v));
}

/** The URL people reach the registry at: the setting, else the origin of the current request. */
export function publicUrl(db: Db, requestUrl: string): string {
  return getSettings(db).publicUrl || new URL(requestUrl).origin;
}

/**
 * Whether the session cookie gets the Secure flag. Behind a TLS proxy the request itself arrives
 * as plain http, so the public URL being https counts too.
 */
export function secureCookie(db: Db, requestUrl: string, override?: boolean): boolean {
  if (override !== undefined) return override;
  return new URL(requestUrl).protocol === "https:" || getSettings(db).publicUrl.startsWith("https:");
}

/** pull-request as soon as any enabled git source exists, so a direct publish can never skip review. */
export function publishMode(db: Db): PublishMode {
  const r = db.prepare("SELECT count(*) AS n FROM git_sources WHERE enabled = 1").get() as { n: number };
  return r.n > 0 ? "pull-request" : "direct";
}

export function needsSetup(db: Db): boolean {
  const r = db.prepare("SELECT count(*) AS n FROM users WHERE system = 0").get() as { n: number };
  return r.n === 0;
}

/** Names Claude Code reserves for its own marketplaces (docs/API.md "v3: package kinds"). */
const RESERVED_EXACT = new Set(["npm", "pip", "uv", "cargo", "github", "gh"]);
const RESERVED_PREFIX = ["claude-", "anthropic", "official", "claudeai-"];
export const DEFAULT_MARKETPLACE_NAME = "intra-skills";

/**
 * The org name as a marketplace slug: lowercased, every run outside [a-z0-9._-] replaced by "-",
 * trimmed of "-". Empty, reserved, or not starting with a letter or digit: "intra-skills".
 */
export function marketplaceSlug(orgName: string): string {
  const s = orgName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!s || !/^[a-z0-9]/.test(s)) return DEFAULT_MARKETPLACE_NAME;
  if (RESERVED_EXACT.has(s) || RESERVED_PREFIX.some((p) => s.startsWith(p))) return DEFAULT_MARKETPLACE_NAME;
  return s;
}

/** Name of the Claude Code plugin marketplace this registry serves. */
export function marketplaceName(db: Db): string {
  return marketplaceSlug(getSettings(db).name);
}
