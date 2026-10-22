// Rows <-> wire types for git sources and proposals. Secrets never leave this layer in a wire type:
// toGitSource reads only the *_enc columns' presence and the stored hint.
import { randomBytes } from "node:crypto";
import type {
  Behavior,
  GitCredentialInput,
  GitProviderId,
  GitSource,
  PackageKind,
  Proposal,
  ProposalStatus,
  SkillSource,
  SyncStatus,
  Visibility,
} from "@intra-skills/shared";
import type { Db } from "../db.js";
import type { Actor } from "../access.js";
import { canRead } from "../access.js";
import { findSkill } from "../model.js";
import { getSettings } from "../settings.js";
import { webUrls } from "./provider.js";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** prefix + n unbiased base62 characters. */
export function randomId(prefix: string, n: number): string {
  let out = "";
  while (out.length < n)
    for (const b of randomBytes(n * 2)) {
      if (b < 248) out += BASE62[b % 62];
      if (out.length === n) break;
    }
  return prefix + out;
}

// ---------- sources ----------

export interface SourceRow {
  id: string;
  provider: GitProviderId;
  repo: string;
  base_branch: string;
  root: string;
  plugins_root: string;
  rules_root: string;
  api_url: string | null;
  min_approvals: number;
  enabled: number;
  is_default: number;
  credential_kind: GitCredentialInput["kind"];
  credential_enc: string | null;
  credential_hint: string;
  webhook_secret_enc: string | null;
  last_sync: string | null;
  created_at: string;
  updated_at: string;
}

export function sourceRow(db: Db, id: string): SourceRow | null {
  return (db.prepare("SELECT * FROM git_sources WHERE id = ?").get(id) as SourceRow | undefined) ?? null;
}

export function sourceRows(db: Db, where = ""): SourceRow[] {
  return db.prepare(`SELECT * FROM git_sources ${where} ORDER BY created_at, id`).all() as unknown as SourceRow[];
}

/** The source new skills are proposed into: the enabled default, else the oldest enabled one. */
export function defaultSource(db: Db): SourceRow | null {
  const rows = sourceRows(db, "WHERE enabled = 1");
  return rows.find((r) => r.is_default === 1) ?? rows[0] ?? null;
}

/** Base for webhook URLs when no request is at hand: the publicUrl setting, else empty. */
export function configuredBase(db: Db): string {
  return getSettings(db).publicUrl;
}

export function toGitSource(row: SourceRow, base: string): GitSource {
  return {
    id: row.id,
    provider: row.provider,
    repo: row.repo,
    baseBranch: row.base_branch,
    root: row.root,
    pluginsRoot: row.plugins_root,
    rulesRoot: row.rules_root,
    apiUrl: row.api_url,
    minApprovals: row.min_approvals,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    credential: { kind: row.credential_kind, set: row.credential_enc !== null, hint: row.credential_hint },
    webhook: { url: `${base.replace(/\/+$/, "")}/api/hooks/${row.id}`, secretSet: row.webhook_secret_enc !== null },
    lastSync: row.last_sync ? (JSON.parse(row.last_sync) as SyncStatus) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maskTail(secret: string): string {
  const s = secret.trim();
  if (s.length < 12) return "...";
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

/** Masked tail shown in the console, e.g. "ghp_...a1b2". Never enough to reuse the secret. */
export function credentialHint(c: GitCredentialInput): string {
  if (c.kind === "token") return maskTail(c.token);
  if (c.kind === "basic") return `${c.username} / ...${c.password.length >= 12 ? c.password.slice(-4) : ""}`;
  return `app ${c.appId}, installation ${c.installationId}`;
}

/** Wire form of the git source managing a skill, or null when the source no longer exists. */
export function skillSource(db: Db, sourceId: string | null, path: string | null): SkillSource | null {
  if (sourceId === null || path === null) return null;
  const row = sourceRow(db, sourceId);
  if (!row) return null;
  return {
    sourceId: row.id,
    provider: row.provider,
    repo: row.repo,
    path,
    webUrl: webUrls(row.provider, row.repo, row.api_url).folder(row.base_branch, path),
  };
}

// ---------- proposals ----------

export interface ProposalRow {
  id: string;
  skill_name: string;
  package_kind: PackageKind;
  version: string;
  kind: "new" | "update";
  proposer_id: number;
  source_id: string;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  status: ProposalStatus;
  status_message: string;
  changelog: string;
  behaviors: string;
  visibility: Visibility | null;
  team_slug: string | null;
  created_at: string;
  updated_at: string;
  proposer_handle: string;
  proposer_name: string;
}

const PROPOSAL_SELECT = `SELECT p.*, u.handle AS proposer_handle, u.display_name AS proposer_name
  FROM proposals p JOIN users u ON u.id = p.proposer_id`;

export function proposalRow(db: Db, id: string): ProposalRow | null {
  return (db.prepare(`${PROPOSAL_SELECT} WHERE p.id = ?`).get(id) as ProposalRow | undefined) ?? null;
}

export function proposalRows(db: Db, where = "", params: (string | number)[] = []): ProposalRow[] {
  return db
    .prepare(`${PROPOSAL_SELECT} ${where} ORDER BY p.created_at DESC, p.id DESC`)
    .all(...params) as unknown as ProposalRow[];
}

export function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id,
    skill: r.skill_name,
    packageKind: r.package_kind,
    version: r.version,
    kind: r.kind,
    proposer: { handle: r.proposer_handle, displayName: r.proposer_name },
    sourceId: r.source_id,
    branch: r.branch,
    pullRequest: r.pr_number !== null && r.pr_url !== null ? { number: r.pr_number, url: r.pr_url } : null,
    status: r.status,
    statusMessage: r.status_message,
    changelog: r.changelog,
    behaviors: JSON.parse(r.behaviors) as Behavior[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function setProposalStatus(db: Db, id: string, status: ProposalStatus, message: string): void {
  db.prepare("UPDATE proposals SET status = ?, status_message = ?, updated_at = ? WHERE id = ?").run(
    status,
    message,
    new Date().toISOString(),
    id,
  );
}

/**
 * Members see proposals for skills they can read plus their own; admins see all. A proposal for a
 * skill that does not exist yet is visible unless it asks for private visibility.
 */
export function canSeeProposal(db: Db, actor: Actor, r: ProposalRow): boolean {
  if (actor.role === "admin" || r.proposer_id === actor.id) return true;
  const s = findSkill(db, r.skill_name);
  if (s) return canRead(actor, s);
  return r.visibility !== "private";
}

const OPEN_STATUSES = "('open','merged','failed')";

/** Open proposals for a skill (any status except published and closed), newest first. */
export function proposalsForSkill(db: Db, skillName: string): Proposal[] {
  return proposalRows(db, `WHERE p.skill_name = ? AND p.status IN ${OPEN_STATUSES}`, [skillName]).map(toProposal);
}

/** For GET /api/home: open proposals the caller can see, and the caller's own non-published ones. */
export function proposalsForHome(db: Db, actor: Actor): { open: number; mine: Proposal[] } {
  const open = proposalRows(db, "WHERE p.status = 'open'").filter((r) => canSeeProposal(db, actor, r)).length;
  const mine = proposalRows(db, "WHERE p.proposer_id = ? AND p.status != 'published'", [actor.id])
    .slice(0, 20)
    .map(toProposal);
  return { open, mine };
}
