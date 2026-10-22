// Git identities: a person's usernames on GitHub and Bitbucket Cloud. The registry needs them so a
// pull request a person proposed never counts as approved by that same person. One per provider.
// Used by Get started and Settings (your own), and Members (an admin editing someone else's).
import { useState } from "react";
import { GIT_PROVIDERS, type GitIdentity, type GitProviderId, type User } from "@intra-skills/shared/types";
import { Button, Field, InlineError, Input } from "../ui";

export const PROVIDER_LABEL: Record<GitProviderId, string> = { github: "GitHub", "bitbucket-cloud": "Bitbucket Cloud" };
const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$/;

const toMap = (ids: GitIdentity[]) => Object.fromEntries(GIT_PROVIDERS.map((p) => [p, ids.find((i) => i.provider === p)?.username ?? ""])) as Record<GitProviderId, string>;

/** "github devpatel, bitbucket-cloud dpatel" as plain text, or null. */
export function identitiesText(ids: GitIdentity[]): string | null {
  if (!ids.length) return null;
  return ids.map((i) => `${PROVIDER_LABEL[i.provider]} ${i.username}`).join(", ");
}

export function GitIdentityForm({
  user,
  save,
  onSaved,
  idBase,
  submitLabel = "Save usernames",
  compact,
}: {
  user: User;
  save: (ids: GitIdentity[]) => Promise<User>;
  onSaved: (u: User) => void;
  idBase: string;
  submitLabel?: string;
  /** Inputs side by side on wide screens. */
  compact?: boolean;
}) {
  const [values, setValues] = useState(() => toMap(user.gitIdentities ?? []));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const initial = toMap(user.gitIdentities ?? []);
  const dirty = GIT_PROVIDERS.some((p) => values[p].trim() !== initial[p]);
  const invalid = GIT_PROVIDERS.filter((p) => values[p].trim() && !USERNAME_RE.test(values[p].trim()));

  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    setSaved(false);
    try {
      const ids = GIT_PROVIDERS.filter((p) => values[p].trim()).map((p) => ({ provider: p, username: values[p].trim() }));
      const u = await save(ids);
      setValues(toMap(u.gitIdentities ?? []));
      setSaved(true);
      onSaved(u);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty && !invalid.length) void submit();
      }}
    >
      <div className={compact ? "grid gap-4 sm:grid-cols-2" : "flex flex-col gap-4"}>
        {GIT_PROVIDERS.map((p) => {
          const bad = invalid.includes(p);
          return (
            <Field
              key={p}
              label={`${PROVIDER_LABEL[p]} username`}
              htmlFor={`${idBase}-${p}`}
              error={bad ? "Letters, digits, dots, dashes and underscores; it starts with a letter or digit." : undefined}
              hint={p === "github" ? "The name in your profile URL, github.com/<username>." : "Your Bitbucket username from your personal Bitbucket settings, not your email."}
            >
              <Input
                id={`${idBase}-${p}`}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="Not linked"
                aria-invalid={bad || undefined}
                value={values[p]}
                onChange={(e) => {
                  setSaved(false);
                  setValues({ ...values, [p]: e.target.value });
                }}
              />
            </Field>
          );
        })}
      </div>
      <InlineError error={err} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" loading={busy} disabled={!dirty || invalid.length > 0}>
          {submitLabel}
        </Button>
        <span className="text-sm text-ok-text" aria-live="polite">
          {saved && !dirty ? "Saved" : ""}
        </span>
      </div>
    </form>
  );
}
