// Versions: a ledger of every publish, a Compare mode (the old Diff tab), and the skill's history.
import { useMemo, useState } from "react";
import { ArrowLeftRight, ChevronRight, GitPullRequest } from "lucide-react";
import type { DiffFile, SkillDetail, VersionMeta } from "@intra-skills/shared/types";
import { api } from "../../api";
import { useAsync } from "../../lib/useAsync";
import { formatBytes, formatDate, formatDateTime, plural, shortSha } from "../../lib/format";
import { copyText } from "../../lib/useCopy";
import { AuditRow, AuditSkeleton } from "../../components/AuditList";
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  Input,
  Menu,
  Segmented,
  Select,
  Skeleton,
  WarningLine,
  cx,
  useToast,
} from "../../components/ui";

export type VersionsView = "ledger" | "compare";

const EXT = "text-fg-muted underline decoration-line-control underline-offset-[0.2em] hover:text-fg hover:decoration-current";

/** Changelogs are plain text; backtick spans render as code, nothing else is interpreted. */
function InlineCode({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="rounded-sm border border-line bg-surface-2 px-1 font-mono text-[0.88em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

const sentence = (s: string) => {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
};

export function VersionsTab({
  skill,
  view,
  from,
  to,
  onView,
  onCompare,
  onViewVersion,
  onChanged,
}: {
  skill: SkillDetail;
  view: VersionsView;
  from: string;
  to: string;
  onView: (v: VersionsView) => void;
  onCompare: (from: string, to: string) => void;
  onViewVersion: (v: string) => void;
  onChanged: (v: VersionMeta) => void;
}) {
  const many = skill.versions.length > 1;
  return (
    <div className="flex flex-col gap-4">
      {many && (
        <div className="flex flex-wrap items-center gap-3">
          <Segmented
            label="Versions view"
            value={view}
            onChange={onView}
            options={[
              { value: "ledger", label: "All versions" },
              { value: "compare", label: "Compare" },
            ]}
          />
        </div>
      )}
      {view === "compare" && many ? (
        <Compare skill={skill} from={from} to={to} onChange={onCompare} />
      ) : (
        <>
          <Ledger skill={skill} onCompare={onCompare} onViewVersion={onViewVersion} onChanged={onChanged} />
          <History name={skill.name} />
        </>
      )}
    </div>
  );
}

// ---------- ledger ----------

function Ledger({
  skill,
  onCompare,
  onViewVersion,
  onChanged,
}: {
  skill: SkillDetail;
  onCompare: (from: string, to: string) => void;
  onViewVersion: (v: string) => void;
  onChanged: (v: VersionMeta) => void;
}) {
  const toast = useToast();
  const versions = skill.versions;
  const latest = versions.find((v) => !v.yanked)?.version;
  const [yankTarget, setYankTarget] = useState<VersionMeta | null>(null);
  const [unyankTarget, setUnyankTarget] = useState<VersionMeta | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [tried, setTried] = useState(false);

  const close = () => {
    setYankTarget(null);
    setUnyankTarget(null);
    setReason("");
    setErr(undefined);
    setTried(false);
  };

  const yank = async (v: VersionMeta) => {
    setTried(true);
    if (!reason.trim()) return;
    setBusy(true);
    setErr(undefined);
    try {
      onChanged(await api.yank(skill.name, v.version, reason.trim()));
      close();
      toast({
        message: (
          <>
            Yanked <span className="font-mono whitespace-nowrap">{v.version}</span>
          </>
        ),
        action: {
          label: "Undo",
          onClick: () => void api.unyank(skill.name, v.version).then(onChanged),
        },
      });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const unyank = async (v: VersionMeta) => {
    setBusy(true);
    setErr(undefined);
    try {
      onChanged(await api.unyank(skill.name, v.version));
      close();
      toast({
        message: (
          <>
            Restored <span className="font-mono whitespace-nowrap">{v.version}</span>
          </>
        ),
      });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  if (!versions.length)
    return (
      <EmptyState title="Nothing published yet" align="start" className="px-0">
        Versions appear here after the first <span className="font-mono whitespace-nowrap">intra publish</span>.
      </EmptyState>
    );

  return (
    <>
      <div>
        <ul aria-label="Versions, newest first" className="divide-y divide-line border-y border-line">
          {versions.map((v, i) => {
            const prev = versions[i + 1];
            const isLatest = v.version === latest;
            return (
              <li key={v.version} className="grid gap-x-5 gap-y-1.5 px-1 py-4 md:grid-cols-[96px_minmax(0,1fr)_auto] md:px-2">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 md:flex-col md:items-start">
                  <button
                    type="button"
                    onClick={() => onViewVersion(v.version)}
                    title={`View the readme and files of ${v.version}`}
                    className={cx(
                      "rounded-sm font-mono text-sm leading-5 font-medium text-fg tabular hover:underline hover:decoration-line-control hover:underline-offset-[0.2em] max-md:min-h-11",
                      v.yanked && "text-fg-muted line-through decoration-danger-text",
                    )}
                  >
                    {v.version}
                  </button>
                  {isLatest && <Badge tone="sel">latest</Badge>}
                  {v.yanked && <Badge tone="bad">yanked</Badge>}
                </div>
                <div className="min-w-0">
                  <p className="max-w-[72ch] text-sm text-fg">{v.changelog ? <InlineCode text={v.changelog} /> : <span className="text-fg-subtle">No changelog.</span>}</p>
                  <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-fg-muted tabular">
                    <span>
                      <time dateTime={v.publishedAt} title={formatDateTime(v.publishedAt)}>
                        {formatDate(v.publishedAt)}
                      </time>{" "}
                      by <span className="font-mono text-xs">@{v.publishedBy}</span>
                    </span>
                    <span>{formatBytes(v.size)}</span>
                    <span className="font-mono text-xs leading-5" title={`sha256 ${v.sha256}`}>
                      <span className="text-fg-subtle">sha256 </span>
                      {v.sha256.slice(0, 12)}
                    </span>
                    {v.git && (
                      <span className="font-mono text-xs leading-5" title={`${v.git.repo ?? ""} ${v.git.commit}`.trim()}>
                        <span className="text-fg-subtle">commit </span>
                        {v.git.url ? (
                          <a href={v.git.url} target="_blank" rel="noopener noreferrer" className={EXT}>
                            {shortSha(v.git.commit)}
                            <span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        ) : (
                          shortSha(v.git.commit)
                        )}
                      </span>
                    )}
                    {v.git?.pullRequest && (
                      <a href={v.git.pullRequest.url} target="_blank" rel="noopener noreferrer" className={cx(EXT, "inline-flex items-center gap-1")}>
                        <GitPullRequest className="size-3 text-fg-subtle" aria-hidden />
                        Pull request #{v.git.pullRequest.number}
                        <span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    )}
                  </p>
                  {v.yanked && (
                    <p className="mt-1.5 max-w-[72ch] text-sm text-danger-text">
                      Yanked: {sentence(v.yanked)} <span className="text-fg-muted">Exact pins still install it; ranges and latest skip it.</span>
                    </p>
                  )}
                  {v.git?.dirty && (
                    <WarningLine className="mt-1.5">
                      Published with uncommitted changes, so the bundle does not match commit <span className="font-mono text-xs">{shortSha(v.git.commit)}</span>.
                    </WarningLine>
                  )}
                </div>
                <div className="-my-1 flex items-start gap-1 md:justify-end max-md:-ml-2">
                  {prev && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => onCompare(prev.version, v.version)}
                     
                      aria-label={`Compare ${v.version} with ${prev.version}`}
                    >
                      Compare with previous
                    </Button>
                  )}
                  <span className="max-md:ml-auto">
                    <Menu
                      label={`More actions for ${v.version}`}
                      size="sm"
                      items={[
                        { label: "View readme and files", onSelect: () => onViewVersion(v.version) },
                        {
                          label: "Copy sha256",
                          onSelect: () =>
                            void copyText(v.sha256).then(() =>
                              toast({
                                message: (
                                  <>
                                    Copied sha256 of <span className="font-mono whitespace-nowrap">{v.version}</span>
                                  </>
                                ),
                              }),
                            ),
                        },
                        ...(skill.permissions.canWrite
                          ? [
                              "separator" as const,
                              v.yanked
                                ? { label: `Unyank ${v.version}`, text: "Unyank", onSelect: () => setUnyankTarget(v) }
                                : { label: `Yank ${v.version}`, text: "Yank", danger: true, onSelect: () => setYankTarget(v) },
                            ]
                          : []),
                      ]}
                    />
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <ConfirmDialog
        open={!!yankTarget}
        onClose={close}
        onConfirm={() => yankTarget && void yank(yankTarget)}
        title={`Yank ${yankTarget?.version ?? ""}?`}
        description={
          <>
            <span className="font-mono whitespace-nowrap">latest</span> and ranges like <span className="font-mono whitespace-nowrap">^{yankTarget?.version.split(".")[0]}</span> stop resolving to{" "}
            <span className="font-mono whitespace-nowrap">{skill.name}@{yankTarget?.version}</span>. Exact pins, including every <span className="font-mono whitespace-nowrap">skills.lock.json</span> that
            names it, still install it, so nothing already installed breaks.
          </>
        }
        confirmLabel={`Yank ${yankTarget?.version ?? ""}`}
        danger
        busy={busy}
        error={err}
      >
        <Field
          label="Reason"
          htmlFor="yank-reason"
          hint="Shown to everyone who views this version. Say what to use instead."
          error={tried && !reason.trim() ? "Write a reason before yanking." : undefined}
        >
          <Input
            id="yank-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            aria-invalid={tried && !reason.trim()}
            placeholder={`e.g. Breaks on OpenTofu 1.10, use ${latest ?? "the latest version"}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && yankTarget) {
                e.preventDefault();
                void yank(yankTarget);
              }
            }}
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!unyankTarget}
        onClose={close}
        onConfirm={() => unyankTarget && void unyank(unyankTarget)}
        title={`Unyank ${unyankTarget?.version ?? ""}?`}
        description={
          <>
            <span className="font-mono whitespace-nowrap">latest</span> and ranges resolve to <span className="font-mono whitespace-nowrap">{skill.name}@{unyankTarget?.version}</span> again when it is the highest
            match.
          </>
        }
        confirmLabel={`Unyank ${unyankTarget?.version ?? ""}`}
        busy={busy}
        error={err}
      />
    </>
  );
}

export function VersionsSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-line" aria-busy="true" aria-label="Loading versions">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-start gap-4 border-b border-line px-4 py-3.5 last:border-0">
          <Skeleton className="h-4 w-16" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- history ----------

/** Per-skill audit trail. Loads on first open, so the ledger never waits for it. */
function History({ name }: { name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="group border-b border-line">
      <summary className="flex min-h-11 list-none items-center gap-2 rounded-md px-1 text-sm font-medium text-fg select-none hover:bg-surface-2 max-md:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-open:rotate-90" aria-hidden />
        History
        <span className="font-normal text-fg-muted">publishes, yanks and access changes</span>
      </summary>
      {open && <HistoryRows name={name} />}
    </details>
  );
}

function HistoryRows({ name }: { name: string }) {
  const rows = useAsync(() => api.audit({ target: name, limit: 100 }), [name]);
  return (
    <div className="border-t border-line">
      {rows.error ? (
        <ErrorState error={rows.error} onRetry={rows.reload} title="Could not load the history" />
      ) : !rows.data ? (
        <AuditSkeleton rows={4} />
      ) : !rows.data.length ? (
        <p className="px-4 py-4 text-sm text-fg-muted">No events yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {rows.data.map((e) => (
            <AuditRow key={e.id} e={e} dense />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- compare ----------

const STATUS_LABEL: Record<DiffFile["status"], string> = { added: "added", removed: "removed", modified: "changed", unchanged: "unchanged" };
const STATUS_MARK: Record<DiffFile["status"], { ch: string; cls: string }> = {
  added: { ch: "A", cls: "text-ok-text" },
  removed: { ch: "D", cls: "text-danger-text" },
  modified: { ch: "M", cls: "text-warning-text" },
  unchanged: { ch: " ", cls: "text-fg-subtle" },
};

interface DiffLine {
  kind: "ctx" | "add" | "del" | "hunk";
  text: string;
  a?: number;
  b?: number;
}

function parsePatch(patch: string): { lines: DiffLine[]; adds: number; dels: number } {
  const out: DiffLine[] = [];
  let a = 0;
  let b = 0;
  let adds = 0;
  let dels = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("---") || raw.startsWith("+++")) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      out.push({ kind: "hunk", text: raw });
      continue;
    }
    // Anything before the first hunk is patch header ("Index:", "====="), not file content.
    if (!out.length || raw === "" || raw.startsWith("\\")) continue;
    const c = raw[0];
    const text = raw.slice(1);
    if (c === "+") {
      out.push({ kind: "add", text, b: b++ });
      adds++;
    } else if (c === "-") {
      out.push({ kind: "del", text, a: a++ });
      dels++;
    } else out.push({ kind: "ctx", text, a: a++, b: b++ });
  }
  return { lines: out, adds, dels };
}

const fileId = (p: string) => `diff-${p.replace(/[^a-z0-9]+/gi, "-")}`;

function FileDiff({ file, parsed }: { file: DiffFile; parsed: ReturnType<typeof parsePatch> | null }) {
  const M = STATUS_MARK[file.status];
  return (
    <section id={fileId(file.path)} aria-label={`${file.path}, ${STATUS_LABEL[file.status]}`} className="scroll-mt-28 overflow-hidden rounded-lg border border-line bg-surface">
      <header className="flex min-h-9 items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
        <span className={cx("w-3 font-mono text-xs font-semibold", M.cls)} aria-hidden>
          {M.ch}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-sm font-medium" title={file.path}>
          {file.path}
        </span>
        <span className="text-sm text-fg-muted">{STATUS_LABEL[file.status]}</span>
        {parsed && (
          <span className="font-mono text-xs tabular">
            <span className="text-ok-text">+{parsed.adds}</span> <span className="text-danger-text">-{parsed.dels}</span>
          </span>
        )}
      </header>
      {file.binary ? (
        <p className="px-4 py-3 text-sm text-fg-muted">Binary file. Its contents are not shown.</p>
      ) : !parsed ? (
        <p className="px-4 py-3 text-sm text-fg-muted">No line changes.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse font-mono text-xs leading-5">
            <tbody>
              {parsed.lines.map((l, i) =>
                l.kind === "hunk" ? (
                  <tr key={i} className="bg-surface-2">
                    <td colSpan={3} className="px-3 py-0.5 text-fg-muted">
                      {l.text}
                    </td>
                  </tr>
                ) : (
                  <tr key={i} className={l.kind === "add" ? "bg-diff-add" : l.kind === "del" ? "bg-diff-del" : undefined}>
                    <td
                      aria-hidden
                      className={cx(
                        "w-px border-r border-line px-2 text-right tabular select-none",
                        l.kind === "del" ? "bg-diff-del-strong text-fg-muted" : l.kind === "add" ? "text-fg-muted" : "text-fg-subtle",
                      )}
                    >
                      {l.a ?? ""}
                    </td>
                    <td
                      aria-hidden
                      className={cx(
                        "w-px border-r border-line px-2 text-right tabular select-none",
                        l.kind === "add" ? "bg-diff-add-strong text-fg-muted" : l.kind === "del" ? "text-fg-muted" : "text-fg-subtle",
                      )}
                    >
                      {l.b ?? ""}
                    </td>
                    <td className="pr-4 pl-2 whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
                      <span className={cx("inline-block w-4 font-semibold select-none", l.kind === "add" ? "text-ok-text" : l.kind === "del" ? "text-danger-text" : "text-transparent")} aria-hidden>
                        {l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}
                      </span>
                      <span className="sr-only">{l.kind === "add" ? "added: " : l.kind === "del" ? "removed: " : ""}</span>
                      {l.text}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Compare({ skill, from, to, onChange }: { skill: SkillDetail; from: string; to: string; onChange: (from: string, to: string) => void }) {
  const diff = useAsync(() => (from && to && from !== to ? api.diff(skill.name, from, to) : Promise.resolve(null)), [skill.name, from, to]);
  const changed = useMemo(() => diff.data?.files.filter((f) => f.status !== "unchanged") ?? [], [diff.data]);
  const parsed = useMemo(() => new Map(changed.map((f) => [f.path, f.patch ? parsePatch(f.patch) : null])), [changed]);
  const unchanged = (diff.data?.files.length ?? 0) - changed.length;
  const totals = useMemo(() => {
    let adds = 0;
    let dels = 0;
    for (const p of parsed.values()) if (p) {
      adds += p.adds;
      dels += p.dels;
    }
    return { adds, dels };
  }, [parsed]);
  const opt = (v: VersionMeta) => (
    <option key={v.version} value={v.version}>
      {v.version}
      {v.yanked ? " (yanked)" : ""}
    </option>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Older version" value={from} onChange={(e) => onChange(e.target.value, to)} className="font-mono [&_select]:font-mono">
          {skill.versions.map(opt)}
        </Select>
        <span className="text-sm text-fg-muted">to</span>
        <Select aria-label="Newer version" value={to} onChange={(e) => onChange(from, e.target.value)} className="font-mono [&_select]:font-mono">
          {skill.versions.map(opt)}
        </Select>
        <IconButton label="Swap versions" onClick={() => onChange(to, from)} disabled={from === to}>
          <ArrowLeftRight className="size-3.5" aria-hidden />
        </IconButton>
        {diff.data && changed.length > 0 && (
          <span className="text-sm text-fg-muted tabular sm:ml-auto">
            {plural(changed.length, "file")} changed, <span className="font-mono text-xs text-ok-text">+{totals.adds}</span>{" "}
            <span className="font-mono text-xs text-danger-text">-{totals.dels}</span>
          </span>
        )}
      </div>

      {from === to ? (
        <EmptyState title="Pick two different versions" align="start" className="px-0 py-8">
          Choose an older and a newer version to see every line that changed between them.
        </EmptyState>
      ) : diff.error ? (
        <ErrorState error={diff.error} onRetry={diff.reload} title={`Could not compare ${from} and ${to}`} />
      ) : !diff.data ? (
        <div className="grid gap-4 lg:grid-cols-[208px_minmax(0,1fr)]" aria-busy="true" aria-label="Loading comparison">
          <Skeleton className="h-28 max-lg:hidden" />
          <div className="flex flex-col gap-4">
            <Skeleton className="h-40" />
            <Skeleton className="h-24" />
          </div>
        </div>
      ) : changed.length === 0 ? (
        <EmptyState title="These versions are identical" align="start" className="px-0 py-8">
          Every file has the same content in <span className="font-mono whitespace-nowrap">{from}</span> and <span className="font-mono whitespace-nowrap">{to}</span>.
        </EmptyState>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[208px_minmax(0,1fr)]">
          <nav aria-label="Changed files" className="self-start rounded-lg border border-line bg-panel p-1 lg:sticky lg:top-[104px]">
            <ul>
              {changed.map((f) => {
                const M = STATUS_MARK[f.status];
                const p = parsed.get(f.path);
                return (
                  <li key={f.path}>
                    <a
                      href={`#${fileId(f.path)}`}
                      title={f.path}
                      className="flex min-h-7 items-start gap-2 rounded-[4px] px-2 py-1 text-fg-muted hover:bg-surface-2 hover:text-fg max-md:min-h-11 max-md:items-center"
                    >
                      <span className={cx("w-3 font-mono text-xs font-semibold", M.cls)} aria-hidden>
                        {M.ch}
                      </span>
                      <span className="min-w-0 flex-1 font-mono text-xs leading-5 [overflow-wrap:anywhere]">{f.path}</span>
                      <span className="sr-only">{STATUS_LABEL[f.status]}</span>
                      {p && <span className="font-mono text-xs text-fg-subtle tabular">{p.adds + p.dels}</span>}
                    </a>
                  </li>
                );
              })}
            </ul>
            {unchanged > 0 && <p className="mt-1 border-t border-line px-2 pt-1.5 pb-1 text-sm text-fg-muted">{plural(unchanged, "file")} unchanged</p>}
          </nav>
          <div className={cx("flex min-w-0 flex-col gap-4", diff.loading && "opacity-60")}>
            {changed.map((f) => (
              <FileDiff key={f.path} file={f} parsed={parsed.get(f.path) ?? null} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
