// The one path that turns a set of files into an immutable version. Used by the direct publish
// route (POST /skills/:name/versions) and by git-source ingest, so both enforce the same checks.
// File bytes live once each in the content-addressed `blobs` table; version_files points at them.
import {
  bundleSha256,
  compareVersions,
  estimateTokens,
  normalizeMode,
  parsePackage,
  pluginBehaviors,
  scanBehaviors,
  sha256Hex,
  validateBundleFiles,
  type Behavior,
  type GitInfo,
  type PackageKind,
  type ParsedPackage,
  type ParsedSkill,
  type ScanFile,
  type TokenEstimate,
  type ValidationIssue,
  type Visibility,
} from "@intra-skills/shared";
import type { Db } from "./db.js";
import { tx } from "./db.js";
import type { Actor } from "./access.js";
import { HttpError, conflict, forbidden, invalid } from "./http.js";
import { type SkillRecord, audit, loadVersions, teamIdBySlug } from "./model.js";

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Text = valid UTF-8 with no NUL byte; anything else is binary. */
export function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export interface DecodedFile {
  path: string;
  mode: number;
  size: number;
  sha256: string;
  content: Buffer;
}

export function decodedFile(path: string, mode: number, content: Buffer): DecodedFile {
  return { path, mode: normalizeMode(mode), size: content.length, sha256: sha256Hex(content), content };
}

/** Decode a request's `files` array (BundleFile[]); any malformed entry is a 400. */
export function decodeFiles(raw: unknown): DecodedFile[] {
  if (!Array.isArray(raw) || raw.length === 0) throw invalid("files must be a non-empty array");
  if (raw.length > 10_000) throw invalid("too many files");
  return raw.map((f, i) => {
    if (!f || typeof f !== "object") throw invalid(`files[${i}] must be an object`);
    const { path, mode, contentBase64 } = f as Record<string, unknown>;
    if (typeof path !== "string" || path.length === 0 || path.length > 1024)
      throw invalid(`files[${i}].path must be a non-empty string`);
    if (typeof mode !== "number" || !Number.isInteger(mode) || mode < 0 || mode > 0o7777)
      throw invalid(`files[${i}].mode must be an integer file mode`);
    if (typeof contentBase64 !== "string" || !BASE64_RE.test(contentBase64))
      throw invalid(`files[${i}].contentBase64 must be base64`);
    return decodedFile(path, mode, Buffer.from(contentBase64, "base64"));
  });
}

// ---------- blobs ----------

export function putBlob(db: Db, sha256: string, content: Uint8Array): void {
  db.prepare("INSERT OR IGNORE INTO blobs (sha256, size, content) VALUES (?, ?, ?)").run(sha256, content.length, content);
}

export function getBlob(db: Db, sha256: string): Uint8Array | null {
  const r = db.prepare("SELECT content FROM blobs WHERE sha256 = ?").get(sha256) as { content: Uint8Array } | undefined;
  return r?.content ?? null;
}

export interface FileRow {
  path: string;
  mode: number;
  size: number;
  sha256: string;
  content: Uint8Array;
}

export function loadFiles(db: Db, versionId: number): FileRow[] {
  return db
    .prepare(
      `SELECT f.path, f.mode, f.size, f.sha256, b.content FROM version_files f JOIN blobs b ON b.sha256 = f.sha256
       WHERE f.version_id = ? ORDER BY f.path`,
    )
    .all(versionId) as unknown as FileRow[];
}

export function loadFile(db: Db, versionId: number, path: string): Uint8Array | null {
  const r = db
    .prepare(
      "SELECT b.content FROM version_files f JOIN blobs b ON b.sha256 = f.sha256 WHERE f.version_id = ? AND f.path = ?",
    )
    .get(versionId, path) as { content: Uint8Array } | undefined;
  return r?.content ?? null;
}

// ---------- validation ----------

export function toScanFiles(files: { path: string; mode: number; content: Uint8Array }[]): ScanFile[] {
  return files.map((f) => ({ path: f.path, mode: f.mode, text: asText(f.content) }));
}

/**
 * Path and size checks, then the kind's own checks (SKILL.md, plugin.json, RULE.md). Throws 422
 * invalid_skill with every issue when any is an error.
 */
export function validateSkillFiles(
  files: DecodedFile[],
  name: string,
  version: string,
): { parsed: ParsedSkill; pkg: ParsedPackage; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = validateBundleFiles(files.map((f) => ({ path: f.path, size: f.size })));
  const { pkg, issues: kindIssues } = parsePackage(
    files.map((f) => ({ path: f.path, text: asText(f.content) })),
    name,
  );
  issues.push(...kindIssues);
  if (pkg?.skill.version && pkg.skill.version !== version)
    issues.push({
      level: "error",
      field: pkg.kind === "plugin" ? "plugin.json version" : "metadata.version",
      message: `the files declare ${pkg.skill.version} but the request publishes ${version}`,
    });
  if (issues.some((i) => i.level === "error") || !pkg) throw new HttpError("invalid_skill", "package is invalid", issues);
  return { parsed: pkg.skill, pkg, issues };
}

/** 409 unless `version` is strictly greater than every existing version of the skill. */
export function assertNewerVersion(db: Db, existing: SkillRecord | null, name: string, version: string): void {
  if (!existing) return;
  for (const p of loadVersions(db, existing.id)) {
    const cmp = compareVersions(version, p.version);
    if (cmp === 0) throw conflict(`${name}@${version} already exists; versions are immutable`);
    if (cmp < 0) throw conflict(`${version} is not greater than the existing ${p.version}`);
  }
}

export interface VersionInput {
  name: string;
  version: string;
  files: DecodedFile[];
  changelog: string;
  git: GitInfo | null;
  /** User recorded as the publisher (and creator on first publish). */
  publisherId: number;
  /** The caller, for the audit trail; null for git-source ingest. */
  actor: Actor | null;
  /**
   * Whether a metadata.team that MOVES an existing skill is allowed. Direct publish passes
   * canAdmin(actor, skill); git ingest passes true because the merged review already covered it.
   */
  mayMoveTeam: boolean;
  /** First publish only: overrides metadata.team (undefined = use metadata). */
  requestedTeam?: string | null;
  /** First publish only: overrides metadata.visibility. */
  requestedVisibility?: Visibility;
  /** Set when the version came from a git source; marks the skill as managed by it. */
  source?: { id: string; path: string } | null;
}

export interface CreatedVersion {
  kind: PackageKind;
  versionId: number;
  skillId: number;
  created: boolean;
  behaviors: Behavior[];
  tokens: TokenEstimate;
}

/**
 * Validate and insert one immutable version, creating the skill on first publish. Facets
 * (description, team, areas, stacks, tags, tools) refresh from SKILL.md every time.
 */
export function createVersion(db: Db, existing: SkillRecord | null, input: VersionInput): CreatedVersion {
  const { name, version, files } = input;
  const { parsed, pkg } = validateSkillFiles(files, name, version);
  const kind: PackageKind = pkg.kind;
  if (existing && existing.kind !== kind)
    throw conflict(`${name} is a ${existing.kind}; a new version cannot turn it into a ${kind}`);
  assertNewerVersion(db, existing, name, version);

  let teamId: number | null;
  if (!existing) {
    const slug = input.requestedTeam !== undefined ? input.requestedTeam : parsed.team;
    teamId = slug === null ? null : teamIdBySlug(db, slug);
    if (slug !== null && teamId === null) throw invalid(`team "${slug}" does not exist`);
  } else if (parsed.team !== null) {
    teamId = teamIdBySlug(db, parsed.team);
    if (teamId === null) throw invalid(`team "${parsed.team}" does not exist`);
    if (teamId !== existing.teamId && !input.mayMoveTeam)
      throw forbidden("moving a skill to another team needs skill admin rights");
  } else teamId = existing.teamId;
  const visibility: Visibility = existing
    ? existing.visibility
    : (input.requestedVisibility ?? parsed.visibility ?? "org");

  const scan = toScanFiles(files);
  // A plugin's bin/ files are already one "puts executables on PATH" behavior; do not list each again as a script.
  const structural = pkg.plugin ? pluginBehaviors(pkg.plugin.components) : [];
  const lines = scanBehaviors(scan).filter((b) => !(structural.some((x) => x.id === "plugin-bin") && b.id === "script" && b.file.startsWith("bin/")));
  const behaviors = [...structural, ...lines];
  const tokens = estimateTokens(scan, name, parsed.description);
  const sha256 = bundleSha256(files);
  const size = files.reduce((n, f) => n + f.size, 0);
  const now = new Date().toISOString();

  return tx(db, () => {
    let skillId: number;
    const facets = [
      parsed.description,
      teamId,
      JSON.stringify(parsed.areas),
      JSON.stringify(parsed.stacks),
      JSON.stringify(parsed.tools),
      JSON.stringify(parsed.tags),
    ] as const;
    if (existing) {
      skillId = existing.id;
      db.prepare(
        "UPDATE skills SET description = ?, team_id = ?, areas = ?, stacks = ?, tools = ?, tags = ?, updated_at = ? WHERE id = ?",
      ).run(...facets, now, skillId);
    } else {
      skillId = Number(
        db
          .prepare(
            `INSERT INTO skills (name, description, team_id, areas, stacks, tools, tags, visibility, created_by, created_at, updated_at, kind)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(name, ...facets, visibility, input.publisherId, now, now, kind).lastInsertRowid,
      );
    }
    if (input.source)
      db.prepare("UPDATE skills SET source_id = ?, source_path = ? WHERE id = ?").run(input.source.id, input.source.path, skillId);
    const versionId = Number(
      db
        .prepare(
          `INSERT INTO versions (skill_id, version, sha256, size, file_count, changelog, published_by, published_at, git, behaviors, tokens, plugin, rule)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          skillId,
          version,
          sha256,
          size,
          files.length,
          input.changelog,
          input.publisherId,
          now,
          input.git ? JSON.stringify(input.git) : null,
          JSON.stringify(behaviors),
          JSON.stringify(tokens),
          pkg.plugin ? JSON.stringify(pkg.plugin.components) : null,
          pkg.rule ? JSON.stringify(pkg.rule) : null,
        ).lastInsertRowid,
    );
    const ins = db.prepare("INSERT INTO version_files (version_id, path, mode, size, sha256) VALUES (?, ?, ?, ?, ?)");
    for (const f of files) {
      putBlob(db, f.sha256, f.content);
      ins.run(versionId, f.path, f.mode, f.size, f.sha256);
    }
    audit(db, input.actor, "skill.publish", "skill", name, {
      version,
      sha256,
      created: !existing,
      ...(input.source ? { source: input.source.id } : {}),
      ...(input.git?.pullRequest ? { pullRequest: input.git.pullRequest.number } : {}),
    });
    return { kind, versionId, skillId, created: !existing, behaviors, tokens };
  });
}
