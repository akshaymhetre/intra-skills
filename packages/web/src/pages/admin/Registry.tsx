// Registry settings (admins): the organization name, the public URL every command carries, the stale
// window and the git poll interval. A key an environment variable overrides at boot is shown read-only,
// with the variable's name, because saving it here would have no effect.
import { useEffect, useState, type ReactNode } from "react";
import { Navigate } from "react-router";
import { Lock } from "lucide-react";
import type { OrgSettings } from "@intra-skills/shared/types";
import { api } from "../../api";
import { useMe } from "../../auth";
import { useAsync } from "../../lib/useAsync";
import { Button, ErrorState, Field, InlineError, Input, Skeleton, useToast } from "../../components/ui";
import { Page, PageIntro, PageSection } from "../../components/admin/Page";
import { useDocTitle } from "./parts";

/** The env var that pins each setting. Mirrors ENV in packages/server/src/settings.ts; GET /api/settings names only the keys. */
export const SETTING_ENV: Record<keyof OrgSettings, string> = {
  name: "INTRA_SKILLS_ORG_NAME",
  publicUrl: "INTRA_SKILLS_PUBLIC_URL",
  staleDays: "INTRA_SKILLS_STALE_DAYS",
  pollSeconds: "INTRA_SKILLS_POLL_SECONDS",
};

type Draft = { name: string; publicUrl: string; staleDays: string; pollSeconds: string };
const toDraft = (s: OrgSettings): Draft => ({ name: s.name, publicUrl: s.publicUrl, staleDays: String(s.staleDays), pollSeconds: String(s.pollSeconds) });

function validate(d: Draft): Partial<Record<keyof Draft, string>> {
  const e: Partial<Record<keyof Draft, string>> = {};
  if (!d.name.trim() || d.name.trim().length > 80) e.name = "1 to 80 characters.";
  if (d.publicUrl.trim()) {
    try {
      const u = new URL(d.publicUrl.trim());
      if (!/^https?:$/.test(u.protocol)) e.publicUrl = "Use http:// or https://.";
      else if (u.pathname !== "/" || u.search || u.hash) e.publicUrl = "Just the origin, with no path: https://skills.example.com";
    } catch {
      e.publicUrl = "Not a URL. For example https://skills.example.com";
    }
  }
  const sd = Number(d.staleDays);
  if (!Number.isInteger(sd) || sd < 1 || sd > 3650) e.staleDays = "A whole number of days from 1 to 3650.";
  const ps = Number(d.pollSeconds);
  if (!Number.isInteger(ps) || ps < 15 || ps > 86400) e.pollSeconds = "A whole number of seconds from 15 to 86400 (one day).";
  return e;
}

export function RegistrySettings() {
  useDocTitle("Registry");
  const me = useMe();
  const toast = useToast();
  const res = useAsync(() => api.getSettings(), []);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (res.data && !draft) setDraft(toDraft(res.data.settings));
  }, [res.data, draft]);

  if (me.role !== "admin") return <Navigate to="/" replace />;

  const pinned = new Set(res.data?.pinned ?? []);
  const errors = draft ? validate(draft) : {};
  const saved = res.data ? toDraft(res.data.settings) : null;
  const changed = (k: keyof Draft) => !!draft && !!saved && draft[k].trim() !== saved[k] && !pinned.has(k);
  const dirty = (["name", "publicUrl", "staleDays", "pollSeconds"] as const).some(changed);
  const hasErrors = (["name", "publicUrl", "staleDays", "pollSeconds"] as const).some((k) => !pinned.has(k) && errors[k]);

  const save = async () => {
    if (!draft) return;
    setTouched(true);
    if (hasErrors) return;
    setBusy(true);
    setErr(undefined);
    try {
      const patch: Partial<OrgSettings> = {};
      if (changed("name")) patch.name = draft.name.trim();
      if (changed("publicUrl")) patch.publicUrl = draft.publicUrl.trim().replace(/\/+$/, "");
      if (changed("staleDays")) patch.staleDays = Number(draft.staleDays);
      if (changed("pollSeconds")) patch.pollSeconds = Number(draft.pollSeconds);
      const r = await api.patchSettings(patch);
      res.setData(r);
      setDraft(toDraft(r.settings));
      setTouched(false);
      toast({ message: patch.name || patch.publicUrl ? "Saved. Reload the page to see the new name and URLs everywhere." : "Saved registry settings" });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  const set = (k: keyof Draft) => (e: React.ChangeEvent<HTMLInputElement>) => draft && setDraft({ ...draft, [k]: e.target.value });
  const fieldErr = (k: keyof Draft) => (touched || changed(k) ? errors[k] : undefined);

  return (
    <Page width="narrow">
      <PageIntro title="Registry" description="How this registry names itself and the address every command, link and agent document carries." />

      {res.error ? (
        <div className="pt-8">
          <ErrorState error={res.error} onRetry={res.reload} title="Could not load registry settings" align="start" className="px-0" />
        </div>
      ) : !draft ? (
        <div className="space-y-6 pt-10" aria-busy="true" aria-label="Loading settings">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-9 w-full" />
            </div>
          ))}
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <PageSection id="reg-id" title="Identity">
            <div className="flex flex-col gap-5">
              <Setting k="name" pinned={pinned.has("name")} value={res.data!.settings.name}>
                <Field label="Organization name" htmlFor="reg-name" error={fieldErr("name")} hint="Shown in the sidebar, page titles and the agent documents. Up to 80 characters.">
                  <Input id="reg-name" value={draft.name} onChange={set("name")} maxLength={80} aria-invalid={!!fieldErr("name") || undefined} />
                </Field>
              </Setting>
              <Setting k="publicUrl" pinned={pinned.has("publicUrl")} value={res.data!.settings.publicUrl || "(the address of each request)"}>
                <Field
                  label="Public URL"
                  htmlFor="reg-url"
                  error={fieldErr("publicUrl")}
                  hint={
                    <>
                      The address people and agents use, for example <span className="font-mono text-[0.93em]">https://skills.example.com</span>. It goes into the install
                      script, webhook URLs and device sign-in links. Leave empty to use whatever address a request arrives on.
                    </>
                  }
                >
                  <Input
                    id="reg-url"
                    mono
                    type="url"
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={window.location.origin}
                    value={draft.publicUrl}
                    onChange={set("publicUrl")}
                    aria-invalid={!!fieldErr("publicUrl") || undefined}
                  />
                </Field>
              </Setting>
            </div>
          </PageSection>

          <PageSection id="reg-timing" title="Timing">
            <div className="grid gap-5 sm:grid-cols-2">
              <Setting k="staleDays" pinned={pinned.has("staleDays")} value={`${res.data!.settings.staleDays} days`}>
                <Field label="Stale after (days)" htmlFor="reg-stale" error={fieldErr("staleDays")} hint="A skill with no new version for this long is marked Stale.">
                  <Input id="reg-stale" type="number" inputMode="numeric" min={1} max={3650} value={draft.staleDays} onChange={set("staleDays")} className="tabular" aria-invalid={!!fieldErr("staleDays") || undefined} />
                </Field>
              </Setting>
              <Setting k="pollSeconds" pinned={pinned.has("pollSeconds")} value={`${res.data!.settings.pollSeconds} seconds`}>
                <Field label="Check repositories every (seconds)" htmlFor="reg-poll" error={fieldErr("pollSeconds")} hint="How often each connected repository is read for merged pull requests. Webhooks start a sync sooner.">
                  <Input id="reg-poll" type="number" inputMode="numeric" min={15} max={86400} value={draft.pollSeconds} onChange={set("pollSeconds")} className="tabular" aria-invalid={!!fieldErr("pollSeconds") || undefined} />
                </Field>
              </Setting>
            </div>
          </PageSection>

          <div className="mt-10 flex flex-wrap items-center gap-3 border-t border-line pt-5">
            <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
              Save changes
            </Button>
            {dirty && (
              <Button variant="ghost" onClick={() => (setDraft(saved), setTouched(false), setErr(undefined))}>
                Discard
              </Button>
            )}
            {!dirty && <span className="text-sm text-fg-subtle">No unsaved changes</span>}
          </div>
          {err != null && (
            <div className="mt-3">
              <InlineError error={err} />
            </div>
          )}
        </form>
      )}
    </Page>
  );
}

/** A setting, or, when an env var pins it, its value read-only with the variable that sets it. */
function Setting({ k, pinned, value, children }: { k: keyof OrgSettings; pinned: boolean; value: string; children: ReactNode }) {
  if (!pinned) return <>{children}</>;
  const label = { name: "Organization name", publicUrl: "Public URL", staleDays: "Stale after", pollSeconds: "Check repositories every" }[k];
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-fg">{label}</span>
      <div className="flex min-h-9 items-center gap-2 rounded-md border border-dashed border-line-strong bg-panel px-2.5 text-base text-fg-muted max-md:min-h-11">
        <Lock className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
        <span className="min-w-0 truncate">{value}</span>
      </div>
      <p className="text-sm text-fg-subtle">
        Set by the environment variable <code className="font-mono text-[0.93em] text-fg-muted">{SETTING_ENV[k]}</code>. Change it there and restart the server.
      </p>
    </div>
  );
}
