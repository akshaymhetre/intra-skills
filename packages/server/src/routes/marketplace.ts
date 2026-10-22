// The Claude Code plugin marketplace (docs/API.md "Claude Code plugin marketplace"). Mounted at "/"
// by app.ts, ahead of the /api catch-all. Both routes authenticate by ?key= or a Bearer header and
// accept a marketplace key or a full token; the /api auth middleware skips /api/plugins/.
import { Hono, type Context } from "hono";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import { type AppEnv, authenticateTokenScoped } from "../auth.js";
import type { Actor } from "../access.js";
import { canRead } from "../access.js";
import type { AppOptions } from "../app.js";
import { HttpError, notFound } from "../http.js";
import { type SkillRecord, findSkill, latestOf, loadSkills, loadVersions } from "../model.js";
import { loadFile } from "../publish.js";
import { getSettings, marketplaceName, publicUrl } from "../settings.js";
import { archiveSha, pluginArchive } from "../archive.js";

export interface MarketplacePlugin {
  name: string;
  description: string;
  version: string;
  category: string;
  tags: string[];
  keywords: string[];
  source: { source: "archive"; url: string; sha256: string };
}

export interface MarketplaceJson {
  name: string;
  owner: { name: string };
  description: string;
  plugins: MarketplacePlugin[];
}

/** The key from ?key= or Authorization: Bearer, with its plaintext (echoed into archive URLs). */
function keyActor(db: Db, c: Context): { actor: Actor; key: string } {
  let key = c.req.query("key") ?? "";
  if (!key) {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header("Authorization") ?? "");
    key = m?.[1] ?? "";
  }
  if (!key) throw new HttpError("unauthenticated", "pass the marketplace key as ?key= or a Bearer header");
  const r = authenticateTokenScoped(db, key);
  if (!r) throw new HttpError("unauthenticated", "invalid or revoked key");
  return { actor: r.actor, key };
}

/** plugin.json keywords, read from the stored manifest; [] when absent or malformed. */
function manifestKeywords(db: Db, versionId: number): string[] {
  const raw = loadFile(db, versionId, ".claude-plugin/plugin.json");
  if (!raw) return [];
  try {
    const m = JSON.parse(Buffer.from(raw).toString("utf8")) as { keywords?: unknown };
    return Array.isArray(m.keywords) ? m.keywords.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function archiveUrl(base: string, name: string, version: string, key: string): string {
  return `${base}/api/plugins/${encodeURIComponent(name)}/${encodeURIComponent(version)}.zip?key=${encodeURIComponent(key)}`;
}

export function buildMarketplace(db: Db, actor: Actor, base: string, key: string): MarketplaceJson {
  const org = getSettings(db).name;
  const plugins: MarketplacePlugin[] = [];
  const readable = loadSkills(db, "WHERE s.kind = 'plugin' AND s.deprecated IS NULL ORDER BY s.name").filter((s: SkillRecord) => canRead(actor, s));
  for (const s of readable) {
    const versions = loadVersions(db, s.id);
    const latest = latestOf(versions);
    const v = latest === null ? undefined : versions.find((x) => x.version === latest);
    if (!v) continue;
    plugins.push({
      name: s.name,
      description: s.description,
      version: v.version,
      category: s.teamSlug ?? "general",
      tags: s.tags,
      keywords: manifestKeywords(db, v.id),
      source: { source: "archive", url: archiveUrl(base, s.name, v.version, key), sha256: archiveSha(db, v.id, v.archive_sha256) },
    });
  }
  return {
    name: marketplaceName(db),
    owner: { name: org },
    description: `Claude Code plugins from the ${org} registry`,
    plugins,
  };
}

export function marketplaceRoutes(db: Db, _opts: AppOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/marketplace.json", (c) => {
    const { actor, key } = keyActor(db, c);
    const body = buildMarketplace(db, actor, publicUrl(db, c.req.url), key);
    c.header("Cache-Control", "no-store");
    return c.json(body);
  });

  r.get("/api/plugins/:name/:file", (c) => {
    const { actor } = keyActor(db, c);
    const name = c.req.param("name");
    const file = c.req.param("file");
    if (!file.endsWith(".zip")) throw notFound("no such plugin archive");
    const version = file.slice(0, -".zip".length);
    const s = findSkill(db, name);
    // Unreadable and unknown answer the same, so a private plugin's existence does not leak.
    if (!s || s.kind !== "plugin" || !canRead(actor, s)) throw notFound(`plugin "${name}" not found`);
    const v = loadVersions(db, s.id).find((x) => x.version === version);
    if (!v) throw notFound(`version "${version}" of "${name}" not found`);
    const { bytes } = pluginArchive(db, v.id);
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
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${name}-${version}.zip"`,
      "Cache-Control": "no-store",
    });
  });

  return r;
}
