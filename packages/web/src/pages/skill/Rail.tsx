// The right rail (stacked under the install card on phones): what a careful reader checks before
// installing. Behaviors first, then what the registry recorded, where the skill comes from, open
// proposals, and the keys SKILL.md declares (each a catalog query).
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ExternalLink, GitPullRequest, TriangleAlert } from "lucide-react";
import { stackLabel } from "@intra-skills/shared/stacks";
import { TOOLS, type Behavior, type SkillDetail, type VersionMeta } from "@intra-skills/shared/types";
import { formatBytes, formatDateTime, formatNumber, plural, relativeTime, shortSha } from "../../lib/format";
import { DottedRule, PersonMark } from "../../components/fx";
import { CopyButton, WarningLine, cx, toolLabel } from "../../components/ui";
import { KIND_FILE, kindNoun, kindOf } from "../../lib/kinds";

function RailSection({ id, title, meta, children }: { id: string; title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id={id} className="text-sm font-semibold text-fg">
          {title}
        </h2>
        {meta && <span className="text-xs text-fg-subtle tabular">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

const ext = "text-fg underline decoration-line-control underline-offset-[0.2em] hover:decoration-current";

function ExtLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cx(ext, "inline-flex min-h-6 items-center gap-1 max-md:min-h-11", className)}>
      {children}
      <ExternalLink className="size-3 shrink-0 text-fg-subtle" aria-hidden />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {relativeTime(iso)}
    </time>
  );
}

/** Facts in two columns: a sans label, then the value. */
function Facts({ rows }: { rows: { k: string; v: ReactNode; hidden?: boolean }[] }) {
  return (
    <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      {rows
        .filter((r) => !r.hidden)
        .map((r) => (
          <div key={r.k} className="contents">
            <dt className="text-fg-subtle">{r.k}</dt>
            <dd className="min-w-0 text-fg">{r.v}</dd>
          </div>
        ))}
    </dl>
  );
}

// ---------- behaviors ----------

function BehaviorItem({ b }: { b: Behavior }) {
  return (
    <li className="min-w-0 py-2.5 first:pt-0 last:pb-0">
      <p className="text-sm text-fg">{b.label}</p>
      <p className="mt-0.5 font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">
        {b.file}
        {b.line !== null ? `:${b.line}` : ""}
      </p>
      {b.match && b.match !== b.file && (
        <code className="mt-1.5 block rounded-[4px] border border-line bg-panel px-2 py-1 font-mono text-xs leading-5 whitespace-pre-wrap text-fg-muted [overflow-wrap:anywhere]">
          {b.match}
        </code>
      )}
    </li>
  );
}

export function Behaviors({ meta, noun = "skill" }: { meta: VersionMeta | null; noun?: string }) {
  if (!meta) return null;
  const ask = meta.behaviors.filter((b) => b.tier === "ask");
  const info = meta.behaviors.filter((b) => b.tier !== "ask");
  const preScan = meta.tokens === null && meta.behaviors.length === 0;
  return (
    <RailSection id="rail-behaviors" title="Behaviors" meta={meta.behaviors.length ? plural(meta.behaviors.length, "match", "matches") : undefined}>
      {preScan ? (
        <p className="text-sm text-fg-muted">This version was published before the registry scanned {noun}s, so it has no behaviors list. Read its files before you install it.</p>
      ) : meta.behaviors.length === 0 ? (
        <p className="text-sm text-fg-muted">
          <span className="font-medium text-fg">No behaviors matched.</span> The scan looks for fixed patterns such as piping to a shell or deleting folders, so it misses
          obfuscated code.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {ask.length > 0 && (
            <div className="rounded-lg border border-warning-line bg-warning-soft p-3">
              <p className="flex items-start gap-2 text-sm font-medium text-warning-text">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {noun === "plugin" ? "Read these before you install it. Claude Code runs them without asking each time." : `An agent should show you these before following the ${noun}.`}
              </p>
              <ul className="mt-3 divide-y divide-warning-line">
                {ask.map((b, i) => (
                  <BehaviorItem key={`${b.id}-${i}`} b={b} />
                ))}
              </ul>
            </div>
          )}
          {info.length > 0 && (
            <div>
              {ask.length > 0 && <h3 className="mb-2 text-xs font-medium text-fg-subtle">Worth knowing</h3>}
              <ul className="divide-y divide-line">
                {info.map((b, i) => (
                  <BehaviorItem key={`${b.id}-${i}`} b={b} />
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-fg-subtle">Found by a fixed-pattern scan at publish. It misses obfuscated code.</p>
        </div>
      )}
    </RailSection>
  );
}

// ---------- registry facts ----------

function Registry({ skill: s, meta }: { skill: SkillDetail; meta: VersionMeta | null }) {
  const v = s.verification;
  return (
    <RailSection id="rail-registry" title="Registry" meta={meta ? <span className="font-mono">{meta.version}</span> : undefined}>
      <Facts
        rows={[
          { k: "Published", hidden: !meta, v: meta && <When iso={meta.publishedAt} /> },
          { k: "By", hidden: !meta, v: meta && <span className="font-mono text-[13px]">@{meta.publishedBy}</span> },
          {
            k: "Commit",
            hidden: !meta?.git,
            v: meta?.git && (
              <span className="flex flex-col gap-1">
                {meta.git.url ? (
                  <ExtLink href={meta.git.url} className="font-mono text-[13px] tabular">
                    {shortSha(meta.git.commit)}
                  </ExtLink>
                ) : (
                  <span className="font-mono text-[13px] tabular" title={meta.git.commit}>
                    {shortSha(meta.git.commit)}
                  </span>
                )}
                {meta.git.dirty && <WarningLine>Published with uncommitted changes, so the files do not match this commit.</WarningLine>}
              </span>
            ),
          },
          {
            k: "SHA-256",
            hidden: !meta,
            v: meta && (
              <span className="flex items-center gap-1">
                <span className="font-mono text-[13px] tabular" title={meta.sha256}>
                  {meta.sha256.slice(0, 12)}
                </span>
                <CopyButton text={meta.sha256} label={`Copy the full SHA-256 of ${meta.version}`} className="-my-1 h-6 min-w-6 max-md:-my-3.5" />
              </span>
            ),
          },
          { k: "Size", hidden: !meta, v: meta && <span className="tabular">{formatBytes(meta.size)}</span> },
          { k: "Files", hidden: !meta, v: meta && <span className="tabular">{formatNumber(meta.fileCount)}</span> },
          {
            k: "Installs",
            v: (
              <span className="tabular">
                {formatNumber(s.downloads)} <span className="text-fg-muted">all time</span>
              </span>
            ),
          },
          {
            k: "Verified",
            hidden: !v,
            v: v && (
              <span>
                <span className="font-mono text-[13px]">{v.version}</span> <span className="text-fg-muted">by</span> {v.by.displayName}
                <span className="text-fg-muted">
                  , <When iso={v.at} />
                </span>
                {!s.verified && <span className="mt-0.5 block text-sm text-fg-muted">The latest version asks for more than the one an admin reviewed.</span>}
              </span>
            ),
          },
        ]}
      />
    </RailSection>
  );
}

// ---------- provenance ----------

const PROVIDER: Record<string, string> = { github: "GitHub", bitbucket: "Bitbucket Cloud" };

function Provenance({ skill: s, meta }: { skill: SkillDetail; meta: VersionMeta | null }) {
  const pr = meta?.git?.pullRequest;
  return (
    <RailSection id="rail-provenance" title="Provenance">
      {s.source ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-fg-muted">
            Managed in a {PROVIDER[s.source.provider] ?? s.source.provider} repository. Every merged pull request becomes a version.
          </p>
          <Facts
            rows={[
              { k: "Repository", v: <span className="font-mono text-[13px] [overflow-wrap:anywhere]">{s.source.repo}</span> },
              { k: "Folder", v: <ExtLink href={s.source.webUrl} className="font-mono text-[13px] [overflow-wrap:anywhere]">{s.source.path}</ExtLink> },
              { k: "From", hidden: !pr, v: pr && <ExtLink href={pr.url}>Pull request #{pr.number}</ExtLink> },
            ]}
          />
        </div>
      ) : (
        <div className="flex flex-col gap-2 text-sm">
          <p className="text-fg-muted">
            Published directly with <span className="font-mono text-[0.93em] whitespace-nowrap text-fg">intra publish</span>
            {meta?.git?.repo ? (
              <>
                {" "}
                from a checkout of <span className="font-mono text-[0.93em] text-fg [overflow-wrap:anywhere]">{meta.git.repo}</span>.
              </>
            ) : (
              ". No git repository was recorded."
            )}
          </p>
          {pr && (
            <p>
              <ExtLink href={pr.url}>Pull request #{pr.number}</ExtLink>
            </p>
          )}
        </div>
      )}
    </RailSection>
  );
}

// ---------- proposals ----------

function Proposals({ skill: s }: { skill: SkillDetail }) {
  if (!s.proposals.length) return null;
  return (
    <RailSection id="rail-proposals" title="Open proposals" meta={formatNumber(s.proposals.length)}>
      <ul className="divide-y divide-line">
        {s.proposals.map((p) => (
          <li key={p.id} className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
            <GitPullRequest className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            <div className="min-w-0 text-sm">
              <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-mono font-medium text-fg">{p.version}</span>
                <span className="inline-flex items-center gap-1.5 text-fg-muted">
                  <PersonMark handle={p.proposer.handle} name={p.proposer.displayName} size={16} />
                  {p.proposer.displayName}
                </span>
              </p>
              <p className="mt-0.5 text-fg-muted">{p.statusMessage}</p>
              {p.pullRequest && (
                <p className="mt-1">
                  <ExtLink href={p.pullRequest.url}>Pull request #{p.pullRequest.number}</ExtLink>
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>
    </RailSection>
  );
}

// ---------- declared frontmatter ----------

const qhref = (key: string, value: string) => `/skills?${new URLSearchParams({ q: `${key}:${/\s/.test(value) ? `"${value}"` : value}` })}`;

function Values({ k, values, label = (v: string) => v }: { k: string; values: string[]; label?: (v: string) => string }) {
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
      {values.map((v) => (
        <Link
          key={v}
          to={qhref(k, v)}
          title={`Skills with ${k}:${v}`}
          className="inline-block min-w-6 rounded-sm px-0.5 py-0.5 text-center text-fg underline decoration-transparent underline-offset-[0.2em] transition-colors duration-[120ms] hover:decoration-line-control max-md:-my-2.5 max-md:min-w-11 max-md:py-3"
        >
          {label(v)}
        </Link>
      ))}
    </span>
  );
}

function Declared({ skill: s, teamName }: { skill: SkillDetail; teamName: string | null }) {
  const rows = [
    s.team && { k: "team", v: <Values k="team" values={[s.team]} label={() => teamName ?? s.team!} /> },
    s.areas.length > 0 && { k: "areas", v: <Values k="area" values={s.areas} /> },
    s.stacks.length > 0 && { k: "stacks", v: <Values k="stack" values={s.stacks} label={stackLabel} /> },
    s.tags.length > 0 && { k: "tags", v: <Values k="tag" values={s.tags} /> },
    s.tools.length > 0 && { k: "tools", v: <Values k="tool" values={TOOLS.filter((t) => s.tools.includes(t))} label={toolLabel} /> },
  ].filter(Boolean) as { k: string; v: ReactNode }[];
  if (!rows.length) return null;
  return (
    <RailSection id="rail-declared" title={`Declared in ${KIND_FILE[kindOf(s)]}`}>
      <dl className="grid grid-cols-[3.75rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
        {rows.map((r) => (
          <div key={r.k} className="contents">
            <dt className="pt-px font-mono text-xs leading-5 text-fg-subtle">{r.k}</dt>
            <dd className="min-w-0 font-mono text-[13px] leading-5">{r.v}</dd>
          </div>
        ))}
      </dl>
    </RailSection>
  );
}

export function SkillRail({ skill, meta, teamName }: { skill: SkillDetail; meta: VersionMeta | null; teamName: string | null }) {
  const parts = [
    meta ? <Behaviors key="b" meta={meta} noun={kindNoun(kindOf(skill))} /> : null,
    <Registry key="r" skill={skill} meta={meta} />,
    <Provenance key="p" skill={skill} meta={meta} />,
    skill.proposals.length ? <Proposals key="o" skill={skill} /> : null,
    <Declared key="d" skill={skill} teamName={teamName} />,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-6">
      {parts.map((p, i) => (
        <div key={i} className="flex flex-col gap-6">
          {i > 0 && <DottedRule />}
          {p}
        </div>
      ))}
    </div>
  );
}

export function RailSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-hidden>
      {[3, 6, 2].map((n, s) => (
        <div key={s} className="flex flex-col gap-2.5">
          <span className="skeleton block h-4 w-24" />
          {Array.from({ length: n }, (_, i) => (
            <span key={i} className="flex gap-3">
              <span className="skeleton block h-3.5 w-16" />
              <span className={cx("skeleton block h-3.5", i % 2 ? "w-24" : "w-36")} />
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
