// The skill page's one beam: the install card. Four ways in (Terminal, Project, Agent, MCP), each one
// copyable line. The pin and the target tools are inline choices inside the sentence under the command,
// so the line and the words that explain it never disagree. Below the card: Run once, and the token cost.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronDown } from "lucide-react";
import { parseVersion } from "@intra-skills/shared/semver";
import { TOOL_DIRS, TOOLS, type ToolId, type VersionMeta } from "@intra-skills/shared/types";
import { agentPrompt, installCommand, mcpClaudeCommand, runCommand } from "../../lib/commands";
import { formatNumber } from "../../lib/format";
import { InstallCard } from "../../components/InstallCard";
import { CopyCommand } from "../../components/CopyCommand";
import { Menu, WarningLine, cx } from "../../components/ui";

export type Pin = "latest" | "caret" | "exact";

/** The tool sets offered. Cursor also reads the Claude Code and Codex folders, so it never pairs with them. */
const TARGET_SETS: { tools: ToolId[]; label: string }[] = [
  { tools: ["claude", "codex"], label: "Claude Code and Codex" },
  { tools: ["claude"], label: "Claude Code" },
  { tools: ["codex"], label: "Codex" },
  { tools: ["cursor"], label: "Cursor" },
];

const sameSet = (a: ToolId[], b: ToolId[]) => a.length === b.length && a.every((t) => b.includes(t));

function offeredSets(declared: ToolId[]) {
  if (!declared.length) return TARGET_SETS;
  const fit = TARGET_SETS.filter((s) => s.tools.every((t) => declared.includes(t)));
  return fit.length ? fit : TARGET_SETS;
}

function rangeFor(pin: Pin, version: string | null): string | undefined {
  if (!version || pin === "latest") return undefined;
  if (pin === "exact") return version;
  const major = parseVersion(version)?.major;
  return major === undefined ? version : `^${major}`;
}

/** Inline choice inside a sentence: dotted underline plus a chevron, so it reads as text you can change. */
function InlineChoice({ label, value, items }: { label: string; value: string; items: { label: string; hint?: string; checked: boolean; onSelect: () => void }[] }) {
  return (
    <Menu
      label={`${label}: ${value}`}
      align="start"
      items={items}
      triggerClassName={cx(
        "h-auto! gap-0.5! rounded-sm! pl-0.5 align-baseline font-medium text-fg! underline decoration-line-control decoration-dotted underline-offset-[0.25em]",
        "min-h-6 -my-0.5 hover:bg-surface-3! hover:decoration-current max-md:-my-3 max-md:min-w-0!",
      )}
      trigger={
        <>
          {value}
          <ChevronDown className="size-3 translate-y-px text-fg-subtle" aria-hidden />
        </>
      }
    />
  );
}

const Path = ({ children }: { children: string }) => <span className="font-mono text-[0.92em] whitespace-nowrap text-fg">{children}</span>;

function joinWords(parts: React.ReactNode[]) {
  return parts.map((p, i) => (
    <span key={i}>
      {p}
      {i < parts.length - 2 ? ", " : i === parts.length - 2 ? " and " : ""}
    </span>
  ));
}

export function SkillInstall({
  name,
  tools,
  version,
  latest,
  meta,
  publicUrl,
  mcpUrl,
  deprecated = false,
}: {
  name: string;
  tools: ToolId[];
  /** The version the page shows. */
  version: string | null;
  latest: string | null;
  meta: VersionMeta | null;
  publicUrl: string;
  mcpUrl: string;
  /** A deprecated skill still installs, but its card loses the beam: nobody should be invited to it. */
  deprecated?: boolean;
}) {
  const isLatest = version !== null && version === latest;
  const sets = offeredSets(tools);
  const [pin, setPin] = useState<Pin>(isLatest ? "latest" : "exact");
  const [targets, setTargets] = useState<ToolId[]>(sets[0]!.tools);
  useEffect(() => setPin(isLatest ? "latest" : "exact"), [isLatest, version]);

  const range = rangeFor(pin, version);
  const major = version ? parseVersion(version)?.major : undefined;
  const ordered = TOOLS.filter((t) => targets.includes(t));
  const targetLabel = TARGET_SETS.find((s) => sameSet(s.tools, ordered))?.label ?? ordered.map((t) => TOOL_DIRS[t].label).join(" and ");

  const pinValue = pin === "latest" ? "the latest version" : pin === "caret" ? `the newest ${major ?? "x"}.x` : `exactly ${version}`;
  const pinItems = version
    ? [
        { label: "Latest", hint: "skips yanked", checked: pin === "latest", onSelect: () => setPin("latest") },
        { label: `Newest ${major ?? "x"}.x`, hint: `^${major ?? "x"}`, checked: pin === "caret", onSelect: () => setPin("caret") },
        { label: `Exactly ${version}`, hint: "pinned", checked: pin === "exact", onSelect: () => setPin("exact") },
      ]
    : [];
  const targetItems = sets.map((s) => ({
    label: s.label,
    hint: s.tools.length === 2 ? "default" : undefined,
    checked: sameSet(s.tools, ordered),
    onSelect: () => setTargets(s.tools),
  }));

  // The second choice and the punctuation after it never split across lines.
  const choices = (after: string) => (
    <>
      Installs <InlineChoice label="Version to install" value={pinValue} items={pinItems} /> into{" "}
      <span className="whitespace-nowrap">
        <InlineChoice label="Tools to install into" value={targetLabel} items={targetItems} />
        {after}
      </span>
    </>
  );

  const card = (
    <InstallCard
      title={deprecated ? "Still installs" : "Install"}
      beam={!deprecated}
      tabs={[
        {
          id: "terminal",
          label: "Terminal",
          command: installCommand(name, { range, tools: ordered }),
          note: (
            <>
              {choices(",")} for every project on this machine. Files land in {joinWords(ordered.map((t) => <Path key={t}>{`~/${TOOL_DIRS[t].global}`}</Path>))}.
            </>
          ),
        },
        {
          id: "project",
          label: "Project",
          command: installCommand(name, { range, tools: ordered, project: true }),
          note: (
            <>
              {choices("")} for this repository only, in {joinWords(ordered.map((t) => <Path key={t}>{`./${TOOL_DIRS[t].project}`}</Path>))}. It writes <Path>skills.lock.json</Path>: commit it so
              teammates get the same version.
            </>
          ),
        },
        {
          id: "agent",
          label: "Agent",
          command: agentPrompt(publicUrl, name),
          prose: true,
          note: "Paste this into Claude Code or Codex. The agent reads the registry's instructions, shows you what the skill does, then installs it.",
        },
        {
          id: "mcp",
          label: "MCP",
          command: mcpClaudeCommand(mcpUrl),
          note: (
            <>
              Adds this registry to Claude Code as an MCP server, so the agent can look up <Path>{name}</Path> itself. Create a token in{" "}
              <Link to="/settings" className="text-fg underline decoration-line-control underline-offset-[0.2em] hover:decoration-current">
                Settings
              </Link>{" "}
              first.
            </>
          ),
        },
      ]}
      footer={
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            <h3 className="text-sm font-semibold text-fg">Run once</h3>
            <span className="text-sm text-fg-subtle">Loads it for one session. Nothing lands on disk.</span>
          </div>
          <CopyCommand command={runCommand(name, version && !isLatest ? version : undefined)} label="Copy run command" size="sm" />
        </div>
      }
    />
  );

  return (
    <div className="flex flex-col gap-3">
      {card}
      {meta?.yanked && (
        <WarningLine>
          <span className="font-mono text-[0.93em]">{version}</span> is yanked: {meta.yanked.replace(/[.\s]+$/, "")}. It installs only when pinned exactly.
        </WarningLine>
      )}
      {meta?.tokens && <TokenLine tokens={meta.tokens} files={Math.max(0, meta.fileCount - 1)} />}
    </div>
  );
}

function N({ n }: { n: number }) {
  return <span className="font-mono text-fg tabular">{formatNumber(n)}</span>;
}

/** The cost line: what the skill costs in an agent's context, and when. */
export function TokenLine({ tokens, files }: { tokens: NonNullable<VersionMeta["tokens"]>; files: number }) {
  return (
    <p className="px-1 text-sm text-fg-muted">
      About <N n={tokens.metadata} /> tokens always in context (name and description), <N n={tokens.body} /> when used
      {tokens.references > 0 && files > 0 ? (
        <>
          , <N n={tokens.references} /> more on demand in {files === 1 ? "1 file" : `${files} files`}
        </>
      ) : null}
      .
    </p>
  );
}

export function InstallSkeleton() {
  return (
    <div className="rounded-xl border border-line bg-surface p-4" aria-hidden>
      <div className="flex items-center justify-between">
        <span className="skeleton block h-4 w-14" />
        <span className="flex gap-3">
          {[48, 44, 40, 32].map((w) => (
            <span key={w} className="skeleton block h-4" style={{ width: w }} />
          ))}
        </span>
      </div>
      <span className="skeleton mt-4 block h-10 rounded-md" />
      <span className="skeleton mt-3 block h-3.5 w-4/5" />
      <span className="skeleton mt-2 block h-3.5 w-3/5" />
      <span className="mt-4 block border-t border-line pt-3">
        <span className="skeleton block h-8 rounded-md" />
      </span>
    </div>
  );
}
