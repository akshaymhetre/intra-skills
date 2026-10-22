import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@intra-skills/shared";
import { Harness } from "./test/harness.js";
import { MAX_PENDING } from "./routes/device.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => h.close());

const start = async (clientName?: string) => {
  const r = await h.call("POST", "/api/auth/device", { body: clientName === undefined ? {} : { clientName } });
  expect(r.status).toBe(200);
  return r.json as { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; interval: number; expiresIn: number };
};
const poll = (deviceCode: string) => h.call("POST", "/api/auth/device/token", { body: { deviceCode } });

describe("device login", () => {
  it("start -> pending -> approve -> approved with a working token -> spent", async () => {
    const s = await start("laptop CLI");
    expect(s.deviceCode).toMatch(/^[0-9A-Za-z]{32}$/);
    expect(s.userCode).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(s).toMatchObject({ verificationUri: "http://localhost/device", interval: 3, expiresIn: 600 });
    expect(s.verificationUriComplete).toBe(`http://localhost/device?code=${s.userCode}`);
    // Only the hash is stored.
    const rows = h.db.prepare("SELECT device_hash, token FROM device_codes").all() as { device_hash: string; token: string | null }[];
    expect(rows).toEqual([{ device_hash: sha256Hex(s.deviceCode), token: null }]);

    expect((await poll(s.deviceCode)).json).toEqual({ status: "pending" });

    const lower = s.userCode.toLowerCase().replace("-", "");
    const info = await h.call("GET", `/api/auth/device/${lower}`, { token: h.adminToken });
    expect(info.json).toMatchObject({ userCode: s.userCode, clientName: "laptop CLI", status: "pending" });

    const ok = await h.call("POST", `/api/auth/device/${s.userCode}/approve`, { token: h.adminToken });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("approved");

    const got = await poll(s.deviceCode);
    expect(got.status).toBe(200);
    expect(got.json.status).toBe("approved");
    expect(got.json.user.handle).toBe("root");
    expect((await h.call("GET", "/api/me", { token: got.json.token })).json.handle).toBe("root");
    const tokens = await h.call("GET", "/api/tokens", { token: got.json.token });
    expect(tokens.json.map((t: { name: string }) => t.name)).toContain("laptop CLI (device login)");
    expect((await poll(s.deviceCode)).json).toEqual({ status: "expired" });
    // Approving again after it was collected is a conflict, not a second token.
    expect((await h.call("POST", `/api/auth/device/${s.userCode}/approve`, { token: h.adminToken })).status).toBe(409);
  });

  it("deny makes the poll answer denied and mints nothing", async () => {
    const s = await start();
    const m = await h.user("mia");
    const d = await h.call("POST", `/api/auth/device/${s.userCode}/deny`, { token: m });
    expect(d.json.status).toBe("denied");
    expect((await poll(s.deviceCode)).json).toEqual({ status: "denied" });
    expect((await h.call("GET", `/api/auth/device/${s.userCode}`, { token: m })).json.clientName).toBe("intra CLI");
    expect((await h.call("POST", `/api/auth/device/${s.userCode}/approve`, { token: m })).status).toBe(409);
  });

  it("expires: poll answers expired and approving is 409", async () => {
    const s = await start();
    h.db.prepare("UPDATE device_codes SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await poll(s.deviceCode)).json).toEqual({ status: "expired" });
    expect((await h.call("GET", `/api/auth/device/${s.userCode}`, { token: h.adminToken })).json.status).toBe("expired");
    const r = await h.call("POST", `/api/auth/device/${s.userCode}/approve`, { token: h.adminToken });
    expect(r.status).toBe(409);
  });

  it("an approval that expires before it is collected yields no token", async () => {
    const s = await start();
    await h.call("POST", `/api/auth/device/${s.userCode}/approve`, { token: h.adminToken });
    h.db.prepare("UPDATE device_codes SET expires_at = ?").run(new Date(Date.now() - 1000).toISOString());
    expect((await poll(s.deviceCode)).json).toEqual({ status: "expired" });
  });

  it("approval requires a signed-in caller (and the cookie CSRF header)", async () => {
    const s = await start();
    expect((await h.call("GET", `/api/auth/device/${s.userCode}`)).status).toBe(401);
    expect((await h.call("POST", `/api/auth/device/${s.userCode}/approve`)).status).toBe(401);
    const cookie = `isk_session=${h.adminToken}`;
    expect((await h.call("POST", `/api/auth/device/${s.userCode}/approve`, { cookie })).status).toBe(403);
    const ok = await h.call("POST", `/api/auth/device/${s.userCode}/approve`, { cookie, headers: { "X-Requested-With": "intra-skills" } });
    expect(ok.status).toBe(200);
  });

  it("unknown codes are 404 and unknown device codes poll as expired", async () => {
    expect((await h.call("GET", "/api/auth/device/BBBB-BBBB", { token: h.adminToken })).status).toBe(404);
    expect((await h.call("GET", "/api/auth/device/AEIOU123", { token: h.adminToken })).status).toBe(404);
    expect((await poll("x".repeat(32))).json).toEqual({ status: "expired" });
    expect((await poll("")).json).toEqual({ status: "expired" });
  });

  it("keeps at most 20 pending codes, expiring the oldest first", async () => {
    const first = await start("first");
    for (let i = 0; i < MAX_PENDING; i++) await start(`n${i}`);
    const live = h.db
      .prepare("SELECT count(*) AS n FROM device_codes WHERE status = 'pending' AND expires_at > ?")
      .get(new Date().toISOString()) as { n: number };
    expect(live.n).toBe(MAX_PENDING);
    expect((await poll(first.deviceCode)).json).toEqual({ status: "expired" });
  });

  it("a system user's approval never turns into a token", async () => {
    const s = await start();
    const id = Number(
      h.db
        .prepare("INSERT INTO users (handle, display_name, role, created_at, system) VALUES ('git-sync', 'Git sync', 'admin', ?, 1)")
        .run(new Date().toISOString()).lastInsertRowid,
    );
    h.db.prepare("UPDATE device_codes SET status = 'approved', user_id = ?").run(id);
    expect((await poll(s.deviceCode)).json).toEqual({ status: "expired" });
    expect((h.db.prepare("SELECT count(*) AS n FROM tokens WHERE user_id = ?").get(id) as { n: number }).n).toBe(0);
  });
});
