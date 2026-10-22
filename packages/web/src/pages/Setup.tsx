// First run for a new organization, outside the shell. The server prints a one-time link carrying
// the setup token at first boot (and writes it to <data dir>/setup-token). This page names the org,
// creates the first admin, shows that admin's API token once, and continues to Get started.
// States: checking, already set up, no token in the link, the form, wrong token, done.
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { CircleCheck, TriangleAlert } from "lucide-react";
import type { User } from "@intra-skills/shared/types";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import { Logo } from "../components/Shell";
import { Button, CopyCommand, ErrorState, Field, InlineError, Input, Spinner } from "../components/ui";
import { DottedRule, SectionHeading } from "../components/fx";
import { useDocTitle } from "../lib/meta";

const HANDLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOKEN_RE = /^ist_[A-Za-z0-9_-]{43}$/;
const handleFrom = (name: string) =>
  (name.trim().split(/\s+/)[0] ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");

export function Setup() {
  const [params] = useSearchParams();
  // Read once: the token must survive any later rewrite of the address.
  const [urlToken] = useState(() => (params.get("token") ?? "").trim());
  const [status, setStatus] = useState<{ needsSetup: boolean } | null>(null);
  const [statusErr, setStatusErr] = useState<unknown>();
  const [done, setDone] = useState<{ user: User; token: string } | null>(null);

  useDocTitle("Set up");
  useEffect(() => {
    // Keep the secret out of the history and the address bar once it is in memory.
    if (params.has("token")) window.history.replaceState(null, "", "/setup");
    api.setupStatus().then(setStatus, setStatusErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Frame>
      {done ? (
        <Done user={done.user} token={done.token} />
      ) : statusErr ? (
        <ErrorState error={statusErr} title="Could not reach the registry" align="start" className="px-0" onRetry={() => window.location.reload()} />
      ) : !status ? (
        <div className="flex items-center gap-2 py-10 text-sm text-fg-muted">
          <Spinner /> Checking this registry
        </div>
      ) : !status.needsSetup ? (
        <AlreadySetUp />
      ) : (
        <SetupForm urlToken={urlToken} onDone={setDone} />
      )}
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex h-14 items-center px-5 md:px-8">
        <Logo />
      </header>
      <main className="flex flex-1 justify-center px-5 pt-[8vh] pb-20">
        <div className="w-full max-w-[480px]">{children}</div>
      </main>
    </div>
  );
}

function AlreadySetUp() {
  return (
    <div>
      <SectionHeading as="h1" size="lg" mark="set up">
        This registry is already set up
      </SectionHeading>
      <p className="mt-3 text-base text-fg-muted">
        It has an admin, so the setup link no longer works. Sign in with your API token, or run <code className="font-mono text-[0.93em] text-fg">intra login</code> in a terminal.
      </p>
      <Link
        to="/signin"
        className="mt-6 inline-flex h-9 items-center rounded-md bg-primary px-3.5 text-base font-medium text-on-primary transition-colors duration-[120ms] hover:bg-primary-hover max-md:h-11"
      >
        Sign in
      </Link>
      <p className="mt-6 text-sm text-fg-subtle">Need another account? An admin adds people under Admin, Members.</p>
    </div>
  );
}

function SetupForm({ urlToken, onDone }: { urlToken: string; onDone: (r: { user: User; token: string }) => void }) {
  const { setUser } = useAuth();
  const [token, setToken] = useState(urlToken);
  const [showToken, setShowToken] = useState(!urlToken);
  const [org, setOrg] = useState("");
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [tokenWrong, setTokenWrong] = useState(false);

  const tokenOk = TOKEN_RE.test(token.trim());
  const handleOk = HANDLE_RE.test(handle);
  const canSubmit = tokenOk && !!org.trim() && !!name.trim() && handleOk;

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    setTokenWrong(false);
    try {
      const r = await api.setup({ setupToken: token.trim(), handle, displayName: name.trim(), orgName: org.trim() });
      setUser(r.user);
      onDone(r);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setTokenWrong(true);
        setShowToken(true);
      } else if (e instanceof ApiError && e.status === 409) {
        // Someone finished setup in another tab or with `init` meanwhile.
        window.location.reload();
        return;
      } else setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <SectionHeading as="h1" size="lg" mark="registry">
        Set up your skills registry
      </SectionHeading>
      <p className="mt-3 text-base text-fg-muted">Name it and create the first admin. It takes a minute, and you can change the name later.</p>

      {!urlToken && !tokenWrong && (
        <div className="mt-6 rounded-lg border border-line bg-surface p-4">
          <h2 className="text-sm font-semibold text-fg">Open the setup link the server printed</h2>
          <p className="mt-1 text-sm text-fg-muted">
            This page needs the one-time setup token. The server printed a link carrying it when it first started:
          </p>
          <pre className="mt-2.5 overflow-x-auto rounded-md border border-line bg-panel px-3 py-2 font-mono text-xs leading-5 text-fg-muted">
            No admin yet. Open this link once to create one:{"\n"}  {window.location.origin}/setup?token=ist_...
          </pre>
          <p className="mt-2.5 text-sm text-fg-muted">
            Lost the log? The same token is in the file <code className="font-mono text-[0.93em] text-fg">setup-token</code> inside the server's data folder. Paste it below.
          </p>
        </div>
      )}

      {tokenWrong && (
        <p role="alert" className="mt-6 flex items-start gap-2 rounded-md border border-danger-line bg-danger-soft px-3 py-2.5 text-sm text-danger-text">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            The server did not accept this setup token. Copy it again from the server log or from <code className="font-mono text-[0.93em]">&lt;data dir&gt;/setup-token</code>.
            A token from an earlier data folder does not work.
          </span>
        </p>
      )}

      <form
        noValidate
        className="mt-7 flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        {showToken ? (
          <Field
            label="Setup token"
            htmlFor="setup-token"
            error={token.trim() && !tokenOk ? "A setup token starts with ist_ and is 47 characters long." : undefined}
            hint="Starts with ist_. It works once, then the server deletes it."
          >
            <Input
              id="setup-token"
              mono
              type="password"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              placeholder="ist_..."
              aria-invalid={(!!token.trim() && !tokenOk) || tokenWrong || undefined}
              value={token}
              onChange={(e) => {
                setTokenWrong(false);
                setToken(e.target.value);
              }}
            />
          </Field>
        ) : (
          <p className="flex items-center gap-2 text-sm text-ok-text">
            <CircleCheck className="size-3.5" aria-hidden />
            Setup token from the link is ready.
          </p>
        )}

        <Field label="Organization name" htmlFor="setup-org" hint="Shown in the sidebar and on every page, for example Acme or Acme Platform. Up to 80 characters.">
          <Input id="setup-org" autoFocus={!showToken} autoComplete="organization" maxLength={80} value={org} onChange={(e) => setOrg(e.target.value)} />
        </Field>

        <DottedRule className="my-1" />

        <div>
          <h2 className="text-sm font-semibold text-fg">The first admin: you</h2>
          <p className="mt-0.5 text-sm text-fg-muted">Admins manage every team, person, skill and repository. You can add more admins later.</p>
        </div>
        <Field label="Your name" htmlFor="setup-name">
          <Input
            id="setup-name"
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!handleTouched) setHandle(handleFrom(e.target.value));
            }}
          />
        </Field>
        <Field
          label="Handle"
          htmlFor="setup-handle"
          error={handle && !handleOk ? "Use lowercase letters, digits and single hyphens." : undefined}
          hint="Shows in the audit log, on pull requests the registry opens, and in the CLI. It cannot change later."
        >
          <Input
            id="setup-handle"
            mono
            autoComplete="username"
            spellCheck={false}
            aria-invalid={(!!handle && !handleOk) || undefined}
            value={handle}
            onChange={(e) => {
              setHandleTouched(true);
              setHandle(e.target.value.toLowerCase());
            }}
          />
        </Field>

        <InlineError error={err} />
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!canSubmit} className="mt-1 w-full">
          Create the registry and my admin account
        </Button>
      </form>
    </div>
  );
}

function Done({ user, token }: { user: User; token: string }) {
  const origin = window.location.origin;
  const [stored, setStored] = useState(false);
  return (
    <div>
      <SectionHeading as="h1" size="lg" mark="ready">
        {`Your registry is ready, ${user.displayName.split(/\s+/)[0]}`}
      </SectionHeading>
      <p className="mt-3 text-base text-fg-muted">This browser is signed in as the admin. Here is your first API token, for the CLI and for signing in on another browser.</p>

      <p className="mt-6 flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft px-3 py-2.5 text-sm text-warning-text">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-semibold">Store it now, in your password manager.</strong> This is the only time it is shown; the registry keeps only a hash. If it is lost, an
          admin can only make you a new one.
        </span>
      </p>

      <div className="mt-5 flex flex-col gap-1.5">
        <p className="text-sm font-medium">API token for {user.handle}</p>
        <CopyCommand command={token} label="Copy API token" className="[&_code]:[overflow-wrap:anywhere]" />
      </div>
      <div className="mt-4 flex flex-col gap-1.5">
        <p className="text-sm font-medium">Sign in from a terminal</p>
        <CopyCommand command={`intra login --registry ${origin} --token ${token}`} label="Copy login command" className="[&_code]:[overflow-wrap:anywhere]" />
      </div>

      <label className="mt-6 flex items-start gap-2.5 text-sm text-fg select-none">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} className="mt-0.5 size-4 shrink-0" />
        I stored the token somewhere safe.
      </label>
      <Button
        variant="primary"
        size="lg"
        className="mt-4 w-full"
        disabled={!stored}
        // A full load, so the new organization name replaces the one cached before setup.
        onClick={() => window.location.assign("/get-started")}
      >
        Continue to Get started
      </Button>
      <p className="mt-3 text-sm text-fg-subtle">Next: connect a GitHub or Bitbucket Cloud repository under Admin, Repositories, so every publish arrives as a pull request.</p>
    </div>
  );
}
