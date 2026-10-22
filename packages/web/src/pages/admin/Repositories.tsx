// Repositories (admins): the git sources skills are published from. Once one is connected and enabled,
// every publish becomes a pull request that needs an approved merge, and each sync turns merged pull
// requests into versions. Per source: Test (read-only access checks), Sync now, Edit, Disable, Delete.
// The connect form asks for what the registry needs, says which scopes each credential must carry, and
// runs the access test right after saving.
import { useState } from "react";
import { Navigate } from "react-router";
import { CircleCheck, CircleDashed, CircleX, ExternalLink, GitBranch, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { GitCredentialInput, GitProviderId, GitSource, GitSourceInput, SourceCheck, SyncStatus } from "@intra-skills/shared/types";
import { api } from "../../api";
import { useMe } from "../../auth";
import { useAsync } from "../../lib/useAsync";
import { formatDateTime, plural, relativeTime, shortSha } from "../../lib/format";
import {
  Button,
  CodeLine,
  ConfirmDialog,
  Dialog,
  Disclosure,
  ErrorState,
  Field,
  InlineError,
  Input,
  Menu,
  Segmented,
  Skeleton,
  cx,
  useToast,
} from "../../components/ui";
import { Page, PageIntro, StatusText } from "../../components/admin/Page";
import { PROVIDER_LABEL } from "../../components/admin/GitIdentities";
import { useDocTitle } from "./parts";

const CHECK_LABEL: Record<string, string> = {
  credential: "Credential",
  repo: "Read the repository",
  branch: "Base branch",
  write: "Create branches and pull requests",
};

const repoUrl = (s: Pick<GitSource, "provider" | "repo" | "apiUrl">) =>
  s.provider === "github"
    ? s.apiUrl
      ? null
      : `https://github.com/${s.repo}`
    : `https://bitbucket.org/${s.repo}`;

/** The provider as a small mono mark, so a list of sources scans by host. */
function ProviderMark({ provider }: { provider: GitProviderId }) {
  return (
    <span
      aria-hidden
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-[28%] border border-line-strong bg-surface-2 font-mono text-xs font-semibold text-fg-muted"
      title={PROVIDER_LABEL[provider]}
    >
      {provider === "github" ? "GH" : "BB"}
    </span>
  );
}

export function Repositories() {
  useDocTitle("Repositories");
  const me = useMe();
  const sources = useAsync(() => api.listSources(), []);
  const [connecting, setConnecting] = useState(false);
  const [editing, setEditing] = useState<GitSource | null>(null);
  if (me.role !== "admin") return <Navigate to="/" replace />;

  const list = sources.data ? [...sources.data].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.createdAt.localeCompare(b.createdAt)) : null;
  const anyEnabled = list?.some((s) => s.enabled);
  const replace = (s: GitSource) => sources.data && sources.setData(sources.data.map((x) => (x.id === s.id ? s : x)));

  return (
    <Page>
      <PageIntro
        title="Repositories"
       
        description={
          anyEnabled
            ? "Skills, plugins and rules are published from these repositories. Everything new and every update arrives as a pull request, and a merged pull request with enough approvals becomes a version on the next sync."
            : "Connect the GitHub or Bitbucket Cloud repository your skills, plugins and rules live in. From then on every publish arrives as a pull request that needs an approved merge."
        }
        meta={
          list && (
            <p className="text-sm text-fg-muted">
              Publishing now:{" "}
              {/* From the live list, not the meta read at page load: it changes the moment a source is enabled. */}
              <span className="font-medium text-fg">{anyEnabled ? "through pull requests" : "directly, with no review"}</span>
            </p>
          )
        }
        actions={
          list &&
          list.length > 0 && (
            <Button variant="primary" onClick={() => setConnecting(true)}>
              Connect a repository
            </Button>
          )
        }
        rule={false}
      />

      {sources.error ? (
        <div className="border-y border-line">
          <ErrorState error={sources.error} onRetry={sources.reload} title="Could not load repositories" />
        </div>
      ) : !list ? (
        <div className="border-y border-line" aria-busy="true" aria-label="Loading repositories">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="flex gap-3 border-b border-line px-1 py-5 last:border-b-0 md:px-3">
              <Skeleton className="size-8" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-56" />
                <Skeleton className="h-3 w-80 max-w-full" />
              </div>
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <FirstConnect onConnect={() => setConnecting(true)} />
      ) : (
        <ul aria-label="Connected repositories" className="border-y border-line">
          {list.map((s) => (
            <SourceRow key={s.id} source={s} onChange={replace} onEdit={() => setEditing(s)} onDeleted={() => sources.setData((sources.data ?? []).filter((x) => x.id !== s.id))} />
          ))}
        </ul>
      )}

      <SourceDialog
        key={connecting ? "new-open" : "new"}
        open={connecting}
        onClose={() => setConnecting(false)}
        onSaved={(s) => sources.setData([...(sources.data ?? []).filter((x) => x.id !== s.id), s])}
      />
      {editing && (
        <SourceDialog
          key={editing.id}
          open
          source={editing}
          onClose={() => setEditing(null)}
          onSaved={(s) => {
            replace(s);
          }}
        />
      )}
    </Page>
  );
}

function FirstConnect({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="grid gap-8 border-y border-line py-10 md:grid-cols-[minmax(0,1fr)_minmax(0,340px)] md:gap-12">
      <div>
        <h2 className="display text-xl text-fg">No repository connected</h2>
        <p className="mt-2 max-w-[60ch] text-sm text-fg-muted">
          Right now <code className="font-mono text-[0.93em] text-fg">intra publish</code> creates a version as soon as it passes validation. Connect a repository and the
          registry opens a pull request for every publish instead; the version goes live once someone other than the author approves it and it merges.
        </p>
        <Button variant="primary" className="mt-5" onClick={onConnect}>
          Connect a repository
        </Button>
      </div>
      <ol className="flex flex-col gap-3 text-sm text-fg-muted">
        {[
          ["Pick the host and repository", "GitHub, GitHub Enterprise Server or Bitbucket Cloud. Skills live in one folder of it, skills/ by default."],
          ["Give the registry a credential", "A token that can read the repository and open pull requests. It is encrypted at rest and never shown again."],
          ["Test, then sync", "The registry checks its access, then reads merged pull requests on a timer or when the webhook calls."],
        ].map(([t, d], i) => (
          <li key={t} className="grid grid-cols-[1.75rem_minmax(0,1fr)]">
            <span aria-hidden className="font-mono text-fg-subtle tabular">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span>
              <span className="block font-medium text-fg">{t}</span>
              {d}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---------- one source ----------

function SourceRow({ source: s, onChange, onEdit, onDeleted }: { source: GitSource; onChange: (s: GitSource) => void; onEdit: () => void; onDeleted: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<"test" | "sync" | "toggle" | "delete" | null>(null);
  const [checks, setChecks] = useState<SourceCheck[] | null>(null);
  const [err, setErr] = useState<unknown>();
  const [deleting, setDeleting] = useState(false);
  const url = repoUrl(s);

  const run = async (kind: "test" | "sync" | "toggle", fn: () => Promise<void>) => {
    setBusy(kind);
    setErr(undefined);
    try {
      await fn();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };
  const test = () =>
    run("test", async () => {
      const r = await api.testSource(s.id);
      setChecks(r.checks);
    });
  const sync = () =>
    run("sync", async () => {
      const st = await api.syncSource(s.id);
      onChange({ ...s, lastSync: st });
      toast({ message: st.ok ? (st.ingested.length ? `Synced ${s.repo}: ${plural(st.ingested.length, "new version")}` : `Synced ${s.repo}: nothing new`) : `Sync of ${s.repo} failed` });
    });
  const toggle = () =>
    run("toggle", async () => {
      const next = await api.patchSource(s.id, { enabled: !s.enabled });
      onChange(next);
      toast({ message: next.enabled ? `Enabled ${s.repo}` : `Disabled ${s.repo}. It is no longer read or proposed to.` });
    });
  const remove = async () => {
    setBusy("delete");
    setErr(undefined);
    try {
      await api.deleteSource(s.id);
      setDeleting(false);
      onDeleted();
      toast({ message: `Disconnected ${s.repo}` });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className={cx("border-b border-line px-1 py-5 last:border-b-0 md:px-3", !s.enabled && "bg-panel/60")}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <ProviderMark provider={s.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {url ? (
              <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-[15px] font-medium text-fg hover:underline hover:decoration-line-control hover:underline-offset-4">
                {s.repo}
                <ExternalLink className="size-3 text-fg-subtle" aria-hidden />
                <span className="sr-only">(opens on {PROVIDER_LABEL[s.provider]})</span>
              </a>
            ) : (
              <span className="font-mono text-[15px] font-medium text-fg">{s.repo}</span>
            )}
            <span className="text-xs text-fg-subtle">{s.apiUrl ? "GitHub Enterprise Server" : PROVIDER_LABEL[s.provider]}</span>
            {s.isDefault && <span className="rounded-sm border border-line-strong bg-surface-2 px-1.5 text-xs font-medium text-fg-muted" title="New skills are proposed into this repository">Default</span>}
            {!s.enabled && <span className="rounded-sm border border-line-strong px-1.5 text-xs text-fg-muted">Disabled</span>}
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
            <Fact k="Branch">
              <span className="inline-flex items-center gap-1 font-mono text-[13px]">
                <GitBranch className="size-3 text-fg-subtle" aria-hidden />
                {s.baseBranch}
              </span>
            </Fact>
            <Fact k="Folders">
              <span className="font-mono text-[13px]" title="Where sync looks for skills, plugins and rules">
                {s.root}/ <span className="text-fg-subtle">·</span> {s.pluginsRoot ?? "plugins"}/ <span className="text-fg-subtle">·</span> {s.rulesRoot ?? "rules"}/
              </span>
            </Fact>
            <Fact k="Approvals needed">
              <span className="tabular">{s.minApprovals}</span>
            </Fact>
            {s.credential.set && (
              <Fact k="Credential">
                <span className="font-mono text-[13px]">{s.credential.hint}</span>
              </Fact>
            )}
            <Fact k="Webhook">{s.webhook.secretSet ? "secret set" : "off, polling only"}</Fact>
          </dl>
          {!s.credential.set && (
            <p className="mt-2.5 flex items-start gap-2 text-sm text-warning-text">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>
                No credential stored, so Test and Sync fail and no pull request can be opened.{" "}
                <button type="button" onClick={onEdit} className="font-medium text-fg underline decoration-line-control underline-offset-4 hover:decoration-current max-md:min-h-11">
                  Add a credential
                </button>
              </span>
            </p>
          )}
          {/* Without a credential the warning above already says why a sync fails; do not say it twice. */}
          <LastSync status={s.lastSync} quiet={!s.credential.set} />
        </div>
        <div className="flex shrink-0 items-center gap-2 max-md:w-full">
          <Button size="sm" onClick={test} loading={busy === "test"} disabled={!!busy && busy !== "test"} icon={<ShieldCheck className="size-3.5" aria-hidden />} className="max-md:flex-1">
            Test
          </Button>
          <Button size="sm" onClick={sync} loading={busy === "sync"} disabled={!s.enabled || (!!busy && busy !== "sync")} icon={<RefreshCw className="size-3.5" aria-hidden />} title={s.enabled ? undefined : "Enable it to sync"} className="max-md:flex-1">
            Sync now
          </Button>
          <Menu
            label={`More actions for ${s.repo}`}
            size="sm"
            items={[
              { label: "Edit", onSelect: onEdit },
              { label: s.enabled ? "Disable" : "Enable", onSelect: () => void toggle() },
              "separator",
              { label: "Delete", danger: true, onSelect: () => (setErr(undefined), setDeleting(true)) },
            ]}
          />
        </div>
      </div>

      {(checks || err != null) && (
        <div className="mt-4 md:pl-12">
          {err != null && !deleting && <InlineError error={err} />}
          {checks && <CheckList checks={checks} onClose={() => setChecks(null)} />}
        </div>
      )}

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => void remove()}
        title={`Disconnect ${s.repo}?`}
        description={
          <>
            The registry stops reading <span className="font-mono text-fg">{s.repo}</span> and forgets its credential. Versions it already published stay installable.
            Open proposals into it stop updating. If it is the only repository, publishing goes back to direct, with no review.
          </>
        }
        confirmLabel={`Delete ${s.repo}`}
        danger
        busy={busy === "delete"}
        error={deleting ? err : undefined}
      />
    </li>
  );
}

function Fact({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-fg-subtle">{k}</dt>
      <dd className="text-fg-muted">{children}</dd>
    </div>
  );
}

function LastSync({ status, quiet = false }: { status: SyncStatus | null; quiet?: boolean }) {
  if (!status) return <p className="mt-2.5 text-sm text-fg-subtle">Not synced yet. Run Test, then Sync now.</p>;
  return (
    <div className="mt-2.5">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <StatusText tone={status.ok ? "ok" : "bad"} icon={status.ok ? <CircleCheck aria-hidden /> : <CircleX aria-hidden />}>
          {status.ok ? "Last sync" : "Last sync failed"}
        </StatusText>
        <time dateTime={status.at} title={formatDateTime(status.at)} className="text-fg-muted tabular">
          {relativeTime(status.at)}
        </time>
        {status.headCommit && <span className="font-mono text-xs text-fg-subtle">at {shortSha(status.headCommit)}</span>}
      </p>
      {!quiet && (!status.ok || status.ingested.length === 0) && <p className={cx("mt-0.5 text-sm", status.ok ? "text-fg-muted" : "text-danger-text")}>{status.message}</p>}
      {(status.ingested.length > 0 || status.skipped.length > 0) && (
        <div className="mt-2 flex flex-col gap-2">
          {status.ingested.length > 0 && (
            <p className="text-sm text-fg-muted">
              <span className="text-fg">Published {plural(status.ingested.length, "version")}:</span>{" "}
              <span className="font-mono text-[13px]">{status.ingested.join(", ")}</span>
            </p>
          )}
          {status.skipped.length > 0 && (
            <Disclosure summary={`Skipped ${plural(status.skipped.length, "folder")}`} className="max-w-2xl">
              <ul className="flex flex-col gap-1.5 text-sm">
                {status.skipped.map((k) => (
                  <li key={k.path} className="flex flex-wrap gap-x-3">
                    <span className="font-mono text-[13px] text-fg">{k.path}</span>
                    <span className="text-fg-muted">{k.reason}</span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          )}
        </div>
      )}
    </div>
  );
}

const isSkipped = (c: SourceCheck) => !c.ok && /^skipped\b/i.test(c.message);

function CheckList({ checks, onClose }: { checks: SourceCheck[]; onClose?: () => void }) {
  const ok = checks.every((c) => c.ok);
  const failed = checks.filter((c) => !c.ok && !isSkipped(c)).length;
  return (
    <div role="status" className={cx("rounded-md border px-3 py-3", ok ? "border-ok-line bg-ok-soft" : "border-danger-line bg-danger-soft")}>
      <div className="flex items-center justify-between gap-3">
        <p className={cx("text-sm font-medium", ok ? "text-ok-text" : "text-danger-text")}>
          {ok ? "Every check passed. The registry can read this repository and open pull requests." : `${plural(failed, "check")} failed. The registry cannot use this repository until ${failed === 1 ? "it passes" : "they pass"}.`}
        </p>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose}>
            Hide
          </Button>
        )}
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {checks.map((c) => (
          <li key={c.name} className="grid grid-cols-[1rem_minmax(0,1fr)] gap-x-2 text-sm">
            {c.ok ? (
              <CircleCheck className="mt-0.5 size-3.5 text-ok-text" aria-hidden />
            ) : isSkipped(c) ? (
              <CircleDashed className="mt-0.5 size-3.5 text-fg-subtle" aria-hidden />
            ) : (
              <CircleX className="mt-0.5 size-3.5 text-danger-text" aria-hidden />
            )}
            <span className="min-w-0">
              <span className={isSkipped(c) ? "text-fg-muted" : "text-fg"}>{CHECK_LABEL[c.name] ?? c.name}</span>
              <span className="sr-only">{c.ok ? ": passed" : isSkipped(c) ? ": not run" : ": failed"}</span>
              <span className="text-fg-muted"> · {c.message}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- connect / edit ----------

type CredKind = "token" | "basic" | "github-app";

interface Draft {
  provider: GitProviderId;
  enterprise: boolean;
  apiUrl: string;
  repo: string;
  baseBranch: string;
  root: string;
  pluginsRoot: string;
  rulesRoot: string;
  minApprovals: string;
  kind: CredKind;
  token: string;
  username: string;
  password: string;
  appId: string;
  installationId: string;
  privateKey: string;
  webhookSecret: string;
  isDefault: boolean;
}

const fromSource = (s?: GitSource): Draft => ({
  provider: s?.provider ?? "github",
  enterprise: !!s?.apiUrl,
  apiUrl: s?.apiUrl ?? "",
  repo: s?.repo ?? "",
  baseBranch: s?.baseBranch ?? "main",
  root: s?.root ?? "skills",
  pluginsRoot: s?.pluginsRoot ?? "plugins",
  rulesRoot: s?.rulesRoot ?? "rules",
  minApprovals: String(s?.minApprovals ?? 1),
  kind: s?.credential.kind ?? "token",
  token: "",
  username: "",
  password: "",
  appId: "",
  installationId: "",
  privateKey: "",
  webhookSecret: "",
  isDefault: s?.isDefault ?? false,
});

const clean = (p: string) => p.trim().replace(/^\/+|\/+$/g, "");

const GITHUB_REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const BITBUCKET_REPO_RE = /^[a-z0-9][a-z0-9_.-]{0,61}\/[a-z0-9][a-z0-9_.-]{0,61}$/;

/** Accept a pasted browser URL as well as owner/name. */
function normalizeRepo(raw: string): string {
  let r = raw.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = r.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com|bitbucket\.org)\/([^/]+\/[^/]+)/i) ?? r.match(/^git@(?:github\.com|bitbucket\.org):([^/]+\/[^/]+)$/i);
  if (m) r = m[1]!;
  return r;
}

function randomSecret(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function SourceDialog({ open, onClose, onSaved, source }: { open: boolean; onClose: () => void; onSaved: (s: GitSource) => void; source?: GitSource }) {
  const editing = !!source;
  const [d, setD] = useState<Draft>(() => fromSource(source));
  const [changeCred, setChangeCred] = useState(!editing);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState<GitSource | null>(null);
  const [checks, setChecks] = useState<SourceCheck[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [testErr, setTestErr] = useState<unknown>();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));

  const gh = d.provider === "github";
  const repo = normalizeRepo(d.repo);
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (!(gh ? GITHUB_REPO_RE : BITBUCKET_REPO_RE).test(repo)) errors.repo = gh ? "Use owner/name, for example acme/skills." : "Use workspace/repo-slug in lowercase, for example acme/skills.";
  if (gh && d.enterprise && !/^https:\/\/[^\s/]+/.test(d.apiUrl.trim())) errors.apiUrl = "The https API address of your server, for example https://github.example.com/api/v3.";
  if (!d.baseBranch.trim()) errors.baseBranch = "Name the branch pull requests merge into.";
  if (!d.root.trim() || d.root.includes("..")) errors.root = "A folder inside the repository, for example skills.";
  if (!d.pluginsRoot.trim() || d.pluginsRoot.includes("..")) errors.pluginsRoot = "A folder inside the repository, for example plugins.";
  if (!d.rulesRoot.trim() || d.rulesRoot.includes("..")) errors.rulesRoot = "A folder inside the repository, for example rules.";
  const mn = Number(d.minApprovals);
  if (!Number.isInteger(mn) || mn < 0 || mn > 10) errors.minApprovals = "A whole number from 0 to 10.";
  if (changeCred) {
    if (d.kind === "token" && !d.token.trim()) errors.token = "Paste the token.";
    if (d.kind === "basic") {
      if (!d.username.trim()) errors.username = "Your Bitbucket username or the email the API token belongs to.";
      if (!d.password.trim()) errors.password = "Paste the API token.";
    }
    if (d.kind === "github-app") {
      if (!/^(\d+|Iv[0-9A-Za-z.]+)$/.test(d.appId.trim())) errors.appId = "The App ID (a number) or its client ID (starts with Iv).";
      if (!/^\d+$/.test(d.installationId.trim())) errors.installationId = "A number, from the installation's settings URL.";
      if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(d.privateKey)) errors.privateKey = "Paste the whole .pem file, including the BEGIN and END lines.";
    }
  }
  if (d.webhookSecret && d.webhookSecret.length < 16) errors.webhookSecret = "At least 16 characters. Use Generate for a strong one.";
  const shown = (k: keyof Draft) => (touched ? errors[k] : undefined);
  const valid = Object.keys(errors).length === 0;

  const credential = (): GitCredentialInput =>
    d.kind === "token"
      ? { kind: "token", token: d.token.trim() }
      : d.kind === "basic"
        ? { kind: "basic", username: d.username.trim(), password: d.password.trim() }
        : { kind: "github-app", appId: d.appId.trim(), installationId: d.installationId.trim(), privateKey: d.privateKey.trim() };

  const runTest = async (s: GitSource) => {
    setTesting(true);
    setTestErr(undefined);
    try {
      setChecks((await api.testSource(s.id)).checks);
    } catch (e) {
      setTestErr(e);
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    setBusy(true);
    setErr(undefined);
    try {
      const body: GitSourceInput = {
        repo,
        baseBranch: d.baseBranch.trim(),
        root: clean(d.root),
        pluginsRoot: clean(d.pluginsRoot),
        rulesRoot: clean(d.rulesRoot),
        minApprovals: mn,
        apiUrl: gh && d.enterprise ? d.apiUrl.trim() : null,
        isDefault: d.isDefault || undefined,
      };
      if (!editing) body.provider = d.provider;
      if (changeCred) body.credential = credential();
      if (d.webhookSecret) body.webhookSecret = d.webhookSecret;
      const s = editing ? await api.patchSource(source!.id, body) : await api.createSource(body);
      setSaved(s);
      onSaved(s);
      void runTest(s);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const close = () => onClose();

  if (saved)
    return (
      <Dialog
        open={open}
        onClose={close}
        width="max-w-xl"
        title={
          checks && checks.some((c) => !c.ok)
            ? checks.find((c) => !c.ok && !isSkipped(c))?.name === "credential"
              ? `${PROVIDER_LABEL[saved.provider]} refused the credential`
              : "A check failed"
            : editing
              ? `Saved ${saved.repo}`
              : `Connected ${saved.repo}`
        }
        description={
          checks && checks.some((c) => !c.ok)
            ? (
                <>
                  <span className="font-mono text-[0.93em] text-fg">{saved.repo}</span> is saved, but the registry cannot use it yet. Fix what failed with Edit, then test again.
                </>
              )
            : editing
              ? "The registry re-checked its access with the new settings."
              : "From now on every publish arrives as a pull request into this repository."
        }
        footer={
          <>
            <Button onClick={() => void runTest(saved)} loading={testing}>
              Test again
            </Button>
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5">
          {testing && !checks ? (
            <p className="text-sm text-fg-muted">Checking access on {PROVIDER_LABEL[saved.provider]}...</p>
          ) : testErr ? (
            <InlineError error={testErr} />
          ) : (
            checks && <CheckList checks={checks} />
          )}
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">Webhook URL</p>
            <CodeLine copyText={saved.webhook.url}>{saved.webhook.url}</CodeLine>
            <p className="text-sm text-fg-muted">
              {saved.webhook.secretSet
                ? `Optional, for syncs within seconds of a merge. In the repository's webhook settings, paste this URL and the same secret, content type JSON, and send push and pull request events.`
                : "Webhooks are off because no secret is set; the registry checks for merged pull requests on its poll interval. Edit the repository and add a secret to turn them on."}
            </p>
          </div>
        </div>
      </Dialog>
    );

  const scope = gh
    ? d.kind === "github-app"
      ? "Install the App on this repository with Contents: read and write, and Pull requests: read and write."
      : "A fine-grained personal access token for this repository with Contents: read and write, and Pull requests: read and write."
    : d.kind === "basic"
      ? "An Atlassian API token with Bitbucket scopes for repository read and write, and pull request read and write, plus the username or email it belongs to."
      : "A repository (or workspace) access token with Repositories: read and write, and Pull requests: read and write.";

  return (
    <Dialog
      open={open}
      onClose={close}
      width="max-w-xl"
      title={editing ? `Edit ${source!.repo}` : "Connect a repository"}
      description={editing ? undefined : "Once it is connected, every publish goes through a pull request that needs an approved merge."}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            {editing ? "Save and test" : "Connect and test"}
          </Button>
        </>
      }
    >
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!editing && (
          <div className="flex flex-col gap-1.5">
            <span id="src-host" className="text-sm font-medium">
              Git host
            </span>
            <div aria-labelledby="src-host">
              <Segmented<GitProviderId>
                label="Git host"
                value={d.provider}
                onChange={(v) => setD((x) => ({ ...x, provider: v, kind: "token", enterprise: false }))}
                options={[
                  { value: "github", label: "GitHub" },
                  { value: "bitbucket-cloud", label: "Bitbucket Cloud" },
                ]}
              />
            </div>
          </div>
        )}

        <Field label="Repository" htmlFor="src-repo" error={shown("repo")} hint={gh ? "owner/name, or paste its github.com URL." : "workspace/repo-slug, or paste its bitbucket.org URL."}>
          <Input id="src-repo" mono autoComplete="off" spellCheck={false} placeholder={gh ? "acme/skills" : "acme/skills"} value={d.repo} disabled={editing} onChange={(e) => set("repo", e.target.value)} aria-invalid={!!shown("repo") || undefined} />
        </Field>

        {gh && (
          <label className="-mt-2 flex items-center gap-2 text-sm text-fg-muted select-none">
            <input type="checkbox" checked={d.enterprise} onChange={(e) => set("enterprise", e.target.checked)} className="size-3.5" />
            On GitHub Enterprise Server
          </label>
        )}
        {gh && d.enterprise && (
          <Field label="API address" htmlFor="src-api" error={shown("apiUrl")} hint="Usually https://<your-server>/api/v3.">
            <Input id="src-api" mono type="url" autoComplete="off" spellCheck={false} placeholder="https://github.example.com/api/v3" value={d.apiUrl} onChange={(e) => set("apiUrl", e.target.value)} aria-invalid={!!shown("apiUrl") || undefined} />
          </Field>
        )}

        <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_7rem]">
          <Field label="Base branch" htmlFor="src-branch" error={shown("baseBranch")}>
            <Input id="src-branch" mono autoComplete="off" spellCheck={false} value={d.baseBranch} onChange={(e) => set("baseBranch", e.target.value)} aria-invalid={!!shown("baseBranch") || undefined} />
          </Field>
          <Field label="Approvals" htmlFor="src-min" error={shown("minApprovals")}>
            <Input id="src-min" type="number" inputMode="numeric" min={0} max={10} className="tabular" value={d.minApprovals} onChange={(e) => set("minApprovals", e.target.value)} aria-invalid={!!shown("minApprovals") || undefined} />
          </Field>
        </div>
        <p className="-mt-3 text-sm text-fg-subtle">Approvals counts reviewers other than the proposer and the registry's own account.</p>

        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-medium">Folders</legend>
          <div className="grid gap-x-5 gap-y-4 sm:grid-cols-3">
            <Field label="Skills" htmlFor="src-root" error={shown("root")}>
              <Input id="src-root" mono autoComplete="off" spellCheck={false} value={d.root} onChange={(e) => set("root", e.target.value)} aria-invalid={!!shown("root") || undefined} />
            </Field>
            <Field label="Plugins" htmlFor="src-plugins" error={shown("pluginsRoot")}>
              <Input id="src-plugins" mono autoComplete="off" spellCheck={false} value={d.pluginsRoot} onChange={(e) => set("pluginsRoot", e.target.value)} aria-invalid={!!shown("pluginsRoot") || undefined} />
            </Field>
            <Field label="Rules" htmlFor="src-rules" error={shown("rulesRoot")}>
              <Input id="src-rules" mono autoComplete="off" spellCheck={false} value={d.rulesRoot} onChange={(e) => set("rulesRoot", e.target.value)} aria-invalid={!!shown("rulesRoot") || undefined} />
            </Field>
          </div>
          <ul aria-label="Where sync looks" className="flex flex-col font-mono text-[13px] leading-5 text-fg-muted">
            <li className="[overflow-wrap:anywhere]">{clean(d.root) || "skills"}/&lt;name&gt;/SKILL.md</li>
            <li className="[overflow-wrap:anywhere]">{clean(d.pluginsRoot) || "plugins"}/&lt;name&gt;/.claude-plugin/plugin.json</li>
            <li className="[overflow-wrap:anywhere]">{clean(d.rulesRoot) || "rules"}/&lt;name&gt;/RULE.md</li>
          </ul>
          <p className="text-sm text-fg-subtle">Sync reads each kind from its own folder. A plugin sits directly in its folder; skills and rules may be up to three folders deep.</p>
        </fieldset>

        <fieldset className="flex flex-col gap-4 rounded-lg border border-line p-4">
          <legend className="px-1 text-sm font-medium">Credential</legend>
          {editing && !changeCred ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-fg-muted">
                Stored and encrypted: <span className="font-mono text-[13px] text-fg">{source!.credential.hint}</span>
              </p>
              <Button size="sm" onClick={() => setChangeCred(true)}>
                Replace credential
              </Button>
            </div>
          ) : (
            <>
              <Segmented<CredKind>
                label="Credential type"
                size="sm"
                value={d.kind}
                onChange={(v) => set("kind", v)}
                options={
                  gh
                    ? [
                        { value: "token", label: "Personal access token" },
                        { value: "github-app", label: "GitHub App" },
                      ]
                    : [
                        { value: "token", label: "Access token" },
                        { value: "basic", label: "Username and API token" },
                      ]
                }
              />
              <p className="text-sm text-fg-muted">
                <span className="text-fg">What the registry needs:</span> {scope} Check the exact names on {PROVIDER_LABEL[d.provider]}'s own docs, since hosts rename scopes.
              </p>
              {d.kind === "token" && (
                <Field label={gh ? "Token" : "Access token"} htmlFor="src-token" error={shown("token")} hint="Stored encrypted. You will see only its last characters again.">
                  <Input id="src-token" mono type="password" autoComplete="off" spellCheck={false} placeholder={gh ? "github_pat_..." : ""} value={d.token} onChange={(e) => set("token", e.target.value)} aria-invalid={!!shown("token") || undefined} />
                </Field>
              )}
              {d.kind === "basic" && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Username or email" htmlFor="src-user" error={shown("username")}>
                    <Input id="src-user" autoComplete="off" spellCheck={false} value={d.username} onChange={(e) => set("username", e.target.value)} aria-invalid={!!shown("username") || undefined} />
                  </Field>
                  <Field label="API token" htmlFor="src-pass" error={shown("password")}>
                    <Input id="src-pass" mono type="password" autoComplete="off" spellCheck={false} value={d.password} onChange={(e) => set("password", e.target.value)} aria-invalid={!!shown("password") || undefined} />
                  </Field>
                </div>
              )}
              {d.kind === "github-app" && (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="App ID" htmlFor="src-app" error={shown("appId")} hint="On the App's settings page.">
                      <Input id="src-app" mono autoComplete="off" spellCheck={false} value={d.appId} onChange={(e) => set("appId", e.target.value)} aria-invalid={!!shown("appId") || undefined} />
                    </Field>
                    <Field label="Installation ID" htmlFor="src-inst" error={shown("installationId")} hint="The number at the end of the installation's URL.">
                      <Input id="src-inst" mono inputMode="numeric" autoComplete="off" spellCheck={false} value={d.installationId} onChange={(e) => set("installationId", e.target.value)} aria-invalid={!!shown("installationId") || undefined} />
                    </Field>
                  </div>
                  <Field label="Private key" htmlFor="src-key" error={shown("privateKey")} hint="The .pem file GitHub downloads when you generate a private key for the App.">
                    <textarea
                      id="src-key"
                      rows={4}
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="-----BEGIN RSA PRIVATE KEY-----"
                      value={d.privateKey}
                      onChange={(e) => set("privateKey", e.target.value)}
                      aria-invalid={!!shown("privateKey") || undefined}
                      className="w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 py-2 font-mono text-xs text-fg placeholder:text-fg-subtle transition-colors duration-[120ms] hover:border-line-control focus-visible:border-focus aria-[invalid=true]:border-danger-text"
                    />
                  </Field>
                </>
              )}
            </>
          )}
        </fieldset>

        <Disclosure
          summary="Webhook and default"
          meta={d.webhookSecret || (editing && source!.webhook.secretSet) ? "webhook on" : "optional"}
          defaultOpen={editing && source!.webhook.secretSet}
        >
          <div className="flex flex-col gap-4">
            <Field
              label="Webhook secret"
              htmlFor="src-hook"
              error={shown("webhookSecret")}
              hint={
                editing && source!.webhook.secretSet
                  ? "A secret is set. Type a new one to replace it."
                  : "With a secret, the git host tells the registry about a merge within seconds; the webhook URL appears after you save. Without one, the registry checks on its poll interval."
              }
            >
              <div className="flex gap-2">
                <Input id="src-hook" mono autoComplete="off" spellCheck={false} value={d.webhookSecret} onChange={(e) => set("webhookSecret", e.target.value)} aria-invalid={!!shown("webhookSecret") || undefined} />
                <Button onClick={() => set("webhookSecret", randomSecret())}>Generate</Button>
              </div>
            </Field>
            {d.webhookSecret && (
              <p className="-mt-2 text-sm text-warning-text">Copy this secret now. Paste the same value into the host's webhook settings; the registry never shows it again.</p>
            )}
            <label className="flex items-center gap-2 text-sm text-fg select-none">
              <input type="checkbox" checked={d.isDefault} onChange={(e) => set("isDefault", e.target.checked)} className="size-3.5" />
              Propose new skills into this repository (default)
            </label>
          </div>
        </Disclosure>

        <InlineError error={err} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
