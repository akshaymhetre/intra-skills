// Git sources (admin only): CRUD, a read-only access test and a sync-now. Credentials and webhook
// secrets are write-only: they are encrypted on the way in and never appear in a response.
import { createPrivateKey } from "node:crypto";
import { Hono } from "hono";
import { GIT_PROVIDERS, isSafeRelativePath, type GitCredentialInput, type GitProviderId } from "@intra-skills/shared";
import type { Db } from "../db.js";
import { nowIso, tx } from "../db.js";
import type { AppEnv } from "../auth.js";
import type { Actor } from "../access.js";
import { conflict, forbidden, invalid, jsonBody, notFound } from "../http.js";
import { audit } from "../model.js";
import { publicUrl } from "../settings.js";
import type { GitService } from "../git/service.js";
import { type SourceRow, credentialHint, randomId, sourceRow, sourceRows, toGitSource } from "../git/store.js";

const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BITBUCKET_REPO_RE = /^[a-z0-9][a-z0-9_.-]{0,61}\/[a-z0-9][a-z0-9_.-]{0,61}$/;
const BRANCH_RE = /^(?!\/|-)(?!.*(?:\.\.|\/\/|@\{|\.lock$|\/$|\.$))[A-Za-z0-9._\/-]{1,200}$/;
const MIN_WEBHOOK_SECRET = 16;

function requireAdmin(actor: Actor): void {
  if (actor.role !== "admin") throw forbidden("only admins can manage git sources");
}

function checkRepo(provider: GitProviderId, repo: unknown): string {
  if (typeof repo !== "string") throw invalid("repo is required");
  const r = repo.trim().replace(/\.git$/, "");
  if (provider === "github" ? !GITHUB_REPO_RE.test(r) : !BITBUCKET_REPO_RE.test(r))
    throw invalid(provider === "github" ? "repo must be owner/name" : "repo must be workspace/repo-slug (lowercase)");
  return r;
}

function str(o: Record<string, unknown>, key: string, max: number): string {
  const v = o[key];
  if (typeof v !== "string" || v.trim() === "") throw invalid(`credential.${key} is required`);
  if (v.length > max) throw invalid(`credential.${key} is longer than ${max} characters`);
  return v.trim();
}

function checkCredential(provider: GitProviderId, raw: unknown): GitCredentialInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid("credential must be an object");
  const c = raw as Record<string, unknown>;
  const allowed = provider === "github" ? ["token", "github-app"] : ["token", "basic"];
  if (typeof c.kind !== "string" || !allowed.includes(c.kind))
    throw invalid(`credential.kind for ${provider} must be one of ${allowed.join(", ")}`);
  if (c.kind === "token") return { kind: "token", token: str(c, "token", 1000) };
  if (c.kind === "basic") return { kind: "basic", username: str(c, "username", 200), password: str(c, "password", 1000) };
  const appId = str(c, "appId", 40);
  const installationId = str(c, "installationId", 40);
  if (!/^\d+$/.test(installationId)) throw invalid("credential.installationId must be a number");
  if (!/^(\d+|Iv[0-9A-Za-z.]+)$/.test(appId)) throw invalid("credential.appId must be the App ID or client ID");
  const privateKey = str(c, "privateKey", 10_000);
  try {
    if (createPrivateKey(privateKey).asymmetricKeyType !== "rsa") throw new Error("not RSA");
  } catch {
    throw invalid("credential.privateKey must be the App's PEM private key (RSA)");
  }
  return { kind: "github-app", appId, installationId, privateKey };
}

function checkApiUrl(provider: GitProviderId, raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (provider !== "github") throw invalid("apiUrl applies only to GitHub Enterprise Server");
  if (typeof raw !== "string" || raw.length > 500) throw invalid("apiUrl must be a URL");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw invalid("apiUrl must be a URL");
  }
  if (u.protocol !== "https:") throw invalid("apiUrl must use https");
  if (u.username || u.password || u.search || u.hash) throw invalid("apiUrl must not carry credentials, a query or a fragment");
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

function checkRoot(raw: unknown, key = "root", example = "skills"): string {
  if (typeof raw !== "string") throw invalid(`${key} must be a string`);
  const r = raw.trim().replace(/^\/+|\/+$/g, "");
  if (!isSafeRelativePath(r) || r.length > 200) throw invalid(`${key} must be a relative folder path such as ${example}`);
  return r;
}

/** The three kind folders must differ and must not sit inside one another, or one sync reads a package twice. */
function checkRoots(roots: { root: string; pluginsRoot: string; rulesRoot: string }): void {
  const list = Object.entries(roots);
  for (let i = 0; i < list.length; i++)
    for (let j = i + 1; j < list.length; j++) {
      const [ka, a] = list[i]!;
      const [kb, b] = list[j]!;
      if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/"))
        throw invalid(`${ka} and ${kb} must be separate folders (got "${a}" and "${b}")`);
    }
}

function checkBranch(raw: unknown): string {
  if (typeof raw !== "string" || !BRANCH_RE.test(raw.trim())) throw invalid("baseBranch must be a branch name");
  return raw.trim();
}

function checkMin(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 10) throw invalid("minApprovals must be an integer 0-10");
  return raw;
}

function checkBool(raw: unknown, key: string): boolean {
  if (typeof raw !== "boolean") throw invalid(`${key} must be a boolean`);
  return raw;
}

function checkSecret(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 500) throw invalid("webhookSecret must be a string");
  if (raw !== "" && raw.length < MIN_WEBHOOK_SECRET)
    throw invalid(`webhookSecret must be at least ${MIN_WEBHOOK_SECRET} characters (or empty to clear it)`);
  return raw;
}

/** Exactly one default while any source exists: the flagged one, else the oldest. */
function fixDefault(db: Db, preferId: string | null): void {
  if (preferId) db.prepare("UPDATE git_sources SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END").run(preferId);
  const rows = sourceRows(db);
  if (rows.length > 0 && !rows.some((r) => r.is_default === 1))
    db.prepare("UPDATE git_sources SET is_default = 1 WHERE id = ?").run(rows[0]!.id);
}

function uniqueClash(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: git_sources/.test(e.message);
}

export function sourceRoutes(db: Db, git: GitService): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const wire = (row: SourceRow, url: string) => toGitSource(row, publicUrl(db, url));
  const load = (id: string): SourceRow => {
    const row = sourceRow(db, id);
    if (!row) throw notFound("git source not found");
    return row;
  };

  r.get("/sources", (c) => {
    requireAdmin(c.get("actor"));
    return c.json(sourceRows(db).map((row) => wire(row, c.req.url)));
  });

  r.post("/sources", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const b = await jsonBody(c);
    if (typeof b.provider !== "string" || !GIT_PROVIDERS.includes(b.provider as GitProviderId))
      throw invalid(`provider must be one of ${GIT_PROVIDERS.join(", ")}`);
    const provider = b.provider as GitProviderId;
    const repo = checkRepo(provider, b.repo);
    if (b.credential === undefined) throw invalid("credential is required");
    const credential = checkCredential(provider, b.credential);
    const apiUrl = checkApiUrl(provider, b.apiUrl);
    const root = b.root === undefined ? "skills" : checkRoot(b.root);
    const pluginsRoot = b.pluginsRoot === undefined ? "plugins" : checkRoot(b.pluginsRoot, "pluginsRoot", "plugins");
    const rulesRoot = b.rulesRoot === undefined ? "rules" : checkRoot(b.rulesRoot, "rulesRoot", "rules");
    checkRoots({ root, pluginsRoot, rulesRoot });
    const baseBranch = b.baseBranch === undefined ? "main" : checkBranch(b.baseBranch);
    const minApprovals = b.minApprovals === undefined ? 1 : checkMin(b.minApprovals);
    const enabled = b.enabled === undefined ? true : checkBool(b.enabled, "enabled");
    const isDefault = b.isDefault === undefined ? false : checkBool(b.isDefault, "isDefault");
    const secret = b.webhookSecret === undefined ? "" : checkSecret(b.webhookSecret);
    const id = randomId("src_", 12);
    const now = nowIso();
    try {
      tx(db, () => {
        db.prepare(
          `INSERT INTO git_sources (id, provider, repo, base_branch, root, plugins_root, rules_root, api_url, min_approvals, enabled, is_default,
             credential_kind, credential_enc, credential_hint, webhook_secret_enc, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          provider,
          repo,
          baseBranch,
          root,
          pluginsRoot,
          rulesRoot,
          apiUrl,
          minApprovals,
          enabled ? 1 : 0,
          credential.kind,
          git.encryptCredential(id, credential),
          credentialHint(credential),
          secret ? git.encryptWebhookSecret(id, secret) : null,
          now,
          now,
        );
        fixDefault(db, isDefault ? id : null);
        audit(db, actor, "source.create", "source", id, { provider, repo, root, pluginsRoot, rulesRoot, baseBranch, minApprovals, enabled });
      });
    } catch (e) {
      if (uniqueClash(e)) throw conflict(`a source for ${repo} with root ${root} already exists`);
      throw e;
    }
    return c.json(wire(load(id), c.req.url), 201);
  });

  r.get("/sources/:id", (c) => {
    requireAdmin(c.get("actor"));
    return c.json(wire(load(c.req.param("id")), c.req.url));
  });

  r.patch("/sources/:id", async (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const row = load(c.req.param("id"));
    const b = await jsonBody(c);
    let provider = row.provider;
    if (b.provider !== undefined) {
      if (typeof b.provider !== "string" || !GIT_PROVIDERS.includes(b.provider as GitProviderId))
        throw invalid(`provider must be one of ${GIT_PROVIDERS.join(", ")}`);
      provider = b.provider as GitProviderId;
      if (provider !== row.provider && b.credential === undefined) throw invalid("changing the provider needs a new credential");
    }
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const changed: string[] = [];
    const set = (col: string, v: string | number | null, label: string) => {
      sets.push(`${col} = ?`);
      vals.push(v);
      changed.push(label);
    };
    if (provider !== row.provider) set("provider", provider, "provider");
    if (b.repo !== undefined || provider !== row.provider) set("repo", checkRepo(provider, b.repo ?? row.repo), "repo");
    const roots = { root: row.root, pluginsRoot: row.plugins_root, rulesRoot: row.rules_root };
    if (b.root !== undefined) set("root", (roots.root = checkRoot(b.root)), "root");
    if (b.pluginsRoot !== undefined) set("plugins_root", (roots.pluginsRoot = checkRoot(b.pluginsRoot, "pluginsRoot", "plugins")), "pluginsRoot");
    if (b.rulesRoot !== undefined) set("rules_root", (roots.rulesRoot = checkRoot(b.rulesRoot, "rulesRoot", "rules")), "rulesRoot");
    checkRoots(roots);
    if (b.baseBranch !== undefined) set("base_branch", checkBranch(b.baseBranch), "baseBranch");
    if (b.apiUrl !== undefined || provider !== row.provider)
      set("api_url", checkApiUrl(provider, b.apiUrl === undefined ? row.api_url : b.apiUrl), "apiUrl");
    if (b.minApprovals !== undefined) set("min_approvals", checkMin(b.minApprovals), "minApprovals");
    if (b.enabled !== undefined) set("enabled", checkBool(b.enabled, "enabled") ? 1 : 0, "enabled");
    if (b.credential !== undefined) {
      const cred = checkCredential(provider, b.credential);
      set("credential_kind", cred.kind, "credential");
      sets.push("credential_enc = ?", "credential_hint = ?");
      vals.push(git.encryptCredential(row.id, cred), credentialHint(cred));
    }
    if (b.webhookSecret !== undefined) {
      const s = checkSecret(b.webhookSecret);
      set("webhook_secret_enc", s ? git.encryptWebhookSecret(row.id, s) : null, "webhookSecret");
    }
    const isDefault = b.isDefault === undefined ? undefined : checkBool(b.isDefault, "isDefault");
    try {
      tx(db, () => {
        if (sets.length > 0) db.prepare(`UPDATE git_sources SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).run(...vals, nowIso(), row.id);
        if (isDefault === true) fixDefault(db, row.id);
        else if (isDefault === false && row.is_default === 1) {
          const other = sourceRows(db).find((x) => x.id !== row.id);
          if (other) fixDefault(db, other.id);
        }
        if (isDefault !== undefined) changed.push("isDefault");
        audit(db, actor, "source.update", "source", row.id, { changed });
      });
    } catch (e) {
      if (uniqueClash(e)) throw conflict("another source already uses that repo and root");
      throw e;
    }
    git.forget(row.id);
    return c.json(wire(load(row.id), c.req.url));
  });

  r.delete("/sources/:id", (c) => {
    const actor = c.get("actor");
    requireAdmin(actor);
    const row = load(c.req.param("id"));
    tx(db, () => {
      db.prepare("DELETE FROM git_sources WHERE id = ?").run(row.id);
      fixDefault(db, null);
      audit(db, actor, "source.delete", "source", row.id, { provider: row.provider, repo: row.repo });
    });
    git.forget(row.id);
    return c.body(null, 204);
  });

  r.post("/sources/:id/test", async (c) => {
    requireAdmin(c.get("actor"));
    const row = load(c.req.param("id"));
    return c.json(await git.test(row.id));
  });

  r.post("/sources/:id/sync", async (c) => {
    requireAdmin(c.get("actor"));
    const row = load(c.req.param("id"));
    // A manual sync re-reads every folder even when the base branch has not moved, so an approval
    // given after the merge can still be picked up.
    return c.json(await git.sync(row.id, true));
  });

  return r;
}
