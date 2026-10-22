// Every command string the console shows. One place, so the console never prints a flag the CLI
// does not have. The CLI surface is documented in docs/API.md "Agent documents" and `intra --help`.
import type { ToolId } from "@intra-skills/shared/types";

export interface InstallOpts {
  /** A semver range or exact version; omitted = latest (recorded as ^latest). */
  range?: string;
  project?: boolean;
  tools?: ToolId[];
}

const DEFAULT_TOOLS: ToolId[] = ["claude", "codex"];

export function installCommand(name: string, o: InstallOpts = {}): string {
  const ref = o.range ? `${name}@${o.range}` : name;
  const parts = ["intra install", ref];
  if (o.project) parts.push("--project");
  if (o.tools && !(o.tools.length === DEFAULT_TOOLS.length && DEFAULT_TOOLS.every((t) => o.tools!.includes(t))))
    parts.push("--to", o.tools.join(","));
  return parts.join(" ");
}

export const runCommand = (name: string, range?: string) => `intra run ${range ? `${name}@${range}` : name}`;

export const collectionInstallCommand = (team: string, slug: string, project = false) =>
  `intra install @${team}/${slug}${project ? " --project" : ""}`;

/** One line that installs the CLI from THIS registry, then signs in and sets up the agent tools. */
export const bootstrapCommand = (publicUrl: string) => `curl -fsSL ${publicUrl}/install.sh | sh && intra setup`;

export const mcpClaudeCommand = (mcpUrl: string) =>
  `claude mcp add --transport http intra-skills ${mcpUrl} --header "Authorization: Bearer <your token>"`;

/** What a person pastes into Claude Code or Codex so the AGENT does the install. */
export function agentPrompt(publicUrl: string, skill?: string, kind: "skill" | "plugin" | "rule" = "skill"): string {
  return skill
    ? `Install the ${skill} ${kind} from our skills registry at ${publicUrl}. Read ${publicUrl}/agent.md first and follow it.`
    : `Set up our skills registry at ${publicUrl} for me. Read ${publicUrl}/agent.md first and follow it.`;
}

export const collectionAgentPrompt = (publicUrl: string, team: string, slug: string) =>
  `Install the @${team}/${slug} collection from our skills registry at ${publicUrl}. Read ${publicUrl}/agent.md first and follow it.`;

// ---------- plugins (Claude Code installs them itself, from this registry's marketplace) ----------

/** One-time: adds this registry's plugin marketplace to Claude Code (the CLI creates the read-only key). */
export const pluginsConnectCommand = () => "intra plugins connect";

/** The same, by hand, with a key made in Settings. */
export const marketplaceAddCommand = (marketplaceUrl: string) => `claude plugin marketplace add ${marketplaceUrl}`;

export const pluginInstallCommand = (name: string, marketplace: string, o: { project?: boolean } = {}) =>
  `claude plugin install ${name}@${marketplace}${o.project ? " --scope project" : ""}`;

/** Typed inside a Claude Code session, not in a shell. */
export const pluginSlashCommand = (name: string, marketplace: string) => `/plugin install ${name}@${marketplace}`;

/** How a plugin's command is invoked inside Claude Code. */
export const pluginCommandName = (plugin: string, command: string) => `/${plugin}:${command}`;

// ---------- rules (written into the project, one file per tool) ----------

export const ruleInstallCommand = (name: string) => installCommand(name, { project: true });

/** Where a project install of a rule lands, per tool. */
export const rulePaths = (name: string) => ({
  cursor: `.cursor/rules/${name}.mdc`,
  claude: `.claude/rules/${name}.md`,
  codex: "AGENTS.md",
});
