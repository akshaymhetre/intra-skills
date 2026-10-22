// Device login (RFC 8628 shape): the CLI starts a request and polls; a signed-in person approves
// the short user code in the console. Device codes are stored only as sha256, and the token is
// minted at the poll that collects it, so no usable credential ever sits in the table.
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { type DevicePoll, type DeviceRequestInfo, type DeviceStart, sha256Hex } from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import { type AppEnv, createToken, randomBase62 } from "../auth.js";
import { conflict, jsonBody, notFound, optString } from "../http.js";
import { audit, getUser, loadActorById } from "../model.js";
import { publicUrl } from "../settings.js";

export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const DEVICE_LIFETIME_S = 600;
export const DEVICE_INTERVAL_S = 3;
export const MAX_PENDING = 20;
const DEVICE_CODE_RE = /^[0-9A-Za-z]{32}$/;

interface DeviceRow {
  device_hash: string;
  user_code: string;
  client_name: string;
  created_at: string;
  expires_at: string;
  status: "pending" | "approved" | "denied" | "consumed";
  user_id: number | null;
}

/** 8 unbiased characters from the 20-letter alphabet (no vowels, so no words; no look-alike digits). */
function newUserCode(): string {
  let out = "";
  while (out.length < 8)
    for (const b of randomBytes(16)) {
      if (b < 240) out += USER_CODE_ALPHABET[b % 20];
      if (out.length === 8) break;
    }
  return out;
}

const dashed = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/** Case-insensitive, dash and space tolerant; null when it cannot be a user code. */
export function normalizeUserCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[-\s]/g, "");
  if (s.length !== 8) return null;
  for (const ch of s) if (!USER_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

const expired = (r: DeviceRow, now = Date.now()) => Date.parse(r.expires_at) <= now;

function info(r: DeviceRow): DeviceRequestInfo {
  let status: DeviceRequestInfo["status"];
  if (r.status === "consumed") status = "approved";
  else if (r.status === "denied") status = "denied";
  else if (expired(r)) status = "expired";
  else status = r.status;
  return {
    userCode: dashed(r.user_code),
    clientName: r.client_name,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    status,
  };
}

export function deviceRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  const byUserCode = (raw: string): DeviceRow => {
    const code = normalizeUserCode(raw);
    const row = code
      ? (db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get(code) as DeviceRow | undefined)
      : undefined;
    if (!row) throw notFound("no such device code");
    return row;
  };

  // ---------- public: the CLI side ----------

  r.post("/auth/device", async (c) => {
    const body = await jsonBody(c).catch(() => ({}) as Record<string, unknown>);
    const clientName = (optString(body, "clientName", 80) ?? "").trim().replace(/[\u0000-\u001f\u007f]/g, "") || "intra CLI";
    const deviceCode = randomBase62(32);
    const now = Date.now();
    const userCode = tx(db, () => {
      const nowIso = new Date(now).toISOString();
      // Rows past expiry are useless to everyone; drop them so the table stays small.
      db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").run(nowIso);
      // Cap open requests so an anonymous caller cannot flood the approval page or the code space.
      const pending = db
        .prepare("SELECT device_hash FROM device_codes WHERE status = 'pending' ORDER BY created_at, rowid")
        .all() as { device_hash: string }[];
      const expireOldest = db.prepare("UPDATE device_codes SET expires_at = ? WHERE device_hash = ?");
      for (const p of pending.slice(0, Math.max(0, pending.length - MAX_PENDING + 1))) expireOldest.run(nowIso, p.device_hash);
      for (let attempt = 0; ; attempt++) {
        const code = newUserCode();
        if (db.prepare("SELECT 1 FROM device_codes WHERE user_code = ?").get(code)) {
          if (attempt > 10) throw new Error("could not allocate a device user code");
          continue;
        }
        db.prepare(
          "INSERT INTO device_codes (device_hash, user_code, client_name, created_at, expires_at, status) VALUES (?, ?, ?, ?, ?, 'pending')",
        ).run(sha256Hex(deviceCode), code, clientName, nowIso, new Date(now + DEVICE_LIFETIME_S * 1000).toISOString());
        return code;
      }
    });
    const base = publicUrl(db, c.req.url);
    const res: DeviceStart = {
      deviceCode,
      userCode: dashed(userCode),
      verificationUri: `${base}/device`,
      verificationUriComplete: `${base}/device?code=${dashed(userCode)}`,
      interval: DEVICE_INTERVAL_S,
      expiresIn: DEVICE_LIFETIME_S,
    };
    return c.json(res);
  });

  r.post("/auth/device/token", async (c) => {
    const body = await jsonBody(c);
    const deviceCode = typeof body.deviceCode === "string" ? body.deviceCode.trim() : "";
    const poll = tx(db, (): DevicePoll => {
      const row = DEVICE_CODE_RE.test(deviceCode)
        ? (db.prepare("SELECT * FROM device_codes WHERE device_hash = ?").get(sha256Hex(deviceCode)) as DeviceRow | undefined)
        : undefined;
      if (!row || row.status === "consumed" || expired(row)) return { status: "expired" };
      if (row.status === "pending") return { status: "pending" };
      if (row.status === "denied") return { status: "denied" };
      // approved: hand out exactly one token, then the code is spent.
      db.prepare("UPDATE device_codes SET status = 'consumed' WHERE device_hash = ?").run(row.device_hash);
      const user = db.prepare("SELECT system FROM users WHERE id = ?").get(row.user_id ?? -1) as { system: number } | undefined;
      const actor = user && user.system === 0 ? loadActorById(db, row.user_id!) : null;
      if (!actor) return { status: "expired" };
      const name = `${row.client_name} (device login)`;
      const { token, meta } = createToken(db, actor.id, name);
      audit(db, actor, "token.create", "token", meta.id, { name, prefix: meta.prefix, via: "device" });
      return { status: "approved", token, user: getUser(db, actor.id) };
    });
    return c.json(poll);
  });

  // ---------- signed in: the console side ----------

  r.get("/auth/device/:userCode", (c) => c.json(info(byUserCode(c.req.param("userCode")))));

  const decide = (decision: "approved" | "denied") =>
    r.post(`/auth/device/:userCode/${decision === "approved" ? "approve" : "deny"}`, (c) => {
      const actor = c.get("actor");
      const out = tx(db, () => {
        const row = byUserCode(c.req.param("userCode"));
        if (row.status === "pending" && expired(row)) throw conflict("this code has expired; start the login again");
        if (row.status !== "pending") throw conflict(`this code was already ${info(row).status}`);
        db.prepare("UPDATE device_codes SET status = ?, user_id = ? WHERE device_hash = ?").run(
          decision,
          decision === "approved" ? actor.id : null,
          row.device_hash,
        );
        return info({ ...row, status: decision, user_id: decision === "approved" ? actor.id : null });
      });
      return c.json(out);
    });
  decide("approved");
  decide("denied");

  return r;
}
