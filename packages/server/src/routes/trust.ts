// Trust: works/broken votes from readers, admin verification of a version, and the review queue.
import { Hono } from "hono";
import type { Context } from "hono";
import type { Trust, Vote } from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import type { AppEnv } from "../auth.js";
import type { Actor } from "../access.js";
import { canRead } from "../access.js";
import { forbidden, invalid, jsonBody } from "../http.js";
import {
  type SkillRecord,
  audit,
  latestOf,
  loadSkills,
  loadVersions,
  readableSkill,
  skillDetail,
  summaryContext,
} from "../model.js";

export const MAX_VOTE_NOTE = 280;

function trustOf(db: Db, actor: Actor, s: SkillRecord): Trust {
  return summaryContext(db, actor, [s]).facts(s).trust;
}

function requireAdmin(actor: Actor, what: string): void {
  if (actor.role !== "admin") throw forbidden(`only admins can ${what}`);
}

/** A JSON object body, where an empty body counts as {}. */
async function optionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.raw.clone().text();
  if (text.trim() === "") return {};
  return jsonBody(c);
}

export function trustRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.put("/skills/:name/vote", async (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const body = await jsonBody(c);
    if (typeof body.works !== "boolean") throw invalid("works must be true or false");
    let note = "";
    if (body.note !== undefined) {
      if (typeof body.note !== "string") throw invalid("note must be a string");
      // One line: collapse any line breaks a client sends.
      note = body.note.replace(/\s+/g, " ").trim();
      if (note.length > MAX_VOTE_NOTE) throw invalid(`note is longer than ${MAX_VOTE_NOTE} characters`);
    }
    const version = latestOf(loadVersions(db, s.id));
    db.prepare(
      `INSERT INTO votes (skill_id, user_id, works, note, version, at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (skill_id, user_id) DO UPDATE SET works = excluded.works, note = excluded.note,
         version = excluded.version, at = excluded.at`,
    ).run(s.id, actor.id, body.works ? 1 : 0, note, version, new Date().toISOString());
    return c.json(trustOf(db, actor, s));
  });

  r.delete("/skills/:name/vote", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    db.prepare("DELETE FROM votes WHERE skill_id = ? AND user_id = ?").run(s.id, actor.id);
    return c.json(trustOf(db, actor, s));
  });

  r.get("/skills/:name/votes", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const rows = db
      .prepare(
        `SELECT v.works, v.note, v.version, v.at, u.handle, u.display_name
         FROM votes v JOIN users u ON u.id = v.user_id WHERE v.skill_id = ? ORDER BY v.at DESC, u.handle`,
      )
      .all(s.id) as { works: number; note: string; version: string | null; at: string; handle: string; display_name: string }[];
    const votes: Vote[] = rows.map((v) => ({
      user: { handle: v.handle, displayName: v.display_name },
      works: v.works === 1,
      note: v.note,
      version: v.version,
      at: v.at,
    }));
    return c.json(votes);
  });

  r.post("/skills/:name/verify", async (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    requireAdmin(actor, "verify skills");
    const body = await optionalJsonBody(c);
    if (body.version !== undefined && typeof body.version !== "string") throw invalid("version must be a string");
    const versions = loadVersions(db, s.id);
    const version = (body.version as string | undefined) ?? latestOf(versions);
    if (version === null) throw invalid(`skill "${s.name}" has no live version to verify`);
    const row = versions.find((v) => v.version === version);
    if (!row) throw invalid(`version ${version} of "${s.name}" does not exist`);
    if (row.yanked !== null) throw invalid(`version ${version} of "${s.name}" is yanked`);
    tx(db, () => {
      db.prepare("UPDATE skills SET verified_version = ?, verified_by = ?, verified_at = ? WHERE id = ?").run(
        version,
        actor.id,
        new Date().toISOString(),
        s.id,
      );
      audit(db, actor, "skill.verify", "skill", s.name, { version });
    });
    return c.json(skillDetail(db, actor, readableSkill(db, actor, s.name)));
  });

  r.delete("/skills/:name/verify", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    requireAdmin(actor, "unverify skills");
    tx(db, () => {
      db.prepare("UPDATE skills SET verified_version = NULL, verified_by = NULL, verified_at = NULL WHERE id = ?").run(s.id);
      audit(db, actor, "skill.unverify", "skill", s.name, { version: s.verifiedVersion });
    });
    return c.json(skillDetail(db, actor, readableSkill(db, actor, s.name)));
  });

  r.get("/review", (c) => {
    const actor = c.get("actor");
    requireAdmin(actor, "see the review queue");
    return c.json(reviewQueue(db, actor));
  });

  return r;
}

/** Readable skills with a live version whose `verified` is false, oldest update first. */
export function reviewQueue(db: Db, actor: Actor) {
  const skills = loadSkills(db).filter((s) => canRead(actor, s));
  const ctx = summaryContext(db, actor, skills);
  return skills
    .filter((s) => ctx.facts(s).latestVersion !== null && !ctx.facts(s).verified)
    .map((s) => ctx.summary(s))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.name < b.name ? -1 : 1));
}
