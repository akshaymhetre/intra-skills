// Typed client for the registry API (docs/API.md). Every shape comes from @intra-skills/shared/types.
// Development runs against a real registry seeded by scripts/dev/up.sh, never a mock, so the console
// and the server cannot drift apart.
import type {
  ApiToken,
  AuditEntry,
  Collection,
  CollectionInput,
  DeviceRequestInfo,
  GitIdentity,
  GitSource,
  GitSourceInput,
  HomeResponse,
  MarketplaceKeyResponse,
  OrgSettings,
  Proposal,
  ProposalStatus,
  RegistryMeta,
  SkillSummary,
  SourceCheck,
  SyncStatus,
  Trust,
  Vote,
  VoteRequest,
  CreateTokenResponse,
  CreateUserResponse,
  DiffResponse,
  Grant,
  Role,
  SkillDetail,
  SkillListResponse,
  SkillPatch,
  Team,
  TeamDetail,
  TeamRole,
  User,
  VersionDetail,
  VersionMeta,
} from "@intra-skills/shared/types";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
  get isUnauthenticated() {
    return this.status === 401 || this.code === "unauthenticated";
  }
  get isNotFound() {
    return this.status === 404 || this.code === "not_found";
  }
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Low-level transport result. */
export interface RawResponse {
  status: number;
  /** Parsed JSON, raw text (for file reads), or null for 204. */
  body: unknown;
}

async function transport(method: Method, url: string, body: unknown, expectText: boolean): Promise<RawResponse> {
  const headers: Record<string, string> = { Accept: expectText ? "text/plain, */*" : "application/json" };
  if (method !== "GET") headers["X-Requested-With"] = "intra-skills";
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Could not reach the registry server. Check that it is running and try again.");
  }
  if (res.status === 204) return { status: 204, body: null };
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  return { status: res.status, body: await res.text() };
}

async function request<T>(method: Method, path: string, body?: unknown, opts: { text?: boolean } = {}): Promise<T> {
  const res = await transport(method, `/api${path}`, body, !!opts.text);
  if (res.status >= 200 && res.status < 300) return res.body as T;
  const err = (res.body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
  throw new ApiError(
    res.status,
    err?.code ?? `http_${res.status}`,
    err?.message ?? `The server answered ${res.status} without an error message.`,
    err?.details,
  );
}

const enc = encodeURIComponent;

export interface SkillQuery {
  q?: string;
  /** Package kinds (skill, plugin, rule); repeatable. */
  kind?: string[];
  team?: string[];
  area?: string[];
  stack?: string[];
  tool?: string[];
  tag?: string[];
  visibility?: string[];
  health?: "active" | "stale";
  verified?: boolean;
  sort?: "updated" | "name" | "downloads" | "trending";
  deprecated?: "include" | "exclude";
}

export function skillQueryString(q: SkillQuery): string {
  const p = new URLSearchParams();
  if (q.q) p.set("q", q.q);
  for (const k of ["kind", "team", "area", "stack", "tool", "tag", "visibility"] as const) for (const v of q[k] ?? []) p.append(k, v);
  if (q.health) p.set("health", q.health);
  if (q.verified) p.set("verified", "1");
  if (q.sort) p.set("sort", q.sort);
  if (q.deprecated) p.set("deprecated", q.deprecated);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export const api = {
  health: () => request<{ ok: true; version: string }>("GET", "/health"),
  me: () => request<User>("GET", "/me"),
  login: (token: string) => request<User>("POST", "/auth/login", { token }),
  logout: () => request<null>("POST", "/auth/logout"),

  listSkills: (q: SkillQuery) => request<SkillListResponse>("GET", `/skills${skillQueryString(q)}`),
  getSkill: (name: string) => request<SkillDetail>("GET", `/skills/${enc(name)}`),
  patchSkill: (name: string, patch: SkillPatch) => request<SkillDetail>("PATCH", `/skills/${enc(name)}`, patch),
  deleteSkill: (name: string) => request<null>("DELETE", `/skills/${enc(name)}`),

  getVersion: (name: string, version: string) =>
    request<VersionDetail>("GET", `/skills/${enc(name)}/versions/${enc(version)}`),
  getFile: (name: string, version: string, path: string) =>
    request<string>(
      "GET",
      `/skills/${enc(name)}/versions/${enc(version)}/files/${path.split("/").map(enc).join("/")}`,
      undefined,
      { text: true },
    ),
  yank: (name: string, version: string, reason: string) =>
    request<VersionMeta>("POST", `/skills/${enc(name)}/versions/${enc(version)}/yank`, { reason }),
  unyank: (name: string, version: string) =>
    request<VersionMeta>("DELETE", `/skills/${enc(name)}/versions/${enc(version)}/yank`),
  diff: (name: string, from: string, to: string) =>
    request<DiffResponse>("GET", `/skills/${enc(name)}/diff?from=${enc(from)}&to=${enc(to)}`),

  getGrants: (name: string) => request<Grant[]>("GET", `/skills/${enc(name)}/grants`),
  setGrants: (name: string, grants: Grant[]) => request<Grant[]>("PUT", `/skills/${enc(name)}/grants`, grants),

  listTeams: () => request<Team[]>("GET", "/teams"),
  getTeam: (slug: string) => request<TeamDetail>("GET", `/teams/${enc(slug)}`),
  createTeam: (t: { slug: string; name: string; description?: string }) => request<TeamDetail>("POST", "/teams", t),
  patchTeam: (slug: string, patch: { name?: string; description?: string }) =>
    request<TeamDetail>("PATCH", `/teams/${enc(slug)}`, patch),
  setTeamMember: (slug: string, handle: string, role: TeamRole) =>
    request<TeamDetail>("PUT", `/teams/${enc(slug)}/members/${enc(handle)}`, { role }),
  removeTeamMember: (slug: string, handle: string) =>
    request<TeamDetail>("DELETE", `/teams/${enc(slug)}/members/${enc(handle)}`),

  listUsers: () => request<User[]>("GET", "/users"),
  createUser: (u: { handle: string; displayName: string; role?: Role }) =>
    request<CreateUserResponse>("POST", "/users", u),
  updateUser: (handle: string, patch: { role?: Role; displayName?: string }) =>
    request<User>("PATCH", `/users/${enc(handle)}`, patch),

  listTokens: () => request<ApiToken[]>("GET", "/tokens"),
  createToken: (name: string) => request<CreateTokenResponse>("POST", "/tokens", { name }),
  /** A read-only key for Claude Code's plugin marketplace; its plaintext is shown once. */
  createMarketplaceKey: (name?: string) => request<MarketplaceKeyResponse>("POST", "/tokens/marketplace", name ? { name } : {}),
  revokeToken: (id: string) => request<null>("DELETE", `/tokens/${enc(id)}`),

  audit: (q: { limit?: number; before?: number; target?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.limit) p.set("limit", String(q.limit));
    if (q.before !== undefined) p.set("before", String(q.before));
    if (q.target) p.set("target", q.target);
    const s = p.toString();
    return request<AuditEntry[]>("GET", `/audit${s ? `?${s}` : ""}`);
  },

  // ---------- v2 ----------
  meta: () => request<RegistryMeta>("GET", "/meta"),
  setupStatus: () => request<{ needsSetup: boolean }>("GET", "/setup"),
  setup: (b: { setupToken: string; handle: string; displayName: string; orgName?: string }) =>
    request<{ user: User; token: string }>("POST", "/setup", b),
  getSettings: () => request<{ settings: OrgSettings; pinned: (keyof OrgSettings)[] }>("GET", "/settings"),
  patchSettings: (patch: Partial<OrgSettings>) =>
    request<{ settings: OrgSettings; pinned: (keyof OrgSettings)[] }>("PATCH", "/settings", patch),
  setMyGitIdentities: (ids: GitIdentity[]) => request<User>("PUT", "/me/git-identities", ids),
  setUserGitIdentities: (handle: string, ids: GitIdentity[]) =>
    request<User>("PUT", `/users/${enc(handle)}/git-identities`, ids),

  deviceInfo: (userCode: string) => request<DeviceRequestInfo>("GET", `/auth/device/${enc(userCode)}`),
  approveDevice: (userCode: string) => request<DeviceRequestInfo>("POST", `/auth/device/${enc(userCode)}/approve`),
  denyDevice: (userCode: string) => request<DeviceRequestInfo>("POST", `/auth/device/${enc(userCode)}/deny`),

  home: () => request<HomeResponse>("GET", "/home"),

  vote: (name: string, v: VoteRequest) => request<Trust>("PUT", `/skills/${enc(name)}/vote`, v),
  unvote: (name: string) => request<Trust>("DELETE", `/skills/${enc(name)}/vote`),
  votes: (name: string) => request<Vote[]>("GET", `/skills/${enc(name)}/votes`),
  verify: (name: string, version?: string) =>
    request<SkillDetail>("POST", `/skills/${enc(name)}/verify`, version ? { version } : {}),
  unverify: (name: string) => request<SkillDetail>("DELETE", `/skills/${enc(name)}/verify`),
  reviewQueue: () => request<SkillSummary[]>("GET", "/review"),

  listCollections: (team?: string) =>
    request<Collection[]>("GET", `/collections${team ? `?team=${enc(team)}` : ""}`),
  getCollection: (team: string, slug: string) => request<Collection>("GET", `/collections/${enc(team)}/${enc(slug)}`),
  putCollection: (team: string, slug: string, c: CollectionInput) =>
    request<Collection>("PUT", `/collections/${enc(team)}/${enc(slug)}`, c),
  deleteCollection: (team: string, slug: string) => request<null>("DELETE", `/collections/${enc(team)}/${enc(slug)}`),

  listSources: () => request<GitSource[]>("GET", "/sources"),
  getSource: (id: string) => request<GitSource>("GET", `/sources/${enc(id)}`),
  createSource: (s: GitSourceInput) => request<GitSource>("POST", "/sources", s),
  patchSource: (id: string, s: GitSourceInput) => request<GitSource>("PATCH", `/sources/${enc(id)}`, s),
  deleteSource: (id: string) => request<null>("DELETE", `/sources/${enc(id)}`),
  testSource: (id: string) => request<{ ok: boolean; checks: SourceCheck[] }>("POST", `/sources/${enc(id)}/test`),
  syncSource: (id: string) => request<SyncStatus>("POST", `/sources/${enc(id)}/sync`),

  listProposals: (q: { status?: ProposalStatus; mine?: boolean; skill?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set("status", q.status);
    if (q.mine) p.set("mine", "1");
    if (q.skill) p.set("skill", q.skill);
    const s = p.toString();
    return request<Proposal[]>("GET", `/proposals${s ? `?${s}` : ""}`);
  },
  getProposal: (id: string) => request<Proposal>("GET", `/proposals/${enc(id)}`),
  refreshProposal: (id: string) => request<Proposal>("POST", `/proposals/${enc(id)}/refresh`),
};
