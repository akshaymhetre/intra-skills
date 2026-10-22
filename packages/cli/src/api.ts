// Typed client for the registry (docs/API.md). Bearer auth; error JSON becomes an ApiError.
import type {
  ApiToken,
  Bundle,
  Collection,
  DevicePoll,
  DeviceStart,
  GitIdentity,
  Proposal,
  ProposalRequest,
  RegistryMeta,
  RepoSignals,
  SuggestResponse,
  Trust,
  VoteRequest,
  CreateTokenResponse,
  CreateUserResponse,
  DiffResponse,
  Grant,
  MarketplaceKeyResponse,
  PublishRequest,
  SkillDetail,
  SkillListResponse,
  SkillPatch,
  Team,
  TeamDetail,
  TeamRole,
  User,
  VersionDetail,
  VersionMeta,
} from "@intra-skills/shared";
import { loadConfig } from "./config.js";
import { ApiError, CliError } from "./errors.js";

const e = encodeURIComponent;

export class Api {
  constructor(
    public registry: string,
    private token: string | null,
  ) {}

  async request<T>(method: string, path: string, body?: unknown, query?: Record<string, string | string[] | undefined>): Promise<T> {
    let url = `${this.registry}/api${path}`;
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined) continue;
        for (const item of Array.isArray(v) ? v : [v]) qs.append(k, item);
      }
      const s = qs.toString();
      if (s) url += `?${s}`;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ApiError("offline", `cannot reach registry ${this.registry} (${cause?.code ?? cause?.message ?? (err as Error).message})`, 0);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const errObj = (data as { error?: { code?: string; message?: string; details?: unknown } } | undefined)?.error;
      throw new ApiError(
        errObj?.code ?? `http_${res.status}`,
        errObj?.message || `${method} ${path} failed with HTTP ${res.status}`,
        res.status,
        errObj?.details,
      );
    }
    if (data === undefined) throw new ApiError("bad_response", `${method} ${path}: registry returned a non-JSON body`, res.status);
    return data as T;
  }

  health = () => this.request<{ ok: boolean; version: string }>("GET", "/health");
  me = () => this.request<User>("GET", "/me");
  listSkills = (q: Record<string, string | string[] | undefined>) => this.request<SkillListResponse>("GET", "/skills", undefined, q);
  skill = (name: string) => this.request<SkillDetail>("GET", `/skills/${e(name)}`);
  patchSkill = (name: string, patch: SkillPatch) => this.request<SkillDetail>("PATCH", `/skills/${e(name)}`, patch);
  publish = (name: string, req: PublishRequest) => this.request<VersionMeta>("POST", `/skills/${e(name)}/versions`, req);
  version = (name: string, version: string) => this.request<VersionDetail>("GET", `/skills/${e(name)}/versions/${e(version)}`);
  bundle = (name: string, version: string) => this.request<Bundle>("GET", `/skills/${e(name)}/versions/${e(version)}/bundle`);
  resolve = async (name: string, range: string) =>
    (await this.request<{ version: string }>("GET", `/skills/${e(name)}/resolve`, undefined, { range })).version;
  yank = (name: string, version: string, reason: string) =>
    this.request<VersionMeta>("POST", `/skills/${e(name)}/versions/${e(version)}/yank`, { reason });
  unyank = (name: string, version: string) => this.request<VersionMeta>("DELETE", `/skills/${e(name)}/versions/${e(version)}/yank`);
  diff = (name: string, from: string, to: string) => this.request<DiffResponse>("GET", `/skills/${e(name)}/diff`, undefined, { from, to });
  grants = (name: string) => this.request<Grant[]>("GET", `/skills/${e(name)}/grants`);
  setGrants = (name: string, grants: Grant[]) => this.request<Grant[]>("PUT", `/skills/${e(name)}/grants`, grants);
  teams = () => this.request<Team[]>("GET", "/teams");
  team = (slug: string) => this.request<TeamDetail>("GET", `/teams/${e(slug)}`);
  createTeam = (body: { slug: string; name: string; description?: string }) => this.request<TeamDetail>("POST", "/teams", body);
  setMember = (slug: string, handle: string, role: TeamRole) =>
    this.request<TeamDetail>("PUT", `/teams/${e(slug)}/members/${e(handle)}`, { role });
  removeMember = (slug: string, handle: string) => this.request<TeamDetail>("DELETE", `/teams/${e(slug)}/members/${e(handle)}`);
  createUser = (body: { handle: string; displayName: string; role?: string }) => this.request<CreateUserResponse>("POST", "/users", body);
  tokens = () => this.request<ApiToken[]>("GET", "/tokens");
  createToken = (name: string) => this.request<CreateTokenResponse>("POST", "/tokens", { name });
  revokeToken = (id: string) => this.request<void>("DELETE", `/tokens/${e(id)}`);

  // v2
  meta = () => this.request<RegistryMeta>("GET", "/meta");
  deviceStart = (clientName: string) => this.request<DeviceStart>("POST", "/auth/device", { clientName });
  devicePoll = (deviceCode: string) => this.request<DevicePoll>("POST", "/auth/device/token", { deviceCode });
  setGitIdentities = (ids: GitIdentity[]) => this.request<User>("PUT", "/me/git-identities", ids);
  suggest = (signals: RepoSignals) => this.request<SuggestResponse>("POST", "/suggest", signals);
  collection = (team: string, slug: string) => this.request<Collection>("GET", `/collections/${e(team)}/${e(slug)}`);
  propose = (name: string, req: ProposalRequest) => this.request<Proposal>("POST", `/skills/${e(name)}/proposals`, req);
  proposals = (q: Record<string, string | undefined>) => this.request<Proposal[]>("GET", "/proposals", undefined, q);
  refreshProposal = (id: string) => this.request<Proposal>("POST", `/proposals/${e(id)}/refresh`);
  vote = (name: string, body: VoteRequest) => this.request<Trust>("PUT", `/skills/${e(name)}/vote`, body);

  // v3
  marketplaceKey = (name?: string) => this.request<MarketplaceKeyResponse>("POST", "/tokens/marketplace", name ? { name } : {});

  /** A file served outside /api (e.g. /SKILL.md) or a raw version file, as text. */
  async text(path: string): Promise<string> {
    const url = `${this.registry}${path.startsWith("/") ? path : `/${path}`}`;
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let res: Response;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new ApiError("offline", `cannot reach registry ${this.registry} (${cause?.code ?? cause?.message ?? (err as Error).message})`, 0);
    }
    const body = await res.text();
    if (!res.ok) {
      let message = `GET ${path} failed with HTTP ${res.status}`;
      let code = `http_${res.status}`;
      try {
        const err = (JSON.parse(body) as { error?: { code?: string; message?: string } }).error;
        if (err?.message) message = err.message;
        if (err?.code) code = err.code;
      } catch {
        /* plain text body */
      }
      throw new ApiError(code, message, res.status);
    }
    return body;
  }

  versionFile = (name: string, version: string, path: string) =>
    this.text(`/api/skills/${e(name)}/versions/${e(version)}/files/${path.split("/").map(e).join("/")}`);
}

/** Client from config; refuses with the fix when the CLI is not logged in. */
export function apiFromConfig(opts: { requireToken?: boolean } = {}): Api {
  const cfg = loadConfig();
  if (!cfg.registry) throw new CliError("no registry configured; run `intra setup --registry <url>`", "not_configured");
  if (opts.requireToken !== false && !cfg.token)
    throw new CliError("not logged in; run `intra login` (or `intra setup --registry <url>` on a new machine)", "not_configured");
  return new Api(cfg.registry, cfg.token);
}
