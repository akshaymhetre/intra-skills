# intra-skills registry API (v1 contract)

Types live in `packages/shared/src/types.ts` and are the source of truth for every JSON shape below.
All routes are under `/api`, JSON in and out, UTF-8.

## Auth

- A caller authenticates with `Authorization: Bearer <token>` (CLI) or the `isk_session` httpOnly cookie (web console).
- Tokens look like `isk_<32 random base62 chars>`. The server stores only `sha256(token)` plus the first 12 chars as `prefix`.
- `POST /api/auth/login {token}` validates a token and sets `isk_session=<token>` (httpOnly, SameSite=Lax, Path=/, 30 days). `POST /api/auth/logout` clears it and answers `204`.
- Every route except `GET /api/health` and `POST /api/auth/login` requires auth. Missing or bad credentials: `401 {error:{code:"unauthenticated"}}`.
- Mutating requests that authenticate by cookie must carry header `X-Requested-With: intra-skills` (CSRF guard); otherwise `403 csrf`.

## Errors

`{ "error": { "code": string, "message": string, "details"?: any } }` with status 400 `invalid`, 401 `unauthenticated`, 403 `forbidden`, 404 `not_found`, 409 `conflict`, 413 `too_large`, 422 `invalid_skill` (details = ValidationIssue[]).

## Permissions model

- Roles: `admin` (everything) and `member`.
- Teams have members with role `maintainer` or `member`.
- Skill visibility:
  - `org` - every authenticated user can read.
  - `private` - readable only by: admins, the creator, members of the owning team, and principals in the skill's grants.
- Write (publish a new version, patch, yank, manage grants) is allowed to: admins, the creator, members of the owning team, and principals with a `write` grant.
- `canAdmin` (change visibility, team, grants) = admins, creator, maintainers of the owning team.
- A caller who cannot read a private skill gets `404 not_found` on every route for it, never 403, so existence does not leak. The list endpoint omits it.

## Routes

### Meta
- `GET /api/health` -> `{ok:true, version:string}`
- `GET /api/me` -> `User`

### Skills
- `GET /api/skills?q=&team=&area=&tool=&tag=&visibility=&sort=updated|name|downloads&deprecated=include|exclude` -> `SkillListResponse`
  - `q` matches name, description and tags (case-insensitive substring).
  - `team`, `area`, `tool`, `tag` may repeat; values within one facet are OR, across facets AND.
  - Facet counts are computed over the result of the OTHER filters (standard faceted search), only over skills the caller can read.
  - Default sort `updated` (desc); default `deprecated=include`.
- `GET /api/skills/:name` -> `SkillDetail` (versions newest first, yanked included and flagged).
- `PATCH /api/skills/:name` body `SkillPatch` -> `SkillDetail`. `visibility`/`team` need canAdmin; facets/deprecated need write.
- `DELETE /api/skills/:name` (admin only) -> `204`.

### Versions
- `POST /api/skills/:name/versions` body `PublishRequest` -> `201 VersionMeta`
  - Creates the skill on first publish (caller becomes creator). Afterwards requires write.
  - The server decodes files, validates paths/sizes (`validateBundleFiles`) and SKILL.md (`parseSkillMd(text, name)`), requires `metadata.version` absent or equal to `version`, and requires `version` strictly greater than every existing version (409 `conflict` otherwise; versions are immutable).
  - Facets (`team`, `areas`, `tags`, `tools`, `description`) are refreshed from SKILL.md on every publish. On first publish `visibility` comes from the request, else `metadata.visibility`, else `org`; `team` from the request, else `metadata.team`. A team that does not exist is `400 invalid`. On a later publish, a `metadata.team` that MOVES the skill to another team requires canAdmin (`403` otherwise), so a write grant cannot pull a skill into the grantee's own team.
  - SKILL.md frontmatter that is not strict YAML (an unquoted colon in the description is common) is read leniently with a warning, because every agent tool accepts it. A non-semver `metadata.version` is ignored with a warning; a top-level `version` is accepted as a fallback.
  - Server computes per-file sha256 and `bundleSha256`.
- `GET /api/skills/:name/versions/:version` -> `VersionDetail` (`:version` may be `latest`, which skips yanked).
- `GET /api/skills/:name/versions/:version/files/*` -> raw file bytes (`text/plain; charset=utf-8` for text, `application/octet-stream` otherwise).
- `GET /api/skills/:name/versions/:version/bundle` -> `Bundle`; increments download counters. Yanked versions are still downloadable by exact version (lockfiles must keep working) but never resolved by `latest`.
- `GET /api/skills/:name/resolve?range=^1.2.0` -> `{version:string}` highest non-yanked match, `404` if none.
- `POST /api/skills/:name/versions/:version/yank {reason}` -> `VersionMeta`; `DELETE` same path un-yanks.
- `GET /api/skills/:name/diff?from=1.0.0&to=1.1.0` -> `DiffResponse` (unified diff per file, 3 lines context).

### Access
- `GET /api/skills/:name/grants` -> `Grant[]` (write required)
- `PUT /api/skills/:name/grants` body `Grant[]` -> `Grant[]` (replaces; canAdmin required; unknown team/user -> 400)

### Teams and users
- `GET /api/teams` -> `Team[]`
- `POST /api/teams {slug,name,description?}` (admin) -> `201 TeamDetail`
- `GET /api/teams/:slug` -> `TeamDetail`
- `PATCH /api/teams/:slug {name?,description?}` (admin or maintainer) -> `TeamDetail`
- `PUT /api/teams/:slug/members/:handle {role}` (admin or maintainer) -> `TeamDetail`
- `DELETE /api/teams/:slug/members/:handle` (admin or maintainer) -> `TeamDetail`
- `GET /api/users` -> `User[]`
- `POST /api/users {handle,displayName,role?}` (admin) -> `201 CreateUserResponse` (first token, shown once)
- `PATCH /api/users/:handle {role?,displayName?}` (admin) -> `User`

### Tokens
- `GET /api/tokens` -> `ApiToken[]` (caller's own, unrevoked)
- `POST /api/tokens {name}` -> `201 CreateTokenResponse`
- `DELETE /api/tokens/:id` -> `204`

### Audit
- `GET /api/audit?limit=100&before=<id>&target=<skill name>` -> `AuditEntry[]` newest first. Admins see everything; members see entries for skills they can read.
- Actions recorded: `skill.publish`, `skill.patch`, `skill.delete`, `version.yank`, `version.unyank`, `grants.set`, `team.create`, `team.update`, `team.member.set`, `team.member.remove`, `user.create`, `user.update`, `token.create`, `token.revoke`.

## Static console

The server serves the built web console from `INTRA_SKILLS_WEB_DIR` (default `../web/dist` relative to the server package) at `/`, with SPA fallback to `index.html` for any non-`/api` GET.

## Server CLI

- `intra-skills-server init --data <dir> --admin <handle> [--name "Display Name"]` creates the database and the first admin and prints its token once. Refuses if the db already has users.
- `intra-skills-server serve --data <dir> [--port 7710] [--host 127.0.0.1]`.
- Env fallbacks: `INTRA_SKILLS_DATA`, `PORT`, `HOST`.

---

# v2 additions

Everything above still holds unless a line below changes it.
Types are in `packages/shared/src/types.ts` (v2 section at the end of the file).

## Public routes

These answer without a signed-in caller (`PUBLIC_API_PATHS` in `packages/server/src/app.ts`):

- `GET /api/health`, `POST /api/auth/login` (unchanged).
- `GET /api/meta` -> `RegistryMeta`. `publicUrl` is the `publicUrl` setting, else the request origin. `mcpUrl` = `<publicUrl>/api/mcp`.
- `GET /api/setup` -> `{needsSetup:boolean}`.
- `POST /api/setup` body `SetupRequest` -> `201 {user:User, token:string}` and sets the session cookie. Only while no non-system user exists, and only with the setup token (constant-time compare). Afterwards `409 conflict`. A wrong token is `403 forbidden`. Deletes `<data>/setup-token` on success. `orgName`, when given, is stored as the `name` setting.
- `POST /api/auth/device` body `{clientName?:string}` -> `DeviceStart`. User codes are 8 characters from `BCDFGHJKLMNPQRSTVWXZ` shown as `XXXX-XXXX`; device codes are 32 random base62 characters stored only as sha256. Lifetime 600 s, interval 3 s. At most 20 pending codes exist at once (oldest pending expires first).
- `POST /api/auth/device/token` body `{deviceCode}` -> `DevicePoll`, always `200`. On `approved` the server mints a NEW token named `<clientName> (device login)` for the approving user, returns it once, and marks the code consumed, so a second poll answers `expired`.
- `POST /api/hooks/:sourceId` - webhook from a git host, verified by the source's webhook secret (see Git sources). Unknown source or bad signature: `401`. Answers `202 {queued:true}` and runs a sync in the background.

## Signed-in routes

### Device approval
- `GET /api/auth/device/:userCode` -> `DeviceRequestInfo` (`404` for unknown codes; codes compare case-insensitively and ignore the dash).
- `POST /api/auth/device/:userCode/approve` / `.../deny` -> `DeviceRequestInfo`. Approving an expired code is `409`.

### Settings and identity
- `GET /api/settings` (admin) -> `{settings:OrgSettings, pinned:(keyof OrgSettings)[]}`; `pinned` lists keys an env var overrides.
- `PATCH /api/settings` (admin) body `Partial<OrgSettings>` -> same shape. `publicUrl` must be http(s) without a path; `staleDays` 1-3650; `pollSeconds` 15-86400; `name` 1-80 chars. Audit `settings.update`.
- `PUT /api/me/git-identities` body `GitIdentity[]` -> `User` (replaces; one per provider; username `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$`; taken by another user -> `409`).
- `PUT /api/users/:handle/git-identities` (admin) same body -> `User`.
- `User.gitIdentities` is on every user response. System users (`users.system = 1`) never appear in `/api/users`, cannot hold tokens and cannot sign in.

### Skills (changes)
- `GET /api/skills` also takes `stack=` (repeatable, same OR/AND rules), `health=active|stale`, `verified=1`, and `sort=trending` (installs in the last 7 days desc, then downloads, then name). `facets.stacks` is added.
- Every `SkillSummary` carries `stacks`, `installsWeek`, `trend` (14 daily counts from `install_events`, UTC days, oldest first, today last), `health`, `verified`, `trust`, `author` (publisher of the latest version) and `source`.
  - `health` = `active` when the latest version was published within `staleDays`, else `stale`.
  - `verified` = the skill has a verification AND (the verified version is the latest, OR the latest version adds no `ask` behavior id that the verified version lacked - `addsAskBehavior`).
- `SkillDetail.verification` = `{version, by, at}` or null; `SkillDetail.proposals` = open proposals for the skill (any status except `published` and `closed`).
- `PATCH /api/skills/:name` accepts `stacks`.
- `GET /api/skills/:name/versions/:version/bundle` also records an install event (skill, version, user, time).
- `POST /api/skills/:name/versions` answers `403 forbidden` with `details:{publishMode:"pull-request"}` while any enabled git source exists.
- `VersionMeta.behaviors` and `VersionMeta.tokens` are computed at publish (`scanBehaviors`, `estimateTokens` in shared). Versions from before v2 carry `[]` and `null`.

### Trust
- `PUT /api/skills/:name/vote` body `VoteRequest` -> `Trust` (read access; records the latest version at the time; replaces the caller's previous vote). Audit is not written for votes.
- `DELETE /api/skills/:name/vote` -> `Trust`.
- `GET /api/skills/:name/votes` -> `Vote[]` newest first.
- `POST /api/skills/:name/verify` (admin) body `{version?:string}` (default latest) -> `SkillDetail`. Audit `skill.verify`.
- `DELETE /api/skills/:name/verify` (admin) -> `SkillDetail`. Audit `skill.unverify`.
- `GET /api/review` (admin) -> `SkillSummary[]` whose `verified` is false and that have a live version, oldest update first.

### Collections
- `GET /api/collections?team=` -> `Collection[]` (by team, then slug).
- `GET /api/collections/:team/:slug` -> `Collection`.
- `PUT /api/collections/:team/:slug` body `CollectionInput` -> `Collection` (create or replace). Admins and members of that team. Every listed skill must exist and be readable by the caller (`400` naming the first bad one); at most 50; duplicates removed keeping first. Slug uses `TEAM_RE`. Audit `collection.put`.
- `DELETE /api/collections/:team/:slug` -> `204`. Audit `collection.delete`.
- Skills the caller cannot read are dropped from `skills` on every read.

### Home and suggest
- `GET /api/home` -> `HomeResponse`.
- `POST /api/suggest` body `RepoSignals` -> `SuggestResponse`. The server runs `detectStacks`, then scores each readable, non-deprecated skill: +3 per matching stack, +1 per matching tag that equals a detected stack, +2 when it is owned by one of the caller's teams, +1 when verified, +min(installsWeek,5)/5. Only skills with a stack or tag match are returned, best first, at most 20. `reasons` are plain words ("matches terraform", "owned by your team platform", "verified").

### Git sources (admin)
- `GET /api/sources` -> `GitSource[]`; `POST /api/sources` body `GitSourceInput` (provider, repo and credential required) -> `201 GitSource`; `GET|PATCH|DELETE /api/sources/:id`.
  - `id` = `src_` + 12 base62 chars. The first source created is the default. Credentials and webhook secrets are encrypted with AES-256-GCM under the server key and never returned; `credential.hint` is a masked tail (`ghp_...a1b2`).
  - `repo` is `owner/name` (GitHub) or `workspace/repo-slug` (Bitbucket Cloud). `root` default `skills`; `baseBranch` default `main`; `minApprovals` default `1`, range 0-10.
  - `webhook.url` = `<publicUrl>/api/hooks/<id>`.
- `POST /api/sources/:id/test` -> `{ok:boolean, checks:SourceCheck[]}`: credential accepted, repo readable, base branch exists, the credential can create branches and pull requests (permission read from the host, not by writing).
- `POST /api/sources/:id/sync` -> `SyncStatus` (runs a sync now and waits for it). A manual sync reads every folder even when the base branch has not moved, so an approval given after a merge is picked up.
- Webhook secrets are at least 16 characters (an empty string clears the secret).
- Audit: `source.create`, `source.update`, `source.delete`, `source.sync` (only when something was ingested).

### Proposals
- `POST /api/skills/:name/proposals` body `ProposalRequest` -> `201 Proposal` (or `200` when it updated the caller's own open proposal for the same skill).
  - Requires `publishMode` = `pull-request` (else `409` telling the caller to publish directly).
  - Requires write on an existing skill (404 when unreadable). A new skill needs no write.
  - Requires the caller to have a git identity for the source's provider (`403` with `details:{reason:"no_git_identity", provider}`), so the registry can refuse self-approval.
  - Requires `metadata.version` in SKILL.md, equal to `version` (`422` otherwise): sync reads the version from the repository, so a folder without it would be skipped after a review had been spent on it.
  - Runs `validateSkillFiles` and `assertNewerVersion` exactly like a direct publish, plus the secret patterns, BEFORE touching the git host.
  - Opens (or updates) branch `intra/<skill>-<version>` from the base branch, writing the files under `<root>/<skill>/` and deleting files in that folder that the upload does not contain, and opens a pull request titled `<skill> <version>` (`New skill: <skill> <version>` for a new skill). The body states the proposer (handle and git username), version, changelog, the behaviors table and the token estimate, and ends with a hidden marker `<!-- intra-skills:proposal=<id> -->`.
  - If the same skill already has an OPEN proposal by someone else: `409`. Same proposer: the new files are pushed to that branch and the proposal's version and changelog are replaced.
  - Proposing a skill into a source other than the one that manages it, or into a disabled source: `409`.
- `GET /api/proposals?status=&mine=1&skill=` -> `Proposal[]` newest first. Members see proposals for skills they can read plus their own; admins see all.
- `GET /api/proposals/:id` -> `Proposal`; `POST /api/proposals/:id/refresh` -> `Proposal` after re-reading the pull request now.
- Statuses: `open` (pull request open), `merged` (merged, waiting for the next sync), `published` (version created), `closed` (closed without merge), `failed` (merged but refused at ingest; `statusMessage` says why).

### Sync (what turns a merged pull request into a version)
A sync of one source:
1. Reads the base branch head. If it equals the last synced head, only refreshes open proposals.
2. Lists every `SKILL.md` under `root` (any depth up to 3). The folder name is the skill name; `metadata.version` is required (missing: skipped "no metadata.version").
3. Skips a folder whose version already exists in the registry (silently) or is not newer (skipped with a reason). Skips a skill managed by another source.
4. Finds the commit that last changed the folder, and the merged pull request that contains it (GitHub: `GET /repos/{o}/{r}/commits/{sha}/pulls`; Bitbucket Cloud: `GET /repositories/{w}/{r}/commit/{sha}/pullrequests`, falling back to recently merged pull requests when commit links are not indexed). When the host has not indexed the commit yet (GitHub lags a merge by about a second), a proposal whose pull request was merged as exactly that commit is used instead. No merged pull request: skipped "not merged through a pull request". That skip is never final: it does not fail a proposal, and the next sync reads the folder again even if the head has not moved.
5. Counts approvals: distinct reviewers whose latest decisive review is an approval (GitHub: the latest of `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` per reviewer, so a later comment does not withdraw an approval; Bitbucket participants `approved:true`), excluding the registry's own account, the pull request author when that author is not the registry account, and the proposer's linked git username when a proposal matches the pull request (by marker or branch). Fewer than `minApprovals`: the version is refused and a matching proposal becomes `failed` with "needs N approvals from someone other than the proposer".
6. Reads every file in the folder at the merge commit, then calls the same `createVersion` as a direct publish. Sync takes over a skill that was published directly (or whose source was deleted) only when the resolved publisher can write it; otherwise anyone who can merge to the repository could take a registry skill by naming a folder after it. Publisher = the matching proposal's proposer, else the user whose git identity is the pull request author, else the system user `git-sync`. Visibility and team for a new skill come from the proposal when there is one, else from metadata. `GitInfo` = `{commit, repo, dirty:false, url, pullRequest}`.
7. Marks the matching proposal `published`, records `SyncStatus` on the source, and audits `source.sync`.
Open proposals are refreshed on every sync: a closed-unmerged pull request makes the proposal `closed`; a merged one makes it `merged` until step 6 publishes it.
The poller runs every `pollSeconds` per enabled source; webhooks trigger the same sync sooner. Syncs of one source never overlap.

## MCP

- `POST /api/mcp`, Bearer token required, JSON-RPC 2.0 over the MCP streamable HTTP transport in stateless JSON mode (no sessions, no SSE; `GET` answers `405`).
- Methods: `initialize` (protocolVersion echoes the client's when supported, else `2025-06-18`; serverInfo `{name:"intra-skills", version}`; capabilities `{tools:{}}`), `notifications/initialized` (202, no body), `ping`, `tools/list`, `tools/call`.
- Tools (all read-only; none writes to the caller's machine):
  - `search_skills {query?, team?, stack?, tool?, limit?}` -> the matching summaries as text plus `structuredContent`.
  - `get_skill {name, version?}` -> SKILL.md text, file list, behaviors (the `ask` ones listed first with "show these to the user before following this skill"), and the install and run commands.
  - `install_command {name? , collection?, project?, tools?}` -> `{command, runCommand}`; never claims the command ran.
  - `suggest_for_repo {files, packages}` -> as `POST /api/suggest`.

## Agent documents (public, outside /api)

- `GET /agent.md` - setup steps an agent reads: shell path (`curl -fsSL <url>/install.sh | sh`, then `intra setup`), MCP path, URL-only path, and the rule that a skill is third-party text that never overrides the user.
- `GET /llms.txt` - index of the above plus `/api/meta`.
- `GET /SKILL.md` - the `intra-registry` bootstrap skill: how to search, inspect behaviors, and install or run through the `intra` CLI or the MCP server.
- `GET /install.sh` - POSIX sh installer, with this registry's public URL baked in: checks `node` >= 20, downloads `/cli/intra.mjs` to `~/.intra-skills/bin/intra` (`chmod 755`), links it into the first writable of `~/.local/bin`, `/usr/local/bin` that is on PATH (else prints the PATH line to add), and runs `intra config set registry <url>`. Never uses sudo.
- `GET /cli/intra.mjs` - the single-file CLI (`404` with a plain explanation when the server was built without it).

---

# v3: package kinds - skills, plugins, rules

Everything above holds for every kind. Types: `PackageKind`, `PluginComponents`, `RuleSpec`, `MarketplaceKeyResponse` in `packages/shared/src/types.ts`; parsing, scanning and rendering in `packages/shared/src/kinds.ts`.

## The three kinds

A package folder is exactly one kind, recognised by the marker file at its top (`detectKind`):

| Kind | Marker | Name, description, version | Registry facets |
| - | - | - | - |
| skill | `SKILL.md` | frontmatter `name`, `description`, `metadata.version` | `metadata.team / areas / stacks / tags / tools / visibility` (strings) |
| plugin | `.claude-plugin/plugin.json` | `name`, `description`, `version` in plugin.json | plugin.json `metadata.team / areas / stacks / tags / visibility` (strings or arrays); `keywords` add to tags. `tools` is always `["claude"]` |
| rule | `RULE.md` | frontmatter `name`, `description`, `metadata.version` | as a skill, plus top-level `globs` (list or comma string) and `alwaysApply` (bool) |

- A package keeps its kind forever: publishing a version of another kind is `409`.
- Plugins: the structural behaviors (`pluginBehaviors`) are added to the line scan: hooks, local MCP server processes, `bin/` executables and monitors are `ask`; remote MCP servers and LSP servers are `info`. `VersionMeta.plugin` lists the components.
- Rules: `VersionMeta.rule` is the `RuleSpec`. The registry stores RULE.md as written; the CLI renders it per tool at install (`renderCursorRule`, `renderClaudeRule`, `renderAgentsBlock`).

## API changes

- `GET /api/skills?kind=skill|plugin|rule` (repeatable); every summary carries `kind`; `facets.kinds` is added. Other values of `kind` are `400`.
- The skill routes (`/api/skills/:name/...`) serve every kind; "skill" in a path means "package".
- `RegistryMeta.marketplaceName`: the org name lowercased, every run of characters outside `[a-z0-9._-]` replaced by `-`, trimmed of `-`; if empty, reserved (see the Claude Code marketplace reference: names starting `claude-`, `anthropic`, `official`, `claudeai-`, and `npm pip uv cargo github gh`) or not starting with a letter or digit, it becomes `intra-skills`.
- MCP `search_skills` takes `kind`; `get_skill` and `install_command` answer per kind (plugin: the `claude plugin install` line; rule: the project install).
- Agent documents (`/agent.md`, `/llms.txt`, `/SKILL.md`) describe plugins and rules too.

## Claude Code plugin marketplace

Claude Code installs, versions and updates plugins itself from a marketplace (https://code.claude.com/docs/en/plugins/marketplace-reference). The registry serves one.

- `POST /api/tokens/marketplace` body `{name?:string}` -> `201 MarketplaceKeyResponse`. Creates a token with `scope = 'marketplace'` named `name` (default "Claude Code plugins"). Its plaintext is shown once.
  - A marketplace token is refused (`401`, message "this key only reads the plugin marketplace") on every route except the two below. It still appears in `GET /api/tokens` and is revoked like any other token.
  - `marketplaceUrl` = `<publicUrl>/marketplace.json?key=<token>`.
- `GET /marketplace.json` (outside /api) with `?key=<marketplace or full token>` or a Bearer header; no key: `401`.
  - Body: `{name: marketplaceName, owner: {name: <org name>}, description, plugins: [...]}` where each plugin the key's user can read, not deprecated, with a live latest version, is `{name, description, version, category: <team or "general">, tags, keywords, source: {source: "archive", url: "<publicUrl>/api/plugins/<name>/<version>.zip?key=<same key>", sha256}}`.
  - `Cache-Control: no-store`.
- `GET /api/plugins/:name/:version.zip?key=` (public path; the key authenticates) -> `application/zip`, the version's files with the plugin root at the top of the archive. Unreadable or unknown: `404`. Counts as an install event.
  - The archive is deterministic: entries sorted by path, every timestamp 1980-01-01 00:00, unix mode kept in the external attributes, DEFLATE at a fixed level, no extra fields. The same version always gives the same bytes, so `versions.archive_sha256` is computed once (at publish, or on first use) and stored.
- Claude Code refuses archive URLs that are not https or point at a loopback host, so plugins install only from a registry reached over https (for example through `tailscale serve` or a TLS proxy).

## Git sources

- `GitSource.pluginsRoot` (default `plugins`) and `rulesRoot` (default `rules`), editable like `root`.
- Sync discovers each kind under its own folder by its marker (`<root>/<name>/SKILL.md`, `<pluginsRoot>/<name>/.claude-plugin/plugin.json`, `<rulesRoot>/<name>/RULE.md`), any depth up to 3 for skills and rules and exactly `<pluginsRoot>/<name>/` for plugins. A folder whose marker does not match the root's kind is skipped with a reason.
- A proposal writes under the folder of its kind. `Proposal.packageKind` says which; `proposals.package_kind` stores it.
