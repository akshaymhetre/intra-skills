// Review: the verification queue (admins). Every skill whose latest version no admin has verified,
// oldest first. Each row summarises what the latest version tells an agent to do, with the "ask"
// behaviors (the ones an agent must show the user first) spelled out, so the reviewer knows where to
// look before pressing Verify.
import { useState } from "react";
import { Link, Navigate } from "react-router";
import { BadgeCheck, ShieldAlert } from "lucide-react";
import type { Behavior, SkillDetail, SkillSummary } from "@intra-skills/shared/types";
import { api } from "../../api";
import { useMe } from "../../auth";
import { useAsync } from "../../lib/useAsync";
import { formatDateTime, plural, relativeTime } from "../../lib/format";
import { Button, EmptyState, ErrorState, InlineError, Skeleton, useToast } from "../../components/ui";
import { PersonMark } from "../../components/fx";
import { Page, PageIntro } from "../../components/admin/Page";
import { useDocTitle } from "./parts";

/** The latest version's behaviors, from the skill detail. null while loading or when it failed. */
function latestBehaviors(d: SkillDetail | undefined): Behavior[] | null {
  if (!d) return null;
  const v = d.versions.find((x) => x.version === d.latestVersion) ?? d.versions[0];
  return v?.behaviors ?? [];
}

export function Review() {
  useDocTitle("Review");
  const me = useMe();
  const queue = useAsync(() => api.reviewQueue(), []);
  // Behaviors live on versions, so read each queued skill's detail. The queue is short by nature.
  const names = queue.data?.map((s) => s.name).join(",");
  const details = useAsync(async () => {
    const all = await Promise.all((queue.data ?? []).map((s) => api.getSkill(s.name).catch(() => null)));
    return new Map(all.filter((d): d is SkillDetail => !!d).map((d) => [d.name, d]));
  }, [names]);
  if (me.role !== "admin") return <Navigate to="/" replace />;

  // Skills whose latest version carries ask behaviors come first: they are the ones worth reading now.
  const asksOf = (name: string) => (details.data ? (latestBehaviors(details.data.get(name)) ?? []).filter((b) => b.tier === "ask").length : 0);
  const list = queue.data ? [...queue.data].sort((a, b) => Number(asksOf(b.name) > 0) - Number(asksOf(a.name) > 0)) : null;
  const remove = (name: string) => queue.data && queue.setData(queue.data.filter((s) => s.name !== name));
  const restore = (s: SkillSummary) => queue.data && queue.setData([...queue.data.filter((x) => x.name !== s.name), s].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)));

  return (
    <Page>
      <PageIntro
        title="Review queue"
       
        description="Skills whose latest version no admin has verified, oldest first. Check what each one tells an agent to do, then verify it."
        meta={list && list.length > 0 && <p className="text-sm text-fg-muted tabular">{plural(list.length, "skill")} waiting</p>}
        rule={false}
      />
      {queue.error ? (
        <div className="border-y border-line">
          <ErrorState error={queue.error} onRetry={queue.reload} title="Could not load the review queue" />
        </div>
      ) : !list ? (
        <div className="border-y border-line" aria-busy="true" aria-label="Loading the review queue">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2 border-b border-line px-1 py-4 last:border-b-0 md:px-3">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-full max-w-xl" />
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <div className="border-y border-line">
          <EmptyState icon={<BadgeCheck aria-hidden />} title="Every skill is verified">
            New skills and versions that add an ask behavior show up here. Nothing is waiting.
          </EmptyState>
        </div>
      ) : (
        <ul aria-label="Skills waiting for review" className="border-y border-line">
          {list.map((s) => (
            <ReviewRow key={s.name} skill={s} behaviors={details.data && !details.loading ? latestBehaviors(details.data.get(s.name)) : undefined} onVerified={() => remove(s.name)} onUndo={() => restore(s)} />
          ))}
        </ul>
      )}
    </Page>
  );
}

function ReviewRow({
  skill: s,
  behaviors,
  onVerified,
  onUndo,
}: {
  skill: SkillSummary;
  /** undefined while loading; null when the detail could not be read. */
  behaviors: Behavior[] | null | undefined;
  onVerified: () => void;
  onUndo: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const asks = behaviors?.filter((b) => b.tier === "ask") ?? [];
  const infos = behaviors?.filter((b) => b.tier === "info") ?? [];
  // One line per distinct ask rule, with how many places it appears.
  const askGroups = [...asks.reduce((m, b) => m.set(b.label, [...(m.get(b.label) ?? []), b]), new Map<string, Behavior[]>())];

  const verify = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      await api.verify(s.name, s.latestVersion ?? undefined);
      onVerified();
      toast({
        message: `Verified ${s.name} ${s.latestVersion ?? ""}`,
        action: {
          label: "Undo",
          onClick: () =>
            void api.unverify(s.name).then(onUndo, (e) => toast({ message: `Could not undo: ${e instanceof Error ? e.message : "request failed"}` })),
        },
      });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-col gap-3 border-b border-line px-1 py-4 last:border-b-0 md:flex-row md:items-start md:gap-6 md:px-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <Link to={`/skills/${encodeURIComponent(s.name)}`} className="font-mono text-[15px] font-medium text-fg hover:underline hover:decoration-line-control hover:underline-offset-4">
            {s.name}
          </Link>
          {s.latestVersion && <span className="font-mono text-xs text-fg-subtle tabular">{s.latestVersion}</span>}
          {s.deprecated && <span className="rounded-sm border border-warning-line bg-warning-soft px-1.5 text-xs text-warning-text">Deprecated</span>}
        </div>
        <p className="mt-1 line-clamp-2 max-w-[72ch] text-sm text-fg-muted">{s.description}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
          {s.team && (
            <span>
              owned by <span className="text-fg-muted">{s.team}</span>
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <PersonMark handle={s.author.handle} name={s.author.displayName} size={16} />
            {s.author.displayName}
          </span>
          <time dateTime={s.updatedAt} title={formatDateTime(s.updatedAt)}>
            waiting since {relativeTime(s.updatedAt)}
          </time>
        </div>

        {behaviors === undefined ? (
          <Skeleton className="mt-3 h-4 w-64" />
        ) : behaviors === null ? (
          <p className="mt-3 text-sm text-fg-subtle">Could not read this version's behaviors. Open the skill to review its files.</p>
        ) : asks.length === 0 ? (
          <p className="mt-2 text-sm text-fg-subtle">
            No ask behaviors{infos.length ? `, ${plural(infos.length, "info note")}` : ""}.
          </p>
        ) : (
          <div className="mt-3 rounded-md border border-warning-line bg-warning-soft px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-sm font-medium text-warning-text">
              <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
              {plural(askGroups.length, "thing", "things")} an agent must ask the user about first
            </p>
            <ul className="mt-1.5 flex flex-col gap-1 text-sm">
              {askGroups.map(([label, bs]) => (
                <li key={label} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span className="text-fg">{label}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-fg-muted">
                    {bs[0]!.file}
                    {bs[0]!.line ? `:${bs[0]!.line}` : ""}
                    {bs.length > 1 ? ` +${bs.length - 1} more` : ""}
                  </span>
                </li>
              ))}
            </ul>
            {infos.length > 0 && <p className="mt-1.5 text-xs text-fg-muted">Plus {plural(infos.length, "info note")}.</p>}
          </div>
        )}
        {err != null && (
          <div className="mt-3">
            <InlineError error={err} />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-3 md:pt-0.5">
        <Link
          to={`/skills/${encodeURIComponent(s.name)}`}
          className="inline-flex h-8 items-center px-1 text-sm text-fg-muted underline decoration-line-control underline-offset-4 transition-colors duration-[120ms] hover:text-fg max-md:h-11"
        >
          Read files
        </Link>
        <Button onClick={verify} loading={busy} icon={<BadgeCheck className="size-3.5" aria-hidden />} aria-label={`Verify ${s.name} ${s.latestVersion ?? ""}`}>
          Verify
        </Button>
      </div>
    </li>
  );
}
