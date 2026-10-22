// Publishing, version detail, raw files, bundles, resolve, yank and diff.
import { Hono } from "hono";
import { createTwoFilesPatch } from "diff";
import {
  NAME_RE,
  SKILL_FILE,
  isValidRange,
  isValidVersion,
  maxSatisfying,
  type Bundle,
  type DiffFile,
  type DiffResponse,
  type FileEntry,
  type GitInfo,
  type VersionDetail,
  type Visibility,
} from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import type { AppEnv } from "../auth.js";
import type { Actor } from "../access.js";
import { canAdmin, canWrite } from "../access.js";
import { forbidden, invalid, jsonBody, notFound } from "../http.js";
import {
  type SkillRecord,
  type VersionRow,
  audit,
  findSkill,
  latestOf,
  loadVersions,
  readableSkill,
  toVersionMeta,
} from "../model.js";
import { asText, createVersion, decodeFiles, loadFile, loadFiles } from "../publish.js";
import { publishMode } from "../settings.js";

export { asText };

function parseGit(raw: unknown): GitInfo | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("git must be an object or null");
  const g = raw as Record<string, unknown>;
  if (typeof g.commit !== "string" || !/^[0-9a-f]{7,64}$/i.test(g.commit)) throw invalid("git.commit must be a commit sha");
  if (g.repo !== undefined && g.repo !== null && (typeof g.repo !== "string" || g.repo.length > 500))
    throw invalid("git.repo must be a string or null");
  if (g.dirty !== undefined && typeof g.dirty !== "boolean") throw invalid("git.dirty must be a boolean");
  return { commit: g.commit, repo: (g.repo as string | null | undefined) ?? null, dirty: g.dirty === true };
}

export interface PublishBody {
  version: string;
  changelog: string;
  git: GitInfo | null;
  visibility: Visibility | undefined;
  team: string | null | undefined;
  files: ReturnType<typeof decodeFiles>;
}

/** Shape checks shared by POST /versions and POST /proposals. */
export function parsePublishBody(body: Record<string, unknown>): PublishBody {
  const version = body.version;
  if (typeof version !== "string" || !isValidVersion(version)) throw invalid("version must be semver (x.y.z)");
  if (body.changelog !== undefined && (typeof body.changelog !== "string" || body.changelog.length > 20_000))
    throw invalid("changelog must be a string of at most 20000 characters");
  if (body.visibility !== undefined && body.visibility !== "org" && body.visibility !== "private")
    throw invalid("visibility must be org or private");
  if (body.team !== undefined && body.team !== null && typeof body.team !== "string")
    throw invalid("team must be a team slug or null");
  return {
    version,
    changelog: (body.changelog as string | undefined) ?? "",
    git: parseGit(body.git),
    visibility: body.visibility as Visibility | undefined,
    team: body.team as string | null | undefined,
    files: decodeFiles(body.files),
  };
}

function findVersion(db: Db, s: SkillRecord, version: string): VersionRow {
  const versions = loadVersions(db, s.id);
  const want = version === "latest" ? latestOf(versions) : version;
  const v = want === null ? undefined : versions.find((x) => x.version === want);
  if (!v) throw notFound(`version "${version}" of "${s.name}" not found`);
  return v;
}

export function versionRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/skills/:name/versions", async (c) => {
    const actor = c.get("actor");
    const name = c.req.param("name");
    if (name.length > 64 || !NAME_RE.test(name)) throw invalid("invalid skill name");
    if (publishMode(db) === "pull-request")
      throw forbidden("this registry publishes through pull requests: run `intra publish`, which opens one", {
        publishMode: "pull-request",
      });
    const existing = findSkill(db, name);
    if (existing) {
      readableSkill(db, actor, name); // 404 when unreadable
      if (!canWrite(actor, existing)) throw forbidden("you cannot publish to this skill");
    }
    const body = parsePublishBody(await jsonBody(c));
    const { versionId } = createVersion(db, existing, {
      name,
      version: body.version,
      files: body.files,
      changelog: body.changelog,
      git: body.git,
      publisherId: actor.id,
      actor,
      mayMoveTeam: existing ? canAdmin(actor, existing) : true,
      requestedTeam: body.team,
      requestedVisibility: body.visibility,
    });
    const row = db
      .prepare(
        "SELECT v.*, u.handle AS publisher_handle FROM versions v JOIN users u ON u.id = v.published_by WHERE v.id = ?",
      )
      .get(versionId) as unknown as VersionRow;
    return c.json(toVersionMeta(row), 201);
  });

  r.get("/skills/:name/versions/:version", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const v = findVersion(db, s, c.req.param("version"));
    const files = loadFiles(db, v.id);
    const skillFile = files.find((f) => f.path === SKILL_FILE);
    const body: VersionDetail = {
      ...toVersionMeta(v),
      name: s.name,
      files: files.map((f): FileEntry => ({ path: f.path, mode: f.mode, size: f.size, sha256: f.sha256 })),
      skillMd: skillFile ? (asText(skillFile.content) ?? "") : "",
    };
    return c.json(body);
  });

  r.get("/skills/:name/versions/:version/files/*", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const v = findVersion(db, s, c.req.param("version"));
    const pathname = new URL(c.req.url).pathname;
    const idx = pathname.indexOf("/files/", pathname.indexOf("/versions/"));
    let filePath: string;
    try {
      filePath = pathname
        .slice(idx + "/files/".length)
        .split("/")
        .map(decodeURIComponent)
        .join("/");
    } catch {
      throw invalid("malformed file path");
    }
    const content = loadFile(db, v.id, filePath);
    if (!content) throw notFound(`file "${filePath}" not found`);
    const isText = asText(content) !== null;
    return c.body(new Uint8Array(content), 200, {
      "Content-Type": isText ? "text/plain; charset=utf-8" : "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    });
  });

  r.get("/skills/:name/versions/:version/bundle", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const v = findVersion(db, s, c.req.param("version"));
    const files = loadFiles(db, v.id);
    tx(db, () => {
      db.prepare("UPDATE versions SET downloads = downloads + 1 WHERE id = ?").run(v.id);
      db.prepare("UPDATE skills SET downloads = downloads + 1 WHERE id = ?").run(s.id);
      db.prepare("INSERT INTO install_events (skill_id, version_id, user_id, at) VALUES (?, ?, ?, ?)").run(
        s.id,
        v.id,
        actor.id,
        new Date().toISOString(),
      );
    });
    const body: Bundle = {
      name: s.name,
      version: v.version,
      sha256: v.sha256,
      files: files.map((f) => ({
        path: f.path,
        mode: f.mode,
        contentBase64: Buffer.from(f.content).toString("base64"),
      })),
    };
    return c.json(body);
  });

  r.get("/skills/:name/resolve", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const range = c.req.query("range") ?? "latest";
    if (!isValidRange(range)) throw invalid(`invalid range "${range}"`);
    const versions = loadVersions(db, s.id);
    const live = versions.filter((v) => v.yanked === null).map((v) => v.version);
    const trimmed = range.trim();
    const best = trimmed === "" || trimmed === "latest" ? latestOf(versions) : maxSatisfying(live, trimmed);
    if (!best) throw notFound(`no version of "${s.name}" matches "${range}"`);
    return c.json({ version: best });
  });

  const setYank = async (actor: Actor, name: string, version: string, reason: string | null) => {
    const s = readableSkill(db, actor, name);
    if (!canWrite(actor, s)) throw forbidden("you cannot write this skill");
    const v = findVersion(db, s, version);
    tx(db, () => {
      db.prepare("UPDATE versions SET yanked = ? WHERE id = ?").run(reason, v.id);
      db.prepare("UPDATE skills SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), s.id);
      audit(db, actor, reason === null ? "version.unyank" : "version.yank", "skill", s.name, {
        version: v.version,
        ...(reason === null ? {} : { reason }),
      });
    });
    return toVersionMeta({ ...v, yanked: reason });
  };

  r.post("/skills/:name/versions/:version/yank", async (c) => {
    const actor = c.get("actor");
    readableSkill(db, actor, c.req.param("name"));
    const body = await jsonBody(c);
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > 500))
      throw invalid("reason must be a string of at most 500 characters");
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "yanked";
    return c.json(await setYank(actor, c.req.param("name"), c.req.param("version"), reason));
  });

  r.delete("/skills/:name/versions/:version/yank", async (c) => {
    return c.json(await setYank(c.get("actor"), c.req.param("name"), c.req.param("version"), null));
  });

  r.get("/skills/:name/diff", (c) => {
    const actor = c.get("actor");
    const s = readableSkill(db, actor, c.req.param("name"));
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to) throw invalid("from and to are required");
    const vf = findVersion(db, s, from);
    const vt = findVersion(db, s, to);
    const a = new Map(loadFiles(db, vf.id).map((f) => [f.path, f]));
    const b = new Map(loadFiles(db, vt.id).map((f) => [f.path, f]));
    const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
    const files: DiffFile[] = paths.map((path) => {
      const fa = a.get(path);
      const fb = b.get(path);
      const status = !fa ? "added" : !fb ? "removed" : fa.sha256 === fb.sha256 && fa.mode === fb.mode ? "unchanged" : "modified";
      const ta = fa ? asText(fa.content) : "";
      const tb = fb ? asText(fb.content) : "";
      const binary = ta === null || tb === null;
      let patch: string | null = null;
      if (status !== "unchanged" && !binary)
        patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, ta, tb, vf.version, vt.version, { context: 3 });
      return { path, status, patch, binary };
    });
    const body: DiffResponse = { from: vf.version, to: vt.version, files };
    return c.json(body);
  });

  return r;
}
