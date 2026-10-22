import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TOOLS, type ToolId } from "@intra-skills/shared";
import { CliError, UsageError } from "./errors.js";
import { configPath } from "./paths.js";

export interface Config {
  registry: string | null;
  token: string | null;
  defaultTargets: ToolId[];
}

export const DEFAULT_TARGETS: ToolId[] = ["claude", "codex"];

export function readConfigFile(): Config | null {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    return null;
  }
  let data: Partial<Config>;
  try {
    data = JSON.parse(raw) as Partial<Config>;
  } catch {
    throw new CliError(`${configPath()} is not valid JSON; fix it or run \`intra login\` again`, "config");
  }
  return {
    registry: typeof data.registry === "string" ? data.registry : null,
    token: typeof data.token === "string" ? data.token : null,
    defaultTargets: Array.isArray(data.defaultTargets) ? parseTargets(data.defaultTargets.join(",")) : DEFAULT_TARGETS,
  };
}

/** File config with env overrides (INTRA_SKILLS_REGISTRY, INTRA_SKILLS_TOKEN). */
export function loadConfig(): Config {
  const file = readConfigFile() ?? { registry: null, token: null, defaultTargets: DEFAULT_TARGETS };
  return {
    registry: process.env.INTRA_SKILLS_REGISTRY ? normalizeRegistry(process.env.INTRA_SKILLS_REGISTRY) : file.registry,
    token: process.env.INTRA_SKILLS_TOKEN || file.token,
    defaultTargets: file.defaultTargets,
  };
}

export function writeConfig(cfg: Config): void {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p, 0o600); // writeFile's mode only applies on create
}

export function normalizeRegistry(url: string): string {
  const u = url.trim().replace(/\/+$/, "").replace(/\/api$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(u)) throw new UsageError(`registry must be an http(s) URL, got "${url}"`);
  return u;
}

export function parseTargets(value: string): ToolId[] {
  const out: ToolId[] = [];
  for (const raw of value.split(/[,\s]+/)) {
    const t = raw.trim().toLowerCase();
    if (!t) continue;
    if (!(TOOLS as readonly string[]).includes(t))
      throw new UsageError(`unknown target "${t}"; use ${TOOLS.join(", ")}`);
    if (!out.includes(t as ToolId)) out.push(t as ToolId);
  }
  if (!out.length) throw new UsageError(`no targets given; use ${TOOLS.join(", ")}`);
  return out;
}
