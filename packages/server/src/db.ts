// SQLite storage via node:sqlite. The schema is embedded here (no .sql file read at runtime)
// and evolves through the ordered MIGRATIONS array; schema_version records how far a db has got.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Db = DatabaseSync;

/** Ordered migrations. Never edit a shipped entry; append a new one. */
export const MIGRATIONS: string[] = [
  // 1: initial schema
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    handle TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','member')),
    created_at TEXT NOT NULL
  );
  CREATE TABLE teams (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE team_members (
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('maintainer','member')),
    PRIMARY KEY (team_id, user_id)
  );
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE TABLE skills (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    areas TEXT NOT NULL DEFAULT '[]',
    tools TEXT NOT NULL DEFAULT '[]',
    tags TEXT NOT NULL DEFAULT '[]',
    visibility TEXT NOT NULL CHECK (visibility IN ('org','private')),
    deprecated TEXT,
    downloads INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE skill_grants (
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    principal_type TEXT NOT NULL CHECK (principal_type IN ('team','user')),
    principal_id INTEGER NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('read','write')),
    PRIMARY KEY (skill_id, principal_type, principal_id)
  );
  CREATE TABLE versions (
    id INTEGER PRIMARY KEY,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    changelog TEXT NOT NULL DEFAULT '',
    published_by INTEGER NOT NULL REFERENCES users(id),
    published_at TEXT NOT NULL,
    git TEXT,
    yanked TEXT,
    downloads INTEGER NOT NULL DEFAULT 0,
    UNIQUE (skill_id, version)
  );
  CREATE TABLE version_files (
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    mode INTEGER NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY (version_id, path)
  );
  CREATE TABLE audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    kind TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX audit_target ON audit(kind, target);
  CREATE INDEX grants_principal ON skill_grants(principal_type, principal_id);
  `,
  // 2: v2 - content-addressed blobs, stacks, trust, collections, git sources, proposals, device login.
  `
  CREATE TABLE blobs (
    sha256 TEXT PRIMARY KEY,
    size INTEGER NOT NULL,
    content BLOB NOT NULL
  );
  INSERT OR IGNORE INTO blobs (sha256, size, content) SELECT sha256, size, content FROM version_files;
  CREATE TABLE version_files_v2 (
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    mode INTEGER NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL REFERENCES blobs(sha256),
    PRIMARY KEY (version_id, path)
  );
  INSERT INTO version_files_v2 (version_id, path, mode, size, sha256) SELECT version_id, path, mode, size, sha256 FROM version_files;
  DROP TABLE version_files;
  ALTER TABLE version_files_v2 RENAME TO version_files;

  ALTER TABLE users ADD COLUMN system INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE git_identities (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('github','bitbucket-cloud')),
    username TEXT NOT NULL COLLATE NOCASE,
    PRIMARY KEY (user_id, provider),
    UNIQUE (provider, username)
  );

  ALTER TABLE skills ADD COLUMN stacks TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE skills ADD COLUMN source_id TEXT;
  ALTER TABLE skills ADD COLUMN source_path TEXT;
  ALTER TABLE skills ADD COLUMN verified_version TEXT;
  ALTER TABLE skills ADD COLUMN verified_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
  ALTER TABLE skills ADD COLUMN verified_at TEXT;
  ALTER TABLE versions ADD COLUMN behaviors TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE versions ADD COLUMN tokens TEXT;

  CREATE TABLE install_events (
    id INTEGER PRIMARY KEY,
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version_id INTEGER NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX install_events_skill_at ON install_events(skill_id, at);

  CREATE TABLE votes (
    skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    works INTEGER NOT NULL CHECK (works IN (0,1)),
    note TEXT NOT NULL DEFAULT '',
    version TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (skill_id, user_id)
  );

  CREATE TABLE collections (
    id INTEGER PRIMARY KEY,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    skills TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (team_id, slug)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE device_codes (
    device_hash TEXT PRIMARY KEY,
    user_code TEXT NOT NULL UNIQUE,
    client_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','consumed')),
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    token TEXT
  );

  CREATE TABLE git_sources (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('github','bitbucket-cloud')),
    repo TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    root TEXT NOT NULL,
    api_url TEXT,
    min_approvals INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    credential_kind TEXT NOT NULL CHECK (credential_kind IN ('token','basic','github-app')),
    credential_enc TEXT,
    credential_hint TEXT NOT NULL DEFAULT '',
    webhook_secret_enc TEXT,
    last_sync TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (provider, repo, root)
  );

  CREATE TABLE proposals (
    id TEXT PRIMARY KEY,
    skill_name TEXT NOT NULL,
    version TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('new','update')),
    proposer_id INTEGER NOT NULL REFERENCES users(id),
    source_id TEXT NOT NULL REFERENCES git_sources(id) ON DELETE CASCADE,
    branch TEXT NOT NULL,
    pr_number INTEGER,
    pr_url TEXT,
    status TEXT NOT NULL CHECK (status IN ('open','merged','published','closed','failed')),
    status_message TEXT NOT NULL DEFAULT '',
    changelog TEXT NOT NULL DEFAULT '',
    behaviors TEXT NOT NULL DEFAULT '[]',
    visibility TEXT CHECK (visibility IN ('org','private')),
    team_slug TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX proposals_skill ON proposals(skill_name, status);
  CREATE TABLE proposal_files (
    proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    mode INTEGER NOT NULL,
    sha256 TEXT NOT NULL REFERENCES blobs(sha256),
    PRIMARY KEY (proposal_id, path)
  );
  `,
  // 3: package kinds (skill, plugin, rule), plugin marketplace keys.
  `
  ALTER TABLE skills ADD COLUMN kind TEXT NOT NULL DEFAULT 'skill' CHECK (kind IN ('skill','plugin','rule'));
  ALTER TABLE versions ADD COLUMN plugin TEXT;
  ALTER TABLE versions ADD COLUMN rule TEXT;
  ALTER TABLE versions ADD COLUMN archive_sha256 TEXT;
  ALTER TABLE git_sources ADD COLUMN plugins_root TEXT NOT NULL DEFAULT 'plugins';
  ALTER TABLE git_sources ADD COLUMN rules_root TEXT NOT NULL DEFAULT 'rules';
  ALTER TABLE proposals ADD COLUMN package_kind TEXT NOT NULL DEFAULT 'skill' CHECK (package_kind IN ('skill','plugin','rule'));
  ALTER TABLE tokens ADD COLUMN scope TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full','marketplace'));
  CREATE INDEX skills_kind ON skills(kind);
  `,
];

export function migrate(db: Db): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let current = row?.version ?? 0;
  if (!row) db.exec("INSERT INTO schema_version (version) VALUES (0)");
  if (current > MIGRATIONS.length)
    throw new Error(`database schema v${current} is newer than this server (v${MIGRATIONS.length})`);
  while (current < MIGRATIONS.length) {
    const sql = MIGRATIONS[current]!;
    tx(db, () => {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET version = ?").run(current + 1);
    });
    current++;
  }
  return current;
}

export function openDb(file: string): Db {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  return db;
}

export function openDataDir(dir: string): Db {
  mkdirSync(dir, { recursive: true });
  return openDb(join(dir, "registry.db"));
}

/** Run fn in an IMMEDIATE transaction; roll back on any throw. */
export function tx<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
