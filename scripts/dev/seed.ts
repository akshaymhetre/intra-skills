// Seed a REAL registry with the fictional org in data.ts, through the registry's own API, then
// backdate history directly in its SQLite file so the console shows months of realistic activity.
// Development only. Usage (scripts/dev/up.sh runs it):
//   node scripts/dev/seed.ts <registry-url> <data-dir> <admin-token>
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { SEED_PLUGINS, SEED_RULES, SEED_SKILLS, SEED_TEAMS, SEED_USERS, buildFiles } from "./data.ts";

const [registry, dataDir, adminToken] = process.argv.slice(2);
if (!registry || !dataDir || !adminToken) {
  console.error("usage: node scripts/dev/seed.ts <registry-url> <data-dir> <admin-token>");
  process.exit(2);
}

const NOW = Date.now();
const DAY = 86_400_000;
const iso = (daysAgo: number, jitterHours = 0) => new Date(NOW - daysAgo * DAY - jitterHours * 3_600_000).toISOString();

// Deterministic pseudo-random numbers, so every seeded registry looks the same.
let state = 0x9e3779b9;
const rand = () => {
  state = Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) >>> 0;
  state = (state + 0x6d2b79f5) >>> 0;
  return state / 0x100000000;
};

async function api(method: string, path: string, body?: unknown, token = adminToken): Promise<any> {
  const res = await fetch(registry + path, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

// ---------- people and teams ----------
const tokens = new Map<string, string>();
const admin = SEED_USERS[0]!; // created by `init`
tokens.set(admin.handle, adminToken);
for (const u of SEED_USERS.slice(1)) {
  const r = await api("POST", "/api/users", { handle: u.handle, displayName: u.displayName, role: u.role });
  tokens.set(u.handle, r.token);
}
const GITHUB: Record<string, string> = { maya: "maya-chen", ravi: "ravi-iyer", lena: "lenaortiz", sam: "sokafor", noor: "noorh", jonas: "jberg", kim: "kimtran", dev: "devpatel" };
for (const u of SEED_USERS) await api("PUT", `/api/users/${u.handle}/git-identities`, [{ provider: "github", username: GITHUB[u.handle] }]);

for (const t of SEED_TEAMS) {
  await api("POST", "/api/teams", { slug: t.slug, name: t.name, description: t.description });
  for (const [h, role] of t.members) await api("PUT", `/api/teams/${t.slug}/members/${h}`, { role });
}

// ---------- skills and versions ----------
for (const s of SEED_SKILLS) {
  for (let i = 0; i < s.versions.length; i++) {
    const v = s.versions[i]!;
    const files = Object.entries(buildFiles(s, i)).map(([path, content]) => ({
      path,
      mode: path.endsWith(".sh") ? 0o755 : 0o644,
      contentBase64: b64(content),
    }));
    await api("POST", `/api/skills/${s.name}/versions`, {
      version: v.v,
      files,
      changelog: v.changelog,
      git: v.commit ? { commit: v.commit, repo: `acme/${s.team ?? "shared"}-skills`, dirty: !!v.dirty } : null,
      ...(i === 0 ? { visibility: s.visibility, team: s.team } : {}),
    });
    if (v.yanked) await api("POST", `/api/skills/${s.name}/versions/${v.v}/yank`, { reason: v.yanked });
  }
  if (s.deprecated) await api("PATCH", `/api/skills/${s.name}`, { deprecated: s.deprecated });
  if (s.grants?.length) await api("PUT", `/api/skills/${s.name}/grants`, s.grants);
}

// ---------- plugins and rules ----------
for (const p of [...SEED_PLUGINS, ...SEED_RULES]) {
  const manifest = p.files[".claude-plugin/plugin.json"];
  const version = manifest ? (JSON.parse(manifest) as { version: string }).version : /version: "([^"]+)"/.exec(p.files["RULE.md"]!)![1]!;
  await api("POST", `/api/skills/${p.name}/versions`, {
    version,
    files: Object.entries(p.files).map(([path, content]) => ({ path, mode: p.exec?.includes(path) ? 0o755 : 0o644, contentBase64: b64(content) })),
    changelog: "First version in the registry.",
    team: p.team,
    visibility: p.visibility ?? "org",
  });
}

// ---------- history: who published what, and when ----------
const db = new DatabaseSync(join(dataDir, "registry.db"));
const uid = (h: string) => (db.prepare("SELECT id FROM users WHERE handle = ?").get(h) as { id: number }).id;
for (const u of SEED_USERS) db.prepare("UPDATE users SET created_at = ? WHERE handle = ?").run(iso(u.daysAgo), u.handle);
for (const t of SEED_TEAMS) db.prepare("UPDATE teams SET created_at = ? WHERE slug = ?").run(iso(t.daysAgo), t.slug);
for (const s of SEED_SKILLS) {
  const skill = db.prepare("SELECT id FROM skills WHERE name = ?").get(s.name) as { id: number };
  const first = s.versions[0]!;
  const last = s.versions[s.versions.length - 1]!;
  db.prepare("UPDATE skills SET created_by = ?, created_at = ?, updated_at = ? WHERE id = ?").run(
    uid(s.createdBy),
    iso(first.daysAgo, 3),
    iso(last.daysAgo, 1),
    skill.id,
  );
  let total = 0;
  for (const v of s.versions) {
    const row = db.prepare("SELECT id FROM versions WHERE skill_id = ? AND version = ?").get(skill.id, v.v) as { id: number };
    db.prepare("UPDATE versions SET published_by = ?, published_at = ?, downloads = ? WHERE id = ?").run(
      uid(v.by),
      iso(v.daysAgo, 2),
      v.downloads,
      row.id,
    );
    total += v.downloads;
    // Install events spread from publish day to today, mildly weighted toward recent days and
    // with a per-skill weekly rhythm, capped so the database stays small.
    const events = Math.min(v.downloads, 60);
    const phase = rand() * 7;
    const ins = db.prepare("INSERT INTO install_events (skill_id, version_id, user_id, at) VALUES (?, ?, ?, ?)");
    for (let e = 0; e < events; e++) {
      let age = Math.floor(Math.pow(rand(), 1.35) * Math.min(v.daysAgo, 30));
      if (Math.sin((age + phase) * 0.9) < -0.4 && rand() < 0.6) age = Math.min(Math.floor(v.daysAgo), age + 1);
      const who = SEED_USERS[Math.floor(rand() * SEED_USERS.length)]!.handle;
      ins.run(skill.id, row.id, uid(who), iso(age, Math.floor(rand() * 20)));
    }
  }
  db.prepare("UPDATE skills SET downloads = ? WHERE id = ?").run(total, skill.id);
}
for (const p of [...SEED_PLUGINS, ...SEED_RULES]) {
  const skill = db.prepare("SELECT id FROM skills WHERE name = ?").get(p.name) as { id: number };
  db.prepare("UPDATE skills SET created_by = ?, created_at = ?, updated_at = ? WHERE id = ?").run(uid(p.by), iso(p.daysAgo, 3), iso(p.daysAgo, 1), skill.id);
  db.prepare("UPDATE versions SET published_by = ?, published_at = ? WHERE skill_id = ?").run(uid(p.by), iso(p.daysAgo, 2), skill.id);
  const v = db.prepare("SELECT id FROM versions WHERE skill_id = ?").get(skill.id) as { id: number };
  const n = 8 + Math.floor(rand() * 30);
  const ins = db.prepare("INSERT INTO install_events (skill_id, version_id, user_id, at) VALUES (?, ?, ?, ?)");
  for (let e = 0; e < n; e++) ins.run(skill.id, v.id, uid(SEED_USERS[Math.floor(rand() * SEED_USERS.length)]!.handle), iso(Math.floor(rand() * Math.min(p.daysAgo, 20)), Math.floor(rand() * 20)));
  db.prepare("UPDATE skills SET downloads = ? WHERE id = ?").run(n + 20, skill.id);
}
db.prepare("DELETE FROM audit").run(); // the seed's own audit trail is noise; activity starts clean
db.close();

// ---------- trust ----------
const BROKEN_NOTES = [
  "Plan summary fails when the workspace has no backend configured.",
  "Assumes kubectl context is already set; it was pointing at staging.",
];
let broken = 0;
for (const s of SEED_SKILLS) {
  if (s.visibility === "private" || s.deprecated) continue;
  const voters = SEED_USERS.filter(() => rand() < 0.55);
  for (const u of voters) {
    const works = !(broken < BROKEN_NOTES.length && rand() < 0.12);
    const note = works ? "" : BROKEN_NOTES[broken++]!;
    await api("PUT", `/api/skills/${s.name}/vote`, { works, ...(note ? { note } : {}) }, tokens.get(u.handle));
  }
}
for (const name of ["terraform-module-review", "secrets-sweep", "react-component-audit", "k8s-incident-triage", "sql-migration-safety"])
  await api("POST", `/api/skills/${name}/verify`, {});

// ---------- collections ----------
const COLLECTIONS: [string, string, string, string, string[]][] = [
  ["platform", "starter", "Platform starter kit", "What every new platform engineer installs in week one.", ["terraform-module-review", "k8s-incident-triage", "aws-cost-guard", "kubernetes-admission-policy-authoring"]],
  ["frontend", "ui-review", "UI review", "Accessibility, tokens and tests for any front-end pull request.", ["react-component-audit", "design-token-sync", "playwright-flow-writer"]],
  ["security", "baseline", "Security baseline", "The checks every repository should run before release.", ["secrets-sweep", "dependency-cve-triage", "threat-model-lite"]],
];
for (const [team, slug, title, description, skills] of COLLECTIONS)
  await api("PUT", `/api/collections/${team}/${slug}`, { title, description, skills });

// ---------- a connected repository and proposals in every status ----------
// Written straight into the database: a real source would open real pull requests. The source has
// no credential, so Test and Sync on it report a credential error, which is a state worth seeing.
{
  const g = new DatabaseSync(join(dataDir, "registry.db"));
  const gid = (h: string) => (g.prepare("SELECT id FROM users WHERE handle = ?").get(h) as { id: number }).id;
  const src = "src_devacmeskills1";
  g.prepare(
    `INSERT INTO git_sources (id, provider, repo, base_branch, root, min_approvals, enabled, is_default, credential_kind, credential_hint, last_sync, created_at, updated_at)
     VALUES (?, 'github', 'acme/skills', 'main', 'skills', 1, 1, 1, 'token', 'github_pat_...k2Qa', ?, ?, ?)`,
  ).run(
    src,
    JSON.stringify({
      at: iso(0, 1),
      ok: true,
      message: "published react-component-audit@2.0.0",
      ingested: ["react-component-audit@2.0.0"],
      skipped: [{ path: "skills/figma-handoff", reason: "not merged through a pull request" }],
      headCommit: "5f2c9a1e7b3d4c6a8e0f1b2c3d4e5f6a7b8c9d0e",
    }),
    iso(60),
    iso(0, 1),
  );
  for (const [name, path] of [["terraform-module-review", "skills/terraform-module-review"], ["react-component-audit", "skills/react-component-audit"]])
    g.prepare("UPDATE skills SET source_id = ?, source_path = ? WHERE name = ?").run(src, path, name);
  const latest = g.prepare(
    "SELECT v.id FROM versions v JOIN skills s ON s.id = v.skill_id WHERE s.name = 'react-component-audit' ORDER BY v.id DESC LIMIT 1",
  ).get() as { id: number };
  g.prepare("UPDATE versions SET git = ? WHERE id = ?").run(
    JSON.stringify({
      commit: "5f2c9a1e7b3d4c6a8e0f1b2c3d4e5f6a7b8c9d0e",
      repo: "github.com/acme/skills",
      dirty: false,
      url: "https://github.com/acme/skills/commit/5f2c9a1e7b3d4c6a8e0f1b2c3d4e5f6a7b8c9d0e",
      pullRequest: { number: 38, url: "https://github.com/acme/skills/pull/38" },
    }),
    latest.id,
  );
  const P: [string, string, string, "new" | "update", string, number, string, string, string, number][] = [
    ["prp_dev0000000000001", "react-component-audit", "2.1.0", "update", "lena", 42, "open", "Waiting for 1 approval from someone other than you", "Check focus order in dialogs and menus.", 0.2],
    ["prp_dev0000000000002", "figma-handoff", "0.1.0", "new", "kim", 44, "open", "Approved; waiting for someone to merge the pull request", "First version: turn a Figma frame into a component spec.", 1],
    ["prp_dev0000000000003", "playwright-flow-writer", "1.2.0", "update", "dev", 39, "failed", "needs 1 approval from someone other than the proposer", "Retry flaky steps once with a trace.", 3],
    ["prp_dev0000000000004", "react-component-audit", "2.0.0", "update", "lena", 38, "published", "Published as react-component-audit@2.0.0", "Stories as part of the audit.", 21],
  ];
  for (const [id, skill, version, kind, who, pr, status, msg, changelog, days] of P)
    g.prepare(
      `INSERT INTO proposals (id, skill_name, version, kind, proposer_id, source_id, branch, pr_number, pr_url, status, status_message, changelog, behaviors, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`,
    ).run(id, skill, version, kind, gid(who), src, `intra/${skill}-${version}`, pr, `https://github.com/acme/skills/pull/${pr}`, status, msg, changelog, iso(days, 2), iso(days));
  g.close();
}

console.log(`seeded ${SEED_USERS.length} users, ${SEED_TEAMS.length} teams, ${SEED_SKILLS.length} skills`);
for (const [h, t] of tokens) console.log(`token ${h} ${t}`);
