// One sync of one git source: turn merged pull requests into versions (docs/API.md "Sync").
// Every version goes through publish.ts createVersion, the same checks as a direct publish.
import { KINDS, KIND_MARKER, NAME_RE, compareVersions, isValidVersion, parseSkillMd, type GitInfo, type PackageKind, type SyncStatus } from "@intra-skills/shared";
import type { Db } from "../db.js";
import { HttpError } from "../http.js";
import { canWrite } from "../access.js";
import { audit, findSkill, loadActorById, loadVersions } from "../model.js";
import { asText, createVersion, decodedFile } from "../publish.js";
import type { GitProvider, PullRequestInfo } from "./provider.js";
import { LIST_DEPTH, discoverFolders, rootFor } from "./discover.js";
import { type ProposalRow, type SourceRow, proposalRow, proposalRows, setProposalStatus, sourceRow } from "./store.js";

export const SYSTEM_HANDLE = "git-sync";
/**
 * Not final: a host's commit-to-pull-request index lags a merge (GitHub took about a second on
 * 2026-10-16), so a folder skipped for this reason is read again on the next sync, and a proposal
 * is never failed for it.
 */
export const NOT_MERGED = "not merged through a pull request";
const MARKER_RE = /<!-- intra-skills:proposal=(prp_[A-Za-z0-9]{1,64}) -->/g;

export function proposalMarker(id: string): string {
  return `<!-- intra-skills:proposal=${id} -->`;
}

/** The proposal a pull request belongs to: by its hidden marker, else by branch. */
export function matchProposal(db: Db, sourceId: string, pr: PullRequestInfo, skill: string | null): ProposalRow | null {
  const ids = [...pr.body.matchAll(MARKER_RE)].map((m) => m[1]!);
  for (const id of ids.reverse()) {
    const r = proposalRow(db, id);
    if (r && r.source_id === sourceId && (skill === null || r.skill_name === skill)) return r;
  }
  const byBranch = proposalRows(db, "WHERE p.source_id = ? AND p.branch = ?" + (skill ? " AND p.skill_name = ?" : ""), [
    sourceId,
    pr.headBranch,
    ...(skill ? [skill] : []),
  ]);
  return byBranch.find((r) => r.pr_number === pr.number) ?? byBranch[0] ?? null;
}

export function gitUsername(db: Db, userId: number, provider: string): string | null {
  const r = db.prepare("SELECT username FROM git_identities WHERE user_id = ? AND provider = ?").get(userId, provider) as
    | { username: string }
    | undefined;
  return r?.username ?? null;
}

function userByGitIdentity(db: Db, provider: string, username: string): number | null {
  // git_identities.username is COLLATE NOCASE, so this matches case-insensitively.
  const r = db
    .prepare("SELECT g.user_id FROM git_identities g JOIN users u ON u.id = g.user_id WHERE g.provider = ? AND g.username = ?")
    .get(provider, username) as { user_id: number } | undefined;
  return r?.user_id ?? null;
}

/** The system user that publishes merged pull requests nobody in the registry can be matched to. */
export function systemUserId(db: Db): number {
  const r = db.prepare("SELECT id FROM users WHERE handle = ? AND system = 1").get(SYSTEM_HANDLE) as { id: number } | undefined;
  if (r) return r.id;
  return Number(
    db
      .prepare("INSERT INTO users (handle, display_name, role, created_at, system) VALUES (?, ?, 'member', ?, 1)")
      .run(SYSTEM_HANDLE, "Git sync", new Date().toISOString()).lastInsertRowid,
  );
}

/**
 * Approvals that count: distinct reviewers whose latest review approves, minus the registry's own
 * account, the pull request author, and the proposer's linked username.
 */
export function countedApprovals(pr: PullRequestInfo, excluded: (string | null)[]): string[] {
  const ex = new Set(excluded.filter((x): x is string => !!x).map((x) => x.toLowerCase()));
  if (pr.author) ex.add(pr.author.toLowerCase());
  return [...new Set(pr.approvals.map((a) => a.toLowerCase()))].filter((a) => !ex.has(a));
}

export function approvalsMessage(n: number): string {
  return `needs ${n} approval${n === 1 ? "" : "s"} from someone other than the proposer`;
}

/** Re-read one proposal's pull request and move its status. Returns the fresh row. */
export async function refreshProposal(
  db: Db,
  provider: GitProvider,
  source: SourceRow,
  row: ProposalRow,
  registryLogin: string | null,
): Promise<ProposalRow> {
  if (row.pr_number === null || (row.status !== "open" && row.status !== "merged")) return row;
  const pr = await provider.getPullRequest(row.pr_number);
  if (pr.state === "closed") setProposalStatus(db, row.id, "closed", "The pull request was closed without merging");
  else if (pr.state === "merged") {
    const skill = findSkill(db, row.skill_name);
    const published = skill && loadVersions(db, skill.id).some((v) => v.version === row.version);
    if (published) setProposalStatus(db, row.id, "published", `Published as ${row.skill_name}@${row.version}`);
    else if (row.status === "open") setProposalStatus(db, row.id, "merged", "Merged; the next sync publishes it");
  } else {
    const have = countedApprovals(pr, [registryLogin, gitUsername(db, row.proposer_id, source.provider)]).length;
    const need = source.min_approvals - have;
    setProposalStatus(
      db,
      row.id,
      "open",
      need > 0
        ? `Waiting for ${need} approval${need === 1 ? "" : "s"} from someone other than you`
        : "Approved; waiting for someone to merge the pull request",
    );
  }
  return proposalRow(db, row.id)!;
}

export async function runSync(db: Db, source: SourceRow, provider: GitProvider): Promise<SyncStatus> {
  const at = new Date().toISOString();
  const last = source.last_sync ? (JSON.parse(source.last_sync) as SyncStatus) : null;
  const ingested: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let hostErrors = 0;

  const head = await provider.headCommit(source.base_branch);
  if (head === null)
    return { at, ok: false, message: `branch ${source.base_branch} does not exist`, ingested, skipped, headCommit: null };

  let registryLogin: string | null = null;
  try {
    registryLogin = await provider.whoAmI();
  } catch {
    registryLogin = null; // unknown; the PR author exclusion still covers pull requests the registry opened
  }

  // Open proposals are refreshed on every sync.
  for (const r of proposalRows(db, "WHERE p.source_id = ? AND p.status IN ('open','merged')", [source.id])) {
    try {
      await refreshProposal(db, provider, source, r, registryLogin);
    } catch (e) {
      hostErrors++;
      skipped.push({ path: r.branch, reason: `could not read pull request #${r.pr_number}: ${(e as Error).message}` });
    }
  }

  const retry = last?.skipped.some((s) => s.reason === NOT_MERGED) ?? false;
  if (last?.ok && last.headCommit === head && !retry)
    return {
      at,
      ok: hostErrors === 0,
      message: `no new commits on ${source.base_branch}`,
      ingested,
      skipped: hostErrors ? skipped : last.skipped,
      headCommit: head,
    };

  const failedSkills = new Map<string, string>();
  const folders: { folder: string; kind: PackageKind }[] = [];
  for (const kind of KINDS) {
    const root = rootFor(source, kind);
    const found = discoverFolders(await provider.listFiles(head, root, LIST_DEPTH[kind]), root, kind, source);
    skipped.push(...found.skipped);
    folders.push(...found.folders.map((folder) => ({ folder, kind })));
  }
  for (const { folder, kind } of folders) {
    const name = folder.slice(folder.lastIndexOf("/") + 1);
    const skip = (reason: string, proposal?: ProposalRow | null) => {
      skipped.push({ path: folder, reason });
      if (reason === NOT_MERGED) return; // retried on the next sync, see NOT_MERGED
      failedSkills.set(name, reason);
      if (proposal) setProposalStatus(db, proposal.id, "failed", reason);
    };
    try {
      if (!NAME_RE.test(name) || name.length > 64) {
        skip("folder name is not a valid skill name");
        continue;
      }
      const marker = asText(await provider.readFile(head, `${folder}/${KIND_MARKER[kind]}`));
      const version = marker === null ? null : declaredVersion(kind, marker, name);
      if (!version) {
        skip(kind === "plugin" ? "no version in .claude-plugin/plugin.json" : "no metadata.version");
        continue;
      }
      const existing = findSkill(db, name);
      // A skill stays with its source; once that source is deleted, another may take it over.
      if (existing?.sourceId && existing.sourceId !== source.id && sourceRow(db, existing.sourceId)) {
        skip("managed by another git source");
        continue;
      }
      if (existing) {
        const versions = loadVersions(db, existing.id);
        if (versions.some((v) => v.version === version)) continue; // already ingested: silent
        const newer = versions.find((v) => compareVersions(version, v.version) <= 0);
        if (newer) {
          skip(`${version} is not newer than ${newer.version}`);
          continue;
        }
      }

      const commit = await provider.lastCommitForPath(source.base_branch, folder);
      const prs = commit ? (await provider.pullRequestsForCommit(commit, source.base_branch)).filter((p) => p.merged) : [];
      const pick = prs.find((p) => p.baseBranch === source.base_branch) ?? prs[0];
      // The registry's own proposal knows its pull request, so it needs no commit index: use it
      // when the folder's last commit is exactly that pull request's merge commit.
      const pr = pick
        ? await provider.getPullRequest(pick.number)
        : commit
          ? await proposalMergedAt(db, provider, source.id, name, commit)
          : null;
      if (!commit || !pr) {
        skip(NOT_MERGED);
        continue;
      }
      const proposal = matchProposal(db, source.id, pr, name);

      const counted = countedApprovals(pr, [
        registryLogin,
        proposal ? gitUsername(db, proposal.proposer_id, source.provider) : null,
      ]);
      if (counted.length < source.min_approvals) {
        skip(approvalsMessage(source.min_approvals), proposal);
        continue;
      }

      const publisherId =
        proposal?.proposer_id ?? (pr.author ? userByGitIdentity(db, source.provider, pr.author) : null) ?? systemUserId(db);
      if (existing && (!existing.sourceId || existing.sourceId !== source.id)) {
        // Adopting a skill published directly (or left by a deleted source): only for someone who could write it.
        const who = loadActorById(db, publisherId);
        if (!who || !canWrite(who, existing)) {
          skip(`${name} exists in the registry and ${who?.handle ?? "the publisher"} cannot write it`, proposal);
          continue;
        }
      }

      const at2 = pr.mergeCommit ?? commit;
      const files = [];
      for (const f of await provider.listFiles(at2, folder)) {
        files.push(decodedFile(f.path.slice(folder.length + 1), f.mode, await provider.readFile(at2, f.path)));
      }
      const git: GitInfo = {
        commit: at2,
        repo: provider.repoLabel,
        dirty: false,
        url: provider.commitUrl(at2),
        pullRequest: { number: pr.number, url: pr.url },
      };
      try {
        createVersion(db, existing, {
          name,
          version,
          files,
          changelog: proposal?.changelog || pr.title,
          git,
          publisherId,
          actor: null,
          mayMoveTeam: true,
          requestedTeam: existing || !proposal || proposal.team_slug === null ? undefined : proposal.team_slug || null,
          requestedVisibility: existing || !proposal ? undefined : (proposal.visibility ?? undefined),
          source: { id: source.id, path: folder },
        });
      } catch (e) {
        if (!(e instanceof HttpError) || e.code === "upstream" || e.code === "internal") throw e;
        skip(refusal(e), proposal);
        continue;
      }
      ingested.push(`${name}@${version}`);
      failedSkills.delete(name);
      if (proposal) setProposalStatus(db, proposal.id, "published", `Published as ${name}@${version}`);
    } catch (e) {
      hostErrors++;
      skipped.push({ path: folder, reason: (e as Error).message });
    }
  }

  // A merged proposal whose folder was refused for a reason found before its pull request was read.
  for (const r of proposalRows(db, "WHERE p.source_id = ? AND p.status = 'merged'", [source.id])) {
    const reason = failedSkills.get(r.skill_name);
    if (reason) setProposalStatus(db, r.id, "failed", reason);
  }

  if (ingested.length > 0)
    audit(db, null, "source.sync", "source", source.id, { headCommit: head, ingested, skipped: skipped.length });
  const message =
    hostErrors > 0
      ? `${hostErrors} item${hostErrors === 1 ? "" : "s"} could not be read from the git host`
      : ingested.length > 0
        ? `published ${ingested.join(", ")}`
        : "nothing new to publish";
  return { at, ok: hostErrors === 0, message, ingested, skipped, headCommit: head };
}

/** A pull request of one of this skill's proposals that was merged as exactly `commit`. */
async function proposalMergedAt(
  db: Db,
  provider: GitProvider,
  sourceId: string,
  skill: string,
  commit: string,
): Promise<PullRequestInfo | null> {
  const rows = proposalRows(db, "WHERE p.source_id = ? AND p.skill_name = ? AND p.pr_number IS NOT NULL AND p.status IN ('open','merged','failed')", [
    sourceId,
    skill,
  ]);
  for (const r of rows) {
    const pr = await provider.getPullRequest(r.pr_number!);
    const mc = pr.mergeCommit;
    if (pr.state === "merged" && mc && (mc.startsWith(commit) || commit.startsWith(mc))) return pr;
  }
  return null;
}

/** The version a package's marker file declares, or null. */
export function declaredVersion(kind: PackageKind, markerText: string, name: string): string | null {
  if (kind !== "plugin") return parseSkillMd(markerText, name).skill?.version ?? null;
  try {
    const m = JSON.parse(markerText) as { version?: unknown };
    return typeof m.version === "string" && isValidVersion(m.version.trim()) ? m.version.trim() : null;
  } catch {
    return null;
  }
}

function refusal(e: HttpError): string {
  const issues = Array.isArray(e.details) ? (e.details as { level?: string; field?: string; message?: string }[]) : [];
  const errors = issues.filter((i) => i.level === "error").map((i) => `${i.field}: ${i.message}`);
  return errors.length ? `${e.message}: ${errors.join("; ")}` : e.message;
}
