// Collections: a team's named, ordered set of skills, installed in one line as @team/slug.
import { Hono } from "hono";
import { TEAM_RE, type Collection } from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import type { AppEnv } from "../auth.js";
import type { Actor } from "../access.js";
import { canRead } from "../access.js";
import { forbidden, invalid, jsonBody, notFound, optString, reqString } from "../http.js";
import { audit, loadSkills, teamBySlug } from "../model.js";

export const MAX_COLLECTION_SKILLS = 50;

interface CollectionRow {
  id: number;
  team_id: number;
  team_slug: string;
  slug: string;
  title: string;
  description: string;
  skills: string;
  creator_handle: string;
  updated_at: string;
}

const SELECT = `SELECT c.*, t.slug AS team_slug, u.handle AS creator_handle
  FROM collections c JOIN teams t ON t.id = c.team_id JOIN users u ON u.id = c.created_by`;

/** Names of the skills the actor can read (one query), for filtering collection members. */
function readableNames(db: Db, actor: Actor): Set<string> {
  return new Set(
    loadSkills(db)
      .filter((s) => canRead(actor, s))
      .map((s) => s.name),
  );
}

function toCollection(r: CollectionRow, readable: Set<string>): Collection {
  return {
    team: r.team_slug,
    slug: r.slug,
    title: r.title,
    description: r.description,
    skills: (JSON.parse(r.skills) as string[]).filter((n) => readable.has(n)),
    createdBy: r.creator_handle,
    updatedAt: r.updated_at,
  };
}

/** Collections, by team then slug, with unreadable skills dropped. teamIds = null lists every team's. */
export function listCollections(db: Db, actor: Actor, teamIds: number[] | null = null): Collection[] {
  if (teamIds !== null && teamIds.length === 0) return [];
  const where = teamIds === null ? "" : `WHERE c.team_id IN (${teamIds.map(() => "?").join(",")})`;
  const rows = db.prepare(`${SELECT} ${where} ORDER BY t.slug, c.slug`).all(...(teamIds ?? [])) as unknown as CollectionRow[];
  if (rows.length === 0) return [];
  const readable = readableNames(db, actor);
  return rows.map((r) => toCollection(r, readable));
}

function findCollection(db: Db, team: string, slug: string): CollectionRow | null {
  return (db.prepare(`${SELECT} WHERE t.slug = ? AND c.slug = ?`).get(team, slug) as CollectionRow | undefined) ?? null;
}

function canEditTeam(actor: Actor, teamId: number): boolean {
  return actor.role === "admin" || actor.teams.has(teamId);
}

export function collectionRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/collections", (c) => {
    const actor = c.get("actor");
    const team = c.req.query("team");
    if (team === undefined || team === "") return c.json(listCollections(db, actor));
    const t = teamBySlug(db, team);
    return c.json(t ? listCollections(db, actor, [t.id]) : []);
  });

  r.get("/collections/:team/:slug", (c) => {
    const actor = c.get("actor");
    const row = findCollection(db, c.req.param("team"), c.req.param("slug"));
    if (!row) throw notFound("collection not found");
    return c.json(toCollection(row, readableNames(db, actor)));
  });

  r.put("/collections/:team/:slug", async (c) => {
    const actor = c.get("actor");
    const t = teamBySlug(db, c.req.param("team"));
    if (!t) throw notFound("team not found");
    if (!canEditTeam(actor, t.id)) throw forbidden(`only admins and members of team "${t.slug}" can edit its collections`);
    const slug = c.req.param("slug");
    if (slug.length > 64 || !TEAM_RE.test(slug)) throw invalid("slug must be lowercase letters, digits and single hyphens");
    const body = await jsonBody(c);
    const title = reqString(body, "title", 100).trim();
    const description = (optString(body, "description", 1000) ?? "").trim();
    if (!Array.isArray(body.skills)) throw invalid("skills must be an array of skill names");
    const skills: string[] = [];
    for (const x of body.skills) {
      if (typeof x !== "string") throw invalid("skills must contain skill names");
      if (!skills.includes(x)) skills.push(x);
    }
    if (skills.length > MAX_COLLECTION_SKILLS) throw invalid(`a collection holds at most ${MAX_COLLECTION_SKILLS} skills`);
    const readable = readableNames(db, actor);
    // Unreadable and missing read the same, so the refusal does not reveal a private skill.
    const bad = skills.find((n) => !readable.has(n));
    if (bad !== undefined) throw invalid(`skill "${bad}" not found`, { skill: bad });

    const now = new Date().toISOString();
    tx(db, () => {
      db.prepare(
        `INSERT INTO collections (team_id, slug, title, description, skills, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (team_id, slug) DO UPDATE SET title = excluded.title, description = excluded.description,
           skills = excluded.skills, updated_at = excluded.updated_at`,
      ).run(t.id, slug, title, description, JSON.stringify(skills), actor.id, now, now);
      audit(db, actor, "collection.put", "collection", `${t.slug}/${slug}`, { title, skills });
    });
    return c.json(toCollection(findCollection(db, t.slug, slug)!, readable));
  });

  r.delete("/collections/:team/:slug", (c) => {
    const actor = c.get("actor");
    const row = findCollection(db, c.req.param("team"), c.req.param("slug"));
    if (!row) throw notFound("collection not found");
    if (!canEditTeam(actor, row.team_id))
      throw forbidden(`only admins and members of team "${row.team_slug}" can edit its collections`);
    tx(db, () => {
      db.prepare("DELETE FROM collections WHERE id = ?").run(row.id);
      audit(db, actor, "collection.delete", "collection", `${row.team_slug}/${row.slug}`, {});
    });
    return c.body(null, 204);
  });

  return r;
}
