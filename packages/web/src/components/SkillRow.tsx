// The one row used for a skill in every list: Home, Skills, a stack, a team, a collection.
// Two lines: name, version and marks; then the description. Right side: who and how it is doing.
// The copy-install action appears on hover and on keyboard focus.
import { Link } from "react-router";
import { Check, Copy, Lock } from "lucide-react";
import type { SkillSummary } from "@intra-skills/shared/types";
import { stackLabel } from "@intra-skills/shared/stacks";
import { cx } from "../lib/cx";
import { useCopy } from "../lib/useCopy";
import { useRegistryMeta } from "../lib/meta";
import { KIND_LABELS, kindOf, marketplaceOf, primaryInstallCommand } from "../lib/kinds";
import { formatCompact, relativeTime } from "../lib/format";
import { PersonMark, Rank, VerifiedMark } from "./fx";
import { CopyCommand } from "./CopyCommand";

export function SkillRow({
  skill,
  rank,
  sequence,
  showTeam = true,
  showTrend = true,
  className,
}: {
  skill: SkillSummary;
  /** Position in a ranking: 01-03 read heavier. */
  rank?: number;
  /** Position in an install order (a collection): every number at one weight. */
  sequence?: number;
  showTeam?: boolean;
  showTrend?: boolean;
  className?: string;
}) {
  const { copied, copy } = useCopy(1500);
  const meta = useRegistryMeta();
  const kind = kindOf(skill);
  const cmd = primaryInstallCommand(skill.name, kind, marketplaceOf(meta));
  return (
    <li
      className={cx(
        "group/row relative flex items-start gap-4 border-b border-line px-1 py-3.5 transition-colors duration-[120ms] last:border-b-0 hover:bg-surface-2/60 focus-within:bg-surface-2/60 md:px-3",
        className,
      )}
    >
      {rank !== undefined && <Rank n={rank} className="pt-0.5" />}
      {sequence !== undefined && (
        <span className="w-6 shrink-0 pt-0.5 font-mono text-sm text-fg-muted tabular">{String(sequence).padStart(2, "0")}</span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            to={`/skills/${skill.name}`}
            className="font-mono text-[15px] font-medium text-fg [overflow-wrap:anywhere] md:truncate after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-line-control hover:underline-offset-4"
          >
            {skill.name}
          </Link>
          {skill.latestVersion && <span className="font-mono text-xs text-fg-subtle tabular">{skill.latestVersion}</span>}
          {kind !== "skill" && <KindMark kind={kind} />}
          {skill.verified && <VerifiedMark compact />}
          {skill.visibility === "private" && (
            <span className="inline-flex items-center gap-1 text-xs text-fg-muted" title="Only its team and people it is shared with can see it">
              <Lock aria-hidden className="size-3" />
              Private
            </span>
          )}
          {skill.deprecated && <span className="rounded-sm border border-warning-line bg-warning-soft px-1.5 text-xs text-warning-text">Deprecated</span>}
          {skill.health === "stale" && !skill.deprecated && <span className="text-xs text-fg-subtle">Stale</span>}
        </div>
        <p className="mt-1 line-clamp-1 text-sm text-fg-muted max-md:line-clamp-2">{skill.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          {showTeam && (skill.team ? <span>owned by <span className="text-fg-muted">{skill.team}</span></span> : <span>no owning team</span>)}
          {skill.stacks.length > 0 && <span className="font-mono">{skill.stacks.map(stackLabel).join(" · ")}</span>}
          <span className="inline-flex items-center gap-1.5">
            <PersonMark handle={skill.author.handle} name={skill.author.displayName} size={16} />
            {skill.author.displayName}
            <span aria-hidden>·</span>
            {relativeTime(skill.updatedAt)}
          </span>
        </div>
        {/* Touch: the install line itself, always there, since there is no hover to reveal it. */}
        <CopyCommand command={cmd} size="sm" label={`Copy install command for ${skill.name}`} className="relative z-10 mt-2.5 md:hidden" />
      </div>
      <div className="relative hidden shrink-0 items-center gap-6 pt-0.5 md:flex">
        <TrustCell trust={skill.trust} />
        {showTrend && (
          <span className="w-16 text-right text-sm text-fg-muted tabular" title={`${skill.installsWeek} installs in the last 7 days`}>
            {formatCompact(skill.installsWeek)}
          </span>
        )}
        <button
          type="button"
          onClick={() => void copy(cmd)}
          aria-label={copied ? "Copied" : `Copy install command for ${skill.name}`}
          title={cmd}
          className="z-10 inline-flex h-8 w-[92px] items-center justify-center gap-1.5 rounded-md border border-line-strong bg-surface font-mono text-xs text-fg-muted transition-colors duration-[120ms] hover:border-line-control hover:text-fg"
        >
          {copied ? <Check className="size-3.5 text-ok-text" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
          {copied ? "copied" : "install"}
        </button>
      </div>
    </li>
  );
}

/** Plugins and rules say what they are; a skill, the default, shows nothing. */
export function KindMark({ kind, className }: { kind: Exclude<ReturnType<typeof kindOf>, "skill">; className?: string }) {
  return (
    <span
      className={cx("inline-flex h-[18px] items-center rounded-sm border border-line-strong px-1.5 text-xs leading-none font-medium text-fg-muted", className)}
      title={kind === "plugin" ? "A Claude Code plugin: Claude Code installs and updates it" : "A rule: written into a project for Claude Code, Codex and Cursor"}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

/**
 * Share of teammates who said it works: one neutral meter and the number. Red only when most
 * voters said it is broken, so a 75% skill never reads as failing.
 */
function TrustCell({ trust }: { trust: SkillSummary["trust"] }) {
  const total = trust.works + trust.broken;
  if (total === 0) return <span className="w-[112px] text-xs whitespace-nowrap text-fg-subtle">No votes yet</span>;
  const pct = Math.round((trust.works / total) * 100);
  const failing = trust.broken > trust.works;
  return (
    <span className="flex w-[112px] items-center gap-2 whitespace-nowrap" title={`${trust.works} works, ${trust.broken} broken`}>
      <span aria-hidden className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-3">
        <span className={cx("block h-full rounded-full", failing ? "bg-danger" : "bg-fg-muted")} style={{ width: `${pct}%` }} />
      </span>
      <span className={cx("text-xs tabular", failing ? "text-danger-text" : "text-fg-muted")}>
        {pct}% <span className="text-fg-subtle">· {total}</span>
      </span>
    </span>
  );
}

/** A list frame for SkillRow: a plain ruled list, never a card grid. `header` labels the right-hand columns. */
export function SkillList({
  children,
  className,
  label,
  header = true,
  showTrend = true,
}: {
  children: React.ReactNode;
  className?: string;
  label?: string;
  header?: boolean;
  showTrend?: boolean;
}) {
  return (
    <div className={className}>
      {header && (
        <div aria-hidden className="hidden items-center justify-end gap-6 px-3 pb-2 text-xs text-fg-subtle md:flex">
          <span className="w-[112px]">Works, by votes</span>
          {showTrend && <span className="w-16 text-right">This week</span>}
          <span className="w-[92px]" />
        </div>
      )}
      <ul aria-label={label} className="border-y border-line">
        {children}
      </ul>
    </div>
  );
}
