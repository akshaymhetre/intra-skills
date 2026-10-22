// /stacks: every technology a skill declares in `metadata.stacks`, as a ranked index with counts and
// the top three skills. /stacks/:stack: that stack's skills ranked by installs this week, plus the teams that
// own them. Both read the same GET /api/skills, so the counts always agree with the catalog.
import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight } from "lucide-react";
import type { SkillSummary } from "@intra-skills/shared/types";
import { STACK_RULES, stackLabel } from "@intra-skills/shared/stacks";
import { api } from "../api";
import { useAsync } from "../lib/useAsync";
import { formatCompact, plural } from "../lib/format";
import { DottedRule, Rank, SectionHeading, TeamMark } from "../components/fx";
import { SkillList, SkillRow } from "../components/SkillRow";
import { EmptyState, ErrorState, Skeleton } from "../components/ui";
import { SkillListSkeleton } from "../components/catalog/SkillListSkeleton";
import { CopyCommand } from "../components/CopyCommand";
import { useDocTitle } from "../lib/meta";

const PAGE = "mx-auto w-full max-w-[1180px] px-5 pb-20 md:px-10";

// ---------- /stacks ----------

export function StacksIndex() {
  const list = useAsync(() => api.listSkills({ sort: "trending" }), []);
  useDocTitle("Stacks");

  const tiles = useMemo(() => {
    const d = list.data;
    if (!d) return null;
    return d.facets.stacks.map((f) => ({
      stack: f.value,
      count: f.count,
      // The list is already in trending order, so the first three carrying the stack are its top three.
      top: d.skills.filter((s) => s.stacks.includes(f.value)).slice(0, 3),
      installs: d.skills.filter((s) => s.stacks.includes(f.value)).reduce((n, s) => n + s.installsWeek, 0),
    })).sort((a, b) => b.installs - a.installs || b.count - a.count || a.stack.localeCompare(b.stack));
  }, [list.data]);
  const unstacked = list.data?.skills.filter((s) => s.stacks.length === 0).length ?? 0;

  return (
    <div className={PAGE}>
      <header className="pt-8 pb-6 lg:pt-10">
        <SectionHeading
          as="h1"
          size="lg"
          mark="stack"
          description={
            <>
              Skills grouped by the technology they work on, from the <span className="font-mono text-[0.93em]">stacks</span> key in each SKILL.md.
            </>
          }
        >
          Browse by stack
        </SectionHeading>
      </header>
      <DottedRule />

      {list.error && !list.data ? (
        <div className="-mx-6">
          <ErrorState error={list.error} onRetry={list.reload} title="The stacks did not load" align="start" />
        </div>
      ) : !tiles ? (
        <ul className="mt-6 border-y border-line" aria-busy="true" aria-label="Loading stacks">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i} className="flex items-center gap-4 border-b border-line px-1 py-4 last:border-b-0 md:px-3">
              <Skeleton className="h-4 w-6" />
              <Skeleton className="h-4 w-40" />
              <Skeleton className="ml-auto h-3 w-48" />
            </li>
          ))}
        </ul>
      ) : tiles.length === 0 ? (
        <div className="-mx-6">
          <EmptyState title="No skill declares a stack yet" align="start">
            Add <span className="font-mono">stacks: [terraform, aws]</span> under <span className="font-mono">metadata</span> in a SKILL.md and publish it. The stack
            appears here with its skills.
          </EmptyState>
        </div>
      ) : (
        <>
          <div aria-hidden className="mt-6 hidden items-center gap-4 px-3 pb-2 text-xs text-fg-subtle md:flex">
            <span className="w-6" />
            <span className="w-48">Stack</span>
            <span className="min-w-0 flex-1">Most installed</span>
            <span className="w-40 text-right">Installs, 7 days</span>
          </div>
          <ol className="border-y border-line max-md:mt-6">
            {tiles.map((t, i) => {
              const max = Math.max(1, ...tiles.map((x) => x.installs));
              return (
                <li key={t.stack} className="group/row relative flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line px-1 py-3.5 transition-colors duration-[120ms] last:border-b-0 hover:bg-surface-2/60 md:flex-nowrap md:px-3">
                  <Rank n={i + 1} />
                  <span className="w-48 min-w-0">
                    <Link
                      to={`/stacks/${encodeURIComponent(t.stack)}`}
                      className="text-[15px] font-semibold tracking-[-0.01em] text-fg after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-line-control hover:underline-offset-4"
                    >
                      {stackLabel(t.stack)}
                    </Link>
                    <span className="block text-xs text-fg-subtle tabular">{plural(t.count, "skill")}</span>
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-sm text-fg-muted max-md:basis-full max-md:pl-10">
                    {t.top.map((s) => s.name).join(" · ")}
                  </span>
                  <span className="flex w-40 items-center justify-end gap-3 max-md:hidden">
                    <span aria-hidden className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-3">
                      <span className="block h-full rounded-full bg-fg-subtle" style={{ width: `${Math.round((t.installs / max) * 100)}%` }} />
                    </span>
                    <span className="w-8 text-right text-sm text-fg-muted tabular">{formatCompact(t.installs)}</span>
                  </span>
                </li>
              );
            })}
          </ol>
          {unstacked > 0 && (
            <p className="mt-6 text-sm text-fg-muted">
              {plural(unstacked, "skill")} {unstacked === 1 ? "declares" : "declare"} no stack.{" "}
              <Link to="/skills" className="text-fg underline decoration-line-control underline-offset-4 hover:decoration-current">
                See every skill
              </Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}

// ---------- /stacks/:stack ----------

export function StackPage() {
  const { stack = "" } = useParams();
  const slug = stack.toLowerCase();
  const label = stackLabel(slug);
  const list = useAsync(() => api.listSkills({ stack: [slug], sort: "trending" }), [slug]);
  const teams = useAsync(() => api.listTeams(), []);
  useDocTitle(`${label} skills`);

  const d = list.data;
  const teamName = (s: string) => teams.data?.find((t) => t.slug === s)?.name ?? s;
  const paired = useMemo(() => (d ? pairedStacks(d.skills, slug) : []), [d, slug]);
  const known = STACK_RULES.some((r) => r.stack === slug);
  const installs = d?.skills.reduce((n, s) => n + s.installsWeek, 0) ?? 0;
  const installTop = (d?.skills ?? []).filter((s) => s.latestVersion && !s.deprecated).slice(0, 3).map((s) => s.name);

  return (
    <div className={PAGE}>
      <header className="pt-8 pb-6 lg:pt-10">
        <SectionHeading
          as="h1"
          size="lg"
          mark={d?.total === 0 ? undefined : label}
          description={
            d && d.total > 0
              ? `${plural(d.total, "skill")} ${d.total === 1 ? "declares" : "declare"} ${label}, ranked by installs across the org in the last seven days.`
              : undefined
          }
          actions={
            d && d.total > 0 ? (
              <Link
                to={`/skills?q=${encodeURIComponent(`stack:${slug}`)}`}
                className="-mx-2 inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-fg-muted transition-colors duration-[120ms] hover:text-fg max-md:h-11"
              >
                Filter in the catalog
                <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            ) : undefined
          }
        >
          {d?.total === 0 ? (known ? `No ${label} skills yet` : `No stack called ${slug}`) : `${label} skills`}
        </SectionHeading>
        {d?.total === 0 && <p className="mt-3 font-mono text-xs text-fg-subtle">stack:{slug}</p>}
      </header>
      <DottedRule />

      {list.error && !d ? (
        <div className="-mx-6">
          <ErrorState error={list.error} onRetry={list.reload} title={`${label} skills did not load`} align="start" />
        </div>
      ) : !d ? (
        <div className="grid gap-x-10 gap-y-10 pt-8 lg:grid-cols-[minmax(0,1fr)_232px]">
          <SkillListSkeleton rows={5} ranked />
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      ) : d.total === 0 ? (
        <div className="max-w-xl pt-8">
          <p className="text-base text-fg-muted">
            {known ? (
              <>
                Add <span className="font-mono text-[0.93em]">{slug}</span> to <span className="font-mono text-[0.93em]">metadata.stacks</span> in a SKILL.md and publish
                it, and it is listed here.
              </>
            ) : (
              <>
                No published skill declares <span className="font-mono text-[0.93em]">stack:{slug}</span>. Check the spelling, or pick a stack from the list.
              </>
            )}
          </p>
          <Link
            to="/stacks"
            className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover max-md:h-11"
          >
            See every stack
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </div>
      ) : (
        <div className="grid gap-x-10 gap-y-12 pt-8 lg:grid-cols-[minmax(0,1fr)_232px]">
          <section aria-label={`${label} skills, ranked`} className="min-w-0">
            {installTop.length > 1 && (
              <div className="mb-4 flex flex-col gap-1.5 md:pl-3">
                <p className="text-sm text-fg-muted">{installTop.length < d.skills.length ? `Install the top ${installTop.length} in one line` : installTop.length === 2 ? "Install both in one line" : `Install all ${installTop.length} in one line`}</p>
                <CopyCommand command={`intra install ${installTop.join(" ")}`} label={`Copy install command for the top ${label} skills`} />
              </div>
            )}
            <SkillList label={`${label} skills`}>
              {d.skills.map((s, i) => (
                <SkillRow key={s.name} skill={s} rank={i + 1} />
              ))}
            </SkillList>
          </section>

          <aside className="flex min-w-0 flex-col gap-10 lg:pt-1">
            <section aria-labelledby="stack-teams">
              <h2 id="stack-teams" className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
                Teams working with {label}
              </h2>
              {d.facets.teams.length === 0 ? (
                <p className="mt-2 text-sm text-fg-muted">No team owns these skills yet.</p>
              ) : (
                <ul className="mt-3 flex flex-col">
                  {d.facets.teams.map((t) => (
                    <li key={t.value}>
                      <Link
                        to={`/teams/${encodeURIComponent(t.value)}`}
                        className="-mx-2 flex h-10 items-center gap-3 rounded-md px-2 transition-colors duration-[120ms] hover:bg-surface-2 max-md:h-11"
                      >
                        <TeamMark slug={t.value} name={teamName(t.value)} size={24} />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">{teamName(t.value)}</span>
                        <span className="font-mono text-xs text-fg-subtle tabular">{plural(t.count, "skill")}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <dl className="grid grid-cols-2 gap-4 border-t border-dashed border-line pt-5">
              <div>
                <dt className="text-xs text-fg-subtle">Installs this week</dt>
                <dd className="mt-0.5 font-mono text-lg font-medium text-fg tabular">{formatCompact(installs)}</dd>
              </div>
              <div>
                <dt className="text-xs text-fg-subtle">Verified</dt>
                <dd className="mt-0.5 font-mono text-lg font-medium text-fg tabular">
                  {d.skills.filter((s) => s.verified).length}
                  <span className="text-sm text-fg-subtle"> of {d.total}</span>
                </dd>
              </div>
            </dl>

            {paired.length > 0 && (
              <section aria-labelledby="stack-paired">
                <h2 id="stack-paired" className="text-[15px] font-semibold tracking-[-0.01em] text-fg">
                  Often paired with
                </h2>
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {paired.map((p) => (
                    <li key={p.stack}>
                      <Link
                        to={`/stacks/${encodeURIComponent(p.stack)}`}
                        className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-sm text-fg transition-colors duration-[120ms] hover:border-line-strong hover:bg-surface-2 max-md:h-11"
                      >
                        {stackLabel(p.stack)}
                        <span className="font-mono text-xs text-fg-subtle tabular">{p.count}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

/** Other stacks declared by the same skills, most shared first. */
function pairedStacks(skills: SkillSummary[], stack: string): { stack: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const s of skills) for (const o of s.stacks) if (o !== stack) counts.set(o, (counts.get(o) ?? 0) + 1);
  return [...counts].map(([s, count]) => ({ stack: s, count })).sort((a, b) => b.count - a.count || a.stack.localeCompare(b.stack));
}
