import { CliError } from "./errors.js";
import { Output, type Io } from "./output.js";
import { defaultCtx, parse, type Command, type Ctx } from "./command.js";
import { config, identity, login, logout, whoami } from "./commands/auth.js";
import { init, publish, validate } from "./commands/author.js";
import { diff, info, run, search, vote } from "./commands/browse.js";
import { proposals } from "./commands/proposals.js";
import { setup } from "./commands/setup.js";
import { suggest } from "./commands/suggest.js";
import { install, listCmd, prune, remove, sync, update } from "./commands/manage.js";
import { deprecate, grant, revoke, team, token, unyank, user, visibility, yank } from "./commands/admin.js";
import { doctor } from "./commands/doctor.js";
import { plugins } from "./commands/plugins.js";

export const VERSION = "0.1.0";

const GROUPS: [string, Command[]][] = [
  ["Get started", [setup, login]],
  ["Install", [install, listCmd, update, remove, sync, prune, plugins]],
  ["Discover", [search, suggest, info, run, diff, vote]],
  ["Author", [init, validate, publish, proposals, identity]],
  ["Manage", [yank, unyank, deprecate, visibility, grant, revoke, team, user, token]],
  ["Account", [logout, whoami, config, doctor]],
];
export const COMMANDS = new Map<string, Command>(GROUPS.flatMap(([, cmds]) => cmds.map((c) => [c.name, c] as const)));
COMMANDS.set("ls", listCmd);
COMMANDS.set("rm", remove);
COMMANDS.set("i", install);

export function rootHelp(): string {
  const lines = [
    "intra - install and publish agent skills, rules and Claude Code plugins from your team's intra-skills registry",
    "",
    "Usage: intra <command> [options]",
    "",
  ];
  for (const [group, cmds] of GROUPS) {
    lines.push(`${group}:`);
    for (const c of cmds) lines.push(`  ${c.name.padEnd(11)} ${c.summary}`);
    lines.push("");
  }
  lines.push(
    "New here? Run `intra setup --registry <url>`. Agents: `intra login --start --json`, then `intra login --wait --json`.",
    "Kinds: skills install into each tool's skills folder; rules render into the project (.claude/rules, .cursor/rules, AGENTS.md);",
    "plugins install through Claude Code (`intra plugins connect` once per machine). `intra init --kind plugin|rule` scaffolds one.",
    "Every command takes --help and --json (one JSON document on stdout, errors as {\"ok\":false,\"error\":{...}}).",
    "Environment: INTRA_SKILLS_HOME (default ~/.intra-skills), INTRA_SKILLS_REGISTRY, INTRA_SKILLS_TOKEN, INTRA_CLAUDE_BIN, NO_COLOR.",
  );
  return lines.join("\n");
}

/** Run the CLI in-process. Returns the exit code: 0 ok, 1 error, 2 usage. */
export async function main(argv: string[], io: Io, makeCtx: (out: Output, io: Io) => Ctx = defaultCtx): Promise<number> {
  const json = argv.includes("--json");
  const out = new Output(io, json);
  const [name, ...rest] = argv;
  try {
    if (!name || name === "--help" || name === "-h" || name === "help") {
      const target = name === "help" && rest[0] ? COMMANDS.get(rest[0]) : undefined;
      io.stdout.write((target ? target.help : rootHelp()) + "\n");
      return 0;
    }
    if (name === "--version" || name === "-v") {
      io.stdout.write(VERSION + "\n");
      return 0;
    }
    const cmd = COMMANDS.get(name);
    if (!cmd) {
      if (json) throw new CliError(`unknown command "${name}"`, "usage", 2);
      io.stderr.write(`unknown command "${name}"\n\n${rootHelp()}\n`);
      return 2;
    }
    const { values, positionals } = parse(cmd, rest);
    if (values.help) {
      io.stdout.write(cmd.help + "\n");
      return 0;
    }
    return (await cmd.run(makeCtx(out, io), values, positionals)) ?? 0;
  } catch (err) {
    if (!(err instanceof CliError)) {
      const msg = err instanceof Error ? err.message : String(err);
      if (json) io.stdout.write(JSON.stringify({ ok: false, error: { code: "internal", message: msg } }) + "\n");
      else io.stderr.write(`intra: unexpected error: ${msg}\n${process.env.INTRA_DEBUG ? (err as Error).stack + "\n" : "(set INTRA_DEBUG=1 for a stack trace)\n"}`);
      return 1;
    }
    if (json) {
      const error: Record<string, unknown> = { code: err.code, message: err.message };
      if (err.details !== undefined) error.details = err.details;
      if ("status" in err) error.status = (err as { status: number }).status;
      io.stdout.write(JSON.stringify({ ok: false, error }) + "\n");
    } else {
      const prefix = io.stderr.isTTY && !process.env.NO_COLOR ? "\u001b[31merror\u001b[39m" : "error";
      io.stderr.write(`${prefix}: ${err.message}\n`);
    }
    return err.exitCode;
  }
}
