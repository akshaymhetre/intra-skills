// Proposals: every new skill and update that arrives as a pull request. Two tabs, "Mine" (all of
// the caller's, any status) and "All open" (everything still in flight: open, merged-not-yet-synced,
// failed). Each row says, in plain words, what is holding it up, and links the pull request.
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { CircleAlert, CircleCheck, CircleDot, CircleX, ExternalLink, GitMerge, GitPullRequest, RefreshCw } from "lucide-react";
import type { Proposal, ProposalStatus } from "@intra-skills/shared/types";
import { KIND_LABELS, kindNoun } from "../lib/kinds";
import { api } from "../api";
import { useMe } from "../auth";
import { useAsync } from "../lib/useAsync";
import { useRegistryMeta } from "../lib/meta";
import { formatDateTime, plural, relativeTime } from "../lib/format";
import { Button, EmptyState, ErrorState, InlineError, Skeleton, Tabs, cx, useToast } from "../components/ui";
import { PersonMark } from "../components/fx";
import { Page, PageIntro, StatusText } from "../components/admin/Page";
import { TD, TH, TR, TableFrame, useDocTitle } from "./admin/parts";

type Tab = "mine" | "open";

const sentence = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** Still in flight: anything a person might still act on. */
export const isInFlight = (p: Proposal) => p.status !== "published" && p.status !== "closed";

const STATUS: Record<ProposalStatus, { label: string; tone: "ok" | "bad" | "warn" | "neutral" | "sel"; icon: typeof CircleDot }> = {
  open: { label: "Open, in review", tone: "neutral", icon: GitPullRequest },
  merged: { label: "Merged, publishing on next sync", tone: "neutral", icon: GitMerge },
  published: { label: "Published", tone: "ok", icon: CircleCheck },
  closed: { label: "Closed without merging", tone: "neutral", icon: CircleX },
  failed: { label: "Merged, needs attention", tone: "warn", icon: CircleAlert },
};

export function Proposals() {
  useDocTitle("Proposals");
  const me = useMe();
  const meta = useRegistryMeta();
  const [params, setParams] = useSearchParams();
  const mine = useAsync(() => api.listProposals({ mine: true }), []);
  // With no tab in the address, land on "All open" when the caller has nothing of their own.
  const tabParam = params.get("tab");
  const tab: Tab = tabParam === "open" || tabParam === "mine" ? tabParam : mine.data && mine.data.length === 0 ? "open" : "mine";
  const all = useAsync(() => api.listProposals({}), []);
  const direct = meta?.publishMode === "direct";

  const mineList = mine.data ? [...mine.data].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : null;
  const openList = all.data ? all.data.filter(isInFlight).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : null;
  const state = tab === "mine" ? mine : all;
  const list = tab === "mine" ? mineList : openList;

  const replace = (p: Proposal) => {
    if (mine.data) mine.setData(mine.data.map((x) => (x.id === p.id ? p : x)));
    if (all.data) all.setData(all.data.map((x) => (x.id === p.id ? p : x)));
  };

  return (
    <Page>
      <PageIntro
        title="Proposals"
       
        description={
          direct ? (
            "When a repository is connected, every new skill and update arrives here as a pull request that needs an approved merge."
          ) : (
            <>
              Every new skill and update arrives as a pull request. <code className="font-mono text-[0.93em] text-fg">intra publish</code> opens it for you; the version is
              published once someone other than you approves it and it merges.
            </>
          )
        }
        rule={false}
      />

      {direct && <DirectMode admin={me.role === "admin"} />}

      <div className="border-b border-line">
        <Tabs<Tab>
          idBase="proposals"
          label="Which proposals"
          value={tab}
          onChange={(v) => {
            const next = new URLSearchParams(params);
            next.set("tab", v);
            setParams(next, { replace: true });
          }}
          tabs={[
            { value: "mine", label: "Mine", count: mineList?.length },
            { value: "open", label: "All open", count: openList?.length },
          ]}
        />
      </div>

      <div id="proposals-panel" role="tabpanel" aria-labelledby={`proposals-tab-${tab}`}>
        {state.error ? (
          <ErrorState error={state.error} onRetry={state.reload} title="Could not load proposals" />
        ) : !list ? (
          <ProposalSkeleton />
        ) : list.length === 0 ? (
          <EmptyState title="Nothing waiting" className="border-b border-line">
            {tab === "mine" ? (
              direct ? (
                "This registry publishes directly, so intra publish creates the version at once and nothing waits here."
              ) : (
                <>
                  Run <code className="font-mono text-[0.93em] text-fg">intra publish</code> in a skill folder. It opens a pull request and the proposal shows up here
                  with its review status.
                </>
              )
            ) : (
              "No pull request is open for any skill you can see."
            )}
          </EmptyState>
        ) : (
          <ProposalTable proposals={list} showProposer={tab === "open"} onChange={replace} />
        )}
      </div>
    </Page>
  );
}

function DirectMode({ admin }: { admin: boolean }) {
  return (
    <div className="mb-8 rounded-lg border border-line bg-surface px-4 py-4 md:px-5">
      <h2 className="text-base font-semibold text-fg">This registry publishes directly</h2>
      <p className="mt-1 max-w-[70ch] text-sm text-fg-muted">
        No git repository is connected, so <code className="font-mono text-[0.93em] text-fg">intra publish</code> creates a version as soon as it passes validation, with no
        review step.
        {admin
          ? " Connect a GitHub or Bitbucket Cloud repository and every publish becomes a pull request that needs an approval from someone other than the author."
          : " An admin can connect a GitHub or Bitbucket Cloud repository; after that every publish becomes a pull request that needs an approval."}
      </p>
      {admin && (
        <Link
          to="/admin/repositories"
          className="mt-3 inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-on-primary transition-colors duration-[120ms] hover:bg-primary-hover max-md:h-11"
        >
          Connect a repository
        </Link>
      )}
    </div>
  );
}

function ProposalTable({ proposals, showProposer, onChange }: { proposals: Proposal[]; showProposer: boolean; onChange: (p: Proposal) => void }) {
  return (
    <TableFrame label="Proposals" stackBelow="lg">
      <thead className="max-lg:hidden">
        <tr className="border-b border-line">
          <th scope="col" className={TH}>Name</th>
          <th scope="col" className={cx(TH, "w-[19rem]")}>Status</th>
          {showProposer && <th scope="col" className={cx(TH, "w-44")}>Proposed by</th>}
          <th scope="col" className={cx(TH, "w-28")}>Pull request</th>
          <th scope="col" className={cx(TH, "w-32 text-right")}>Updated</th>
          <th scope="col" className={cx(TH, "w-px")}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {proposals.map((p) => (
          <ProposalRow key={p.id} p={p} showProposer={showProposer} onChange={onChange} />
        ))}
      </tbody>
    </TableFrame>
  );
}

function ProposalRow({ p, showProposer, onChange }: { p: Proposal; showProposer: boolean; onChange: (p: Proposal) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const s = STATUS[p.status];
  const Icon = s.icon;
  const asks = p.behaviors.filter((b) => b.tier === "ask").length;

  const refresh = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const next = await api.refreshProposal(p.id);
      onChange(next);
      toast({ message: next.status === p.status ? `${p.skill} ${p.version}: no change on the pull request` : `${p.skill} ${p.version}: ${STATUS[next.status].label.toLowerCase()}` });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className={cx(TR, "align-top max-lg:flex max-lg:flex-wrap max-lg:items-center max-lg:gap-x-4 max-lg:gap-y-1.5 max-lg:px-1 max-lg:py-3.5")}>
      <td className={cx(TD, "py-3 max-lg:w-full max-lg:h-auto max-lg:min-w-0 max-lg:p-0!")}>
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Link to={`/skills/${encodeURIComponent(p.skill)}`} className="font-mono text-[15px] font-medium text-fg hover:underline hover:decoration-line-control hover:underline-offset-4">
            {p.skill}
          </Link>
          <span className="font-mono text-xs text-fg-muted tabular">{p.version}</span>
          <span className={cx("text-xs", p.kind === "new" ? "font-medium text-fg" : "text-fg-subtle")}>
            {p.kind === "new" ? `New ${kindNoun(p.packageKind ?? "skill")}` : (p.packageKind ?? "skill") === "skill" ? "Update" : `${KIND_LABELS[p.packageKind]} update`}
          </span>
        </span>
        {p.changelog && <span className="mt-0.5 block max-w-[44ch] truncate text-sm text-fg-muted" title={p.changelog}>{p.changelog}</span>}
        {asks > 0 && (
          <span className="mt-0.5 block text-xs text-warning-text">
            {plural(asks, "behavior")} to show the user before following it
          </span>
        )}
      </td>
      <td className={cx(TD, "py-3 max-lg:w-full max-lg:h-auto max-lg:min-w-0 max-lg:p-0!")}>
        <StatusText tone={s.tone} icon={<Icon aria-hidden />} className={cx("font-medium", s.tone === "neutral" && "text-fg")}>
          {s.label}
        </StatusText>
        {p.statusMessage && p.statusMessage !== s.label && <span className="mt-0.5 block max-w-[48ch] text-sm text-fg-muted">{sentence(p.statusMessage)}</span>}
        {err != null && (
          <div className="mt-2">
            <InlineError error={err} />
          </div>
        )}
      </td>
      {showProposer && (
        <td className={cx(TD, "py-3 max-lg:h-auto max-lg:min-w-0 max-lg:p-0!")}>
          <span className="flex min-w-0 items-center gap-2 text-sm">
            <PersonMark handle={p.proposer.handle} name={p.proposer.displayName} size={20} />
            <span className="truncate text-fg">{p.proposer.displayName}</span>
          </span>
        </td>
      )}
      <td className={cx(TD, "py-3 whitespace-nowrap max-lg:h-auto max-lg:min-w-0 max-lg:p-0!")}>
        {p.pullRequest ? (
          <a
            href={p.pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-sm text-fg underline decoration-line-control underline-offset-4 hover:decoration-current"
          >
            #{p.pullRequest.number}
            <ExternalLink className="size-3 text-fg-subtle" aria-hidden />
            <span className="sr-only">(opens the pull request on the git host)</span>
          </a>
        ) : (
          <span className="text-sm text-fg-subtle">Not opened</span>
        )}
      </td>
      <td className={cx(TD, "py-3 text-right whitespace-nowrap max-lg:h-auto max-lg:min-w-0 max-lg:p-0! max-lg:text-left")}>
        <time dateTime={p.updatedAt} title={`Updated ${formatDateTime(p.updatedAt)}`} className="block text-sm text-fg-muted tabular">
          {relativeTime(p.updatedAt)}
        </time>
        <time dateTime={p.createdAt} title={formatDateTime(p.createdAt)} className="block text-xs text-fg-subtle tabular max-lg:hidden">
          opened {relativeTime(p.createdAt)}
        </time>
      </td>
      <td className={cx(TD, "w-px py-2.5 text-right max-lg:ml-auto max-lg:h-auto max-lg:w-auto max-lg:p-0!")}>
        {isInFlight(p) && (
          <Button variant="ghost" size="sm" loading={busy} icon={<RefreshCw className="size-3.5" aria-hidden />} onClick={refresh} aria-label={`Refresh ${p.skill} ${p.version} from the pull request`}>
            Refresh
          </Button>
        )}
      </td>
    </tr>
  );
}

function ProposalSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading proposals" className="border-b border-line">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-6 border-b border-line px-1 py-4 last:border-b-0 md:px-3">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-40 max-md:hidden" />
          <Skeleton className="ml-auto h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
