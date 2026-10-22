// A tiny in-process registry implementing the routes the CLI uses, faithful to docs/API.md
// (v1 contract, the v2 additions, and v3 package kinds + the plugin marketplace key).
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  bundleSha256,
  compareVersions,
  detectStacks,
  estimateTokens,
  maxSatisfying,
  normalizeMode,
  parsePackage,
  pluginBehaviors,
  scanBehaviors,
  KIND_MARKER,
  sha256Hex,
  validateBundleFiles,
  type BundleFile,
  type Collection,
  type DeviceStart,
  type FileEntry,
  type GitIdentity,
  type Grant,
  type MarketplaceKeyResponse,
  type PackageKind,
  type Proposal,
  type ProposalRequest,
  type PublishMode,
  type PublishRequest,
  type RepoSignals,
  type SkillDetail,
  type SkillSummary,
  type Trust,
  type User,
  type VersionDetail,
  type VersionMeta,
  type VoteRequest,
} from "@intra-skills/shared";

interface FakeVersion {
  meta: VersionMeta;
  files: BundleFile[];
}

interface FakeSkill {
  name: string;
  kind: PackageKind;
  description: string;
  team: string | null;
  visibility: "org" | "private";
  deprecated: string | null;
  stacks: string[];
  versions: Map<string, FakeVersion>;
  grants: Grant[];
  trust: Trust;
}

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export const TOKEN = `isk_${"A1b2C3d4".repeat(4)}`;

/** The bootstrap skill served at GET /SKILL.md. */
export const BOOTSTRAP_MD = `---
name: intra-registry
description: Find, inspect and install agent skills from this organization's intra-skills registry. Use when the user asks for a skill.
---
# intra-registry

Search with \`intra search <words>\`, inspect with \`intra info <name>\`, try with \`intra run <name>\`.
`;

export class FakeRegistry {
  skills = new Map<string, FakeSkill>();
  collections = new Map<string, Collection>();
  proposals: Proposal[] = [];
  requests: Recorded[] = [];
  /** Marketplace keys minted by POST /api/tokens/marketplace, by token id; deleted ones are removed. */
  marketplaceKeys = new Map<string, string>();
  marketplaceName = "acme-skills";
  /** "name@version" whose bundle is served with a WRONG sha256. */
  tamper = new Set<string>();
  publishMode: PublishMode = "direct";
  user: User = { handle: "ada", displayName: "Ada", role: "admin", createdAt: "2026-01-01T00:00:00Z", teams: [], gitIdentities: [] };
  /** Device login script: how many polls answer pending, then the outcome. */
  device: { pendingPolls: number; outcome: "approved" | "denied" | "expired"; interval: number } = { pendingPolls: 1, outcome: "approved", interval: 3 };
  private pending = new Map<string, { polls: number; done: boolean }>();
  private server: Server | null = null;
  url = "";

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((err: unknown) => this.send(res, 500, { error: { code: "internal", message: String(err) } }));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  reset(): void {
    this.skills.clear();
    this.collections.clear();
    this.proposals = [];
    this.requests = [];
    this.tamper.clear();
    this.pending.clear();
    this.marketplaceKeys.clear();
    this.publishMode = "direct";
    this.user = { ...this.user, gitIdentities: [] };
    this.device = { pendingPolls: 1, outcome: "approved", interval: 3 };
  }

  /** Publish directly (bypassing HTTP) to seed fixtures. */
  seed(name: string, version: string, extra: Record<string, string> = {}, opts: { body?: string } = {}): void {
    const skillMd = `---\nname: ${name}\ndescription: Seeded fixture skill ${name} used by the CLI tests to exercise install paths.\nmetadata:\n  version: "${version}"\n---\n${opts.body ?? `# ${name} ${version}\n`}`;
    const files: BundleFile[] = [
      { path: "SKILL.md", mode: 0o644, contentBase64: Buffer.from(skillMd).toString("base64") },
      ...Object.entries(extra).map(([path, text]) => ({
        path,
        mode: path.endsWith(".sh") ? 0o755 : 0o644,
        contentBase64: Buffer.from(text).toString("base64"),
      })),
    ];
    const r = this.doPublish(name, { version, files });
    if (r.status !== 201) throw new Error(`seed failed: ${JSON.stringify(r.body)}`);
  }

  /** Seed a Claude Code plugin with one command (plus `extra` files). */
  seedPlugin(name: string, version: string, extra: Record<string, string> = {}): void {
    const manifest = { name, version, description: `Seeded fixture plugin ${name} for the CLI tests.`, metadata: { team: "platform" } };
    const files: BundleFile[] = [
      { path: ".claude-plugin/plugin.json", mode: 0o644, contentBase64: Buffer.from(JSON.stringify(manifest, null, 2) + "\n").toString("base64") },
      { path: `commands/${name}.md`, mode: 0o644, contentBase64: Buffer.from(`Run ${name}.\n`).toString("base64") },
      ...Object.entries(extra).map(([path, text]) => ({ path, mode: 0o644, contentBase64: Buffer.from(text).toString("base64") })),
    ];
    const r = this.doPublish(name, { version, files });
    if (r.status !== 201) throw new Error(`seed failed: ${JSON.stringify(r.body)}`);
  }

  /** The RULE.md text seedRule publishes, so tests can render the expected outputs themselves. */
  static ruleMd(name: string, version: string, opts: { globs?: string[]; alwaysApply?: boolean; body?: string } = {}): string {
    const fm = [`name: ${name}`, `description: Seeded fixture rule ${name} for the CLI tests.`];
    if (opts.globs?.length) fm.push("globs:", ...opts.globs.map((g) => `  - "${g}"`));
    fm.push(`alwaysApply: ${opts.alwaysApply === true}`, "metadata:", `  version: "${version}"`);
    return `---\n${fm.join("\n")}\n---\n${opts.body ?? `Always do ${name} things (${version}).\n`}`;
  }

  seedRule(name: string, version: string, opts: { globs?: string[]; alwaysApply?: boolean; body?: string } = {}): void {
    const files: BundleFile[] = [{ path: "RULE.md", mode: 0o644, contentBase64: Buffer.from(FakeRegistry.ruleMd(name, version, opts)).toString("base64") }];
    const r = this.doPublish(name, { version, files });
    if (r.status !== 201) throw new Error(`seed failed: ${JSON.stringify(r.body)}`);
  }

  private send(res: ServerResponse, status: number, body?: unknown, contentType = "application/json"): void {
    res.writeHead(status, { "content-type": contentType });
    if (body === undefined) res.end();
    else res.end(typeof body === "string" && contentType !== "application/json" ? body : JSON.stringify(body));
  }

  private err(status: number, code: string, message: string, details?: unknown) {
    return { status, body: { error: { code, message, ...(details !== undefined ? { details } : {}) } } };
  }

  private summary(s: FakeSkill): SkillSummary {
    const live = [...s.versions.values()].filter((v) => !v.meta.yanked).map((v) => v.meta.version);
    const latest = maxSatisfying(live, "latest");
    return {
      name: s.name,
      kind: s.kind,
      description: s.description,
      team: s.team,
      areas: [],
      stacks: s.stacks,
      tools: s.kind === "plugin" ? ["claude"] : ["claude", "codex", "cursor"],
      tags: [],
      visibility: s.visibility,
      latestVersion: latest,
      deprecated: s.deprecated,
      downloads: 0,
      installsWeek: 2,
      trend: Array(14).fill(0) as number[],
      health: "active",
      verified: false,
      trust: s.trust,
      createdBy: "ada",
      author: { handle: "ada", displayName: "Ada" },
      source: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }

  private detail(s: FakeSkill): SkillDetail {
    const versions = [...s.versions.values()].map((v) => v.meta).sort((a, b) => compareVersions(b.version, a.version));
    return {
      ...this.summary(s),
      versions,
      grants: s.grants,
      permissions: { canWrite: true, canAdmin: true },
      verification: null,
      proposals: this.proposals.filter((p) => p.skill === s.name && p.status !== "published" && p.status !== "closed"),
    };
  }

  private decode(req: PublishRequest) {
    return req.files.map((f) => ({ ...f, data: Buffer.from(f.contentBase64, "base64") }));
  }

  private parse(name: string, req: PublishRequest) {
    return parsePackage(this.decode(req).map((f) => ({ path: f.path, text: f.data.includes(0) ? null : f.data.toString("utf8") })), name);
  }

  private check(name: string, req: PublishRequest): { status: number; body: unknown } | null {
    const decoded = this.decode(req);
    const issues = validateBundleFiles(decoded.map((f) => ({ path: f.path, size: f.data.length }))).filter((i) => i.level === "error");
    if (issues.length) return this.err(422, "invalid_skill", "invalid bundle", issues);
    const parsed = this.parse(name, req);
    if (!parsed.pkg) return this.err(422, "invalid_skill", "invalid package", parsed.issues);
    if (parsed.pkg.skill.version && parsed.pkg.skill.version !== req.version)
      return this.err(422, "invalid_skill", `version ${parsed.pkg.skill.version} != ${req.version}`);
    const existing = this.skills.get(name);
    if (existing && existing.kind !== parsed.pkg.kind) return this.err(409, "conflict", `${name} is a ${existing.kind}; a package keeps its kind`);
    for (const v of existing?.versions.keys() ?? [])
      if (compareVersions(req.version, v) <= 0) return this.err(409, "conflict", `version ${req.version} must be greater than ${v}`);
    return null;
  }

  doPublish(name: string, req: PublishRequest): { status: number; body: unknown } {
    const bad = this.check(name, req);
    if (bad) return bad;
    const decoded = this.decode(req);
    const pkg = this.parse(name, req).pkg!;
    const parsed = pkg.skill;
    const skill =
      this.skills.get(name) ??
      ({
        name,
        kind: pkg.kind,
        description: "",
        team: req.team ?? parsed.team,
        visibility: req.visibility ?? parsed.visibility ?? "org",
        deprecated: null,
        stacks: parsed.stacks,
        versions: new Map(),
        grants: [],
        trust: { works: 0, broken: 0, mine: null },
      } as FakeSkill);
    skill.description = parsed.description;
    const entries = decoded.map((f) => ({ path: f.path, mode: normalizeMode(f.mode), sha256: sha256Hex(f.data) }));
    const scanFiles = decoded.map((f) => ({ path: f.path, mode: normalizeMode(f.mode), text: f.data.includes(0) ? null : f.data.toString("utf8") }));
    const meta: VersionMeta = {
      version: req.version,
      sha256: bundleSha256(entries),
      size: decoded.reduce((n, f) => n + f.data.length, 0),
      fileCount: decoded.length,
      changelog: req.changelog ?? "",
      publishedBy: this.user.handle,
      publishedAt: new Date().toISOString(),
      git: req.git ?? null,
      yanked: null,
      downloads: 0,
      behaviors: [...scanBehaviors(scanFiles), ...(pkg.plugin ? pluginBehaviors(pkg.plugin.components) : [])],
      tokens: estimateTokens(scanFiles, name, parsed.description),
      plugin: pkg.plugin?.components ?? null,
      rule: pkg.rule,
    };
    skill.versions.set(req.version, { meta, files: req.files.map((f) => ({ ...f, mode: normalizeMode(f.mode) })) });
    this.skills.set(name, skill);
    return { status: 201, body: meta };
  }

  private propose(name: string, req: ProposalRequest): { status: number; body: unknown } {
    if (this.publishMode !== "pull-request") return this.err(409, "conflict", "this registry publishes directly; use POST /versions");
    if (!this.user.gitIdentities.length)
      return this.err(403, "forbidden", "link your git identity in Settings before proposing a skill");
    const bad = this.check(name, req);
    if (bad) return bad;
    const n = this.proposals.length + 1;
    const p: Proposal = {
      id: `prop_${String(n).padStart(4, "0")}`,
      skill: name,
      packageKind: this.parse(name, req).pkg?.kind ?? "skill",
      version: req.version,
      kind: this.skills.has(name) ? "update" : "new",
      proposer: { handle: this.user.handle, displayName: this.user.displayName },
      sourceId: "src_000000000001",
      branch: `intra/${name}-${req.version}`,
      pullRequest: { number: 40 + n, url: `https://github.com/acme/skills/pull/${40 + n}` },
      status: "open",
      statusMessage: "Waiting for 1 approval from someone other than you",
      changelog: req.changelog ?? "",
      behaviors: [],
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    };
    this.proposals.unshift(p);
    return { status: 201, body: p };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : undefined;
    this.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, body });
    const out = this.route(req.method ?? "GET", url, body, req.headers.authorization);
    this.send(res, out.status, out.body, out.contentType);
  }

  private route(method: string, url: URL, body: unknown, auth: string | undefined): { status: number; body?: unknown; contentType?: string } {
    const p = url.pathname;
    // Public routes.
    if (method === "GET" && p === "/api/health") return { status: 200, body: { ok: true, version: "fake" } };
    if (method === "GET" && p === "/api/meta")
      return {
        status: 200,
        body: {
          name: "Acme skills",
          publicUrl: this.url,
          version: "2.0.0-fake",
          needsSetup: false,
          publishMode: this.publishMode,
          mcpUrl: `${this.url}/api/mcp`,
          marketplaceName: this.marketplaceName,
        },
      };
    if (method === "GET" && p === "/SKILL.md") return { status: 200, body: BOOTSTRAP_MD, contentType: "text/markdown; charset=utf-8" };
    if (method === "POST" && p === "/api/auth/device") {
      const deviceCode = randomBytes(16).toString("hex");
      this.pending.set(deviceCode, { polls: 0, done: false });
      const start: DeviceStart = {
        deviceCode,
        userCode: "WDJB-MJHT",
        verificationUri: `${this.url}/device`,
        verificationUriComplete: `${this.url}/device?code=WDJB-MJHT`,
        interval: this.device.interval,
        expiresIn: 600,
      };
      return { status: 200, body: start };
    }
    if (method === "POST" && p === "/api/auth/device/token") {
      const entry = this.pending.get((body as { deviceCode?: string }).deviceCode ?? "");
      if (!entry || entry.done) return { status: 200, body: { status: "expired" } };
      entry.polls++;
      if (entry.polls <= this.device.pendingPolls) return { status: 200, body: { status: "pending" } };
      entry.done = true;
      if (this.device.outcome === "approved") return { status: 200, body: { status: "approved", token: TOKEN, user: this.user } };
      return { status: 200, body: { status: this.device.outcome } };
    }

    if (auth !== `Bearer ${TOKEN}`) return this.err(401, "unauthenticated", "missing or bad token");
    if (method === "GET" && p === "/api/me") return { status: 200, body: this.user };
    if (method === "PUT" && p === "/api/me/git-identities") {
      this.user = { ...this.user, gitIdentities: body as GitIdentity[] };
      return { status: 200, body: this.user };
    }
    if (method === "POST" && p === "/api/tokens/marketplace") {
      const n = this.marketplaceKeys.size + 1;
      const token = `isk_mkt${String(n).padStart(25, "0")}`;
      const id = `tok_mkt${n}`;
      this.marketplaceKeys.set(id, token);
      const resp: MarketplaceKeyResponse = {
        token,
        meta: { id, name: (body as { name?: string } | undefined)?.name ?? "Claude Code plugins", prefix: token.slice(0, 12), createdAt: "2026-01-01T00:00:00Z", lastUsedAt: null, scope: "marketplace" },
        marketplaceUrl: `${this.url}/marketplace.json?key=${token}`,
        marketplaceName: this.marketplaceName,
      };
      return { status: 201, body: resp };
    }
    const tok = /^\/api\/tokens\/([^/]+)$/.exec(p);
    if (tok && method === "DELETE") {
      this.marketplaceKeys.delete(decodeURIComponent(tok[1]!));
      return { status: 204 };
    }
    if (method === "GET" && p === "/api/skills") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const stacks = url.searchParams.getAll("stack");
      const kinds = url.searchParams.getAll("kind");
      if (kinds.some((k) => !(k in KIND_MARKER))) return this.err(400, "invalid", "kind must be skill, plugin or rule");
      const skills = [...this.skills.values()]
        .filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q))
        .filter((s) => !stacks.length || s.stacks.some((x) => stacks.includes(x)))
        .filter((s) => !kinds.length || kinds.includes(s.kind))
        .map((s) => this.summary(s));
      const kindFacet = (["skill", "plugin", "rule"] as const)
        .map((k) => ({ value: k, count: skills.filter((s) => s.kind === k).length }))
        .filter((f) => f.count);
      return {
        status: 200,
        body: { skills, facets: { teams: [], kinds: kindFacet, areas: [], stacks: [], tools: [], tags: [], visibility: [] }, total: skills.length },
      };
    }
    if (method === "POST" && p === "/api/suggest") {
      const signals = body as RepoSignals;
      const detected = detectStacks(signals).map((d) => d.stack);
      const skills = [...this.skills.values()]
        .map((s) => {
          const hits = s.stacks.filter((x) => detected.includes(x));
          return { skill: this.summary(s), score: hits.length * 3 + 0.4, reasons: hits.map((h) => `matches ${h}`) };
        })
        .filter((r) => r.reasons.length)
        .sort((a, b) => b.score - a.score);
      return { status: 200, body: { stacks: detected, skills } };
    }
    const col = /^\/api\/collections\/([^/]+)\/([^/]+)$/.exec(p);
    if (col && method === "GET") {
      const c = this.collections.get(`${col[1]}/${col[2]}`);
      return c ? { status: 200, body: c } : this.err(404, "not_found", "no such collection");
    }
    if (method === "GET" && p === "/api/proposals") {
      const mine = url.searchParams.get("mine") === "1";
      const status = url.searchParams.get("status");
      return {
        status: 200,
        body: this.proposals.filter((x) => (!mine || x.proposer.handle === this.user.handle) && (!status || x.status === status)),
      };
    }
    const pr = /^\/api\/proposals\/([^/]+)\/refresh$/.exec(p);
    if (pr && method === "POST") {
      const found = this.proposals.find((x) => x.id === pr[1]);
      if (!found) return this.err(404, "not_found", "no such proposal");
      found.status = "merged";
      found.statusMessage = "Merged; waiting for the next sync";
      return { status: 200, body: found };
    }

    const m = /^\/api\/skills\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return this.err(404, "not_found", "no route");
    const name = decodeURIComponent(m[1]!);
    const rest = m[2] ?? "";
    if (method === "POST" && rest === "/versions") {
      if (this.publishMode === "pull-request")
        return this.err(403, "forbidden", "this registry publishes through pull requests", { publishMode: "pull-request" });
      return this.doPublish(name, body as PublishRequest);
    }
    if (method === "POST" && rest === "/proposals") return this.propose(name, body as ProposalRequest);
    const s = this.skills.get(name);
    if (!s) return this.err(404, "not_found", `skill ${name} not found`);
    if (method === "GET" && rest === "") return { status: 200, body: this.detail(s) };
    if (method === "PATCH" && rest === "") {
      Object.assign(s, body);
      return { status: 200, body: this.detail(s) };
    }
    if (method === "PUT" && rest === "/vote") {
      const works = (body as VoteRequest).works;
      s.trust = { works: works ? 1 : 0, broken: works ? 0 : 1, mine: works ? "works" : "broken" };
      return { status: 200, body: s.trust };
    }
    if (method === "GET" && rest === "/resolve") {
      const range = url.searchParams.get("range") ?? "latest";
      const live = [...s.versions.values()].filter((v) => !v.meta.yanked).map((v) => v.meta.version);
      const v = maxSatisfying(live, range);
      return v ? { status: 200, body: { version: v } } : this.err(404, "not_found", `no version matches ${range}`);
    }
    if (rest === "/grants") {
      if (method === "GET") return { status: 200, body: s.grants };
      if (method === "PUT") {
        s.grants = body as Grant[];
        return { status: 200, body: s.grants };
      }
    }
    const vm = /^\/versions\/([^/]+)(\/.*)?$/.exec(rest);
    if (vm) {
      const ver = decodeURIComponent(vm[1]!);
      const v = s.versions.get(ver);
      if (!v) return this.err(404, "not_found", `version ${ver} not found`);
      if (method === "GET" && vm[2] === undefined) {
        const files: FileEntry[] = v.files.map((f) => {
          const data = Buffer.from(f.contentBase64, "base64");
          return { path: f.path, mode: f.mode, size: data.length, sha256: sha256Hex(data) };
        });
        const marker = v.files.find((f) => f.path === KIND_MARKER[s.kind]);
        const skillMd = marker ? Buffer.from(marker.contentBase64, "base64").toString("utf8") : "";
        const detail: VersionDetail = { ...v.meta, name, files, skillMd };
        return { status: 200, body: detail };
      }
      if (method === "GET" && vm[2]?.startsWith("/files/")) {
        const path = vm[2].slice("/files/".length).split("/").map(decodeURIComponent).join("/");
        const f = v.files.find((x) => x.path === path);
        if (!f) return this.err(404, "not_found", `no file ${path}`);
        return { status: 200, body: Buffer.from(f.contentBase64, "base64").toString("utf8"), contentType: "text/plain; charset=utf-8" };
      }
      if (method === "GET" && vm[2] === "/bundle") {
        const sha = this.tamper.has(`${name}@${ver}`) ? "0".repeat(64) : v.meta.sha256;
        return { status: 200, body: { name, version: ver, sha256: sha, files: v.files } };
      }
      if (vm[2] === "/yank") {
        v.meta.yanked = method === "POST" ? (body as { reason: string }).reason : null;
        return { status: 200, body: v.meta };
      }
    }
    return this.err(404, "not_found", "no route");
  }
}
