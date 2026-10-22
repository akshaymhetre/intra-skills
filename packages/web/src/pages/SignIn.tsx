import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { api } from "../api";
import { useAuth } from "../auth";
import { useRegistryMeta, useDocTitle } from "../lib/meta";
import { Logo } from "../components/Shell";
import { Button, CopyCommand, InlineError, Spinner } from "../components/ui";
import { DottedRule, SectionHeading } from "../components/fx";

/** Only same-origin paths are allowed as a return target. */
function safeNext(raw: string | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/signin")) return "/";
  return raw;
}

export function SignIn() {
  const [params] = useSearchParams();
  // Capture `next` once: later renders or URL rewrites must never collapse it to the default.
  const [next] = useState(() => safeNext(params.get("next")));
  const { status, setUser } = useAuth();
  const meta = useRegistryMeta();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const org = meta?.name || "intra-skills";

  useDocTitle("Sign in");

  if (status === "signed-in") return <Navigate to={next} replace />;
  if (meta?.needsSetup) return <Navigate to="/setup" replace />;
  if (status === "loading" || !meta)
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg">
        <Spinner />
      </div>
    );

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const user = await api.login(token.trim());
      setUser(user);
      navigate(next, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex h-14 items-center px-5 md:px-8">
        <Logo />
      </header>
      <main className="flex flex-1 items-start justify-center px-5 pt-[8vh] pb-20">
        <div className="w-full max-w-[480px]">
          <SectionHeading as="h1" size="lg" mark={org}>
            {`Sign in to ${org}`}
          </SectionHeading>
          <p className="mt-3 text-base text-fg-muted">This browser stays signed in for 30 days.</p>

          <div className="mt-8">
            <form
              noValidate
              aria-label="Sign in with an API token"
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                if (token.trim()) void submit();
                else setError(new Error("Paste your API token first. It starts with isk_."));
              }}
            >
              <div className="flex flex-col gap-1.5">
                <label htmlFor="token" className="text-sm font-medium">
                  API token
                </label>
                <input
                  id="token"
                  name="token"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="isk_..."
                  aria-describedby="token-help"
                  aria-invalid={!!error || undefined}
                  className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 font-mono text-sm text-fg placeholder:text-fg-subtle transition-colors duration-[120ms] hover:border-line-control focus-visible:border-focus aria-[invalid=true]:border-danger-text max-md:h-11 max-md:text-[16px]"
                />
                <p id="token-help" className="text-sm text-fg-subtle">
                  An admin gives you your first token when they add you under Members. After that, make one per machine under Settings.
                </p>
              </div>
              <InlineError error={error} />
              <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
                Sign in
              </Button>
              {next !== "/" && (
                <p className="text-sm text-fg-subtle">
                  Then back to <span className="font-mono text-fg-muted">{next}</span>
                </p>
              )}
            </form>
          </div>

          <section aria-labelledby="si-cli" className="mt-10">
            <div className="flex items-center gap-3 text-xs text-fg-subtle">
              <h2 id="si-cli" className="shrink-0 text-sm font-semibold text-fg">
                Signing in the CLI?
              </h2>
              <DottedRule className="flex-1" />
            </div>
            <p className="mt-2 text-sm text-fg-muted">
              Run <code className="font-mono text-[0.93em] text-fg">intra login</code> in a terminal. It opens this site and asks you to approve a short code, so the CLI
              never needs a pasted token.
            </p>
            <CopyCommand command={`intra login --registry ${meta.publicUrl}`} className="mt-3" label="Copy login command" />
          </section>
        </div>
      </main>
    </div>
  );
}
