// The /skills catalog. The frontmatter query (lib/query.ts) lives in the URL as `?q=`: the keys a
// skill declares in its SKILL.md are the keys you type, the labels on the facet rail, and what the
// rows print. Results are ranked SkillRows, never a card grid.
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowRight, SlidersHorizontal, X } from "lucide-react";
import type { SkillListResponse, Team } from "@intra-skills/shared/types";
import { api } from "../api";
import { useMe } from "../auth";
import { useAsync } from "../lib/useAsync";
import { formatNumber } from "../lib/format";
import { kindNoun } from "../lib/kinds";
import {
  LEGACY_PARAM_KEYS,
  fromLegacyParams,
  hasQualifiers,
  isEmptyQuery,
  matchesClientSide,
  parseQuery,
  qualifierList,
  removeQualifier,
  serializeQuery,
  toggleQualifier,
  toSkillQuery,
  withDeprecated,
  withSort,
  type SortKey,
} from "../lib/query";
import { DottedRule, SectionHeading } from "../components/fx";
import { SkillList, SkillRow } from "../components/SkillRow";
import { CopyCommand } from "../components/CopyCommand";
import { Button, ErrorState, Select, cx } from "../components/ui";
import { QueryField } from "../components/catalog/QueryField";
import { FacetRail, FacetSkeleton, FilterSheet } from "../components/catalog/Facets";
import { SkillListSkeleton } from "../components/catalog/SkillListSkeleton";
import { useDocTitle } from "../lib/meta";

const SORTS: { value: SortKey; label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "trending", label: "Trending" },
  { value: "downloads", label: "Most installed" },
  { value: "name", label: "Name" },
];

export function Catalog() {
  const me = useMe();
  const [params, setParams] = useSearchParams();

  // Older links (?team=a&sort=trending) fold into one query once; afterwards the URL carries only `q`.
  useEffect(() => {
    const folded = fromLegacyParams(params);
    if (folded === null) return;
    const next = new URLSearchParams(params);
    for (const k of LEGACY_PARAM_KEYS) next.delete(k);
    if (folded) next.set("q", folded);
    else next.delete("q");
    setParams(next, { replace: true });
  }, [params, setParams]);

  useDocTitle("Skills");

  const urlQ = params.get("q") ?? "";
  const parsed = useMemo(() => parseQuery(urlQ), [urlQ]);
  const apiKey = JSON.stringify(toSkillQuery(parsed));
  const list = useAsync(() => api.listSkills(toSkillQuery(parsed)), [apiKey]);
  const teams = useAsync(() => api.listTeams(), []);
  const [sheet, setSheet] = useState(false);

  const setQuery = (q: string, replace = false) => {
    const next = new URLSearchParams(params);
    if (q.trim()) next.set("q", q.trim());
    else next.delete("q");
    setParams(next, { replace });
  };
  // Clearing filters keeps the free text and the sort: only the qualifiers go.
  const clearFilters = () => setQuery(serializeQuery({ ...parseQuery(""), text: parsed.text, sort: parsed.sort }));

  const teamName = (slug: string) => teams.data?.find((t: Team) => t.slug === slug)?.name ?? slug;
  const data = list.data;
  const skills = data ? data.skills.filter((s) => matchesClientSide(parsed, s)) : [];
  const total = data ? (parsed.deprecated === "only" ? skills.length : data.total) : 0;
  const filtered = hasQualifiers(parsed);
  const failed = !!list.error && !data;
  // The registry itself is empty: there is nothing to facet or sort, so the first-use state owns the page.
  const registryEmpty = !!data && data.total === 0 && isEmptyQuery(parsed);
  const sort = parsed.sort ?? "updated";
  const chips = qualifierList(parsed);
  // A short filtered result installs as one line; deprecated and unpublished skills are left out of it.
  // One `intra install` line only makes sense for skills; a plugin installs through Claude Code.
  const installable = skills.filter((s) => s.latestVersion && !s.deprecated && (s.kind ?? "skill") === "skill").map((s) => s.name);
  // Filtered to one kind, counts name it ("3 plugins"); otherwise everything is counted as skills.
  const one = parsed.kind.length === 1 ? (parsed.kind[0] as "skill" | "plugin" | "rule") : null;
  // Mixed kinds on one page are counted as results, so "20 skills" never counts plugins and rules as skills.
  const mixed = !one && skills.some((s) => (s.kind ?? "skill") !== "skill");
  const noun = (n: number) => (one ? kindNoun(one) : mixed ? "result" : "skill") + (n === 1 ? "" : "s");

  const rail = data && (
    <FacetRail
      facets={data.facets}
      query={parsed}
      teamName={teamName}
      onToggle={(k, v) => setQuery(toggleQualifier(urlQ, k, v))}
      onDeprecated={(mode) => setQuery(withDeprecated(urlQ, parsed.deprecated === mode ? "include" : mode))}
    />
  );

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 pb-20 md:px-10">
      <header className="pt-8 pb-6 lg:pt-10">
        <SectionHeading
          as="h1"
          size="lg"
          mark="skill"
          description={
            <>
              Search by what each <span className="font-mono text-[0.93em]">SKILL.md</span>, <span className="font-mono text-[0.93em]">plugin.json</span> or{" "}
              <span className="font-mono text-[0.93em]">RULE.md</span> declares. Every result installs in one line.
            </>
          }
        >
          {one && one !== "skill" ? `Find a ${kindNoun(one)}` : "Find a skill"}
        </SectionHeading>
        {!registryEmpty && (
          <>
            <QueryField value={urlQ} onCommit={setQuery} className="mt-6 max-w-3xl" />
            {!urlQ && data && <Suggestions data={data} myTeam={me.teams[0]?.slug} onPick={(q) => setQuery(q)} />}
          </>
        )}
      </header>

      <DottedRule />

      {failed ? (
        <div className="-mx-6">
          <ErrorState error={list.error} onRetry={list.reload} title="The skills list did not load" align="start" />
        </div>
      ) : registryEmpty ? (
        <FirstUse admin={me.role === "admin"} />
      ) : (
        <div className="min-[900px]:grid min-[900px]:grid-cols-[208px_minmax(0,1fr)]">
          {/* The rail is a grid item, so its border runs the full height of the results, however long. */}
          <aside aria-label="Filters" className="border-r border-line max-[899px]:hidden">
            <div className="sticky top-12 max-h-[calc(100dvh-3rem)] overflow-y-auto overscroll-contain py-7 pr-5 pl-0">{rail ?? <FacetSkeleton />}</div>
          </aside>

          <section aria-label="Results" className="min-w-0 pt-6 min-[900px]:pl-8">
            <div className="flex min-h-9 flex-wrap items-center gap-x-4 gap-y-2 pb-4 md:pl-3">
              <p className="text-sm text-fg-muted" aria-live="polite">
                {data ? (
                  <>
                    <span className="font-mono text-base font-medium text-fg tabular">{formatNumber(total)}</span> {noun(total)}
                    {filtered && total > 0 && <span className="max-[899px]:hidden"> {total === 1 ? "matches" : "match"} these filters</span>}
                  </>
                ) : (
                  "Loading skills"
                )}
              </p>
              {filtered && skills.length > 0 && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex h-7 items-center rounded-md px-1.5 text-sm text-fg-muted underline decoration-line-control underline-offset-4 transition-colors duration-[120ms] hover:text-fg max-[899px]:hidden"
                >
                  Clear filters
                </button>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button size="sm" className="min-[900px]:hidden" icon={<SlidersHorizontal className="size-3.5" aria-hidden />} onClick={() => setSheet(true)} disabled={!data}>
                  Filter{chips.length > 0 && <span className="font-mono text-fg-muted tabular">{chips.length}</span>}
                </Button>
                <label htmlFor="catalog-sort" className="text-sm text-fg-subtle max-sm:sr-only">
                  Sort
                </label>
                <Select id="catalog-sort" value={sort} onChange={(e) => setQuery(withSort(urlQ, e.target.value as SortKey))}>
                  {SORTS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {chips.length > 0 && (
              <ul aria-label="Active filters" className="-mt-1 flex flex-wrap gap-1.5 pb-4 min-[900px]:hidden">
                {chips.map((c) => (
                  <li key={c}>
                    <button
                      type="button"
                      onClick={() => setQuery(removeQualifier(urlQ, c))}
                      aria-label={`Remove ${c}`}
                      className="inline-flex h-11 items-center gap-1.5 rounded-md border border-line-strong bg-surface pr-2 pl-2.5 font-mono text-sm text-fg"
                    >
                      {c}
                      <X className="size-3.5 text-fg-subtle" aria-hidden />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {!data ? (
              <SkillListSkeleton rows={7} ranked={sort === "trending"} />
            ) : skills.length === 0 ? (
              <FilteredEmpty
                noun={noun(2)}
                query={urlQ}
                chips={chips}
                onRemove={(c) => setQuery(removeQualifier(urlQ, c))}
                onClear={() => setQuery("")}
              />
            ) : (
              <>
                {filtered && installable.length > 1 && installable.length <= 6 && (
                  <div className="mb-4 flex flex-col gap-1.5 md:pl-3">
                    <p className="text-sm text-fg-muted">
                      Install {installable.length < skills.length ? `the ${installable.length} current ones` : installable.length === 2 ? "both" : `all ${installable.length}`} in one line
                    </p>
                    <CopyCommand command={`intra install ${installable.join(" ")}`} label={`Copy install command for these ${installable.length} skills`} />
                  </div>
                )}
              <SkillList label="Skills" className={cx("transition-opacity duration-[120ms]", list.loading && "opacity-60")}>
                {skills.map((s, i) => (
                  <SkillRow key={s.name} skill={s} rank={sort === "trending" ? i + 1 : undefined} showTrend={sort !== "name"} />
                ))}
              </SkillList>
              </>
            )}
          </section>
        </div>
      )}

      <FilterSheet open={sheet} onClose={() => setSheet(false)} total={total} noun={noun} canClear={filtered} onClear={clearFilters}>
        {rail}
      </FilterSheet>
    </div>
  );
}

/** Real starting points drawn from this registry: its biggest stack, the reader's team, and the two registry facts. */
function Suggestions({ data, myTeam, onPick }: { data: SkillListResponse; myTeam?: string; onPick: (q: string) => void }) {
  const picks = [
    data.facets.stacks[0] && `stack:${data.facets.stacks[0].value}`,
    data.facets.kinds?.some((k) => k.value === "plugin") && "kind:plugin",
    myTeam && data.facets.teams.some((t) => t.value === myTeam) && `team:${myTeam}`,
    "is:verified",
    "sort:trending",
  ].filter((x): x is string => typeof x === "string");
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-sm text-fg-subtle">
      <span className="mr-1">Try</span>
      {picks.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          className="inline-flex h-7 items-center rounded-md px-1.5 font-mono text-sm text-fg-muted underline decoration-line-control decoration-dotted underline-offset-4 transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg max-md:h-11"
        >
          {p}
        </button>
      ))}
    </div>
  );
}

function FilteredEmpty({ noun, query, chips, onRemove, onClear }: { noun: string; query: string; chips: string[]; onRemove: (c: string) => void; onClear: () => void }) {
  const parsed = parseQuery(query);
  return (
    <div className="border-y border-line px-1 py-12 md:px-3">
      <h2 className="text-lg font-semibold">No {noun} match</h2>
      <p className="mt-3 inline-block max-w-full rounded-md border border-line bg-panel px-3 py-1.5 font-mono text-sm break-words text-fg">{query}</p>
      <p className="mt-3 max-w-lg text-sm text-fg-muted">
        {chips.length > 1
          ? "Values of one key match any of them, and different keys must all match. Remove one to widen the search."
          : parsed.text.length
            ? "No name, description or tag contains that text. Check the spelling, or search for a tag instead."
            : `No published ${noun.replace(/s$/, "")} declares this value.`}
      </p>
      {chips.length > 1 && (
        <ul aria-label="Remove one filter" className="mt-4 flex flex-wrap gap-1.5">
          {chips.map((c) => (
            <li key={c}>
              <button
                type="button"
                onClick={() => onRemove(c)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface pr-2 pl-2.5 font-mono text-sm text-fg transition-colors duration-[120ms] hover:border-line-control hover:bg-surface-2 max-md:h-11"
              >
                <span className="sr-only">Remove</span>
                {c}
                <X className="size-3.5 text-fg-subtle" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button className="mt-5" variant="primary" onClick={onClear}>
        Clear filters
      </Button>
    </div>
  );
}

function FirstUse({ admin }: { admin: boolean }) {
  return (
    <section className="max-w-2xl pt-12" aria-labelledby="catalog-first">
      <SectionHeading id="catalog-first" mark="first" size="md">
        Publish the first skill
      </SectionHeading>
      <p className="mt-3 text-base text-fg-muted">
        A skill is a folder with a <span className="font-mono text-[0.93em]">SKILL.md</span>. Publish one and it shows up here, searchable by every key in its frontmatter.
        {admin ? " If your team keeps skills in a GitHub or Bitbucket repo, connect it and every merged pull request becomes a version." : ""}
      </p>
      <ol className="mt-6 flex flex-col gap-4 text-sm">
        <li>
          <p className="mb-1.5 text-fg-muted">Create a skill folder, or skip this if you have one</p>
          <CopyCommand command="intra init my-first-skill --team <your-team>" />
        </li>
        <li>
          <p className="mb-1.5 text-fg-muted">Publish it to this registry</p>
          <CopyCommand command="intra publish my-first-skill" />
        </li>
      </ol>
      {admin && (
        <Link to="/admin/repositories" className="mt-6 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover max-md:h-11">
          Connect a repository
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </section>
  );
}
