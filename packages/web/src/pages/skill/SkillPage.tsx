// Package detail (a skill, a Claude Code plugin or a rule). Left: the header (name, version, owner, author, health, trust, installs) and the tabs
// (Readme, Files, Versions, Trust, Access). Right: the install card (the page's one beam), then the rail
// a careful reader checks before installing. Phones stack it as header, install, facts, tabs.
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Ban, ExternalLink, FolderGit2, Lock } from "lucide-react";
import type { SkillDetail, VersionMeta } from "@intra-skills/shared/types";
import { api, ApiError } from "../../api";
import { useMe } from "../../auth";
import { useAsync } from "../../lib/useAsync";
import { useRegistryMeta, useDocTitle } from "../../lib/meta";
import { formatDateTime, formatNumber, relativeTime } from "../../lib/format";
import { DottedRule, HealthMark, PersonMark, Sparkline, TeamMark, TrustBar, VerifiedMark } from "../../components/fx";
import { Badge, Button, ErrorState, Id, Menu, Select, Skeleton, cx, useToast, type MenuEntry } from "../../components/ui";
import { InstallSkeleton, SkillInstall } from "./Install";
import { RailSkeleton, SkillRail } from "./Rail";
import { FilesSkeleton, FilesTab, ReadmeSkeleton, ReadmeTab, useReadmeText } from "./ContentTabs";
import { PluginInstall, RuleInstall } from "./KindInstall";
import { ComponentsTab, RendersTab } from "./KindTabs";
import { KindMark } from "../../components/SkillRow";
import { KIND_LABELS, kindNoun, kindOf, marketplaceOf } from "../../lib/kinds";
import { VersionsTab, type VersionsView } from "./VersionTabs";
import { TrustTab } from "./TrustTab";
import { AccessTab } from "./AccessTab";
import { SectionTabs } from "./SectionTabs";
import { DeleteDialog, DeprecateDialog, EditMetadataDialog } from "./Dialogs";

type Tab = "readme" | "components" | "renders" | "files" | "versions" | "trust" | "access";

// One grid for the page and its skeleton: header and tabs on the left, install and rail on the right.
const GRID =
  "mx-auto grid w-full max-w-[1180px] grid-cols-[minmax(0,1fr)] gap-x-12 px-5 pb-20 md:px-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:grid-rows-[auto_1fr]";
const AREA_HEAD = "pt-7 pb-6 lg:col-start-1 lg:row-start-1 lg:pt-10 lg:pb-8";
const AREA_SIDE = "flex min-w-0 flex-col gap-8 pb-10 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:pt-10 lg:pb-0";
const AREA_MAIN = "min-w-0 lg:col-start-1 lg:row-start-2";

export function SkillPage() {
  const { name = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const skill = useAsync(() => api.getSkill(name), [name]);
  const s = skill.data;

  useDocTitle(name);

  if (skill.error) {
    if (skill.error instanceof ApiError && skill.error.isNotFound) return <SkillNotFound name={name} />;
    return <ErrorState error={skill.error} onRetry={skill.reload} title={`Could not load ${name}`} className="py-20" />;
  }
  if (!s || s.name !== name) return <SkillSkeleton />;
  return <SkillView key={s.name} skill={s} setSkill={skill.setData} params={params} setParams={setParams} />;
}

function SkillView({
  skill: s,
  setSkill,
  params,
  setParams,
}: {
  skill: SkillDetail;
  setSkill: (s: SkillDetail) => void;
  params: URLSearchParams;
  setParams: ReturnType<typeof useSearchParams>[1];
}) {
  const toast = useToast();
  const me = useMe();
  const meta = useRegistryMeta();
  const navigate = useNavigate();
  const teams = useAsync(() => api.listTeams(), []);
  const teamName = s.team ? (teams.data?.find((t) => t.slug === s.team)?.name ?? s.team) : null;
  const publicUrl = meta?.publicUrl ?? window.location.origin;
  const isAdmin = me.role === "admin";
  const kind = kindOf(s);

  const latest = s.versions.find((v) => !v.yanked)?.version ?? null;
  const vParam = params.get("v");
  const selected = vParam && s.versions.some((v) => v.version === vParam) ? vParam : (latest ?? s.versions[0]?.version ?? null);
  const selectedMeta = s.versions.find((v) => v.version === selected) ?? null;

  // Old links: ?tab=diff opens Compare, ?tab=activity opens Versions (history lives there now).
  const rawTab = params.get("tab");
  const legacyCompare = rawTab === "diff";
  const tabParam = (legacyCompare || rawTab === "activity" ? "versions" : rawTab) as Tab | null;
  const votes = s.trust.works + s.trust.broken;
  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: "readme", label: "Readme" },
    ...(kind === "plugin" ? [{ value: "components" as Tab, label: "Components", count: componentCount(selectedMeta) }] : []),
    ...(kind === "rule" ? [{ value: "renders" as Tab, label: "Renders as" }] : []),
    { value: "files", label: "Files", count: selectedMeta?.fileCount },
    { value: "versions", label: "Versions", count: s.versions.length },
    { value: "trust", label: "Trust", count: votes || undefined },
    ...(s.permissions.canWrite ? [{ value: "access" as Tab, label: "Access" }] : []),
  ];
  const tab: Tab = tabParam && tabs.some((t) => t.value === tabParam) ? tabParam : "readme";
  const view: VersionsView = legacyCompare || params.get("view") === "compare" ? "compare" : "ledger";

  const set = (patch: Record<string, string | null>, replace = false) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) v === null ? next.delete(k) : next.set(k, v);
    setParams(next, { replace });
  };

  const version = useAsync(() => (selected ? api.getVersion(s.name, selected) : Promise.resolve(null)), [s.name, selected]);
  const loadedVersion = version.data && version.data.version === selected ? version.data : null;
  const readme = useReadmeText(s.name, loadedVersion, kind);

  const [editOpen, setEditOpen] = useState(false);
  const [deprecateOpen, setDeprecateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const updateVersion = (m: VersionMeta) => setSkill({ ...s, versions: s.versions.map((v) => (v.version === m.version ? m : v)) });
  const diffFrom = params.get("from") ?? s.versions[1]?.version ?? "";
  const diffTo = params.get("to") ?? s.versions[0]?.version ?? "";

  const run = async (fn: () => Promise<SkillDetail>, done: string, undo?: () => Promise<SkillDetail>) => {
    try {
      setSkill(await fn());
      toast({ message: done, action: undo ? { label: "Undo", onClick: () => void undo().then(setSkill) } : undefined });
    } catch (e) {
      toast({ message: `${done.split(" ")[0]} failed: ${e instanceof Error ? e.message : "the request failed"}` });
    }
  };

  const verifiedHere = s.verification?.version === latest;
  const overflow: MenuEntry[] = [
    ...(isAdmin && latest
      ? [
          { heading: "Review" },
          ...(!verifiedHere
            ? [{ label: `Verify ${latest}`, text: "Verify", onSelect: () => void run(() => api.verify(s.name, latest), `Verified ${s.name}@${latest}`) }]
            : []),
          ...(s.verification ? [{ label: "Remove verification", onSelect: () => void run(() => api.unverify(s.name), `Removed the verification of ${s.name}`) }] : []),
        ]
      : []),
    ...(s.permissions.canWrite
      ? [
          ...(isAdmin && latest ? ["separator" as const] : []),
          s.deprecated
            ? {
                label: "Undeprecate",
                onSelect: () => {
                  const reason = s.deprecated!;
                  void run(() => api.patchSkill(s.name, { deprecated: null }), `${s.name} is no longer deprecated`, () => api.patchSkill(s.name, { deprecated: reason }));
                },
              }
            : { label: "Deprecate…", text: "Deprecate", onSelect: () => setDeprecateOpen(true) },
        ]
      : []),
    ...(isAdmin ? (["separator", { label: `Delete ${kindNoun(kind)}…`, text: "Delete", danger: true, onSelect: () => setDeleteOpen(true) }] as MenuEntry[]) : []),
  ];

  const viewingOld = selected && latest && selected !== latest;
  const actions = (
    <>
      {!s.source && s.permissions.canWrite && <Button onClick={() => setEditOpen(true)}>Edit metadata</Button>}
      {overflow.length > 0 && <Menu label={`More actions for ${s.name}`} items={overflow} />}
    </>
  );

  return (
    <div className={GRID}>
      <header className={AREA_HEAD}>
        <Header
          skill={s}
          selected={selected}
          latest={latest}
          meta={selectedMeta}
          teamName={teamName}
          onPick={(v) => set({ v: v === latest ? null : v })}
          actions={actions}
        />
      </header>

      <aside aria-label={`Install ${s.name}`} className={cx(AREA_SIDE, "max-lg:contents")}>
        {selected && kind === "plugin" ? (
          <PluginInstall
            name={s.name}
            version={selected}
            meta={selectedMeta}
            publicUrl={publicUrl}
            marketplace={marketplaceOf(meta)}
            deprecated={!!s.deprecated}
          />
        ) : selected && kind === "rule" ? (
          <RuleInstall name={s.name} version={selected} meta={selectedMeta} publicUrl={publicUrl} deprecated={!!s.deprecated} />
        ) : selected ? (
          <SkillInstall
            name={s.name}
            tools={s.tools}
            version={selected}
            latest={latest}
            meta={selectedMeta}
            publicUrl={publicUrl}
            deprecated={!!s.deprecated}
            mcpUrl={meta?.mcpUrl ?? `${publicUrl}/api/mcp`}
          />
        ) : (
          <p className="rounded-xl border border-line bg-surface p-4 text-sm text-fg-muted">Nothing to install yet: no version has been published.</p>
        )}
        {/* On phones the facts follow the readme (order 3), so the content is not buried under them. */}
        <div className="flex flex-col gap-8 max-lg:order-3 max-lg:pt-10">
          <DottedRule className="lg:hidden" />
          <SkillRail skill={s} meta={selectedMeta} teamName={teamName} />
        </div>
      </aside>

      <div className={cx(AREA_MAIN, "max-lg:order-2 max-lg:pt-8")}>
        <div className="sticky top-12 z-10 border-b border-line bg-bg max-[899px]:top-14">
          <SectionTabs
            label={`${KIND_LABELS[kind]} sections`}
            idBase="skill"
            tabs={tabs}
            value={tab}
            onChange={(t) => set({ tab: t === "readme" ? null : t, view: null, from: null, to: null, file: null }, true)}
          />
        </div>
        <div id="skill-panel" role="tabpanel" aria-labelledby={`skill-tab-${tab}`} className="pt-6">
          {(tab === "readme" || tab === "files" || tab === "components" || tab === "renders") && selectedMeta && (selectedMeta.yanked || viewingOld) && (
            <div
              className={cx(
                "mb-5 flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md border px-3 py-2",
                selectedMeta.yanked ? "border-danger-line bg-danger-soft" : "border-line bg-panel",
              )}
            >
              {selectedMeta.yanked ? (
                <p className="text-sm text-danger-text">
                  You are viewing <Id>{selected}</Id>, which is yanked: {selectedMeta.yanked.replace(/[.\s]+$/, "")}.
                </p>
              ) : (
                <p className="text-sm text-fg-muted">
                  You are viewing <Id className="text-fg">{selected}</Id>. The latest is <Id className="text-fg">{latest}</Id>.
                </p>
              )}
              {latest && (
                <button
                  type="button"
                  onClick={() => set({ v: null })}
                  className="text-sm font-medium text-fg underline decoration-line-control underline-offset-[0.2em] hover:decoration-current max-md:min-h-11"
                >
                  View {latest}
                </button>
              )}
            </div>
          )}

          {tab === "readme" &&
            (!selected ? (
              <p className="text-sm text-fg-muted">The readme appears after the first publish.</p>
            ) : version.error ? (
              <ErrorState error={version.error} onRetry={version.reload} title={`Could not load ${s.name}@${selected}`} align="start" className="px-0" />
            ) : readme.error ? (
              <ErrorState error={readme.error} onRetry={readme.reload} title={`Could not load ${readme.file ?? "the readme"}`} align="start" className="px-0" />
            ) : !loadedVersion || readme.text === null ? (
              <ReadmeSkeleton />
            ) : (
              <ReadmeTab version={loadedVersion} text={readme.text} kind={kind} onOpenFile={(p) => set({ tab: "files", file: p })} />
            ))}
          {tab === "components" &&
            (!selected ? (
              <p className="text-sm text-fg-muted">Components appear after the first publish.</p>
            ) : (
              <ComponentsTab plugin={s.name} components={selectedMeta?.plugin ?? null} />
            ))}
          {tab === "renders" &&
            (!selected ? (
              <p className="text-sm text-fg-muted">The previews appear after the first publish.</p>
            ) : version.error ? (
              <ErrorState error={version.error} onRetry={version.reload} title={`Could not load ${s.name}@${selected}`} align="start" className="px-0" />
            ) : !loadedVersion || readme.text === null ? (
              <ReadmeSkeleton />
            ) : (
              <RendersTab version={loadedVersion} description={s.description} rule={selectedMeta?.rule ?? null} ruleMd={readme.text} />
            ))}
          {tab === "files" &&
            (!selected ? (
              <p className="text-sm text-fg-muted">Files appear after the first publish.</p>
            ) : version.error ? (
              <ErrorState error={version.error} onRetry={version.reload} title={`Could not load ${s.name}@${selected}`} align="start" className="px-0" />
            ) : !version.data || version.data.version !== selected ? (
              <FilesSkeleton />
            ) : (
              <FilesTab name={s.name} version={version.data} path={params.get("file")} onSelect={(p) => set({ file: p }, true)} />
            ))}
          {tab === "versions" && (
            <VersionsTab
              skill={s}
              view={view}
              from={diffFrom}
              to={diffTo}
              onView={(v) => set({ tab: "versions", view: v === "compare" ? "compare" : null, from: null, to: null }, true)}
              onChanged={updateVersion}
              onCompare={(from, to) => set({ tab: "versions", view: "compare", from, to })}
              onViewVersion={(v) => set({ v: v === latest ? null : v, tab: null, view: null, from: null, to: null })}
            />
          )}
          {tab === "trust" && <TrustTab skill={s} latest={latest} onTrust={(t) => setSkill({ ...s, trust: t })} />}
          {tab === "access" && <AccessTab skill={s} onChanged={setSkill} />}
        </div>
      </div>

      <EditMetadataDialog open={editOpen} onClose={() => setEditOpen(false)} skill={s} onSaved={setSkill} />
      <DeprecateDialog open={deprecateOpen} onClose={() => setDeprecateOpen(false)} skill={s} onSaved={setSkill} />
      <DeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        skill={s}
        onDeleted={() => {
          toast({
            message: (
              <>
                Deleted <span className="font-mono whitespace-nowrap">{s.name}</span>
              </>
            ),
          });
          navigate("/skills");
        }}
      />
    </div>
  );
}

// ---------- header ----------

function Header({
  skill: s,
  selected,
  latest,
  meta,
  teamName,
  onPick,
  actions,
}: {
  skill: SkillDetail;
  selected: string | null;
  latest: string | null;
  meta: VersionMeta | null;
  teamName: string | null;
  onPick: (v: string) => void;
  actions: React.ReactNode;
}) {
  const author = s.author;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 md:gap-x-6">
      <div className="min-w-0 col-start-1 row-start-1">
        <h1 className="font-mono text-[22px] leading-[1.2] font-medium tracking-[-0.03em] text-fg [overflow-wrap:anywhere] md:text-[28px]">{s.name}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
          {selected &&
            (s.versions.length > 0 ? (
              <Select
                aria-label="Version shown"
                value={selected}
                onChange={(e) => onPick(e.target.value)}
                className="shrink-0 [&_select]:h-7 [&_select]:font-mono [&_select]:text-[13px] [&_select]:tabular-nums"
              >
                {s.versions.map((v) => (
                  <option key={v.version} value={v.version}>
                    {v.version}
                    {v.version === latest ? " (latest)" : v.yanked ? " (yanked)" : ""}
                  </option>
                ))}
              </Select>
            ) : (
              <span className="font-mono text-[13px] text-fg tabular">{selected}</span>
            ))}
          {s.kind && s.kind !== "skill" && <KindMark kind={s.kind} className="h-5 text-[13px]" />}
          {meta?.yanked && <Badge tone="bad">yanked</Badge>}
          {s.verified && <VerifiedMark className="text-sm" />}
          <HealthMark health={s.health} className="text-sm" />
          {s.visibility === "private" && (
            <span className="inline-flex items-center gap-1 text-sm text-fg-muted" title="Only its team, admins and people it is shared with can see it">
              <Lock className="size-3.5" aria-hidden />
              Private
            </span>
          )}
          {s.deprecated && <Badge tone="warn">Deprecated</Badge>}
        </div>
      </div>

      <div className="col-start-2 row-start-1 flex items-start justify-end gap-2 self-start">{actions}</div>

      <div className="col-span-2 min-w-0">
        <p className="mt-4 max-w-[68ch] text-base text-fg-muted">{s.description}</p>

        {s.deprecated && (
          <div role="note" className="mt-5 flex max-w-[68ch] items-start gap-2.5 rounded-md border border-warning-line bg-warning-soft px-3 py-2.5 text-sm text-fg">
            <Ban className="mt-0.5 size-4 shrink-0 text-warning-text" aria-hidden />
            <p>
              <span className="font-semibold text-warning-text">Deprecated.</span> {s.deprecated} <span className="text-fg-muted">It still installs.</span>
            </p>
          </div>
        )}

        <ul aria-label={`About this ${kindNoun(kindOf(s))}`} className="mt-5 grid grid-cols-1 justify-start gap-y-2 text-sm text-fg-muted sm:mt-6 sm:grid-cols-[repeat(2,max-content)] sm:gap-x-8 sm:gap-y-3">
          {s.source && (
            <li className="flex items-center gap-2 sm:col-span-2">
              <FolderGit2 className="size-4 shrink-0 text-fg-subtle" aria-hidden />
              <span>
                Managed in{" "}
                <a
                  href={s.source.webUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex min-h-6 items-center gap-1 font-mono text-[13px] text-fg underline decoration-line-control underline-offset-[0.2em] hover:decoration-current max-md:-my-2.5 max-md:min-h-11"
                >
                  {s.source.repo}
                  <ExternalLink className="size-3 text-fg-subtle" aria-hidden />
                  <span className="sr-only">(opens in a new tab)</span>
                </a>{" "}
                - edit it there
              </span>
            </li>
          )}
          {s.team && (
            <li className="flex items-center gap-2">
              <TeamMark slug={s.team} name={teamName ?? s.team} size={22} />
              <span>
                owned by{" "}
                <Link to={`/teams/${s.team}`} className="font-medium text-fg underline decoration-transparent underline-offset-[0.2em] hover:decoration-line-control max-md:-my-3 max-md:inline-block max-md:py-3">
                  {teamName ?? s.team}
                </Link>
              </span>
            </li>
          )}
          <li className="flex items-center gap-2">
            <PersonMark handle={author.handle} name={author.displayName} size={22} />
            <span>
              <span className="font-medium text-fg">{author.displayName}</span>
              {meta && meta.version === latest && (
                <>
                  {" "}
                  published{" "}
                  <time dateTime={meta.publishedAt} title={formatDateTime(meta.publishedAt)}>
                    {relativeTime(meta.publishedAt)}
                  </time>
                </>
              )}
            </span>
          </li>
          <li className="flex items-center">
            <TrustBar trust={s.trust} />
          </li>
          <li className="flex items-center gap-2" title={`${s.installsWeek} installs in the last 7 days`}>
            <Sparkline values={s.trend} label={`Installs per day for the last ${s.trend.length} days`} />
            <span>
              <span className="font-medium text-fg tabular">{formatNumber(s.installsWeek)}</span> installs this week
            </span>
          </li>
        </ul>
      </div>
    </div>
  );
}

function componentCount(m: VersionMeta | null): number | undefined {
  if (!m?.plugin) return undefined;
  return Object.values(m.plugin).reduce((n, v) => n + (v as unknown[]).length, 0);
}

// ---------- not found ----------

function SkillNotFound({ name }: { name: string }) {
  useDocTitle(`No skill named ${name}`);
  return (
    <div className="mx-auto w-full max-w-[1180px] px-5 pt-16 pb-20 md:px-10">
      <div className="max-w-[46rem]">
        <p className="font-mono text-sm text-fg-subtle">
          <span aria-hidden>$ </span>intra install {name}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-[-0.02em] text-fg [overflow-wrap:anywhere]">
          No skill named <span className="font-mono font-medium sm:whitespace-nowrap">{name}</span>, or you cannot see it
        </h1>
        <p className="mt-3 max-w-[60ch] text-base text-fg-muted">
          It may have been renamed or deleted. If it is private, only its team, admins and people it is shared with can see it: ask its owners to share it with you.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <Link
            to={`/skills?${new URLSearchParams({ q: name.replace(/[-_]+/g, " ") })}`}
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-on-primary transition-colors duration-[120ms] hover:bg-primary-hover max-md:min-h-11"
          >
            Search for similar skills
          </Link>
          <Link
            to="/skills"
            className="inline-flex h-8 items-center rounded-md border border-line-strong bg-surface px-3 text-sm font-medium text-fg transition-colors duration-[120ms] hover:bg-surface-2 max-md:min-h-11"
          >
            Browse all skills
          </Link>
        </div>
      </div>
    </div>
  );
}

// ---------- skeleton ----------

function SkillSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading skill" className={GRID}>
      <div className={AREA_HEAD}>
        <Skeleton className="h-8 w-[26rem] max-w-[80%]" />
        <div className="mt-3 flex gap-3">
          <Skeleton className="h-7 w-24 rounded-md" />
          <Skeleton className="h-5 w-14" />
          <Skeleton className="h-5 w-16" />
        </div>
        <Skeleton className="mt-5 h-3.5 w-full max-w-[68ch]" />
        <Skeleton className="mt-2 h-3.5 w-2/3 max-w-[48ch]" />
        <div className="mt-6 flex flex-wrap gap-6">
          {["w-40", "w-44", "w-28", "w-36"].map((w) => (
            <Skeleton key={w} className={cx("h-5", w)} />
          ))}
        </div>
      </div>
      <div className={AREA_SIDE}>
        <InstallSkeleton />
        <RailSkeleton />
      </div>
      <div className={AREA_MAIN}>
        <div className="flex h-11 items-center gap-5 border-b border-line">
          {["w-14", "w-12", "w-16", "w-12"].map((w, i) => (
            <Skeleton key={i} className={cx("h-3.5", w)} />
          ))}
        </div>
        <div className="pt-6">
          <ReadmeSkeleton />
        </div>
      </div>
    </div>
  );
}
