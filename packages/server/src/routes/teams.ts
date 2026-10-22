// Teams and team membership.
import { Hono } from "hono";
import { TEAM_RE, type TeamRole } from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import type { AppEnv } from "../auth.js";
import { canManageTeam } from "../access.js";
import { conflict, forbidden, invalid, jsonBody, notFound, optString, reqString } from "../http.js";
import { audit, getTeamDetail, listTeams, teamBySlug, userIdByHandle } from "../model.js";

export function teamRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/teams", (c) => c.json(listTeams(db, c.get("actor"))));

  r.post("/teams", async (c) => {
    const actor = c.get("actor");
    if (actor.role !== "admin") throw forbidden("only admins can create teams");
    const body = await jsonBody(c);
    const slug = reqString(body, "slug", 64).trim().toLowerCase();
    if (!TEAM_RE.test(slug)) throw invalid("slug must be lowercase letters, digits and single hyphens");
    const name = reqString(body, "name", 100).trim();
    const description = (optString(body, "description", 1000) ?? "").trim();
    if (teamBySlug(db, slug)) throw conflict(`team "${slug}" already exists`);
    tx(db, () => {
      db.prepare("INSERT INTO teams (slug, name, description, created_at) VALUES (?, ?, ?, ?)").run(
        slug,
        name,
        description,
        new Date().toISOString(),
      );
      audit(db, actor, "team.create", "team", slug, { name });
    });
    return c.json(getTeamDetail(db, actor, slug), 201);
  });

  r.get("/teams/:slug", (c) => c.json(getTeamDetail(db, c.get("actor"), c.req.param("slug"))));

  const managedTeam = (c: { get: (k: "actor") => import("../access.js").Actor }, slug: string) => {
    const t = teamBySlug(db, slug);
    if (!t) throw notFound("team not found");
    if (!canManageTeam(c.get("actor"), t.id)) throw forbidden("needs admin or team maintainer");
    return t;
  };

  r.patch("/teams/:slug", async (c) => {
    const actor = c.get("actor");
    const t = managedTeam(c, c.req.param("slug"));
    const body = await jsonBody(c);
    const name = optString(body, "name", 100);
    const description = optString(body, "description", 1000);
    if (name !== undefined && name.trim() === "") throw invalid("name cannot be empty");
    tx(db, () => {
      if (name !== undefined) db.prepare("UPDATE teams SET name = ? WHERE id = ?").run(name.trim(), t.id);
      if (description !== undefined)
        db.prepare("UPDATE teams SET description = ? WHERE id = ?").run(description.trim(), t.id);
      if (name !== undefined || description !== undefined)
        audit(db, actor, "team.update", "team", t.slug, {
          ...(name !== undefined ? { name: name.trim() } : {}),
          ...(description !== undefined ? { description: description.trim() } : {}),
        });
    });
    return c.json(getTeamDetail(db, actor, t.slug));
  });

  r.put("/teams/:slug/members/:handle", async (c) => {
    const actor = c.get("actor");
    const t = managedTeam(c, c.req.param("slug"));
    const body = await jsonBody(c);
    const role = body.role as TeamRole;
    if (role !== "maintainer" && role !== "member") throw invalid("role must be maintainer or member");
    const handle = c.req.param("handle");
    const userId = userIdByHandle(db, handle);
    if (userId === null) throw notFound(`user "${handle}" not found`);
    tx(db, () => {
      db.prepare(
        "INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role",
      ).run(t.id, userId, role);
      audit(db, actor, "team.member.set", "team", t.slug, { handle, role });
    });
    return c.json(getTeamDetail(db, actor, t.slug));
  });

  r.delete("/teams/:slug/members/:handle", (c) => {
    const actor = c.get("actor");
    const t = managedTeam(c, c.req.param("slug"));
    const handle = c.req.param("handle");
    const userId = userIdByHandle(db, handle);
    if (userId === null) throw notFound(`user "${handle}" not found`);
    tx(db, () => {
      const res = db.prepare("DELETE FROM team_members WHERE team_id = ? AND user_id = ?").run(t.id, userId);
      if (Number(res.changes) === 0) throw notFound(`"${handle}" is not a member of "${t.slug}"`);
      audit(db, actor, "team.member.remove", "team", t.slug, { handle });
    });
    return c.json(getTeamDetail(db, actor, t.slug));
  });

  return r;
}
