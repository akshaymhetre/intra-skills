// POST /skills/:name/proposals: every check a direct publish runs, plus the secret patterns, all
// BEFORE the git host is touched; then a branch, a commit and a pull request opened server-side
// with the registry's own credential.
import {
  KIND_LABELS,
  estimateTokens,
  pluginBehaviors,
  scanBehaviors,
  scanSecrets,
  type Behavior,
  type GitProviderId,
  type PackageKind,
  type Proposal,
  type TokenEstimate,
  type ValidationIssue,
} from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import type { Actor } from "../access.js";
import { canWrite } from "../access.js";
import { HttpError, conflict, forbidden, invalid } from "../http.js";
import { audit, findSkill, readableSkill, teamIdBySlug } from "../model.js";
import { assertNewerVersion, putBlob, toScanFiles, validateSkillFiles } from "../publish.js";
import type { PublishBody } from "../routes/versions.js";
import { publishMode } from "../settings.js";
import type { GitProvider } from "./provider.js";
import { type ProposalRow, type SourceRow, defaultSource, proposalRow, proposalRows, randomId, sourceRow, toProposal } from "./store.js";
import { gitUsername, proposalMarker, refreshProposal } from "./sync.js";
import { rootFor } from "./discover.js";

const PROVIDER_NAME: Record<GitProviderId, string> = { github: "GitHub", "bitbucket-cloud": "Bitbucket Cloud" };

export interface ProposeInput {
  actor: Actor;
  name: string;
  body: PublishBody;
  /** ProposalRequest.source */
  sourceId: string | undefined;
}

export interface ProposeDeps {
  db: Db;
  providerFor(row: SourceRow): GitProvider;
}

function pickSource(db: Db, requested: string | undefined, skillSourceId: string | null): SourceRow {
  if (requested !== undefined) {
    const r = sourceRow(db, requested);
    if (!r || r.enabled !== 1) throw invalid(`git source "${requested}" does not exist or is disabled`);
    if (skillSourceId && skillSourceId !== r.id && sourceRow(db, skillSourceId)) throw conflict(`this skill is managed by git source ${skillSourceId}; propose there`);
    return r;
  }
  if (skillSourceId) {
    const own = sourceRow(db, skillSourceId);
    if (own && own.enabled === 1) return own;
    if (own) throw conflict(`this skill is managed by git source ${own.id}, which is disabled`);
  }
  const d = defaultSource(db);
  if (!d) throw conflict("no enabled git source exists");
  return d;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

/** Text the caller wrote, made unable to forge the hidden marker. */
function inert(s: string): string {
  return s.replace(/<!--/g, "&lt;!--");
}

/** "New skill: ", "New plugin: " or "New rule: " for a new package, "" for an update. */
export function proposalTitle(kind: PackageKind, isNew: boolean, name: string, version: string): string {
  return `${isNew ? `New ${kind}: ` : ""}${name} ${version}`;
}

export function proposalBody(o: {
  id: string;
  actor: Actor;
  gitUser: string;
  provider: GitProviderId;
  name: string;
  /** Default "skill". */
  packageKind?: PackageKind;
  version: string;
  isNew: boolean;
  changelog: string;
  behaviors: Behavior[];
  tokens: TokenEstimate;
}): string {
  const lines = [
    `Proposed through intra-skills by **${cell(o.actor.displayName)}** (registry \`${o.actor.handle}\`, ${PROVIDER_NAME[o.provider]} \`${o.gitUser}\`).`,
    "",
    `- ${KIND_LABELS[o.packageKind ?? "skill"]}: \`${o.name}\`${o.isNew ? ` (new ${o.packageKind ?? "skill"})` : ""}`,
    `- Version: \`${o.version}\``,
    `- Context cost: about ${o.tokens.metadata} tokens always loaded (name and description), ${o.tokens.body} when the skill is used, ${o.tokens.references} in other files read on demand`,
    "",
    "### Changelog",
    "",
    o.changelog.trim() ? inert(o.changelog.trim()) : "_No changelog given._",
    "",
    `### What this ${o.packageKind ?? "skill"} tells an agent to do`,
    "",
  ];
  if (o.behaviors.length === 0) lines.push("No flagged behaviors.");
  else {
    lines.push("| Tier | Behavior | File | Line | Match |", "| --- | --- | --- | --- | --- |");
    for (const b of o.behaviors)
      lines.push(
        `| ${b.tier === "ask" ? "ask first" : "info"} | ${cell(b.label)} | \`${cell(b.file)}\` | ${b.line ?? ""} | \`${cell(inert(b.match)).replace(/`/g, "'")}\` |`,
      );
  }
  lines.push(
    "",
    "Approve this pull request only if someone other than the proposer has reviewed it; the registry does not count the proposer's own approval.",
    "",
    proposalMarker(o.id),
  );
  return lines.join("\n");
}

export async function propose(deps: ProposeDeps, input: ProposeInput): Promise<{ proposal: Proposal; updated: boolean }> {
  const { db } = deps;
  const { actor, name, body } = input;
  if (publishMode(db) !== "pull-request")
    throw conflict("this registry has no enabled git source, so it publishes directly: run `intra publish` (POST /versions)");

  const existing = findSkill(db, name);
  if (existing) {
    readableSkill(db, actor, name); // 404 when unreadable
    if (!canWrite(actor, existing)) throw forbidden("you cannot publish to this skill");
  }
  const source = pickSource(db, input.sourceId, existing?.sourceId ?? null);
  const gitUser = gitUsername(db, actor.id, source.provider);
  if (!gitUser)
    throw forbidden(
      `add your ${PROVIDER_NAME[source.provider]} username under Settings > Git identities first, so your own approval is never counted on your pull request`,
      { reason: "no_git_identity", provider: source.provider },
    );

  // The same checks as a direct publish, plus secrets, before anything reaches the host.
  const { parsed, pkg } = validateSkillFiles(body.files, name, body.version);
  const kind: PackageKind = pkg.kind;
  if (existing && existing.kind !== kind) throw conflict(`${name} is a ${existing.kind}; a new version cannot turn it into a ${kind}`);
  if (parsed.version !== body.version)
    throw new HttpError("invalid_skill", "package is invalid", [
      kind === "plugin"
        ? {
            level: "error",
            field: "plugin.json version",
            message: `.claude-plugin/plugin.json must carry "version": "${body.version}": a sync reads the version from the repository (intra publish --bump sets it)`,
          }
        : {
            level: "error",
            field: "metadata.version",
            message: `${kind === "rule" ? "RULE.md" : "SKILL.md"} must carry metadata.version "${body.version}": a sync reads the version from the repository (intra publish --bump sets it)`,
          },
    ] satisfies ValidationIssue[]);
  assertNewerVersion(db, existing, name, body.version);
  const scan = toScanFiles(body.files);
  const secrets = scanSecrets(scan.map((f) => ({ path: f.path, text: f.text })));
  if (secrets.length > 0)
    throw new HttpError(
      "invalid_skill",
      "files look like they contain secrets; a skill should read credentials from the environment at run time",
      secrets.map((h): ValidationIssue => ({ level: "error", field: `${h.path}:${h.line}`, message: `${h.kind} (${h.preview})` })),
    );
  if (!existing) {
    const slug = body.team !== undefined ? body.team : parsed.team;
    if (slug !== null && teamIdBySlug(db, slug) === null) throw invalid(`team "${slug}" does not exist`);
  }
  const behaviors = [...(pkg.plugin ? pluginBehaviors(pkg.plugin.components) : []), ...scanBehaviors(scan)];
  const tokens = estimateTokens(scan, name, parsed.description);

  const open = proposalRows(db, "WHERE p.skill_name = ? AND p.status = 'open'", [name]);
  const others = open.filter((r) => r.proposer_id !== actor.id);
  if (others.length > 0) throw conflict(`${others[0]!.proposer_handle} already has an open proposal for ${name} (${others[0]!.id})`);

  const provider = deps.providerFor(source);
  let mine: ProposalRow | null = open.find((r) => r.proposer_id === actor.id) ?? null;
  if (mine && mine.source_id !== source.id) throw conflict(`your open proposal ${mine.id} for ${name} is in another git source`);
  // The pull request may have been closed or merged on the host since we last looked.
  if (mine) {
    mine = await refreshProposal(db, provider, source, mine, null);
    if (mine.status !== "open") mine = null;
  }

  const id = mine?.id ?? randomId("prp_", 16);
  const branch = mine?.branch ?? `intra/${name}-${body.version}`;
  // An update lands where the source already keeps the package; a new one under its kind's root.
  const folder = existing?.sourceId === source.id && existing.sourcePath ? existing.sourcePath : `${rootFor(source, kind)}/${name}`;
  const base = await provider.headCommit(source.base_branch);
  if (!base) throw new HttpError("upstream", `the base branch ${source.base_branch} does not exist on the git host`);
  // A fresh proposal starts from the base branch, discarding whatever an older closed proposal left
  // on a branch of the same name; an update builds on its own pull request's branch.
  const current = mine ? await provider.headCommit(branch) : null;
  const parent = current ?? base;
  const present = await provider.listFiles(parent, folder);
  const uploaded = new Set(body.files.map((f) => `${folder}/${f.path}`));
  const isNew = !existing;
  const title = proposalTitle(kind, isNew, name, body.version);
  await provider.writeBranch({
    branch,
    parent,
    files: body.files.map((f) => ({ path: `${folder}/${f.path}`, mode: f.mode, content: f.content })),
    deletions: present.map((f) => f.path).filter((p) => !uploaded.has(p)),
    message: `${title}\n\nProposed by ${actor.handle} through intra-skills.`,
    force: current === null,
  });
  const prBody = proposalBody({
    id,
    actor,
    gitUser,
    provider: source.provider,
    name,
    packageKind: kind,
    version: body.version,
    isNew,
    changelog: body.changelog,
    behaviors,
    tokens,
  });
  let pr: { number: number; url: string };
  if (mine && mine.pr_number !== null && mine.pr_url !== null) {
    await provider.updatePullRequest(mine.pr_number, { title, body: prBody });
    pr = { number: mine.pr_number, url: mine.pr_url };
  } else pr = await provider.openPullRequest({ branch, base: source.base_branch, title, body: prBody });

  const now = new Date().toISOString();
  const waiting = `Waiting for ${source.min_approvals} approval${source.min_approvals === 1 ? "" : "s"} from someone other than you`;
  const message = source.min_approvals > 0 ? waiting : "Waiting for someone to merge the pull request";
  tx(db, () => {
    if (mine)
      db.prepare(
        `UPDATE proposals SET version = ?, kind = ?, package_kind = ?, changelog = ?, behaviors = ?, visibility = ?, team_slug = ?,
           pr_number = ?, pr_url = ?, status = 'open', status_message = ?, updated_at = ? WHERE id = ?`,
      ).run(
        body.version,
        isNew ? "new" : "update",
        kind,
        body.changelog,
        JSON.stringify(behaviors),
        body.visibility ?? null,
        body.team === undefined ? null : (body.team ?? ""),
        pr.number,
        pr.url,
        message,
        now,
        id,
      );
    else
      db.prepare(
        `INSERT INTO proposals (id, skill_name, package_kind, version, kind, proposer_id, source_id, branch, pr_number, pr_url, status,
           status_message, changelog, behaviors, visibility, team_slug, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        name,
        kind,
        body.version,
        isNew ? "new" : "update",
        actor.id,
        source.id,
        branch,
        pr.number,
        pr.url,
        message,
        body.changelog,
        JSON.stringify(behaviors),
        body.visibility ?? null,
        // '' records an explicit "no team"; NULL means "use metadata.team".
        body.team === undefined ? null : (body.team ?? ""),
        now,
        now,
      );
    db.prepare("DELETE FROM proposal_files WHERE proposal_id = ?").run(id);
    const ins = db.prepare("INSERT INTO proposal_files (proposal_id, path, mode, sha256) VALUES (?, ?, ?, ?)");
    for (const f of body.files) {
      putBlob(db, f.sha256, f.content);
      ins.run(id, f.path, f.mode, f.sha256);
    }
    audit(db, actor, mine ? "proposal.update" : "proposal.create", "proposal", id, {
      skill: name,
      packageKind: kind,
      version: body.version,
      source: source.id,
      pullRequest: pr.number,
    });
  });
  return { proposal: toProposal(proposalRow(db, id)!), updated: mine !== null };
}
