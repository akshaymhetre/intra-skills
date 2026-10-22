// Row loaders and row -> wire-type conversions. Every JSON body the server returns is built here.
import type {
  AuditEntry,
  Behavior,
  GitIdentity,
  GitProviderId,
  Health,
  PackageKind,
  PersonRef,
  PluginComponents,
  RuleSpec,
  SkillSource,
  TokenEstimate,
  Trust,
  Grant,
  GitInfo,
  PrincipalType,
  Permission,
  SkillDetail,
  SkillSummary,
  Team,
  TeamDetail,
  TeamRole,
  ToolId,
  User,
  VersionMeta,
} from "@intra-skills/shared";
import { addsAskBehavior, compareVersions, maxSatisfying } from "@intra-skills/shared";
import type { Db } from "./db.js";
import { type Actor, type GrantRef, type SkillAcl, canAdmin, canRead, canWrite } from "./access.js";
import { notFound } from "./http.js";
import { getSettings } from "./settings.js";
import { proposalsForSkill, skillSource } from "./git/store.js";

// ---------- users / actors ----------

interface UserRow {
  id: number;
  handle: string;
  display_name: string;
  role: "admin" | "member";
  created_at: string;
}

export function loadActorById(db: Db, id: number): Actor | null {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!u) return null;
  const teams = new Map<number, TeamRole>();
  for (const r of db.prepare("SELECT team_id, role FROM team_members WHERE user_id = ?").all(id) as {
    team_id: number;
    role: TeamRole;
  }[])
    teams.set(r.team_id, r.role);
  return { id: u.id, handle: u.handle, displayName: u.display_name, role: u.role, teams };
}

export function userIdByHandle(db: Db, handle: string): number | null {
  const r = db.prepare("SELECT id FROM users WHERE handle = ?").get(handle) as { id: number } | undefined;
  return r?.id ?? null;
}

export function getUser(db: Db, id: number): User {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
  if (!u) throw notFound("user not found");
  return toUser(db, u);
}

function toUser(db: Db, u: UserRow): User {
  const teams = db
    .prepare(
      "SELECT t.slug, m.role FROM team_members m JOIN teams t ON t.id = m.team_id WHERE m.user_id = ? ORDER BY t.slug",
    )
    .all(u.id) as { slug: string; role: TeamRole }[];
  return {
    handle: u.handle,
    displayName: u.display_name,
    role: u.role,
    createdAt: u.created_at,
    teams: teams.map((t) => ({ slug: t.slug, role: t.role })),
    gitIdentities: gitIdentitiesOf(db, u.id),
  };
}

export function gitIdentitiesOf(db: Db, userId: number): GitIdentity[] {
  return (
    db.prepare("SELECT provider, username FROM git_identities WHERE user_id = ? ORDER BY provider").all(userId) as {
      provider: GitProviderId;
      username: string;
    }[]
  ).map((r) => ({ provider: r.provider, username: r.username }));
}

export function listUsers(db: Db): User[] {
  return (db.prepare("SELECT * FROM users WHERE system = 0 ORDER BY handle").all() as unknown as UserRow[]).map((u) => toUser(db, u));
}

// ---------- teams ----------

interface TeamRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  created_at: string;
}

export function teamBySlug(db: Db, slug: string): TeamRow | null {
  return (db.prepare("SELECT * FROM teams WHERE slug = ?").get(slug) as TeamRow | undefined) ?? null;
}

export function teamIdBySlug(db: Db, slug: string): number | null {
  return teamBySlug(db, slug)?.id ?? null;
}

function toTeam(db: Db, actor: Actor, t: TeamRow): Team {
  const memberCount = (
    db.prepare("SELECT count(*) AS n FROM team_members WHERE team_id = ?").get(t.id) as { n: number }
  ).n;
  // Count only skills the caller can read, so a private skill's existence does not leak through a count.
  const skillCount = loadSkills(db, "WHERE s.team_id = ?", [t.id]).filter((s) => canRead(actor, s)).length;
  return {
    slug: t.slug,
    name: t.name,
    description: t.description,
    memberCount,
    skillCount,
    createdAt: t.created_at,
  };
}

export function listTeams(db: Db, actor: Actor): Team[] {
  return (db.prepare("SELECT * FROM teams ORDER BY slug").all() as unknown as TeamRow[]).map((t) =>
    toTeam(db, actor, t),
  );
}

export function getTeamDetail(db: Db, actor: Actor, slug: string): TeamDetail {
  const t = teamBySlug(db, slug);
  if (!t) throw notFound("team not found");
  const members = db
    .prepare(
      "SELECT u.handle, u.display_name, m.role FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY u.handle",
    )
    .all(t.id) as { handle: string; display_name: string; role: TeamRole }[];
  return {
    ...toTeam(db, actor, t),
    members: members.map((m) => ({ handle: m.handle, displayName: m.display_name, role: m.role })),
  };
}

// ---------- skills ----------

export interface SkillRecord extends SkillAcl {
  id: number;
  name: string;
  kind: PackageKind;
  description: string;
  teamSlug: string | null;
  areas: string[];
  stacks: string[];
  tools: ToolId[];
  tags: string[];
  deprecated: string | null;
  downloads: number;
  creatorHandle: string;
  creatorName: string;
  /** Git source managing the skill, or null. */
  sourceId: string | null;
  sourcePath: string | null;
  verifiedVersion: string | null;
  verifiedBy: number | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SkillRow {
  id: number;
  name: string;
  kind: PackageKind;
  description: string;
  team_id: number | null;
  team_slug: string | null;
  areas: string;
  stacks: string;
  tools: string;
  tags: string;
  visibility: "org" | "private";
  deprecated: string | null;
  downloads: number;
  created_by: number;
  creator_handle: string;
  creator_name: string;
  source_id: string | null;
  source_path: string | null;
  verified_version: string | null;
  verified_by: number | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

type SqlParam = string | number | null;

export function loadSkills(db: Db, where = "", params: SqlParam[] = []): SkillRecord[] {
  const rows = db
    .prepare(
      `SELECT s.*, t.slug AS team_slug, u.handle AS creator_handle, u.display_name AS creator_name
       FROM skills s LEFT JOIN teams t ON t.id = s.team_id JOIN users u ON u.id = s.created_by ${where}`,
    )
    .all(...params) as unknown as SkillRow[];
  if (rows.length === 0) return [];
  const grants = new Map<number, GrantRef[]>();
  const ids = rows.map((r) => r.id);
  const gs = db
    .prepare(
      `SELECT skill_id, principal_type, principal_id, permission FROM skill_grants WHERE skill_id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as { skill_id: number; principal_type: PrincipalType; principal_id: number; permission: Permission }[];
  for (const g of gs) {
    const list = grants.get(g.skill_id) ?? [];
    list.push({ principalType: g.principal_type, principalId: g.principal_id, permission: g.permission });
    grants.set(g.skill_id, list);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    description: r.description,
    teamId: r.team_id,
    teamSlug: r.team_slug,
    areas: JSON.parse(r.areas) as string[],
    stacks: JSON.parse(r.stacks) as string[],
    tools: JSON.parse(r.tools) as ToolId[],
    tags: JSON.parse(r.tags) as string[],
    visibility: r.visibility,
    deprecated: r.deprecated,
    downloads: r.downloads,
    createdBy: r.created_by,
    creatorHandle: r.creator_handle,
    creatorName: r.creator_name,
    sourceId: r.source_id,
    sourcePath: r.source_path,
    verifiedVersion: r.verified_version,
    verifiedBy: r.verified_by,
    verifiedAt: r.verified_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    grants: grants.get(r.id) ?? [],
  }));
}

export function findSkill(db: Db, name: string): SkillRecord | null {
  return loadSkills(db, "WHERE s.name = ?", [name])[0] ?? null;
}

/** The skill if the actor can read it; otherwise 404 (never 403), so existence does not leak. */
export function readableSkill(db: Db, actor: Actor, name: string): SkillRecord {
  const s = findSkill(db, name);
  if (!s || !canRead(actor, s)) throw notFound(`skill "${name}" not found`);
  return s;
}

export interface VersionRow {
  id: number;
  skill_id: number;
  version: string;
  sha256: string;
  size: number;
  file_count: number;
  changelog: string;
  published_by: number;
  publisher_handle: string;
  published_at: string;
  git: string | null;
  yanked: string | null;
  downloads: number;
  behaviors: string;
  tokens: string | null;
  plugin: string | null;
  rule: string | null;
  archive_sha256: string | null;
}

export function loadVersions(db: Db, skillId: number): VersionRow[] {
  const rows = db
    .prepare(
      "SELECT v.*, u.handle AS publisher_handle FROM versions v JOIN users u ON u.id = v.published_by WHERE v.skill_id = ?",
    )
    .all(skillId) as unknown as VersionRow[];
  return rows.sort((a, b) => compareVersions(b.version, a.version));
}

/** Highest non-yanked stable version; falls back to the highest non-yanked prerelease. */
export function latestOf(versions: { version: string; yanked: string | null }[]): string | null {
  const live = versions.filter((v) => v.yanked === null).map((v) => v.version);
  const stable = maxSatisfying(live, "latest");
  if (stable) return stable;
  let best: string | null = null;
  for (const v of live) if (best === null || compareVersions(v, best) > 0) best = v;
  return best;
}

export function toVersionMeta(v: VersionRow): VersionMeta {
  return {
    version: v.version,
    sha256: v.sha256,
    size: v.size,
    fileCount: v.file_count,
    changelog: v.changelog,
    publishedBy: v.publisher_handle,
    publishedAt: v.published_at,
    git: v.git ? (JSON.parse(v.git) as GitInfo) : null,
    yanked: v.yanked,
    downloads: v.downloads,
    behaviors: JSON.parse(v.behaviors) as Behavior[],
    tokens: v.tokens ? (JSON.parse(v.tokens) as TokenEstimate) : null,
    plugin: v.plugin ? (JSON.parse(v.plugin) as PluginComponents) : null,
    rule: v.rule ? (JSON.parse(v.rule) as RuleSpec) : null,
  };
}

/**
 * Per-request facts a summary needs beyond the skill row. Built once per request for every skill
 * in the response (see summaryContext), so a list of N skills costs a fixed number of queries.
 */
export interface SummaryExtras {
  installsWeek: number;
  trend: number[];
  health: Health;
  verified: boolean;
  trust: Trust;
  author: PersonRef;
  source: SkillSource | null;
}

export const EMPTY_TREND: readonly number[] = Object.freeze(new Array<number>(14).fill(0));

export function toSummary(s: SkillRecord, latest: string | null, extras?: Partial<SummaryExtras>): SkillSummary {
  return {
    name: s.name,
    kind: s.kind,
    description: s.description,
    team: s.teamSlug,
    areas: s.areas,
    stacks: s.stacks,
    tools: s.tools,
    tags: s.tags,
    visibility: s.visibility,
    latestVersion: latest,
    deprecated: s.deprecated,
    downloads: s.downloads,
    installsWeek: extras?.installsWeek ?? 0,
    trend: extras?.trend ?? [...EMPTY_TREND],
    health: extras?.health ?? "active",
    verified: extras?.verified ?? false,
    trust: extras?.trust ?? { works: 0, broken: 0, mine: null },
    createdBy: s.creatorHandle,
    author: extras?.author ?? { handle: s.creatorHandle, displayName: s.creatorName },
    source: extras?.source ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** All versions of the given skills, keyed by skill id (one query). */
export function versionsBySkill(db: Db): Map<number, { version: string; yanked: string | null }[]> {
  const out = new Map<number, { version: string; yanked: string | null }[]>();
  for (const r of db.prepare("SELECT skill_id, version, yanked FROM versions").all() as {
    skill_id: number;
    version: string;
    yanked: string | null;
  }[]) {
    const list = out.get(r.skill_id) ?? [];
    list.push({ version: r.version, yanked: r.yanked });
    out.set(r.skill_id, list);
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const TREND_DAYS = 14;
/** Above this many skills a context loads every row instead of binding an IN list. */
const IN_LIST_MAX = 500;

/** The last TREND_DAYS UTC dates (YYYY-MM-DD), oldest first, today last. */
export function trendDays(now = new Date()): string[] {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const out: string[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) out.push(new Date(today - i * DAY_MS).toISOString().slice(0, 10));
  return out;
}

interface CtxVersion {
  version: string;
  yanked: string | null;
  publishedAt: string;
  behaviors: Behavior[];
  publisher: PersonRef;
}

/** Summary facts for one skill, as computed by a SummaryContext. */
export interface SkillFacts extends SummaryExtras {
  latestVersion: string | null;
  /** published_at of the latest live version, or null when none is live. */
  latestPublishedAt: string | null;
}

export interface SummaryContext {
  facts(s: SkillRecord): SkillFacts;
  summary(s: SkillRecord): SkillSummary;
}

/**
 * Batch the per-skill facts every SkillSummary carries (installs, trend, health, verified, trust,
 * author, source) for a set of skills, with a fixed number of queries however many skills there
 * are. Pass only skills the actor can read: nothing here re-checks access.
 */
export function summaryContext(db: Db, actor: Actor, skills: SkillRecord[], now = new Date()): SummaryContext {
  const ids = [...new Set(skills.map((s) => s.id))];
  const all = ids.length > IN_LIST_MAX;
  const inList = (col: string) => (all ? "" : `${col} IN (${ids.map(() => "?").join(",")})`);
  const idParams = all ? [] : ids;

  const versions = new Map<number, CtxVersion[]>();
  const installsWeek = new Map<number, number>();
  const trend = new Map<number, number[]>();
  const trust = new Map<number, Trust>();
  if (ids.length > 0) {
    const vrows = db
      .prepare(
        `SELECT v.skill_id, v.version, v.yanked, v.published_at, v.behaviors, u.handle, u.display_name
         FROM versions v JOIN users u ON u.id = v.published_by ${all ? "" : `WHERE ${inList("v.skill_id")}`}`,
      )
      .all(...idParams) as {
      skill_id: number;
      version: string;
      yanked: string | null;
      published_at: string;
      behaviors: string;
      handle: string;
      display_name: string;
    }[];
    for (const r of vrows) {
      const list = versions.get(r.skill_id) ?? [];
      list.push({
        version: r.version,
        yanked: r.yanked,
        publishedAt: r.published_at,
        behaviors: JSON.parse(r.behaviors) as Behavior[],
        publisher: { handle: r.handle, displayName: r.display_name },
      });
      versions.set(r.skill_id, list);
    }

    const days = trendDays(now);
    const dayIndex = new Map(days.map((d, i) => [d, i]));
    const where = all ? "WHERE at >= ?" : `WHERE ${inList("skill_id")} AND at >= ?`;
    for (const r of db
      .prepare(`SELECT skill_id, substr(at, 1, 10) AS day, count(*) AS n FROM install_events ${where} GROUP BY skill_id, day`)
      .all(...idParams, `${days[0]}T00:00:00.000Z`) as { skill_id: number; day: string; n: number }[]) {
      const i = dayIndex.get(r.day);
      if (i === undefined) continue;
      const t = trend.get(r.skill_id) ?? new Array<number>(TREND_DAYS).fill(0);
      t[i] = (t[i] ?? 0) + r.n;
      trend.set(r.skill_id, t);
    }
    for (const r of db
      .prepare(`SELECT skill_id, count(*) AS n FROM install_events ${where} GROUP BY skill_id`)
      .all(...idParams, new Date(now.getTime() - 7 * DAY_MS).toISOString()) as { skill_id: number; n: number }[])
      installsWeek.set(r.skill_id, r.n);

    for (const r of db
      .prepare(
        `SELECT skill_id, sum(works) AS works, sum(1 - works) AS broken,
                max(CASE WHEN user_id = ? THEN works + 1 END) AS mine
         FROM votes ${all ? "" : `WHERE ${inList("skill_id")}`} GROUP BY skill_id`,
      )
      .all(actor.id, ...idParams) as { skill_id: number; works: number; broken: number; mine: number | null }[])
      trust.set(r.skill_id, {
        works: r.works,
        broken: r.broken,
        mine: r.mine === null ? null : r.mine === 2 ? "works" : "broken",
      });
  }

  const { staleDays } = getSettings(db);
  const staleBefore = new Date(now.getTime() - staleDays * DAY_MS).toISOString();
  const sources = new Map<string, SkillSource | null>();
  const cache = new Map<number, SkillFacts>();

  const facts = (s: SkillRecord): SkillFacts => {
    const hit = cache.get(s.id);
    if (hit) return hit;
    const vs = versions.get(s.id) ?? [];
    const latest = latestOf(vs);
    const latestRow = latest === null ? undefined : vs.find((v) => v.version === latest);
    const verifiedRow = s.verifiedVersion === null ? undefined : vs.find((v) => v.version === s.verifiedVersion);
    const verified =
      latestRow !== undefined &&
      verifiedRow !== undefined &&
      (verifiedRow.version === latestRow.version || !addsAskBehavior(verifiedRow.behaviors, latestRow.behaviors));
    let source: SkillSource | null = null;
    if (s.sourceId !== null) {
      const key = `${s.sourceId}\n${s.sourcePath ?? ""}`;
      if (!sources.has(key)) sources.set(key, skillSource(db, s.sourceId, s.sourcePath));
      source = sources.get(key) ?? null;
    }
    const f: SkillFacts = {
      latestVersion: latest,
      latestPublishedAt: latestRow?.publishedAt ?? null,
      installsWeek: installsWeek.get(s.id) ?? 0,
      trend: trend.get(s.id) ?? [...EMPTY_TREND],
      health: latestRow !== undefined && latestRow.publishedAt >= staleBefore ? "active" : "stale",
      verified,
      trust: trust.get(s.id) ?? { works: 0, broken: 0, mine: null },
      author: latestRow?.publisher ?? { handle: s.creatorHandle, displayName: s.creatorName },
      source,
    };
    cache.set(s.id, f);
    return f;
  };
  return { facts, summary: (s) => toSummary(s, facts(s).latestVersion, facts(s)) };
}

/** Summaries for a set of readable skills, with the batched v2 facts. */
export function summarize(db: Db, actor: Actor, skills: SkillRecord[]): SkillSummary[] {
  const ctx = summaryContext(db, actor, skills);
  return skills.map((s) => ctx.summary(s));
}

function personById(db: Db, id: number | null): PersonRef {
  const u =
    id === null
      ? undefined
      : (db.prepare("SELECT handle, display_name FROM users WHERE id = ?").get(id) as
          | { handle: string; display_name: string }
          | undefined);
  return u ? { handle: u.handle, displayName: u.display_name } : { handle: "", displayName: "deleted user" };
}

export function grantsOf(db: Db, skillId: number): Grant[] {
  const rows = db
    .prepare(
      `SELECT g.principal_type, g.permission,
              CASE g.principal_type WHEN 'team' THEN t.slug ELSE u.handle END AS principal
       FROM skill_grants g
       LEFT JOIN teams t ON g.principal_type = 'team' AND t.id = g.principal_id
       LEFT JOIN users u ON g.principal_type = 'user' AND u.id = g.principal_id
       WHERE g.skill_id = ?
       ORDER BY g.principal_type, principal`,
    )
    .all(skillId) as { principal_type: PrincipalType; permission: Permission; principal: string | null }[];
  return rows
    .filter((r) => r.principal !== null)
    .map((r) => ({ principalType: r.principal_type, principal: r.principal!, permission: r.permission }));
}

export function skillDetail(db: Db, actor: Actor, s: SkillRecord): SkillDetail {
  const versions = loadVersions(db, s.id);
  const write = canWrite(actor, s);
  const verification =
    s.verifiedVersion !== null && s.verifiedAt !== null
      ? { version: s.verifiedVersion, by: personById(db, s.verifiedBy), at: s.verifiedAt }
      : null;
  return {
    ...summaryContext(db, actor, [s]).summary(s),
    versions: versions.map(toVersionMeta),
    grants: write ? grantsOf(db, s.id) : null,
    permissions: { canWrite: write, canAdmin: canAdmin(actor, s) },
    verification,
    proposals: proposalsForSkill(db, s.name),
  };
}

// ---------- audit ----------

export type AuditKind = "skill" | "team" | "user" | "token" | "source" | "proposal" | "collection" | "settings";

export function audit(
  db: Db,
  actor: Actor | null,
  action: string,
  kind: AuditKind,
  target: string,
  detail: Record<string, unknown> = {},
): void {
  db.prepare("INSERT INTO audit (at, actor, action, kind, target, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    actor?.handle ?? null,
    action,
    kind,
    target,
    JSON.stringify(detail),
  );
}

export function toAuditEntry(r: {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string;
  detail: string;
}): AuditEntry {
  return {
    id: r.id,
    at: r.at,
    actor: r.actor,
    action: r.action,
    target: r.target,
    detail: JSON.parse(r.detail) as Record<string, unknown>,
  };
}
