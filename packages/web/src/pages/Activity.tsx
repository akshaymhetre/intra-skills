import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { AuditEntry } from "@intra-skills/shared/types";
import { api } from "../api";
import { useAsync } from "../lib/useAsync";
import { formatNumber } from "../lib/format";
import { AUDIT_ACTIONS, AuditTable, AuditTableSkeleton } from "../components/AuditList";
import { Button, EmptyState, ErrorState, InlineError, Select, cx } from "../components/ui";
import { Page, PageIntro } from "../components/admin/Page";
import { useDocTitle } from "./admin/parts";

const PAGE = 50;
const GROUPS = ["Skills", "Proposals", "Teams", "People", "Tokens", "Repositories", "Registry"] as const;

export function Activity() {
  useDocTitle("Activity");
  const [params, setParams] = useSearchParams();
  const action = params.get("action") ?? "";
  const target = params.get("skill") ?? "";
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<unknown>();
  const [moreError, setMoreError] = useState<unknown>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  const seq = useRef(0);

  // Names for the "Who" column and the skill filter. Both are optional: the log still reads without them.
  const users = useAsync(() => api.listUsers(), []);
  const skills = useAsync(() => api.listSkills({ sort: "name" }), []);
  const people = useMemo(() => new Map((users.data ?? []).map((u) => [u.handle, u.displayName])), [users.data]);

  // The API filters by target, so the skill filter is server-side and pages correctly.
  const load = useCallback(async () => {
    const id = ++seq.current;
    setError(undefined);
    setMoreError(undefined);
    setRows(null);
    try {
      const r = await api.audit({ limit: PAGE, target: target || undefined });
      if (id !== seq.current) return;
      setRows(r);
      setDone(r.length < PAGE);
    } catch (e) {
      if (id === seq.current) setError(e);
    }
  }, [target]);
  useEffect(() => {
    void load();
  }, [load]);

  const more = async () => {
    if (!rows?.length) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const r = await api.audit({ limit: PAGE, before: rows[rows.length - 1]!.id, target: target || undefined });
      setRows([...rows, ...r]);
      setDone(r.length < PAGE);
    } catch (e) {
      setMoreError(e);
    } finally {
      setLoadingMore(false);
    }
  };

  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
  };

  // The action filter runs over what has been loaded so far; the footer says so when it matters.
  const shown = rows?.filter((r) => !action || r.action === action) ?? null;
  const actionLabel = AUDIT_ACTIONS.find((a) => a.value === action)?.label.toLowerCase();
  const filtered = !!action || !!target;
  const skillNames = skills.data?.skills.map((s) => s.name) ?? [];
  if (target && !skillNames.includes(target)) skillNames.unshift(target);

  return (
    <Page>
      <PageIntro
        title="Activity"
       
        description="Every publish, proposal, verification, access change, repository sync and admin action, newest first."
        rule={false}
      />

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line px-1 py-2.5 md:px-3">
        <label htmlFor="act-action" className="text-sm text-fg-subtle">
          Action
        </label>
        <Select id="act-action" value={action} onChange={(e) => setParam("action", e.target.value)} className="max-sm:flex-1">
          <option value="">All actions</option>
          {GROUPS.map((g) => (
            <optgroup key={g} label={g}>
              {AUDIT_ACTIONS.filter((a) => a.group === g).map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </optgroup>
          ))}
        </Select>
        <label htmlFor="act-skill" className="text-sm text-fg-subtle sm:ml-2">
          Skill
        </label>
        <Select id="act-skill" value={target} onChange={(e) => setParam("skill", e.target.value)} className={cx("max-sm:flex-1", target && "[&_select]:font-mono")}>
          <option value="">Any skill</option>
          {skillNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
        {filtered && (
          <Button
            variant="ghost"
            size="sm"
           
            onClick={() => {
              const next = new URLSearchParams(params);
              next.delete("action");
              next.delete("skill");
              setParams(next, { replace: true });
            }}
          >
            Clear filters
          </Button>
        )}
        <p className="ml-auto text-sm text-fg-subtle tabular max-sm:w-full" aria-live="polite">
          {shown && rows ? (
            action ? (
              <>
                {formatNumber(shown.length)} of {formatNumber(rows.length)} loaded
              </>
            ) : (
              <>{formatNumber(rows.length)} loaded</>
            )
          ) : null}
        </p>
      </div>

      <div className="border-y border-line">
        {error ? (
          <ErrorState error={error} onRetry={load} title="Could not load activity" />
        ) : !shown || !rows ? (
          <AuditTableSkeleton rows={10} />
        ) : rows.length === 0 && !target ? (
          <EmptyState title="Nothing has happened yet">
            Publishes, yanks, access changes and admin actions show up here as people use the registry. Publish a skill with{" "}
            <code className="font-mono text-[0.93em] text-fg">intra publish</code> to write the first entry.
          </EmptyState>
        ) : shown.length === 0 ? (
          <EmptyState
            title={target && !action ? `No activity on ${target}` : `No ${actionLabel ? `"${actionLabel}"` : ""} entries${target ? ` for ${target}` : ""}${done ? "" : " in what has loaded"}`}
            action={
              <>
                {!done && (
                  <Button onClick={more} loading={loadingMore}>
                    Load older entries
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </Button>
              </>
            }
          >
            {done ? "The whole log has been searched." : `The filter covers the newest ${formatNumber(rows.length)} entries. Load older ones to search further back.`}
          </EmptyState>
        ) : (
          <>
            <AuditTable entries={shown} people={people} />
            <div className="flex flex-col items-center gap-2 border-t border-line px-1 py-5">
              {moreError ? <InlineError error={moreError} /> : null}
              {done ? (
                <p className="text-sm text-fg-subtle">This is the start of the log.</p>
              ) : (
                <Button onClick={more} loading={loadingMore}>
                  Load older entries
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </Page>
  );
}
