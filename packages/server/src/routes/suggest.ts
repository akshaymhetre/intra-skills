// POST /suggest: rank readable skills for a repo from its file and dependency names (never contents).
import { Hono } from "hono";
import { detectStacks, type RepoSignals, type SuggestResponse } from "@intra-skills/shared";
import type { Db } from "../db.js";
import type { AppEnv } from "../auth.js";
import type { Actor } from "../access.js";
import { canRead } from "../access.js";
import { invalid, jsonBody } from "../http.js";
import { loadSkills, summaryContext } from "../model.js";

export const MAX_SIGNAL_FILES = 5000;
export const MAX_SIGNAL_PACKAGES = 2000;
export const MAX_SIGNAL_LENGTH = 500;
const MAX_SUGGESTIONS = 20;

function signalList(body: Record<string, unknown>, key: string, max: number): string[] {
  const v = body[key] ?? [];
  if (!Array.isArray(v)) throw invalid(`${key} must be an array of strings`);
  if (v.length > max) throw invalid(`${key} holds at most ${max} entries`);
  for (const x of v) {
    if (typeof x !== "string") throw invalid(`${key} must contain strings`);
    if (x.length > MAX_SIGNAL_LENGTH) throw invalid(`each ${key} entry is at most ${MAX_SIGNAL_LENGTH} characters`);
  }
  return v as string[];
}

export function parseSignals(body: Record<string, unknown>): RepoSignals {
  return {
    files: signalList(body, "files", MAX_SIGNAL_FILES),
    packages: signalList(body, "packages", MAX_SIGNAL_PACKAGES),
  };
}

export function suggest(db: Db, actor: Actor, signals: RepoSignals): SuggestResponse {
  const stacks = detectStacks(signals).map((d) => d.stack);
  const detected = new Set(stacks);
  const skills = loadSkills(db).filter((s) => canRead(actor, s) && s.deprecated === null);
  const teamSlugs = new Map<number, string>(
    (
      db.prepare("SELECT t.id, t.slug FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ?").all(actor.id) as {
        id: number;
        slug: string;
      }[]
    ).map((t) => [t.id, t.slug]),
  );
  const ctx = summaryContext(db, actor, skills);
  const out: SuggestResponse["skills"] = [];
  for (const s of skills) {
    const stackHits = s.stacks.filter((st) => detected.has(st));
    const tagHits = s.tags.filter((t) => detected.has(t));
    if (stackHits.length === 0 && tagHits.length === 0) continue;
    const f = ctx.facts(s);
    let score = 3 * stackHits.length + tagHits.length;
    const reasons = [...new Set([...stackHits, ...tagHits])].map((st) => `matches ${st}`);
    const ownTeam = s.teamId === null ? undefined : teamSlugs.get(s.teamId);
    if (ownTeam !== undefined) {
      score += 2;
      reasons.push(`owned by your team ${ownTeam}`);
    }
    if (f.verified) {
      score += 1;
      reasons.push("verified");
    }
    score += Math.min(f.installsWeek, 5) / 5;
    out.push({ skill: ctx.summary(s), score: Math.round(score * 100) / 100, reasons });
  }
  out.sort((a, b) => b.score - a.score || (a.skill.name < b.skill.name ? -1 : 1));
  return { stacks, skills: out.slice(0, MAX_SUGGESTIONS) };
}

export function suggestRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post("/suggest", async (c) => c.json(suggest(db, c.get("actor"), parseSignals(await jsonBody(c)))));
  return r;
}
