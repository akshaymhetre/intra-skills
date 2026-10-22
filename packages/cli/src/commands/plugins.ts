import type { Api } from "../api.js";
import type { Command, Ctx } from "../command.js";
import { UsageError } from "../errors.js";
import { claudeBin, connectionFor, connectMarketplace, type ConnectResult } from "../plugins.js";

/** Human lines for a connect result. The manual command carries the key, so it is shown only when it must be. */
export function reportConnect(ctx: Ctx, r: ConnectResult): void {
  const o = ctx.out;
  if (r.status === "connected") o.line(`${o.c("green", "✓")} connected the ${o.c("bold", r.marketplaceName)} plugin marketplace to Claude Code (user scope)`);
  else if (r.status === "already-connected") o.line(`${o.c("green", "✓")} the ${r.marketplaceName} plugin marketplace is already connected (\`intra plugins connect --force\` to redo it)`);
  else {
    o.line("Claude Code (`claude`) is not on PATH, so nothing was run. Once it is installed, run:");
    o.line(`  ${r.command}`);
    o.line(o.c("dim", "The URL carries a read-only key for the plugin marketplace; do not share it."));
  }
}

export async function runConnect(ctx: Ctx, api: Api, force: boolean): Promise<ConnectResult> {
  return connectMarketplace(api, ctx.io.cwd, { force });
}

export const plugins: Command = {
  name: "plugins",
  summary: "Connect Claude Code to the registry's plugin marketplace",
  help: `Usage: intra plugins connect [--force] [--json]
       intra plugins status [--json]

Claude Code installs, versions and updates plugins itself, from a marketplace. The registry
serves one; \`connect\` adds it to Claude Code once per machine:
  1. asks the registry for a read-only marketplace key (POST /api/tokens/marketplace)
  2. runs \`claude plugin marketplace add <marketplace URL> --scope user\`
The key is part of that URL, so it lives in Claude Code's own settings and nowhere in intra's
files. When \`claude\` is not on PATH, connect prints the exact command to run instead.
\`intra install <plugin>\` connects first when needed. Set INTRA_CLAUDE_BIN to use a \`claude\`
that is not on PATH.

Options:
  --force   connect again even if this machine is already connected (mints a new key and
            revokes the old one once Claude Code accepts the new one)`,
  options: { force: { type: "boolean" } },
  async run(ctx, v, pos) {
    const sub = pos[0] ?? "status";
    if (sub === "connect") {
      const api = ctx.api();
      const r = await runConnect(ctx, api, Boolean(v.force));
      reportConnect(ctx, r);
      ctx.out.result({ ...r, connected: r.status !== "manual" });
      return 0;
    }
    if (sub === "status") {
      const api = ctx.api({ requireToken: false });
      const conn = connectionFor(api.registry);
      const bin = claudeBin();
      if (conn) ctx.out.line(`${ctx.out.c("green", "✓")} ${conn.marketplaceName} marketplace connected ${ctx.out.c("dim", `(since ${conn.connectedAt})`)}`);
      else ctx.out.line("Not connected. Run `intra plugins connect`.");
      ctx.out.line(bin ? `Claude Code CLI: ${bin}` : "Claude Code CLI: not found on PATH (set INTRA_CLAUDE_BIN to its path)");
      ctx.out.result({ registry: api.registry, connected: Boolean(conn), marketplaceName: conn?.marketplaceName ?? null, connectedAt: conn?.connectedAt ?? null, claude: bin });
      return 0;
    }
    throw new UsageError(`unknown subcommand "${sub}"; use \`intra plugins connect\` or \`intra plugins status\``);
  },
};
