// Account settings in one readable column: profile, git identities, API tokens, Claude Code plugins, CLI setup.
// Stale tokens (never used, or unused for 90+ days) are flagged; Revoke is a quiet action behind a
// confirm that names the token, and revocation is final, so its toast offers no undo.
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { TriangleAlert } from "lucide-react";
import type { ApiToken } from "@intra-skills/shared/types";
import { api } from "../api";
import { useAuth, useMe } from "../auth";
import { useRegistryMeta } from "../lib/meta";
import { bootstrapCommand, marketplaceAddCommand, pluginsConnectCommand } from "../lib/commands";
import { marketplaceOf } from "../lib/kinds";
import { HttpsNote, servesPlugins } from "./skill/KindInstall";
import { Page, PageIntro, PageSection } from "../components/admin/Page";
import { GitIdentityForm } from "../components/admin/GitIdentities";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatDateTime, relativeTime } from "../lib/format";
import {
  Button,
  ConfirmDialog,
  CopyCommand,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  Input,
  Skeleton,
  WarningLine,
  cx,
  useToast,
} from "../components/ui";
import { TokenReveal, useDocTitle } from "./admin/parts";

// Kept for older imports; the component lives with the other admin parts now.
export { TokenReveal } from "./admin/parts";

const DAY = 86_400_000;
const STALE_DAYS = 90;

function staleness(t: ApiToken, now = Date.now()): "never" | "stale" | null {
  if (!t.lastUsedAt) return now - new Date(t.createdAt).getTime() > DAY ? "never" : null;
  return now - new Date(t.lastUsedAt).getTime() >= STALE_DAYS * DAY ? "stale" : null;
}

export function Settings() {
  useDocTitle("Settings");
  const me = useMe();
  const { setUser } = useAuth();
  const meta = useRegistryMeta();
  const toast = useToast();
  const tokens = useAsync(() => api.listTokens(), []);
  const [params, setParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(params.get("create") === "token");
  const [keyOpen, setKeyOpen] = useState(false);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeErr, setRevokeErr] = useState<unknown>();

  // The command palette links to ?create=token.
  useEffect(() => {
    if (params.get("create") === "token") setCreateOpen(true);
  }, [params]);

  const closeCreate = () => {
    setCreateOpen(false);
    if (params.has("create")) {
      const next = new URLSearchParams(params);
      next.delete("create");
      setParams(next, { replace: true });
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    setRevokeErr(undefined);
    try {
      await api.revokeToken(revoking.id);
      tokens.setData((tokens.data ?? []).filter((t) => t.id !== revoking.id));
      toast({ message: `Revoked "${revoking.name}". This cannot be undone.` });
      setRevoking(null);
    } catch (e) {
      setRevokeErr(e);
    } finally {
      setRevokeBusy(false);
    }
  };

  const list = tokens.data ? [...tokens.data].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : null;
  const staleCount = list?.filter((t) => staleness(t)).length ?? 0;
  const teamsText = me.teams.length
    ? me.teams.map((t, i) => (
        <span key={t.slug}>
          {i > 0 && ", "}
          <Link to={`/teams/${t.slug}`} className="text-fg underline decoration-line-control underline-offset-[0.18em] hover:decoration-current">
            {t.slug}
          </Link>
          {t.role === "maintainer" && <span className="text-fg-muted"> (maintainer)</span>}
        </span>
      ))
    : "None yet";

  return (
    <Page width="narrow">
      <PageIntro title="Settings" description="Your profile, the git usernames proposals need, the API tokens that sign the CLI in as you, and the key Claude Code reads plugins with." />

      <PageSection id="profile-h" title="Profile" description="An admin sets your name, handle and role.">
        <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm max-sm:grid-cols-[5.5rem_minmax(0,1fr)]">
          <dt className="text-fg-subtle">Name</dt>
          <dd className="text-fg">{me.displayName}</dd>
          <dt className="text-fg-subtle">Handle</dt>
          <dd className="font-mono text-[0.93em] text-fg">{me.handle}</dd>
          <dt className="text-fg-subtle">Role</dt>
          <dd className="text-fg">{me.role === "admin" ? "Admin: manages every team, person and skill" : "Member: acts through teams and grants"}</dd>
          <dt className="text-fg-subtle">Teams</dt>
          <dd className="text-fg">{teamsText}</dd>
          <dt className="text-fg-subtle">Joined</dt>
          <dd className="text-fg tabular">{formatDate(me.createdAt)}</dd>
        </dl>
      </PageSection>

      <PageSection
        id="git-h"
        title="Git identities"
        description={
          meta?.publishMode === "pull-request"
            ? (
                <>
                  Every new skill and update here arrives as a pull request. Your username on the git host lets the registry make sure someone other than you approves it;{" "}
                  <code className="font-mono text-[0.93em] text-fg">intra publish</code> refuses without it.
                </>
              )
            : "When an admin connects a repository, every publish becomes a pull request. Your username on the git host lets the registry make sure someone other than you approves it."
        }
      >
        <GitIdentityForm idBase="set-git" user={me} save={(ids) => api.setMyGitIdentities(ids)} onSaved={setUser} compact />
      </PageSection>

      <PageSection
        id="tokens-h"
        title="API tokens"
        description="A token signs the CLI or a CI job in as you, with your permissions. Make one per machine, so revoking one breaks nothing else."
        actions={
          list && list.length > 0 ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              Create token
            </Button>
          ) : undefined
        }
      >
        {tokens.error ? (
          <div className="rounded-md border border-line">
            <ErrorState error={tokens.error} onRetry={tokens.reload} title="Could not load your tokens" />
          </div>
        ) : !list ? (
          <TokenSkeleton />
        ) : list.length === 0 ? (
          <div className="rounded-md border border-dashed border-line-strong">
            <EmptyState
              title="No tokens yet"
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  Create token
                </Button>
              }
            >
              The CLI needs a token to install private skills and to publish. Create one, then run the login command it gives you.
            </EmptyState>
          </div>
        ) : (
          <>
            {staleCount > 0 && (
              <WarningLine className="mb-3 max-w-[62ch]" icon={<TriangleAlert aria-hidden />}>
                {staleCount === 1 ? "1 token has" : `${staleCount} tokens have`} not been used in {STALE_DAYS} days or more. Revoke what nothing depends on.
              </WarningLine>
            )}
            <TokenTable tokens={list} onRevoke={(t) => (setRevokeErr(undefined), setRevoking(t))} />
          </>
        )}
      </PageSection>

      <PageSection
        id="plugins-h"
        title="Claude Code plugins"
        description={
          <>
            Claude Code installs this registry's plugins itself, from a marketplace named <code className="font-mono text-[0.93em] text-fg">{marketplaceOf(meta)}</code>. With the
            CLI, one command connects it:
          </>
        }
      >
        <CopyCommand command={pluginsConnectCommand()} label="Copy connect command" />
        <div className="mt-4 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <p className="max-w-[52ch] text-sm text-fg-muted">
            <span className="font-medium text-fg">Or, without the CLI:</span> create a plugin key and add the marketplace by hand. The key only reads plugins: it cannot install skills, publish or change anything. It is listed under API
            tokens and revoked like any other.
          </p>
          <Button onClick={() => setKeyOpen(true)}>Create plugin key</Button>
        </div>
      </PageSection>

      <PageSection id="cli-h" title="CLI setup" description="One line on a fresh laptop installs the CLI, signs it in with a code you approve here, and sets up your agents.">
        <CopyCommand command={bootstrapCommand(meta?.publicUrl ?? window.location.origin)} label="Copy setup command" />
        <p className="mt-3 max-w-[62ch] text-sm text-fg-muted">
          Already installed? Check the setup with <code className="font-mono text-[0.93em] text-fg">intra doctor</code>. The full walkthrough, including the agent prompt and
          MCP, is on{" "}
          <Link to="/get-started" className="text-fg underline decoration-line-control underline-offset-[0.18em] hover:decoration-current">
            Get started
          </Link>
          .
        </p>
      </PageSection>

      <CreateTokenDialog
        open={createOpen}
        onClose={closeCreate}
        onCreated={(meta) => {
          // The dialog can open (from ?create=token) before the list has loaded, so never build on a list that is not there.
          if (tokens.data) tokens.setData([meta, ...tokens.data.filter((t) => t.id !== meta.id)]);
          else tokens.reload();
        }}
      />

      <MarketplaceKeyDialog
        open={keyOpen}
        onClose={() => setKeyOpen(false)}
        onCreated={(meta) => {
          if (tokens.data) tokens.setData([meta, ...tokens.data.filter((t) => t.id !== meta.id)]);
          else tokens.reload();
        }}
      />

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        onConfirm={revoke}
        title={`Revoke "${revoking?.name ?? ""}"?`}
        description={
          <>
            Anything signed in with <code className="font-mono text-[0.93em] text-fg">{revoking?.prefix}…</code> stops working at once. Revocation is final:
            the token cannot be restored, only replaced with a new one.
          </>
        }
        confirmLabel="Revoke token"
        danger
        busy={revokeBusy}
        error={revokeErr}
      />
    </Page>
  );
}

// ---------- tokens table ----------

const TH = "h-8 px-3 first:pl-1 last:pr-1 md:first:pl-3 md:last:pr-3 text-left text-xs font-medium whitespace-nowrap text-fg-subtle";
const TD = "h-11 px-3 first:pl-1 last:pr-1 md:first:pl-3 md:last:pr-3 align-middle";

function LastUsed({ t }: { t: ApiToken }) {
  const s = staleness(t);
  const text = t.lastUsedAt ? relativeTime(t.lastUsedAt) : "Never";
  if (!s)
    return (
      <time dateTime={t.lastUsedAt ?? undefined} title={t.lastUsedAt ? formatDateTime(t.lastUsedAt) : undefined} className="text-fg-muted">
        {text}
      </time>
    );
  return (
    <span
      className="inline-flex items-center gap-1.5 text-warning-text"
      title={s === "never" ? "Never used since it was created" : `Unused for ${STALE_DAYS}+ days. Last used ${formatDateTime(t.lastUsedAt!)}`}
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
      {s === "never" ? "Never used" : text}
      <span className="sr-only">, stale</span>
    </span>
  );
}

function TokenTable({ tokens, onRevoke }: { tokens: ApiToken[]; onRevoke: (t: ApiToken) => void }) {
  return (
    <table aria-labelledby="tokens-h" className="w-full border-collapse border-y border-line text-sm max-sm:block max-sm:[&>tbody]:block">
      <thead className="max-sm:hidden">
        <tr className="border-b border-line">
          <th scope="col" className={TH}>
            Name
          </th>
          <th scope="col" className={TH}>
            Prefix
          </th>
          <th scope="col" className={TH}>
            Created
          </th>
          <th scope="col" className={TH}>
            Last used
          </th>
          <th scope="col" className={TH}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {tokens.map((t) => (
          <tr
            key={t.id}
            className="border-b border-line last:border-b-0 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:gap-x-3 max-sm:py-2.5"
          >
            <td className={cx(TD, "font-medium text-fg max-sm:h-auto max-sm:min-w-0 max-sm:p-0!")}>
              <span className="break-words">{t.name}</span>
              {t.scope === "marketplace" && (
                <span
                  className="ml-2 inline-flex h-[18px] items-center rounded-sm border border-line-strong px-1.5 align-[1px] text-xs leading-none font-medium text-fg-muted"
                  title="Reads the plugin marketplace only"
                >
                  Plugins only
                </span>
              )}
            </td>
            <td className={cx(TD, "max-sm:hidden")}>
              <code className="font-mono text-xs text-fg-muted">{t.prefix}…</code>
            </td>
            <td className={cx(TD, "whitespace-nowrap text-fg-muted tabular max-sm:hidden")} title={formatDateTime(t.createdAt)}>
              {formatDate(t.createdAt)}
            </td>
            <td className={cx(TD, "whitespace-nowrap tabular max-sm:whitespace-normal max-sm:col-start-1 max-sm:row-start-2 max-sm:h-auto max-sm:min-w-0 max-sm:p-0! max-sm:text-sm")}>
              <span className="mr-1.5 font-mono text-xs text-fg-subtle sm:hidden">{t.prefix}…</span>
              <LastUsed t={t} />
            </td>
            <td className={cx(TD, "w-px text-right max-sm:w-auto max-sm:col-start-2 max-sm:row-span-2 max-sm:row-start-1 max-sm:h-auto max-sm:min-w-0 max-sm:p-0!")}>
              <Button variant="ghost" size="sm" onClick={() => onRevoke(t)} aria-label={`Revoke ${t.name}`}>
                Revoke
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TokenSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading tokens" className="border-y border-line">
      {Array.from({ length: 3 }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-6 border-b border-line last:border-b-0">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-24 max-sm:hidden" />
          <Skeleton className="h-3 w-20 max-sm:hidden" />
          <Skeleton className="ml-auto h-3 w-14" />
        </div>
      ))}
    </div>
  );
}

// ---------- create ----------

function CreateTokenDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (meta: ApiToken) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const close = () => {
    onClose();
    setCreated(null);
    setName("");
    setErr(undefined);
  };
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.createToken(name.trim());
      setCreated({ token: r.token, name: r.meta.name });
      onCreated(r.meta);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      width={created ? "max-w-xl" : "max-w-md"}
      title={created ? `Token "${created.name}" is ready` : "Create API token"}
      description={created ? undefined : "Name it after where it will live, so you know what breaks if you revoke it."}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            Done, I copied it
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
              Create token
            </Button>
          </>
        )
      }
    >
      {created ? (
        <TokenReveal token={created.token} />
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <Field label="Name" htmlFor="token-name" hint={`For example "work laptop" or "ci: platform-skills publish".`}>
            <Input id="token-name" autoFocus autoComplete="off" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <InlineError error={err} />
        </form>
      )}
    </Dialog>
  );
}


// ---------- plugin marketplace key ----------

function MarketplaceKeyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (meta: ApiToken) => void }) {
  const [name, setName] = useState("Claude Code plugins");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [created, setCreated] = useState<{ url: string; name: string } | null>(null);
  const close = () => {
    onClose();
    setCreated(null);
    setName("Claude Code plugins");
    setErr(undefined);
  };
  const create = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.createMarketplaceKey(name.trim() || undefined);
      setCreated({ url: r.marketplaceUrl, name: r.meta.name });
      onCreated(r.meta);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      width={created ? "max-w-xl" : "max-w-md"}
      title={created ? `Plugin key "${created.name}" is ready` : "Create plugin key"}
      description={created ? undefined : "A key that lets Claude Code read this registry's plugins, and nothing else. Name it after the machine it goes on."}
      footer={
        created ? (
          <Button variant="primary" onClick={close}>
            Done, I stored it
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={create}>
              Create plugin key
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <p className="flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft px-3 py-2.5 text-sm text-warning-text">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              <strong className="font-semibold">Store this line now.</strong> It carries the key, and you will not see it again. The registry keeps only a hash.
            </span>
          </p>
          {!servesPlugins(created.url.replace(/\/marketplace\.json.*$/, "")) && <HttpsNote publicUrl={created.url.replace(/\/marketplace\.json.*$/, "")} />}
          <div className="flex flex-col gap-1.5">
            <p className="text-sm font-medium">Run it in a terminal, once per machine</p>
            <CopyCommand command={marketplaceAddCommand(created.url)} label="Copy marketplace command" className="[&_code]:[overflow-wrap:anywhere] [&_code>span:last-child>span]:whitespace-normal" />
          </div>
          <p className="text-sm text-fg-muted">
            Then install a plugin from its page. Revoke the key under API tokens and Claude Code stops getting updates on that machine.
          </p>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <Field label="Name" htmlFor="mkey-name" hint={`For example "plugins: work laptop".`}>
            <Input id="mkey-name" autoFocus autoComplete="off" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </Field>
          <InlineError error={err} />
        </form>
      )}
    </Dialog>
  );
}
