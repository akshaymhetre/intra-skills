// Audit log reads. Admins see everything; members see entries for skills they can read.
import { Hono } from "hono";
import type { Db } from "../db.js";
import type { AppEnv } from "../auth.js";
import { canRead } from "../access.js";
import { invalid } from "../http.js";
import { loadSkills, toAuditEntry } from "../model.js";

export function auditRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get("/audit", (c) => {
    const actor = c.get("actor");
    const limitRaw = c.req.query("limit") ?? "100";
    const limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid("limit must be 1-1000");
    const beforeRaw = c.req.query("before");
    const before = beforeRaw === undefined ? null : Number(beforeRaw);
    if (before !== null && (!Number.isInteger(before) || before < 1)) throw invalid("before must be an entry id");
    const target = c.req.query("target");

    const where: string[] = [];
    const params: (string | number)[] = [];
    if (before !== null) {
      where.push("id < ?");
      params.push(before);
    }
    if (target) {
      where.push("target = ?");
      params.push(target);
    }
    if (actor.role !== "admin") {
      const names = loadSkills(db)
        .filter((s) => canRead(actor, s))
        .map((s) => s.name);
      if (names.length === 0) return c.json([]);
      where.push(`kind = 'skill' AND target IN (${names.map(() => "?").join(",")})`);
      params.push(...names);
    }
    const rows = db
      .prepare(
        `SELECT id, at, actor, action, target, detail FROM audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...params, limit) as { id: number; at: string; actor: string | null; action: string; target: string; detail: string }[];
    return c.json(rows.map(toAuditEntry));
  });
  return r;
}
