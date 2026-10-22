// Claude Code plugins. intra never unpacks a plugin itself: Claude Code installs, versions and
// updates plugins from a marketplace, and the registry serves one (docs/API.md, "Claude Code plugin
// marketplace"). intra connects that marketplace once per machine and then drives the `claude` CLI.
//
// The marketplace URL carries a read-only key (Claude Code has no header option for a marketplace),
// so the key lives in Claude Code's own settings once added and NOWHERE in intra's files.
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { Api } from "./api.js";
import { ApiError, CliError } from "./errors.js";
import { pluginStatePath } from "./paths.js";

/** Env var naming the Claude Code CLI to run (default: `claude` on PATH). Tests point it at a fake. */
export const CLAUDE_BIN_ENV = "INTRA_CLAUDE_BIN";

function executable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of the Claude Code CLI, or null when it is not installed. Read at call time. */
export function claudeBin(): string | null {
  const override = process.env[CLAUDE_BIN_ENV];
  // Never let a test run the real `claude` by accident: under vitest only an explicit override counts.
  if (!override && process.env.VITEST) return null;
  const name = override || "claude";
  if (name.includes("/")) {
    const abs = isAbsolute(name) ? name : join(process.cwd(), name);
    return executable(abs) ? abs : null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    if (executable(p)) return p;
  }
  return null;
}

export interface ClaudeRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `claude <args>` with its output captured, so --json still prints exactly one document. */
export function runClaude(bin: string, args: string[], cwd: string): ClaudeRun {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10 * 60_000 });
  if (r.error) return { code: 127, stdout: "", stderr: r.error.message };
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Hide the marketplace key in anything shown on screen or in logs. */
export function maskKey(text: string): string {
  return text.replace(/([?&]key=)[^&\s'"]+/g, "$1***");
}

/** A shell-safe rendering of a command for a person to paste (the URL has `?`, which zsh globs). */
export function shellCommand(args: string[]): string {
  return ["claude", ...args].map((a) => (/^[A-Za-z0-9@%+=:,./_-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(" ");
}

function failure(what: string, r: ClaudeRun): string {
  const detail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join(" ");
  return `\`${maskKey(what)}\` failed (exit ${r.code})${detail ? `: ${maskKey(detail)}` : ""}`;
}

// ---------- connection state ($INTRA_SKILLS_HOME/plugins.json) ----------

export interface MarketplaceConnection {
  marketplaceName: string;
  /** Id of the registry token behind the key, so a reconnect can revoke the old one. Not the key. */
  tokenId: string;
  connectedAt: string;
}

export interface PluginState {
  /** Keyed by registry base URL. */
  registries: Record<string, MarketplaceConnection>;
}

export function readPluginState(): PluginState {
  try {
    const data = JSON.parse(readFileSync(pluginStatePath(), "utf8")) as Partial<PluginState>;
    return { registries: data.registries && typeof data.registries === "object" ? data.registries : {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { registries: {} };
    throw new CliError(`${pluginStatePath()} is not valid JSON; fix or delete it, then run \`intra plugins connect\``, "corrupt");
  }
}

export function writePluginState(state: PluginState): void {
  const p = pluginStatePath();
  mkdirSync(dirname(p), { recursive: true });
  const registries = Object.fromEntries(Object.keys(state.registries).sort().map((k) => [k, state.registries[k]!]));
  writeFileSync(p, JSON.stringify({ registries }, null, 2) + "\n");
}

export const connectionFor = (registry: string): MarketplaceConnection | null => readPluginState().registries[registry] ?? null;

export interface ConnectResult {
  /** connected = ran it now; already-connected = recorded earlier; manual = no `claude`, the user runs `command`. */
  status: "connected" | "already-connected" | "manual";
  registry: string;
  marketplaceName: string;
  /** manual only: the exact command, key included (it is the only way to hand it over). */
  command: string | null;
}

/**
 * Connect this registry's marketplace to Claude Code at user scope. Mints a marketplace key only when
 * it will be used: an existing connection is kept unless `force`.
 */
export async function connectMarketplace(api: Api, cwd: string, opts: { force?: boolean } = {}): Promise<ConnectResult> {
  const state = readPluginState();
  const prev = state.registries[api.registry];
  if (prev && !opts.force) return { status: "already-connected", registry: api.registry, marketplaceName: prev.marketplaceName, command: null };
  const bin = claudeBin();
  let key;
  try {
    key = await api.marketplaceKey("Claude Code plugins");
  } catch (err) {
    if (err instanceof ApiError && err.status === 404)
      throw new CliError(`${api.registry} does not serve a Claude Code plugin marketplace (POST /api/tokens/marketplace answered 404); upgrade the registry`, "unsupported");
    throw err;
  }
  const args = ["plugin", "marketplace", "add", key.marketplaceUrl, "--scope", "user"];
  if (!bin) return { status: "manual", registry: api.registry, marketplaceName: key.marketplaceName, command: shellCommand(args) };
  const r = runClaude(bin, args, cwd);
  if (r.code !== 0) {
    await api.revokeToken(key.meta.id).catch(() => undefined); // the key was never stored anywhere
    throw new CliError(
      `${failure(shellCommand(args), r)}. If Claude Code already has a marketplace named ${key.marketplaceName}, remove it in Claude Code (\`/plugin marketplace remove ${key.marketplaceName}\`) and run \`intra plugins connect\` again`,
      "claude_failed",
    );
  }
  if (prev && prev.tokenId !== key.meta.id) await api.revokeToken(prev.tokenId).catch(() => undefined);
  state.registries[api.registry] = { marketplaceName: key.marketplaceName, tokenId: key.meta.id, connectedAt: new Date().toISOString() };
  writePluginState(state);
  return { status: "connected", registry: api.registry, marketplaceName: key.marketplaceName, command: null };
}

export const NO_CLAUDE = `the Claude Code CLI (\`claude\`) was not found on PATH; plugins install through it. Install Claude Code (or set ${CLAUDE_BIN_ENV} to its path) and run this again`;

/** Run one `claude plugin ...` command, throwing with Claude Code's own message when it fails. */
export function claudePlugin(args: string[], cwd: string): ClaudeRun {
  const bin = claudeBin();
  if (!bin) throw new CliError(NO_CLAUDE, "no_claude");
  const r = runClaude(bin, ["plugin", ...args], cwd);
  if (r.code !== 0) throw new CliError(failure(shellCommand(["plugin", ...args]), r), "claude_failed");
  return r;
}
