// Skill listing (faceted search), detail, patch, delete and grants.
import { Hono } from "hono";
import {
  KINDS,
  TAG_RE,
  TOOLS,
  type FacetCount,
  type Grant,
  type SkillListResponse,
  type SkillPatch,
  type ToolId,
} from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import type { AppEnv } from "../auth.js";
import { canAdmin, canRead, canWrite } from "../access.js";
import { forbidden, invalid, jsonArrayBody, jsonBody, optStringArray } from "../http.js";
import {
  type SkillRecord,
  audit,
  grantsOf,
  loadSkills,
  readableSkill,
  skillDetail,
  summaryContext,
  teamIdBySlug,
  userIdByHandle,
} from "../model.js";

type FacetKey = "team" | "kind" | "area" | "stack" | "tool" | "tag" | "visibility";
const FACET_KEYS: FacetKey[] = ["team", "kind", "area", "stack", "tool", "tag", "visibility"];

function facetValues(s: SkillRecord, k: FacetKey): string[] {
  switch (k) {
    case "team":
      return s.teamSlug ? [s.teamSlug] : [];
    case "kind":
      return [s.kind];
    case "area":
      return s.areas;
    case "stack":
      return s.stacks;
    case "tool":
      return s.tools;
    case "tag":
      return s.tags;
    case "visibility":
      return [s.visibility];
  }
}

function countFacet(skills: SkillRecord[], k: FacetKey): FacetCount[] {
  const counts = new Map<string, number>();
  for (const s of skills) for (const v of facetValues(s, k)) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
}

export function skillRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/skills", (c) => {
    const actor = c.get("actor");
    const q = (c.req.query("q") ?? "").trim().toLowerCase();
    const sort = c.req.query("sort") ?? "updated";
    if (!["updated", "name", "downloads", "trending"].includes(sort))
      throw invalid("sort must be updated, name, downloads or trending");
    const health = c.req.query("health") ?? "";
    if (!["", "active", "stale"].includes(health)) throw invalid("health must be active or stale");
    const verifiedOnly = c.req.query("verified");
    if (verifiedOnly !== undefined && verifiedOnly !== "1") throw invalid("verified must be 1");
    const deprecated = c.req.query("deprecated") ?? "include";
    if (!["include", "exclude"].includes(deprecated)) throw invalid("deprecated must be include or exclude");
    const filters = {} as Record<FacetKey, string[]>;
    for (const k of FACET_KEYS) filters[k] = c.req.queries(k)?.filter((v) => v !== "").map((v) => v.toLowerCase()) ?? [];
    for (const v of filters.visibility)
      if (v !== "org" && v !== "private") throw invalid("visibility must be org or private");
    for (const v of filters.kind)
      if (!(KINDS as readonly string[]).includes(v)) throw invalid(`kind must be one of ${KINDS.join(", ")}`);

    // Base set: readable, matching q and the deprecated, health and verified filters.
    const readable = loadSkills(db).filter((s) => canRead(actor, s));
    const ctx = summaryContext(db, actor, readable);
    const base = readable.filter((s) => {
      if (deprecated === "exclude" && s.deprecated !== null) return false;
      if (health && ctx.facts(s).health !== health) return false;
      if (verifiedOnly === "1" && !ctx.facts(s).verified) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.tags.some((t) => t.includes(q))
      );
    });
    const passes = (s: SkillRecord, k: FacetKey) =>
      filters[k].length === 0 || facetValues(s, k).some((v) => filters[k].includes(v));
    const passesAllExcept = (s: SkillRecord, skip: FacetKey | null) =>
      FACET_KEYS.every((k) => k === skip || passes(s, k));

    const results = base.filter((s) => passesAllExcept(s, null));
    const summaries = results.map((s) => ctx.summary(s));
    summaries.sort((a, b) => {
      if (sort === "name") return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      if (sort === "downloads") return b.downloads - a.downloads || (a.name < b.name ? -1 : 1);
      if (sort === "trending")
        return b.installsWeek - a.installsWeek || b.downloads - a.downloads || (a.name < b.name ? -1 : 1);
      return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.name < b.name ? -1 : 1;
    });
    const facetOver = (k: FacetKey) => countFacet(base.filter((s) => passesAllExcept(s, k)), k);
    const body: SkillListResponse = {
      skills: summaries,
      facets: {
        teams: facetOver("team"),
        kinds: facetOver("kind"),
        areas: facetOver("area"),
        stacks: facetOver("stack"),
        tools: facetOver("tool"),
        tags: facetOver("tag"),
        visibility: facetOver("visibility"),
      },
      total: summaries.length,
    };
    return c.json(body);
  });

  r.get("/skills/:name", (c) => {
    const actor = c.get("actor");
    return c.json(skillDetail(db, actor, readableSkill(db, actor, c.req.param("name"))));
  });

  r.patch("/skills/:name", async (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const body = await jsonBody(c);
    const patch: SkillPatch = {};
    const changes: Record<string, unknown> = {};

    if (body.visibility !== undefined) {
      if (body.visibility !== "org" && body.visibility !== "private") throw invalid("visibility must be org or private");
      patch.visibility = body.visibility;
    }
    let teamId: number | null | undefined;
    if (body.team !== undefined) {
      if (body.team === null) teamId = null;
      else if (typeof body.team !== "string") throw invalid("team must be a team slug or null");
      else {
        teamId = teamIdBySlug(db, body.team);
        if (teamId === null) throw invalid(`team "${body.team}" does not exist`);
      }
      patch.team = body.team as string | null;
    }
    patch.areas = optStringArray(body, "areas", TAG_RE);
    patch.stacks = optStringArray(body, "stacks", TAG_RE);
    patch.tags = optStringArray(body, "tags", TAG_RE);
    const tools = optStringArray(body, "tools", /^[a-z]+$/);
    if (tools) {
      const bad = tools.filter((t) => !(TOOLS as readonly string[]).includes(t));
      if (bad.length) throw invalid(`unknown tool(s): ${bad.join(", ")}`);
      patch.tools = tools as ToolId[];
    }
    if (body.deprecated !== undefined) {
      if (body.deprecated !== null && (typeof body.deprecated !== "string" || body.deprecated.trim() === ""))
        throw invalid("deprecated must be a non-empty reason string or null");
      if (typeof body.deprecated === "string" && body.deprecated.length > 500) throw invalid("deprecated reason too long");
      patch.deprecated = body.deprecated as string | null;
    }

    const needsAdmin = patch.visibility !== undefined || teamId !== undefined;
    const needsWrite =
      patch.areas !== undefined ||
      patch.stacks !== undefined ||
      patch.tags !== undefined || patch.tools !== undefined || patch.deprecated !== undefined;
    if (needsAdmin && !canAdmin(actor, s)) throw forbidden("changing visibility or team needs skill admin rights");
    if ((needsWrite || needsAdmin) && !canWrite(actor, s)) throw forbidden("you cannot write this skill");

    tx(db, () => {
      const set = (col: string, v: string | number | null, key: string, wire: unknown) => {
        db.prepare(`UPDATE skills SET ${col} = ? WHERE id = ?`).run(v, s.id);
        changes[key] = wire;
      };
      if (patch.visibility !== undefined) set("visibility", patch.visibility, "visibility", patch.visibility);
      if (teamId !== undefined) set("team_id", teamId, "team", patch.team);
      if (patch.areas) set("areas", JSON.stringify(patch.areas), "areas", patch.areas);
      if (patch.stacks) set("stacks", JSON.stringify(patch.stacks), "stacks", patch.stacks);
      if (patch.tags) set("tags", JSON.stringify(patch.tags), "tags", patch.tags);
      if (patch.tools) set("tools", JSON.stringify(patch.tools), "tools", patch.tools);
      if (patch.deprecated !== undefined) set("deprecated", patch.deprecated, "deprecated", patch.deprecated);
      if (Object.keys(changes).length) {
        db.prepare("UPDATE skills SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), s.id);
        audit(db, actor, "skill.patch", "skill", s.name, changes);
      }
    });
    return c.json(skillDetail(db, actor, readableSkill(db, actor, s.name)));
  });

  r.delete("/skills/:name", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    if (actor.role !== "admin") throw forbidden("only admins can delete skills");
    tx(db, () => {
      db.prepare("DELETE FROM skills WHERE id = ?").run(s.id);
      audit(db, actor, "skill.delete", "skill", s.name, {});
    });
    return c.body(null, 204);
  });

  r.get("/skills/:name/grants", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    if (!canWrite(actor, s)) throw forbidden("viewing grants needs write access");
    return c.json(grantsOf(db, s.id));
  });

  r.put("/skills/:name/grants", async (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const items = await jsonArrayBody(c);
    if (!canAdmin(actor, s)) throw forbidden("managing grants needs skill admin rights");
    if (items.length > 200) throw invalid("too many grants");
    const resolved = new Map<string, { type: "team" | "user"; id: number; grant: Grant }>();
    for (const raw of items) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("each grant must be an object");
      const g = raw as Record<string, unknown>;
      if (g.principalType !== "team" && g.principalType !== "user") throw invalid("principalType must be team or user");
      if (typeof g.principal !== "string" || !g.principal) throw invalid("principal must be a slug or handle");
      if (g.permission !== "read" && g.permission !== "write") throw invalid("permission must be read or write");
      const id = g.principalType === "team" ? teamIdBySlug(db, g.principal) : userIdByHandle(db, g.principal);
      if (id === null) throw invalid(`unknown ${g.principalType} "${g.principal}"`);
      const key = `${g.principalType}:${id}`;
      const prev = resolved.get(key);
      // A duplicate principal keeps the stronger permission.
      if (prev && prev.grant.permission === "write") continue;
      resolved.set(key, {
        type: g.principalType,
        id,
        grant: { principalType: g.principalType, principal: g.principal, permission: g.permission },
      });
    }
    tx(db, () => {
      db.prepare("DELETE FROM skill_grants WHERE skill_id = ?").run(s.id);
      const ins = db.prepare(
        "INSERT INTO skill_grants (skill_id, principal_type, principal_id, permission) VALUES (?, ?, ?, ?)",
      );
      for (const g of resolved.values()) ins.run(s.id, g.type, g.id, g.grant.permission);
      audit(db, actor, "grants.set", "skill", s.name, { grants: [...resolved.values()].map((g) => g.grant) });
    });
    return c.json(grantsOf(db, s.id));
  });

  return r;
}
