// Device approval, outside the shell. `intra login` and `intra setup` open /device?code=XXXX-XXXX:
// the reader checks the code matches the one in their terminal, sees which client asks and who it
// will sign in as, then approves or denies. Without ?code= the page asks for the code.
// States: enter code, loading, unknown code, pending (with a live expiry), approved, denied, expired.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CircleCheck, CircleX, Clock, Laptop } from "lucide-react";
import type { DeviceRequestInfo } from "@intra-skills/shared/types";
import { api, ApiError } from "../api";
import { useMe } from "../auth";
import { Logo } from "../components/Shell";
import { Button, ErrorState, InlineError, Spinner, cx } from "../components/ui";
import { PersonMark, SectionHeading } from "../components/fx";
import { formatDateTime, relativeTime } from "../lib/format";
import { useDocTitle } from "../lib/meta";

const CODE_CHARS = /[^BCDFGHJKLMNPQRSTVWXZ]/g;
const clean = (s: string) => s.toUpperCase().replace(CODE_CHARS, "").slice(0, 8);
const dashed = (s: string) => (s.length > 4 ? `${s.slice(0, 4)}-${s.slice(4)}` : s);

export function Device() {
  const [params] = useSearchParams();
  const code = clean(params.get("code") ?? "");
  useDocTitle("Approve sign-in");
  return <Frame>{code.length === 8 ? <Request key={code} code={code} /> : <EnterCode initial={code} />}</Frame>;
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

function EnterCode({ initial }: { initial: string }) {
  const navigate = useNavigate();
  const [value, setValue] = useState(dashed(initial));
  const raw = clean(value);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (raw.length === 8) navigate(`/device?code=${dashed(raw)}`, { replace: true });
  };
  return (
    <div>
      <SectionHeading as="h1" size="lg" mark="code">
        Enter the code from your terminal
      </SectionHeading>
      <p className="mt-3 text-base text-fg-muted">
        <code className="font-mono text-[0.93em] text-fg">intra login</code> prints an eight-letter code. Type it here to sign that terminal in as you.
      </p>
      <form onSubmit={submit} className="mt-7 flex flex-col gap-3">
        <label htmlFor="device-code" className="text-sm font-medium">
          Sign-in code
        </label>
        <input
          id="device-code"
          autoFocus
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          placeholder="XXXX-XXXX"
          value={value}
          onChange={(e) => setValue(dashed(clean(e.target.value)))}
          className="h-14 w-full rounded-lg border border-line-strong bg-surface px-4 text-center font-mono text-2xl tracking-[0.18em] text-fg uppercase placeholder:text-fg-subtle transition-colors duration-[120ms] hover:border-line-control focus-visible:border-focus"
        />
        <Button type="submit" variant="primary" size="lg" disabled={raw.length !== 8} className="w-full">
          Continue
        </Button>
        <p className="text-sm text-fg-subtle">Codes use letters only and last ten minutes.</p>
      </form>
    </div>
  );
}

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Request({ code }: { code: string }) {
  const me = useMe();
  const [info, setInfo] = useState<DeviceRequestInfo | null>(null);
  const [loadErr, setLoadErr] = useState<unknown>();
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [actErr, setActErr] = useState<unknown>();
  const now = useNow(1000);

  const load = () => {
    setLoadErr(undefined);
    api.deviceInfo(code).then(setInfo, setLoadErr);
  };
  useEffect(load, [code]);

  const act = async (kind: "approve" | "deny") => {
    setBusy(kind);
    setActErr(undefined);
    try {
      setInfo(kind === "approve" ? await api.approveDevice(code) : await api.denyDevice(code));
    } catch (e) {
      // Approving an expired code answers 409: show the expired state rather than an error.
      if (e instanceof ApiError && e.status === 409) load();
      else setActErr(e);
    } finally {
      setBusy(null);
    }
  };

  if (loadErr) {
    if (loadErr instanceof ApiError && loadErr.isNotFound)
      return (
        <Result tone="bad" icon={<CircleX aria-hidden />} title="No sign-in request with this code">
          <p>
            <span className="font-mono text-fg">{dashed(code)}</span> does not match any request. Check it against your terminal, or run{" "}
            <code className="font-mono text-[0.93em] text-fg">intra login</code> again for a new code.
          </p>
          <Link to="/device" replace className="mt-4 inline-flex h-9 items-center rounded-md border border-line-strong bg-surface px-3 font-medium text-fg hover:bg-surface-2 max-md:h-11">
            Enter a different code
          </Link>
        </Result>
      );
    return <ErrorState error={loadErr} title="Could not load this sign-in request" align="start" className="px-0" onRetry={load} />;
  }
  if (!info)
    return (
      <div className="flex items-center gap-2 py-10 text-sm text-fg-muted">
        <Spinner /> Looking up {dashed(code)}
      </div>
    );

  const leftMs = new Date(info.expiresAt).getTime() - now;
  const status = info.status === "pending" && leftMs <= 0 ? "expired" : info.status;

  if (status === "approved")
    return (
      <Result tone="ok" icon={<CircleCheck aria-hidden />} title="The CLI is signed in">
        <p>
          You can close this tab. <span className="text-fg">{info.clientName}</span> is now signed in as {me.displayName}, and the terminal carries on by itself.
        </p>
        <p className="mt-3 text-fg-subtle">It has its own token, listed under Settings as "{info.clientName} (device login)". Revoke it there to sign that machine out.</p>
      </Result>
    );
  if (status === "denied")
    return (
      <Result tone="bad" icon={<CircleX aria-hidden />} title="Sign-in denied">
        <p>
          <span className="text-fg">{info.clientName}</span> was not signed in, and the code <span className="font-mono text-fg">{dashed(clean(info.userCode))}</span> no longer works.
          If that was you after all, run <code className="font-mono text-[0.93em] text-fg">intra login</code> again.
        </p>
      </Result>
    );
  if (status === "expired")
    return (
      <Result tone="neutral" icon={<Clock aria-hidden />} title="This code has expired">
        <p>
          Codes last ten minutes. Run <code className="font-mono text-[0.93em] text-fg">intra login</code> in the terminal again for a new one.
        </p>
      </Result>
    );

  const mins = Math.floor(leftMs / 60000);
  const secs = Math.floor((leftMs % 60000) / 1000);
  return (
    <div>
      <SectionHeading as="h1" size="lg" mark="terminal">
        Sign in a terminal?
      </SectionHeading>
      <p className="mt-3 text-base text-fg-muted">
        Approve only if you just ran <code className="font-mono text-[0.93em] text-fg">intra login</code> or{" "}
        <code className="font-mono text-[0.93em] text-fg">intra setup</code> and your terminal shows this code.
      </p>

      <div className="mt-7 rounded-xl border border-line-strong bg-surface">
        <div className="px-5 pt-5 pb-4 text-center">
          <p className="text-xs text-fg-subtle">Code in your terminal</p>
          <p className="mt-1.5 font-mono text-[2.25rem] leading-none font-medium tracking-[0.14em] text-fg tabular" aria-label={`Code ${clean(info.userCode).split("").join(" ")}`}>
            {dashed(clean(info.userCode))}
          </p>
        </div>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-t border-line px-5 py-4 text-sm">
          <dt className="text-fg-subtle">Asking</dt>
          <dd className="flex min-w-0 items-center gap-1.5 text-fg">
            <Laptop className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
            <span className="min-w-0 break-words font-mono text-[13px]">{info.clientName}</span>
          </dd>
          <dt className="text-fg-subtle">Requested</dt>
          <dd className="text-fg-muted tabular">
            <time dateTime={info.createdAt} title={formatDateTime(info.createdAt)}>
              {relativeTime(info.createdAt, now)}
            </time>
            <span className={cx("ml-2 whitespace-nowrap tabular", leftMs < 60_000 ? "text-warning-text" : "text-fg-subtle")}>
              expires in {mins > 0 ? `${mins}\u00a0min ` : ""}
              {`${secs}\u00a0s`}
            </span>
          </dd>
          <dt className="text-fg-subtle">Signs in as</dt>
          <dd className="flex min-w-0 items-center gap-2 text-fg">
            <PersonMark handle={me.handle} name={me.displayName} size={20} />
            <span className="truncate">
              {me.displayName} <span className="font-mono text-xs text-fg-subtle">{me.handle}</span>
            </span>
          </dd>
        </dl>
      </div>

      {actErr != null && (
        <div className="mt-4">
          <InlineError error={actErr} />
        </div>
      )}
      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button size="lg" onClick={() => void act("deny")} loading={busy === "deny"} disabled={!!busy}>
          Deny
        </Button>
        <Button variant="primary" size="lg" onClick={() => void act("approve")} loading={busy === "approve"} disabled={!!busy}>
          Approve
        </Button>
      </div>
      <p className="mt-4 text-sm text-fg-subtle">
        Approving gives that terminal its own token with your permissions. Not you, or not your code? Deny it.
      </p>
    </div>
  );
}

function Result({ tone, icon, title, children }: { tone: "ok" | "bad" | "neutral"; icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div role="status">
      <span
        className={cx(
          "inline-flex size-10 items-center justify-center rounded-full [&_svg]:size-5",
          tone === "ok" ? "bg-ok-soft text-ok-text" : tone === "bad" ? "bg-danger-soft text-danger-text" : "bg-surface-2 text-fg-muted",
        )}
      >
        {icon}
      </span>
      <h1 className="display mt-4 text-2xl text-fg md:text-3xl">{title}</h1>
      <div className="mt-3 text-base text-fg-muted">{children}</div>
    </div>
  );
}
