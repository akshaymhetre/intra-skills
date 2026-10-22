// Home: where a teammate lands. One display heading with the search, the bootstrap line inside the
// beam card, then the team's skills, what is trending, stacks, collections and recent publishes.
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowRight, GitPullRequest, Search } from "lucide-react";
import type { Collection, FacetCount, HomeResponse } from "@intra-skills/shared/types";
import { stackLabel } from "@intra-skills/shared/stacks";
import { api } from "../api";
import { useMe } from "../auth";
import { useAsync } from "../lib/useAsync";
import { useDocTitle, useRegistryMeta } from "../lib/meta";
import { agentPrompt, bootstrapCommand, collectionInstallCommand, mcpClaudeCommand } from "../lib/commands";
import { formatNumber, plural } from "../lib/format";
import { DottedRule, SectionHeading, SpotlightTile, TeamMark } from "../components/fx";
import { InstallCard } from "../components/InstallCard";
import { SkillList, SkillRow } from "../components/SkillRow";
import { CopyCommand } from "../components/CopyCommand";
import { ErrorState, Skeleton } from "../components/ui";

export function Home() {
  useDocTitle("Home");
  const me = useMe();
  const meta = useRegistryMeta();
  const home = useAsync(() => api.home(), []);
  // Plugins and rules get two counts, not a section: the catalog filtered by kind is where they live.
  const plugins = home.data?.totals.kinds.plugin ?? 0;
  const rules = home.data?.totals.kinds.rule ?? 0;

  if (home.error) return <ErrorState error={home.error} onRetry={home.reload} />;
  const h = home.data;
  const url = meta?.publicUrl ?? window.location.origin;
  const skillCount = h?.totals.kinds.skill ?? 0;

  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 pb-20 md:px-10">
      <section className="grid gap-x-12 gap-y-8 pt-10 pb-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:pt-14">
        <div className="min-w-0">
          <SectionHeading as="h1" size="hero" cursor>
            Your team's skills, one line away.
          </SectionHeading>
          <p className="mt-4 max-w-xl text-base text-fg-muted">
            {h
              ? `${plural(skillCount, "skill")} from ${plural(h.totals.teams, "team")}. Find one, try it for a session, or install it into Claude Code, Codex and Cursor.`
              : "Find a skill, try it for a session, or install it into Claude Code, Codex and Cursor."}
          </p>
          <HeroSearch />
          {h && (
            <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <Stat label="installs this week" value={formatNumber(h.totals.installsWeek)} />
              <Stat label="skills" value={formatNumber(skillCount)} />
              <Stat label="teams" value={formatNumber(h.totals.teams)} />
              {plugins > 0 && <Stat label={plugins === 1 ? "plugin" : "plugins"} value={formatNumber(plugins)} to="/skills?q=kind%3Aplugin" />}
              {rules > 0 && <Stat label={rules === 1 ? "rule" : "rules"} value={formatNumber(rules)} to="/skills?q=kind%3Arule" />}
            </dl>
          )}
        </div>
        <div className="min-w-0 lg:pt-2">
          <InstallCard
            title="Set up your machine"
            tabs={[
              {
                id: "terminal",
                label: "Terminal",
                command: bootstrapCommand(url),
                note: "Installs the intra CLI, signs you in with a code you approve here, and teaches Claude Code and Codex to use this registry.",
              },
              {
                id: "agent",
                label: "Ask your agent",
                command: agentPrompt(url),
                prose: true,
                note: "Paste this into Claude Code or Codex. The agent reads the setup steps and asks you before it runs anything.",
              },
              {
                id: "mcp",
                label: "MCP",
                command: mcpClaudeCommand(meta?.mcpUrl ?? `${url}/api/mcp`),
                note: (
                  <>
                    For tools without a shell. Create a token in <Link to="/settings" className="underline underline-offset-4">Settings</Link> first.
                  </>
                ),
              },
            ]}
          />
          {me.role === "admin" && h && (h.reviewQueue > 0 || h.proposals.open > 0) && <AdminLine h={h} />}
        </div>
      </section>

      <DottedRule />

      {!h ? (
        <HomeSkeleton />
      ) : h.totals.skills === 0 ? (
        <FirstUse admin={me.role === "admin"} />
      ) : (
        <div className="space-y-16 pt-12">
          {h.proposals.mine.length > 0 && <MyProposals h={h} />}
          {h.teamSkills.length > 0 && (
            <section aria-labelledby="h-team">
              <SectionHeading
                id="h-team"
                mark="your team"
                description={`Owned by or shared with ${h.teams.map((t) => t.name).join(", ")}.`}
                actions={<SeeAll to={`/skills?q=${encodeURIComponent(h.teams.map((t) => `team:${t.slug}`).join(" "))}`} />}
              >
                For your team
              </SectionHeading>
              <SkillList className="mt-5" label="Your team's skills">
                {h.teamSkills.slice(0, 5).map((s) => (
                  <SkillRow key={s.name} skill={s} />
                ))}
              </SkillList>
            </section>
          )}

          <section aria-labelledby="h-trending">
            <SectionHeading
              id="h-trending"
              mark="Trending"
              description="Ranked by installs across the org in the last seven days."
              actions={<SeeAll to="/skills?sort=trending" />}
            >
              Trending this week
            </SectionHeading>
            <SkillList className="mt-5" label="Trending skills">
              {h.trending.map((s, i) => (
                <SkillRow key={s.name} skill={s} rank={i + 1} />
              ))}
            </SkillList>
          </section>

          {h.stacks.length > 0 && <Stacks stacks={h.stacks} />}
          {h.collections.length > 0 && <Collections collections={h.collections} />}

          <section aria-labelledby="h-recent">
            <SectionHeading id="h-recent" mark="published" actions={<SeeAll to="/skills" />}>
              Recently published
            </SectionHeading>
            <SkillList className="mt-5" label="Recently published" showTrend={false}>
              {h.recent.slice(0, 5).map((s) => (
                <SkillRow key={s.name} skill={s} showTrend={false} />
              ))}
            </SkillList>
          </section>
        </div>
      )}
    </div>
  );
}

function HeroSearch() {
  const [q, setQ] = useState("");
  const navigate = useNavigate();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/skills?q=${encodeURIComponent(q.trim())}` : "/skills");
  };
  return (
    <form role="search" onSubmit={submit} className="mt-7 max-w-xl">
      <label htmlFor="home-q" className="sr-only">
        Search skills
      </label>
      <div className="flex h-12 items-center gap-3 rounded-lg border border-line-strong bg-surface px-4 transition-colors duration-[120ms] focus-within:border-sel">
        <Search className="size-4 shrink-0 text-fg-subtle" aria-hidden />
        <input
          id="home-q"
          data-query-input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search skills or stack:aws"
          className="h-full min-w-0 flex-1 bg-transparent font-mono text-sm text-fg outline-none placeholder:text-fg-subtle"
          autoComplete="off"
          spellCheck={false}
        />
        <kbd className="rounded border border-line-strong px-1.5 font-mono text-xs text-fg-subtle max-md:hidden">/</kbd>
      </div>
    </form>
  );
}

function Stat({ label, value, to }: { label: string; value: string; to?: string }) {
  if (to)
    return (
      <div className="flex items-baseline">
        <dt className="sr-only">{label}</dt>
        <dd>
          <Link
            to={to}
            className="group/stat -mx-1 inline-flex items-baseline gap-2 rounded-sm px-1 transition-colors duration-[120ms] max-md:-my-2.5 max-md:py-2.5"
          >
            <span className="font-mono text-lg font-medium text-fg tabular">{value}</span>
            <span className="text-fg-muted underline decoration-line-control decoration-dotted underline-offset-4 group-hover/stat:text-fg group-hover/stat:decoration-current">
              {label}
            </span>
          </Link>
        </dd>
      </div>
    );
  return (
    <div className="flex items-baseline gap-2">
      <dt className="sr-only">{label}</dt>
      <dd className="font-mono text-lg font-medium text-fg tabular">{value}</dd>
      <span aria-hidden className="text-fg-muted">
        {label}
      </span>
    </div>
  );
}

function SeeAll({ to, label = "See all" }: { to: string; label?: string }) {
  return (
    <Link to={to} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-fg-muted transition-colors duration-[120ms] hover:text-fg max-md:h-11">
      {label}
      <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  );
}

function AdminLine({ h }: { h: HomeResponse }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 px-1 text-sm text-fg-muted">
      {h.reviewQueue > 0 && (
        <Link to="/admin/review" className="underline decoration-line-control underline-offset-4 hover:text-fg">
          {plural(h.reviewQueue, "skill")} waiting for review
        </Link>
      )}
      {h.proposals.open > 0 && (
        <Link to="/proposals" className="underline decoration-line-control underline-offset-4 hover:text-fg">
          {plural(h.proposals.open, "open proposal")}
        </Link>
      )}
    </div>
  );
}

function MyProposals({ h }: { h: HomeResponse }) {
  return (
    <section aria-labelledby="h-mine">
      <SectionHeading id="h-mine" mark="proposals" size="md" actions={<SeeAll to="/proposals" />}>
        Your proposals
      </SectionHeading>
      <ul className="mt-4 divide-y divide-line border-y border-line">
        {h.proposals.mine.slice(0, 3).map((p) => (
          <li key={p.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-3 md:px-3">
            <GitPullRequest className="size-4 text-fg-subtle" aria-hidden />
            <Link to={`/skills/${p.skill}`} className="font-mono text-sm font-medium text-fg hover:underline hover:underline-offset-4">
              {p.skill} <span className="text-fg-subtle">{p.version}</span>
            </Link>
            <span className="min-w-0 flex-1 text-sm text-fg-muted">{p.statusMessage}</span>
            {p.pullRequest && (
              <a href={p.pullRequest.url} target="_blank" rel="noreferrer" className="text-sm text-fg-muted underline decoration-line-control underline-offset-4 hover:text-fg">
                Pull request #{p.pullRequest.number}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Stacks({ stacks }: { stacks: FacetCount[] }) {
  return (
    <section aria-labelledby="h-stacks">
      <SectionHeading id="h-stacks" mark="stack" description="Skills grouped by the technology they work on." actions={<SeeAll to="/stacks" />}>
        Browse by stack
      </SectionHeading>
      <ul className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {stacks.slice(0, 8).map((s) => (
          <li key={s.value}>
            <SpotlightTile
              as={Link}
              to={`/stacks/${s.value}`}
              className="flex h-full min-h-[84px] flex-col justify-between rounded-lg border border-line bg-surface px-4 py-3.5 hover:border-line-strong"
            >
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{stackLabel(s.value)}</span>
              <span className="font-mono text-xs text-fg-subtle tabular">{plural(s.count, "skill")}</span>
            </SpotlightTile>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Collections({ collections }: { collections: Collection[] }) {
  return (
    <section aria-labelledby="h-coll">
      <SectionHeading id="h-coll" mark="one command" description="Sets of skills a team recommends together.">
        Install a set in one command
      </SectionHeading>
      <ul className="mt-5 grid gap-4 md:grid-cols-2">
        {collections.slice(0, 4).map((c) => (
          <li key={`${c.team}/${c.slug}`} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
            <div className="flex items-start gap-3">
              <TeamMark slug={c.team} size={32} />
              <div className="min-w-0 flex-1">
                <Link to={`/collections/${c.team}/${c.slug}`} className="text-[15px] font-semibold tracking-[-0.01em] text-fg hover:underline hover:underline-offset-4">
                  {c.title}
                </Link>
                <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{c.description}</p>
              </div>
            </div>
            <p className="font-mono text-xs text-fg-subtle">{c.skills.join(" · ")}</p>
            <CopyCommand command={collectionInstallCommand(c.team, c.slug)} size="sm" className="mt-auto" />
          </li>
        ))}
      </ul>
    </section>
  );
}

function FirstUse({ admin }: { admin: boolean }) {
  return (
    <section className="max-w-2xl pt-12">
      <SectionHeading mark="first" size="md">
        Publish the first skill
      </SectionHeading>
      <p className="mt-3 text-base text-fg-muted">
        A skill is a folder with a SKILL.md. Create one, then publish it.
        {admin ? " If your team keeps skills in a GitHub or Bitbucket repo, connect it and every merged pull request becomes a version." : ""}
      </p>
      <div className="mt-5 space-y-2">
        <CopyCommand command="intra init my-first-skill --team <your-team>" />
        <CopyCommand command="intra publish my-first-skill" />
      </div>
      {admin && (
        <Link to="/admin/repositories" className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover">
          Connect a repository
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      )}
    </section>
  );
}

function HomeSkeleton() {
  return (
    <div className="space-y-4 pt-12" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-8 w-64" />
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  );
}
