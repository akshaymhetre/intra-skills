// GET /home: the console's landing page in one request. Every list is built from readable skills only.
import { Hono } from "hono";
import type { FacetCount, HomeResponse, SkillSummary } from "@intra-skills/shared";
import type { Db } from "../db.js";
import type { AppEnv } from "../auth.js";
import type { Actor } from "../access.js";
import { canRead } from "../access.js";
import { type SkillRecord, loadSkills, summaryContext } from "../model.js";
import { proposalsForHome } from "../git/store.js";
import { listCollections } from "./collections.js";
import { reviewQueue } from "./trust.js";

const HOME_LIST = 8;

const byName = (a: SkillSummary, b: SkillSummary) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Owned by one of the actor's teams, or granted (read or write) to one of them or to the actor. */
function isTeamSkill(actor: Actor, s: SkillRecord): boolean {
  if (s.teamId !== null && actor.teams.has(s.teamId)) return true;
  return s.grants.some((g) => (g.principalType === "team" ? actor.teams.has(g.principalId) : g.principalId === actor.id));
}

export function homeRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/home", (c) => {
    const actor = c.get("actor");
    const skills = loadSkills(db).filter((s) => canRead(actor, s));
    const ctx = summaryContext(db, actor, skills);
    const summaries = new Map(skills.map((s) => [s.id, ctx.summary(s)]));
    const all = [...summaries.values()];

    const teams = db
      .prepare("SELECT t.id, t.slug, t.name FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.slug")
      .all(actor.id) as { id: number; slug: string; name: string }[];

    const teamSkills = skills
      .filter((s) => isTeamSkill(actor, s))
      .map((s) => summaries.get(s.id)!)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : byName(a, b)))
      .slice(0, HOME_LIST);

    const trending = [...all]
      .sort((a, b) => b.installsWeek - a.installsWeek || b.downloads - a.downloads || byName(a, b))
      .slice(0, HOME_LIST);

    const recent = skills
      .filter((s) => ctx.facts(s).latestPublishedAt !== null)
      .sort((a, b) => {
        const pa = ctx.facts(a).latestPublishedAt!;
        const pb = ctx.facts(b).latestPublishedAt!;
        return pa < pb ? 1 : pa > pb ? -1 : a.name < b.name ? -1 : 1;
      })
      .slice(0, HOME_LIST)
      .map((s) => summaries.get(s.id)!);

    const stackCounts = new Map<string, number>();
    for (const s of skills) for (const st of s.stacks) stackCounts.set(st, (stackCounts.get(st) ?? 0) + 1);
    const stacks: FacetCount[] = [...stackCounts]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));

    // The caller's teams' collections first, then everyone else's.
    const allCollections = listCollections(db, actor);
    const mineSlugs = new Set(teams.map((t) => t.slug));
    const collections = [
      ...allCollections.filter((col) => mineSlugs.has(col.team)),
      ...allCollections.filter((col) => !mineSlugs.has(col.team)),
    ];

    const teamCount = (db.prepare("SELECT count(*) AS n FROM teams").get() as { n: number }).n;
    const body: HomeResponse = {
      teams: teams.map((t) => ({ slug: t.slug, name: t.name })),
      teamSkills,
      trending,
      recent,
      stacks,
      collections,
      proposals: proposalsForHome(db, actor),
      reviewQueue: actor.role === "admin" ? reviewQueue(db, actor).length : 0,
      totals: {
        skills: skills.length,
        teams: teamCount,
        installsWeek: all.reduce((n, s) => n + s.installsWeek, 0),
        kinds: {
          skill: skills.filter((s) => s.kind === "skill").length,
          plugin: skills.filter((s) => s.kind === "plugin").length,
          rule: skills.filter((s) => s.kind === "rule").length,
        },
      },
    };
    return c.json(body);
  });

  return r;
}
