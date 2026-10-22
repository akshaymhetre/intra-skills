import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDataDir } from "./db.js";
import { createUser } from "./routes/users.js";
import { backupDataDir, restoreDataDir } from "./backup.js";

describe("backupDataDir", () => {
  const dirs: string[] = [];
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), "srv-backup-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("copies the database while it is open, and the secret key, both owner-only", async () => {
    const data = tmp();
    const db = openDataDir(data);
    createUser(db, { handle: "ada", displayName: "Ada", role: "admin" });
    writeFileSync(join(data, "secret.key"), "a2V5\n");
    const to = join(tmp(), "nightly");
    const out = await backupDataDir(data, to); // db is still open, as under a running server
    db.close();
    const copy = new DatabaseSync(out.database, { readOnly: true });
    expect(copy.prepare("SELECT handle FROM users").all().map((r) => r.handle)).toEqual(["ada"]);
    copy.close();
    expect(readFileSync(out.secretKey!, "utf8")).toBe("a2V5\n");
    expect(statSync(out.database).mode & 0o777).toBe(0o600);
    expect(statSync(out.secretKey!).mode & 0o777).toBe(0o600);
  });

  it("refuses a folder that already holds files, so it never overwrites an older backup", async () => {
    const data = tmp();
    openDataDir(data).close();
    const to = tmp();
    mkdirSync(join(to, "x"));
    await expect(backupDataDir(data, to)).rejects.toThrow(/not empty/);
  });

  it("refuses a data directory with no database", async () => {
    await expect(backupDataDir(tmp(), join(tmp(), "b"))).rejects.toThrow(/no registry.db/);
  });

  it("restore puts the backup back and removes a stale write-ahead log beside it", async () => {
    const data = tmp();
    const db = openDataDir(data);
    createUser(db, { handle: "ada", displayName: "Ada", role: "admin" });
    writeFileSync(join(data, "secret.key"), "a2V5\n");
    const saved = join(tmp(), "b");
    await backupDataDir(data, saved);
    createUser(db, { handle: "later", displayName: "Later", role: "member" });
    db.close();
    writeFileSync(join(data, "registry.db-wal"), "stale");
    const out = restoreDataDir(saved, data);
    expect(existsSync(join(data, "registry.db-wal"))).toBe(false);
    const back = new DatabaseSync(out.database, { readOnly: true });
    expect(back.prepare("SELECT handle FROM users").all().map((r) => r.handle)).toEqual(["ada"]);
    back.close();
    expect(readFileSync(out.secretKey!, "utf8")).toBe("a2V5\n");
  });

  it("restore refuses a backup that is not a healthy database, and leaves the data alone", () => {
    const data = tmp();
    openDataDir(data).close();
    const bad = tmp();
    writeFileSync(join(bad, "registry.db"), "not a database");
    expect(() => restoreDataDir(bad, data)).toThrow();
    expect(existsSync(join(data, "registry.db.restoring"))).toBe(false);
  });
});
