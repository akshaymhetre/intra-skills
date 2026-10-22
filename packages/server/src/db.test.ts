import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS, migrate } from "./db.js";
import { loadFiles } from "./publish.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("migration 2", () => {
  it("moves v1 file bytes into blobs without losing or duplicating any", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    dirs.push(dir);
    const db = new DatabaseSync(join(dir, "r.db"));
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1);");
    db.exec(MIGRATIONS[0]!);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users (handle, display_name, role, created_at) VALUES ('a','A','admin',?)").run(now);
    db.prepare(
      "INSERT INTO skills (name, visibility, created_by, created_at, updated_at) VALUES ('s','org',1,?,?)",
    ).run(now, now);
    for (const v of ["1.0.0", "1.1.0"])
      db.prepare(
        "INSERT INTO versions (skill_id, version, sha256, size, file_count, published_by, published_at) VALUES (1,?,'x',3,2,1,?)",
      ).run(v, now);
    const ins = db.prepare("INSERT INTO version_files (version_id, path, mode, size, sha256, content) VALUES (?,?,?,?,?,?)");
    // SKILL.md identical in both versions, so the blob must be stored once.
    ins.run(1, "SKILL.md", 0o644, 3, "aaa", Buffer.from("one"));
    ins.run(2, "SKILL.md", 0o644, 3, "aaa", Buffer.from("one"));
    ins.run(2, "run.sh", 0o755, 3, "bbb", Buffer.from("two"));

    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect((db.prepare("SELECT count(*) AS n FROM blobs").get() as { n: number }).n).toBe(2);
    const v2 = loadFiles(db, 2);
    expect(v2.map((f) => [f.path, f.mode, Buffer.from(f.content).toString()])).toEqual([
      ["SKILL.md", 0o644, "one"],
      ["run.sh", 0o755, "two"],
    ]);
    expect(loadFiles(db, 1).map((f) => Buffer.from(f.content).toString())).toEqual(["one"]);
    db.close();
  });
});
