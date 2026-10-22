// The tabs only one kind has.
// - Components (plugins): what installing the plugin adds to Claude Code, grouped the way Claude Code
//   names them. The groups that run code on the reader's machine say so in one line.
// - Renders as (rules): the files `intra install <name> --project` writes for Cursor, Claude Code and
//   Codex, rendered from this version's RULE.md by the same shared renderers the CLI uses.
import { useMemo, useState, type ReactNode } from "react";
import { Globe, SquareTerminal } from "lucide-react";
import type { PluginComponents, RuleSpec, VersionDetail } from "@intra-skills/shared/types";
import { renderAgentsBlock, renderClaudeRule, renderCursorRule } from "@intra-skills/shared/kinds";
import { pluginCommandName, rulePaths } from "../../lib/commands";
import { formatNumber, plural } from "../../lib/format";
import { CopyButton, Segmented } from "../../components/ui";

// ---------- Components ----------

interface Group {
  id: string;
  title: string;
  /** Plain words: what this group does once installed. */
  about: string;
  /** Runs something on the reader's machine without being asked each time: how the summary names it. */
  runs?: string;
  items: { key: string; main: ReactNode; sub?: ReactNode }[];
}

function groupsOf(plugin: string, c: PluginComponents): Group[] {
  const mono = (s: string) => <span className="font-mono">{s}</span>;
  const local = c.mcpServers.filter((m) => m.transport === "stdio");
  const remote = c.mcpServers.filter((m) => m.transport === "remote");
  const groups: Group[] = [
    { id: "skills", title: "Skills", about: "Claude Code loads each one when a task matches its description.", items: c.skills.map((n) => ({ key: n, main: mono(n) })) },
    {
      id: "commands",
      title: "Commands",
      about: "Typed in a Claude Code session.",
      items: c.commands.map((n) => ({ key: n, main: mono(pluginCommandName(plugin, n)) })),
    },
    { id: "agents", title: "Agents", about: "Subagents Claude Code can hand a task to.", items: c.agents.map((n) => ({ key: n, main: mono(n) })) },
    {
      id: "hooks",
      title: "Hooks",
      about: "Run commands automatically when these events happen in a session.",
      runs: "hooks",
      items: c.hooks.map((n) => ({ key: n, main: mono(n) })),
    },
    {
      id: "mcp-local",
      title: "MCP servers, local",
      about: "Started as a process on your machine when Claude Code starts.",
      runs: "local MCP servers",
      items: local.map((m) => ({
        key: m.name,
        main: (
          <span className="inline-flex items-center gap-1.5">
            <SquareTerminal className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            {mono(m.name)}
          </span>
        ),
        sub: m.target,
      })),
    },
    {
      id: "mcp-remote",
      title: "MCP servers, remote",
      about: "Claude Code connects to these addresses.",
      items: remote.map((m) => ({
        key: m.name,
        main: (
          <span className="inline-flex items-center gap-1.5">
            <Globe className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            {mono(m.name)}
          </span>
        ),
        sub: m.target,
      })),
    },
    { id: "lsp", title: "Language servers", about: "Started for code intelligence in matching files.", items: c.lspServers.map((n) => ({ key: n, main: mono(n) })) },
    {
      id: "bin",
      title: "Executables",
      about: "Put on the PATH of the agent's shell, so any command it runs can call them.",
      runs: "executables",
      items: c.bin.map((n) => ({ key: n, main: mono(n) })),
    },
    {
      id: "monitors",
      title: "Monitors",
      about: "Background processes that run for the whole session.",
      runs: "monitors",
      items: c.monitors.map((n) => ({ key: n, main: mono(n) })),
    },
    { id: "styles", title: "Output styles", about: "Ways of answering you can switch Claude Code to.", items: c.outputStyles.map((n) => ({ key: n, main: mono(n) })) },
  ];
  return groups.filter((g) => g.items.length > 0);
}

export function ComponentsTab({ plugin, components }: { plugin: string; components: PluginComponents | null }) {
  if (!components)
    return (
      <p className="max-w-[60ch] text-sm text-fg-muted">
        This version was published before the registry read plugin contents. Its files are in the Files tab; <span className="font-mono text-[0.93em] text-fg">.claude-plugin/plugin.json</span> lists what it declares.
      </p>
    );
  const groups = groupsOf(plugin, components);
  if (!groups.length)
    return (
      <div className="max-w-[60ch] rounded-lg border border-dashed border-line-strong px-4 py-6">
        <h3 className="text-base font-semibold text-fg">No components found</h3>
        <p className="mt-1 text-sm text-fg-muted">
          The registry found no skills, commands, agents, hooks or servers in this version. Installing it adds nothing to Claude Code. Check its files.
        </p>
      </div>
    );
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  const running = groups.filter((g) => g.runs);
  return (
    <div className="flex max-w-[72ch] flex-col gap-9">
      <p className="text-sm text-fg-muted">
        Installing it adds {plural(total, "component")} to Claude Code
        {running.length > 0 ? (
          <>
            . Its <span className="font-medium text-fg">{running.map((g) => g.runs).join(", ").replace(/, ([^,]*)$/, " and $1")}</span> run on your machine without asking
            each time; Behaviors lists exactly what they run.
          </>
        ) : (
          ". None of them start a process on your machine."
        )}
      </p>
      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`comp-${g.id}`} className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 pb-1">
            <h3 id={`comp-${g.id}`} className="text-sm font-semibold text-fg">
              {g.title}
            </h3>
            <span className="font-mono text-xs text-fg-subtle tabular">{formatNumber(g.items.length)}</span>
            {g.runs && (
              <span className="inline-flex h-[18px] items-center rounded-sm border border-line-strong px-1.5 text-xs leading-none font-medium text-fg-muted">Runs on your machine</span>
            )}
            <p className="w-full text-sm text-fg-muted">{g.about}</p>
          </div>
          <ul className="divide-y divide-line">
            {g.items.map((it) => (
              <li key={it.key} className="min-w-0 py-2.5">
                <p className="text-sm text-fg [overflow-wrap:anywhere]">{it.main}</p>
                {it.sub && <p className="mt-1 font-mono text-xs leading-5 text-fg-muted [overflow-wrap:anywhere]">{it.sub}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// ---------- Renders as ----------

type ToolKey = "cursor" | "claude" | "codex";

function whenFor(tool: ToolKey, rule: RuleSpec): string {
  if (tool === "cursor")
    return rule.mode === "always" ? "Always applied" : rule.mode === "globs" ? "Applied to files matching its globs" : "Applied when the agent picks it from the description";
  if (tool === "claude") return rule.mode === "globs" ? "Loaded when Claude reads a matching file" : "Loaded in every session";
  return rule.globs.length ? "Read every session; the block names its files" : "Read every session";
}

export function RendersTab({ version, description, rule, ruleMd }: { version: VersionDetail; description: string; rule: RuleSpec | null; ruleMd: string }) {
  const [tool, setTool] = useState<ToolKey>("cursor");
  const paths = rulePaths(version.name);
  const out = useMemo(() => {
    if (!rule) return null;
    return {
      cursor: renderCursorRule(description, rule, ruleMd),
      claude: renderClaudeRule(rule, ruleMd),
      codex: renderAgentsBlock(version.name, version.version, description, rule, ruleMd),
    } satisfies Record<ToolKey, string>;
  }, [rule, ruleMd, description, version.name, version.version]);

  if (!rule || !out)
    return <p className="max-w-[60ch] text-sm text-fg-muted">This version was published before the registry read when rules apply, so it cannot be previewed. Its RULE.md is in the Files tab.</p>;

  const tools: { value: ToolKey; label: string }[] = [
    { value: "cursor", label: "Cursor" },
    { value: "claude", label: "Claude Code" },
    { value: "codex", label: "Codex" },
  ];
  const text = out[tool];
  const lines = text.replace(/\n$/, "").split("\n");
  return (
    <div className="flex max-w-[72ch] flex-col gap-5">
      <p className="text-sm text-fg-muted">
        <span className="font-mono text-[0.93em] text-fg">intra install {version.name} --project</span> writes one file per tool from this version's RULE.md. Each tool reads it in its own way.
      </p>
      <table className="w-full border-collapse border-y border-line text-sm">
        <caption className="sr-only">Where the rule lands and when each tool reads it</caption>
        <thead className="max-sm:hidden">
          <tr className="border-b border-line">
            <th scope="col" className="h-8 pr-3 pl-1 text-left text-xs font-medium text-fg-subtle">Tool</th>
            <th scope="col" className="h-8 px-3 text-left text-xs font-medium text-fg-subtle">File</th>
            <th scope="col" className="h-8 pr-1 pl-3 text-left text-xs font-medium text-fg-subtle">When it is read</th>
          </tr>
        </thead>
        <tbody>
          {tools.map((t) => (
            <tr key={t.value} className="border-b border-line last:border-b-0 max-sm:grid max-sm:grid-cols-1 max-sm:gap-0.5 max-sm:py-2.5">
              <th scope="row" className="py-2.5 pr-3 pl-1 text-left font-medium whitespace-nowrap text-fg max-sm:p-0">
                {t.label}
              </th>
              <td className="px-3 py-2.5 font-mono text-[13px] whitespace-nowrap text-fg max-sm:p-0 max-sm:whitespace-normal max-sm:[overflow-wrap:anywhere]">{paths[t.value]}</td>
              <td className="py-2.5 pr-1 pl-3 text-fg-muted max-sm:p-0">{whenFor(t.value, rule)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rule.mode === "agent" && (
        <p className="text-sm text-fg-muted">
          <span className="font-medium text-fg">Claude Code and Codex load it in every session.</span> Neither has a way to load a rule only when the agent decides, so a rule with no
          file patterns is always in their context.
        </p>
      )}
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-3 py-1.5 max-md:py-2">
          <Segmented label="Preview for" value={tool} onChange={setTool} options={tools} size="sm" />
          <span className="min-w-0 flex-1 font-mono text-sm text-fg-muted [overflow-wrap:anywhere] max-sm:order-last max-sm:basis-full">
            {tool === "codex" ? `${paths.codex}, this rule's block` : paths[tool]}
          </span>
          <CopyButton text={text} label={`Copy the ${tools.find((t) => t.value === tool)!.label} file`} />
        </div>
        <div className="overflow-x-auto py-2">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="w-px pr-3 pl-3 text-right align-top text-fg-subtle tabular select-none" style={{ minWidth: `${String(lines.length).length + 3}ch` }} aria-hidden>
                    {i + 1}
                  </td>
                  <td className="pr-4 align-top whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{l || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {tool === "codex" && <p className="-mt-2 text-sm text-fg-muted">The CLI keeps the rest of AGENTS.md as it is and updates only this block, between its two markers.</p>}
    </div>
  );
}
