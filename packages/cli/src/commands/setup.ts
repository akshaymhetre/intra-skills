import { join } from "node:path";
import { bundleSha256, parseSkillMd, sha256Hex, type RegistryMeta, type ToolId, type User } from "@intra-skills/shared";
import { Api } from "../api.js";
import { list, str, type Command, type Ctx } from "../command.js";
import { loadConfig, normalizeRegistry, parseTargets } from "../config.js";
import { deviceLogin } from "../device.js";
import { ApiError, CliError, UsageError } from "../errors.js";
import { backup, classify, swapDir } from "../install.js";
import { backupRoot, globalToolDir } from "../paths.js";
import { collectChecks } from "./doctor.js";
import { claudeBin, connectMarketplace, type ConnectResult } from "../plugins.js";
import { reportConnect } from "./plugins.js";

/** The registry's own bootstrap skill, served at <registry>/SKILL.md. */
export const BOOTSTRAP = "intra-registry";

async function signedIn(ctx: Ctx, registry: string, browser: boolean): Promise<{ token: string; user: User; fresh: boolean }> {
  const cfg = loadConfig();
  if (cfg.registry === registry && cfg.token) {
    try {
      return { token: cfg.token, user: await new Api(registry, cfg.token).me(), fresh: false };
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 401)) throw err;
      ctx.out.warn("the saved token was rejected; signing in again");
    }
  }
  const res = await deviceLogin(ctx, registry, { browser });
  return { ...res, fresh: true };
}

export function claudeMcpCommand(mcpUrl: string, token: string): string {
  return `claude mcp add --transport http intra-skills ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

export function codexMcpSnippet(mcpUrl: string): string {
  return `[mcp_servers.intra-skills]\nurl = "${mcpUrl}"\nbearer_token_env_var = "INTRA_SKILLS_TOKEN"`;
}

export const setup: Command = {
  name: "setup",
  summary: "Sign in, install the registry's own skill into your agents, print MCP setup",
  help: `Usage: intra setup [--registry <url>] [--to claude,codex] [--no-mcp] [--no-plugins] [--no-browser] [--force] [--json]

One command for a new machine:
  1. signs in with a device login unless a working token is already saved
  2. downloads <registry>/SKILL.md and installs it as ${BOOTSTRAP}/SKILL.md in each tool's
     global skills directory, so your agent knows how to search and install skills
  3. prints the commands that connect Claude Code and Codex to the registry's MCP server
     (it never edits ~/.claude.json or ~/.codex/config.toml itself)
  4. connects Claude Code to the registry's plugin marketplace (\`intra plugins connect\`) when
     \`claude\` is on PATH, so \`intra install <plugin>\` works; otherwise says how to do it later
  5. runs the \`intra doctor\` checks and prints a summary

A ${BOOTSTRAP} directory that intra did not write is never overwritten (same rule as installs).

Options:
  --registry <url>   registry base URL (default: the saved one)
  --to <list>        tools: claude,codex,cursor (default: config defaultTargets, initially claude,codex)
  --no-mcp           do not print the MCP commands
  --no-plugins       do not connect the plugin marketplace
  --no-browser       do not try to open the approval page
  --force            move a foreign ${BOOTSTRAP} directory aside to $INTRA_SKILLS_HOME/backup/<timestamp>/
  --json             print the result as JSON (the sign-in code, when needed, goes to stderr)`,
  options: {
    registry: { type: "string" },
    to: { type: "string", multiple: true },
    "no-mcp": { type: "boolean" },
    "no-plugins": { type: "boolean" },
    "no-browser": { type: "boolean" },
    force: { type: "boolean" },
  },
  async run(ctx, v) {
    const cfg = loadConfig();
    const registryArg = str(v.registry) ?? cfg.registry;
    if (!registryArg) throw new UsageError("usage: intra setup --registry <url> (the URL of your team's intra-skills registry)");
    const registry = normalizeRegistry(registryArg);
    const targets: ToolId[] = list(v.to).length ? parseTargets(list(v.to).join(",")) : cfg.defaultTargets;
    const o = ctx.out;

    // 1. What the registry says about itself (public route; an older server has none).
    let meta: RegistryMeta | null = null;
    try {
      meta = await new Api(registry, null).meta();
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    }
    if (meta?.needsSetup)
      throw new CliError(`${registry} has no admin yet; finish the first-run setup in the console at ${meta.publicUrl}`, "needs_setup");

    // 2. Sign in.
    const auth = await signedIn(ctx, registry, !v["no-browser"]);
    o.line(`${o.c("green", "✓")} signed in to ${registry} as ${o.c("bold", auth.user.handle)}${auth.fresh ? "" : " (saved token)"}`);
    const api = new Api(registry, auth.token);

    // 3. Bootstrap skill, all-or-nothing like an install.
    const text = await api.text("/SKILL.md");
    const parsed = parseSkillMd(text, BOOTSTRAP);
    if (!parsed.skill) o.warn(`${registry}/SKILL.md does not parse as a skill (${parsed.issues.map((i) => i.message).join("; ")}); installing it anyway`);
    const data = Buffer.from(text, "utf8");
    const files = [{ path: "SKILL.md", mode: 0o644, data }];
    const marker = {
      name: BOOTSTRAP,
      version: meta?.version ?? "0.0.0",
      sha256: bundleSha256([{ path: "SKILL.md", mode: 0o644, sha256: sha256Hex(data) }]),
      registry,
    };
    const plan = targets.map((tool) => {
      const path = join(globalToolDir(tool), BOOTSTRAP);
      return { tool, path, state: classify(path, BOOTSTRAP) };
    });
    const blocked = plan.filter((p) => p.state.kind === "unmanaged");
    if (blocked.length && !v.force)
      throw new CliError(
        `refusing to overwrite ${blocked.map((b) => b.path).join(", ")}: not written by intra. ` +
          `Move it away, or re-run with --force to back it up to ${backupRoot()}/<timestamp>/`,
        "unmanaged_target",
        1,
        { paths: blocked.map((b) => b.path) },
      );
    const bootstrap: { tool: ToolId; path: string; backup: string | null }[] = [];
    for (const p of plan) {
      let state = p.state;
      let moved: string | null = null;
      if (state.kind === "unmanaged") {
        moved = backup(p.path, `global-${p.tool}/${BOOTSTRAP}`);
        state = { kind: "missing" };
      }
      swapDir(p.path, files, marker, state);
      bootstrap.push({ tool: p.tool, path: join(p.path, "SKILL.md"), backup: moved });
      o.line(`${o.c("green", "✓")} installed ${BOOTSTRAP} for ${p.tool} ${o.c("dim", join(p.path, "SKILL.md"))}`);
      if (moved) o.line(`    backed up the previous contents to ${moved}`);
    }

    // 4. MCP commands, printed, never applied.
    const mcpUrl = meta?.mcpUrl ?? `${registry}/api/mcp`;
    const mcp = v["no-mcp"]
      ? null
      : {
          url: mcpUrl,
          claude: targets.includes("claude") ? claudeMcpCommand(mcpUrl, auth.token) : null,
          codex: targets.includes("codex") ? codexMcpSnippet(mcpUrl) : null,
        };
    if (mcp) {
      o.line();
      o.line(o.c("bold", "Optional: connect your agents to the registry's MCP server"));
      if (mcp.claude) {
        o.line("Claude Code, run:");
        o.line(`  ${mcp.claude}`);
      }
      if (mcp.codex) {
        o.line("Codex, add this to ~/.codex/config.toml and export INTRA_SKILLS_TOKEN=<your token> in your shell profile:");
        for (const l of mcp.codex.split("\n")) o.line(`  ${l}`);
      }
    }

    // 5. Plugin marketplace (Claude Code only). A failure here never fails setup.
    let plugins: (ConnectResult & { connected: boolean }) | { status: "skipped" | "failed"; reason: string } = { status: "skipped", reason: "--no-plugins" };
    if (!v["no-plugins"]) {
      if (!targets.includes("claude")) plugins = { status: "skipped", reason: "claude is not a target" };
      else if (!claudeBin()) {
        plugins = { status: "skipped", reason: "claude is not on PATH" };
        o.line();
        o.line("Plugins: install Claude Code, then run `intra plugins connect` to install plugins from this registry.");
      } else {
        o.line();
        try {
          const r = await connectMarketplace(api, ctx.io.cwd);
          reportConnect(ctx, r);
          plugins = { ...r, connected: r.status !== "manual" };
        } catch (err) {
          if (!(err instanceof CliError)) throw err;
          plugins = { status: "failed", reason: err.message };
          o.warn(`the plugin marketplace was not connected: ${err.message}`);
        }
      }
    }

    // 6. Doctor summary.
    const checks = await collectChecks(ctx, {});
    const count = (s: string) => checks.filter((c) => c.state === s).length;
    o.line();
    o.line(`Health: ${count("ok")} ok, ${count("warn")} warning(s), ${count("fail")} failed${count("unknown") ? `, ${count("unknown")} unknown` : ""}.`);
    for (const c of checks.filter((x) => x.state === "fail" || x.state === "warn")) {
      o.line(`  ${c.state === "fail" ? o.c("red", "FAIL") : o.c("yellow", "warn")} ${c.name}: ${c.detail}`);
      if (c.fix) o.line(o.c("dim", `       fix: ${c.fix}`));
    }
    o.line();
    o.line("Next: ask your agent to find a skill (it now has the intra-registry skill), or run `intra suggest` in a repo.");
    o.result({
      registry,
      user: auth.user,
      signedIn: auth.fresh ? "device" : "saved-token",
      bootstrap,
      mcp,
      plugins,
      healthy: count("fail") === 0,
      checks,
    });
  },
};
