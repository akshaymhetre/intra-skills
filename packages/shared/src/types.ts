// Wire types shared by the registry server, the CLI and the web console.
// This file is the API contract: docs/API.md describes the routes that carry these shapes.
// Browser-safe: no node imports here.

export type Visibility = "org" | "private";
export type Role = "admin" | "member";
export type TeamRole = "maintainer" | "member";
export type Permission = "read" | "write";
export type PrincipalType = "team" | "user";

/** Agent tools a skill can be installed into. Each maps to a skills directory. */
export type ToolId = "claude" | "codex" | "cursor";

export const TOOLS: readonly ToolId[] = ["claude", "codex", "cursor"] as const;

/**
 * Where each tool reads skills from.
 * global = under $HOME, project = under the project root.
 * codex reads `.agents/skills` (the Agent Skills shared location); Cursor ALSO reads
 * `.claude/skills` and `.agents/skills`, so installing to cursor as well shows duplicates there.
 */
export const TOOL_DIRS: Record<ToolId, { global: string; project: string; label: string }> = {
  claude: { global: ".claude/skills", project: ".claude/skills", label: "Claude Code" },
  codex: { global: ".agents/skills", project: ".agents/skills", label: "Codex" },
  cursor: { global: ".cursor/skills", project: ".cursor/skills", label: "Cursor" },
};

/** Suggested work areas. Areas are free strings; these are offered as defaults in the UI and CLI. */
export const SUGGESTED_AREAS = [
  "frontend",
  "backend",
  "infra",
  "data",
  "mobile",
  "security",
  "qa",
  "design",
  "docs",
  "product",
  "general",
] as const;

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export interface User {
  handle: string;
  displayName: string;
  role: Role;
  createdAt: string;
  teams: { slug: string; role: TeamRole }[];
  /** Usernames on git hosts. Needed to propose skills, so a proposer can never count as their own approver. */
  gitIdentities: GitIdentity[];
}

export interface GitIdentity {
  provider: GitProviderId;
  username: string;
}

/** The short form of a person shown beside a skill, a version or a proposal. */
export interface PersonRef {
  handle: string;
  displayName: string;
}

export interface Team {
  slug: string;
  name: string;
  description: string;
  memberCount: number;
  skillCount: number;
  createdAt: string;
}

export interface TeamDetail extends Team {
  members: { handle: string; displayName: string; role: TeamRole }[];
}

export interface ApiToken {
  id: string;
  name: string;
  /** First 12 characters of the token, safe to show. */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** full = everything the user can do; marketplace = reads the plugin marketplace only. */
  scope: "full" | "marketplace";
}

/** active = a version published within the registry's stale window (default 90 days); stale otherwise. */
export type Health = "active" | "stale";

export interface Trust {
  works: number;
  broken: number;
  /** The caller's own vote. */
  mine: "works" | "broken" | null;
}

export interface SkillSource {
  sourceId: string;
  provider: GitProviderId;
  /** owner/name (GitHub) or workspace/repo (Bitbucket Cloud). */
  repo: string;
  /** Folder of the skill inside the repo, e.g. skills/deploy-check. */
  path: string;
  /** Browser URL of that folder on the base branch. */
  webUrl: string;
}

/** A registry package is a skill (SKILL.md), a Claude Code plugin (.claude-plugin/plugin.json) or a rule (RULE.md). */
export type PackageKind = "skill" | "plugin" | "rule";

export interface McpServerInfo {
  name: string;
  /** stdio = a process on the user's machine; remote = an HTTP/SSE/WebSocket URL. */
  transport: "stdio" | "remote";
  /** The command for stdio, the URL for remote. */
  target: string;
}

/** What a plugin contains, read from its standard layout and plugin.json. */
export interface PluginComponents {
  skills: string[];
  commands: string[];
  agents: string[];
  /** Hook event names, e.g. PreToolUse. */
  hooks: string[];
  mcpServers: McpServerInfo[];
  lspServers: string[];
  /** Executables put on the Bash tool's PATH. */
  bin: string[];
  monitors: string[];
  outputStyles: string[];
}

/** When a rule applies. */
export interface RuleSpec {
  globs: string[];
  alwaysApply: boolean;
  /** always = every session; globs = when a matching file is in context; agent = the agent decides from the description. */
  mode: "always" | "globs" | "agent";
}

export interface SkillSummary {
  name: string;
  kind: PackageKind;
  description: string;
  /** Owning team slug, or null when no team owns it. */
  team: string | null;
  areas: string[];
  /** Tech stacks from metadata.stacks. */
  stacks: string[];
  tools: ToolId[];
  tags: string[];
  visibility: Visibility;
  latestVersion: string | null;
  /** Non-null when the skill is deprecated; carries the reason. */
  deprecated: string | null;
  downloads: number;
  /** Bundle downloads in the last 7 days. */
  installsWeek: number;
  /** Bundle downloads per day for the last 14 days, oldest first (always 14 numbers). */
  trend: number[];
  health: Health;
  /** True when an admin verified the latest version, or an earlier one with the same behaviors. */
  verified: boolean;
  trust: Trust;
  createdBy: string;
  /** Who published the latest version. */
  author: PersonRef;
  /** Non-null when the skill is managed from a git repo: its content is edited there, not here. */
  source: SkillSource | null;
  createdAt: string;
  updatedAt: string;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface SkillListResponse {
  skills: SkillSummary[];
  facets: {
    teams: FacetCount[];
    kinds: FacetCount[];
    areas: FacetCount[];
    stacks: FacetCount[];
    tools: FacetCount[];
    tags: FacetCount[];
    visibility: FacetCount[];
  };
  total: number;
}

export interface VersionMeta {
  version: string;
  sha256: string;
  size: number;
  fileCount: number;
  changelog: string;
  publishedBy: string;
  publishedAt: string;
  git: GitInfo | null;
  yanked: string | null;
  downloads: number;
  /** What the skill's files ask an agent to do, found by a fixed-pattern scan at publish. */
  behaviors: Behavior[];
  /** Rough context cost; null for versions published before v2. */
  tokens: TokenEstimate | null;
  /** Plugins only: what the version contains. */
  plugin: PluginComponents | null;
  /** Rules only: when the rule applies. */
  rule: RuleSpec | null;
}

export interface GitInfo {
  commit: string;
  repo: string | null;
  dirty: boolean;
  /** Browser URL of the commit, when the version came from a git source. */
  url?: string | null;
  /** The merged pull request this version came from. */
  pullRequest?: PullRequestRef | null;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/**
 * One thing a skill's files tell an agent to do that a reader should know about before installing.
 * tier "ask" = an agent should show it to the user and wait for approval; "info" = worth knowing.
 */
export interface Behavior {
  /** Stable id of the rule, e.g. "pipe-to-shell", "network", "delete-recursive". */
  id: string;
  tier: "info" | "ask";
  label: string;
  file: string;
  /** 1-based line, or null when the match is a file name. */
  line: number | null;
  /** The matched text, trimmed to 120 characters. */
  match: string;
}

export interface TokenEstimate {
  /** name + description: always in context once installed. */
  metadata: number;
  /** SKILL.md body: loaded when the skill is used. */
  body: number;
  /** Every other text file: loaded only on demand. */
  references: number;
}

export interface Grant {
  principalType: PrincipalType;
  /** Team slug or user handle. */
  principal: string;
  permission: Permission;
}

export interface SkillDetail extends SkillSummary {
  versions: VersionMeta[];
  /** Present only when the caller can write the skill. */
  grants: Grant[] | null;
  permissions: { canWrite: boolean; canAdmin: boolean };
  verification: { version: string; by: PersonRef; at: string } | null;
  /** Open proposals for this skill, newest first. */
  proposals: Proposal[];
}

export interface FileEntry {
  path: string;
  mode: number;
  size: number;
  sha256: string;
}

export interface VersionDetail extends VersionMeta {
  name: string;
  files: FileEntry[];
  skillMd: string;
}

export interface BundleFile {
  path: string;
  mode: number;
  contentBase64: string;
}

export interface Bundle {
  name: string;
  version: string;
  sha256: string;
  files: BundleFile[];
}

export interface PublishRequest {
  version: string;
  files: BundleFile[];
  changelog?: string;
  git?: GitInfo | null;
  /** Applied only on the first publish of a skill; later changes use PATCH. */
  visibility?: Visibility;
  /** Applied only on the first publish; overrides metadata.team. */
  team?: string | null;
}

export interface SkillPatch {
  visibility?: Visibility;
  team?: string | null;
  areas?: string[];
  stacks?: string[];
  tools?: ToolId[];
  tags?: string[];
  deprecated?: string | null;
}

export type DiffStatus = "added" | "removed" | "modified" | "unchanged";

export interface DiffFile {
  path: string;
  status: DiffStatus;
  /** Unified diff text for text files that changed; null for unchanged or binary. */
  patch: string | null;
  binary: boolean;
}

export interface DiffResponse {
  from: string;
  to: string;
  files: DiffFile[];
}

export interface AuditEntry {
  id: number;
  at: string;
  actor: string | null;
  action: string;
  target: string;
  detail: Record<string, unknown>;
}

export interface CreateUserResponse {
  user: User;
  /** Shown once. */
  token: string;
}

export interface CreateTokenResponse {
  token: string;
  meta: ApiToken;
}

// ---------------------------------------------------------------------------------------------
// v2: registry metadata, setup, device login, votes, collections, home, suggest, git sources.
// ---------------------------------------------------------------------------------------------

/** "direct" = POST /versions publishes; "pull-request" = every new version arrives through a merged PR. */
export type PublishMode = "direct" | "pull-request";

/** GET /api/meta, unauthenticated: what a CLI or the console needs before signing in. */
export interface RegistryMeta {
  name: string;
  /** The URL people and agents use to reach this registry, e.g. https://skills.acme.internal. */
  publicUrl: string;
  version: string;
  /** True until the first admin exists. */
  needsSetup: boolean;
  publishMode: PublishMode;
  mcpUrl: string;
  /** Name of the Claude Code plugin marketplace this registry serves (`<plugin>@<marketplaceName>`). */
  marketplaceName: string;
}

/** POST /api/tokens/marketplace: a read-only key for Claude Code's plugin marketplace. */
export interface MarketplaceKeyResponse {
  /** Shown once. Works only on the marketplace and plugin-archive routes. */
  token: string;
  meta: ApiToken;
  /** Pass to `claude plugin marketplace add`. Carries the key. */
  marketplaceUrl: string;
  marketplaceName: string;
}

/** Org-level settings an admin edits in the console. Env vars override them at boot. */
export interface OrgSettings {
  name: string;
  publicUrl: string;
  /** Days without a new version before a skill is "stale". */
  staleDays: number;
  /** Seconds between polls of each git source. */
  pollSeconds: number;
}

export interface SetupRequest {
  /** Printed by the server on first boot and written to <data>/setup-token. */
  setupToken: string;
  handle: string;
  displayName: string;
  orgName?: string;
}

export interface DeviceStart {
  deviceCode: string;
  /** Short code a person types or confirms in the console, e.g. "WDJB-MJHT". */
  userCode: string;
  /** Console page that approves the code. */
  verificationUri: string;
  verificationUriComplete: string;
  /** Seconds the CLI waits between polls. */
  interval: number;
  expiresIn: number;
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "approved"; token: string; user: User }
  | { status: "denied" }
  | { status: "expired" };

export interface DeviceRequestInfo {
  userCode: string;
  clientName: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
}

export interface Vote {
  user: PersonRef;
  works: boolean;
  note: string;
  version: string | null;
  at: string;
}

export interface VoteRequest {
  works: boolean;
  /** Optional one-line reason, at most 280 characters. */
  note?: string;
}

/** A named, ordered set of skills owned by a team, installed in one line as @team/slug. */
export interface Collection {
  team: string;
  slug: string;
  title: string;
  description: string;
  /** Skill names in install order; skills the caller cannot read are omitted. */
  skills: string[];
  createdBy: string;
  updatedAt: string;
}

export interface CollectionInput {
  title: string;
  description?: string;
  skills: string[];
}

export interface HomeResponse {
  /** The caller's teams. */
  teams: { slug: string; name: string }[];
  /** Skills owned by or granted to the caller's teams, recently updated first (max 8). */
  teamSkills: SkillSummary[];
  /** Ranked by installs in the last 7 days, then by total (max 8). */
  trending: SkillSummary[];
  /** Newest first by latest publish (max 8). */
  recent: SkillSummary[];
  stacks: FacetCount[];
  collections: Collection[];
  proposals: { open: number; mine: Proposal[] };
  /** Admins only: how many skills wait for verification; 0 for others. */
  reviewQueue: number;
  /** `skills` counts every readable package; `kinds` splits it by kind. */
  totals: { skills: number; teams: number; installsWeek: number; kinds: Record<PackageKind, number> };
}

/** What `intra suggest` sends: file names and dependency names only, never file contents. */
export interface RepoSignals {
  /** Repo-relative paths, at most 5000. */
  files: string[];
  /** Dependency names from package.json, pyproject, go.mod, Gemfile and similar, at most 2000. */
  packages: string[];
}

export interface SuggestResponse {
  stacks: string[];
  skills: { skill: SkillSummary; score: number; reasons: string[] }[];
}

// ---------- git sources and proposals ----------

export type GitProviderId = "github" | "bitbucket-cloud";

export const GIT_PROVIDERS: readonly GitProviderId[] = ["github", "bitbucket-cloud"] as const;

export interface SyncStatus {
  at: string;
  ok: boolean;
  message: string;
  /** name@version for each version created by this sync. */
  ingested: string[];
  skipped: { path: string; reason: string }[];
  headCommit: string | null;
}

export interface GitSource {
  id: string;
  provider: GitProviderId;
  repo: string;
  baseBranch: string;
  /** Folder that holds the skills, e.g. "skills". Each skill lives at <root>/<name>/SKILL.md. */
  root: string;
  /** Folder for plugins: <pluginsRoot>/<name>/.claude-plugin/plugin.json. */
  pluginsRoot: string;
  /** Folder for rules: <rulesRoot>/<name>/RULE.md. */
  rulesRoot: string;
  /** API base for GitHub Enterprise Server; null = the public host. */
  apiUrl: string | null;
  /** Approvals a merged pull request needs, not counting its proposer or the registry's own account. */
  minApprovals: number;
  enabled: boolean;
  /** Where new skills are proposed when more than one source exists. */
  isDefault: boolean;
  credential: { kind: "token" | "basic" | "github-app"; set: boolean; hint: string };
  webhook: { url: string; secretSet: boolean };
  lastSync: SyncStatus | null;
  createdAt: string;
  updatedAt: string;
}

export type GitCredentialInput =
  /** GitHub PAT or Bitbucket Cloud repository/workspace access token (Bearer). */
  | { kind: "token"; token: string }
  /** Bitbucket Cloud API token or app password with its username or email (Basic). */
  | { kind: "basic"; username: string; password: string }
  | { kind: "github-app"; appId: string; installationId: string; privateKey: string };

export interface GitSourceInput {
  provider?: GitProviderId;
  repo?: string;
  baseBranch?: string;
  root?: string;
  pluginsRoot?: string;
  rulesRoot?: string;
  apiUrl?: string | null;
  minApprovals?: number;
  enabled?: boolean;
  isDefault?: boolean;
  credential?: GitCredentialInput;
  /** Shared secret for the webhook signature; empty string clears it. */
  webhookSecret?: string;
}

export interface SourceCheck {
  name: string;
  ok: boolean;
  message: string;
}

export type ProposalStatus = "open" | "merged" | "published" | "closed" | "failed";

export interface Proposal {
  id: string;
  skill: string;
  packageKind: PackageKind;
  version: string;
  kind: "new" | "update";
  proposer: PersonRef;
  sourceId: string;
  branch: string;
  pullRequest: PullRequestRef | null;
  status: ProposalStatus;
  /** Plain-words reason for the current status, e.g. "Waiting for 1 approval from someone other than you". */
  statusMessage: string;
  changelog: string;
  behaviors: Behavior[];
  createdAt: string;
  updatedAt: string;
}

export interface ProposalRequest extends PublishRequest {
  /** Source to propose into; default = the default source, or the skill's own source. */
  source?: string;
}
