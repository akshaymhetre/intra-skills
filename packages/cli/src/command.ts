import { parseArgs, type ParseArgsOptionsConfig } from "node:util";
import { Api, apiFromConfig } from "./api.js";
import { UsageError } from "./errors.js";
import { findProjectRoot } from "./paths.js";
import type { Io, Output } from "./output.js";
import { resolve } from "node:path";

export interface Ctx {
  out: Output;
  io: Io;
  api(opts?: { requireToken?: boolean }): Api;
  /** Wait between device-login polls; tests replace it with an instant fake clock. */
  sleep(ms: number): Promise<void>;
}

export type Values = Record<string, string | boolean | string[] | undefined>;

export interface Command {
  name: string;
  summary: string;
  /** Full --help text (usage line first). */
  help: string;
  options?: ParseArgsOptionsConfig;
  run(ctx: Ctx, values: Values, positionals: string[]): Promise<number | void>;
}

export const GLOBAL_OPTIONS: ParseArgsOptionsConfig = {
  help: { type: "boolean", short: "h" },
  json: { type: "boolean" },
};

export function defaultCtx(out: Output, io: Io): Ctx {
  return { out, io, api: (opts) => apiFromConfig(opts), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

/**
 * `--project` takes an OPTIONAL directory. Skill names never contain "/" or start with ".",
 * so the next token is taken as the directory only when it looks like a path.
 * Rewrites to `--project=<dir>` (or `--project=` for auto-detect) before parseArgs sees it.
 */
export function normalizeProjectFlag(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--project") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-") && (next.includes("/") || next.startsWith(".") || next.startsWith("~"))) {
        out.push(`--project=${next}`);
        i++;
      } else out.push("--project=");
    } else out.push(a);
  }
  return out;
}

export function parse(cmd: Command, argv: string[]): { values: Values; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: normalizeProjectFlag(argv),
      options: { ...GLOBAL_OPTIONS, ...(cmd.options ?? {}) },
      allowPositionals: true,
      strict: true,
    });
    return { values: values as Values, positionals };
  } catch (err) {
    throw new UsageError(`${(err as Error).message.split("\n")[0]}\nRun \`intra ${cmd.name} --help\` for usage.`);
  }
}

/** Project root for `--project[=dir]`: the given dir, else nearest ancestor with .git, else cwd. */
export function projectRoot(ctx: Ctx, value: Values[string]): string | null {
  if (value === undefined) return null;
  if (typeof value === "string" && value !== "") return resolve(ctx.io.cwd, value.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  return findProjectRoot(ctx.io.cwd);
}

export const str = (v: Values[string]): string | undefined => (typeof v === "string" ? v : undefined);
export const list = (v: Values[string]): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).flatMap((x) => x.split(",")).map((x) => x.trim()).filter(Boolean);
