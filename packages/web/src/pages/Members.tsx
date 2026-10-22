// Everyone who can sign in (admins only). Promoting to admin asks first; demoting applies at once
// with an undo. The last admin cannot be demoted, and nobody changes their own role here.
import { useState } from "react";
import { Link, Navigate } from "react-router";
import { ShieldCheck } from "lucide-react";
import type { Role, User } from "@intra-skills/shared/types";
import { api } from "../api";
import { useMe } from "../auth";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatDateTime, plural } from "../lib/format";
import {
  Button,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  InlineError,
  Input,
  Menu,
  Segmented,
  cx,
  useToast,
} from "../components/ui";
import { SkeletonRows, TD, TH, TR, TableFrame, TokenReveal, useDocTitle } from "./admin/parts";
import { PersonMark } from "../components/fx";
import { Page, PageIntro } from "../components/admin/Page";
import { GitIdentityForm, PROVIDER_LABEL } from "../components/admin/GitIdentities";

export function Members() {
  useDocTitle("Members");
  const me = useMe();
  const toast = useToast();
  const users = useAsync(() => api.listUsers(), []);
  const teams = useAsync(() => api.listTeams(), []);
  const [addOpen, setAddOpen] = useState(false);
  const [promote, setPromote] = useState<User | null>(null);
  const [editingGit, setEditingGit] = useState<User | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();
  if (me.role !== "admin") return <Navigate to="/" replace />;

  const list = users.data ? [...users.data].sort((a, b) => (a.role === b.role ? a.displayName.localeCompare(b.displayName) : a.role === "admin" ? -1 : 1)) : null;
  const admins = list?.filter((u) => u.role === "admin").length ?? 0;
  const teamName = (slug: string) => teams.data?.find((t) => t.slug === slug)?.name ?? slug;

  const setRole = async (u: User, role: Role, opts: { undoable?: boolean } = {}) => {
    setBusy(u.handle);
    setErr(undefined);
    try {
      const updated = await api.updateUser(u.handle, { role });
      users.setData((users.data ?? []).map((x) => (x.handle === u.handle ? updated : x)));
      setPromote(null);
      toast({
        message: role === "admin" ? `${u.displayName} is now an admin` : `${u.displayName} is now a member`,
        action: opts.undoable ? { label: "Undo", onClick: () => void setRole(updated, u.role) } : undefined,
      });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Page>
      <PageIntro
        title="Members"
       
        description="Everyone who can sign in. Admins manage every team, person, skill and repository; members act through their teams and grants."
        meta={
          list && (
            <p className="text-sm text-fg-muted tabular">
              {plural(list.length, "person", "people")}, {plural(admins, "admin")}
              {admins === 1 && <span className="text-fg-subtle">. The only admin cannot be demoted until another is promoted.</span>}
            </p>
          )
        }
        actions={
          <Button variant="primary" onClick={() => setAddOpen(true)}>
            Add member
          </Button>
        }
        rule={false}
      />

      {err != null && !promote && (
        <div className="pb-3">
          <InlineError error={err} />
        </div>
      )}

      {users.error ? (
        <div className="border-y border-line">
          <ErrorState error={users.error} onRetry={users.reload} title="Could not load people" />
        </div>
      ) : list && list.length === 0 ? (
        <div className="border-y border-line">
          <EmptyState title="Nobody here yet" action={<Button variant="primary" onClick={() => setAddOpen(true)}>Add member</Button>}>
            Add a person to give them a first token. They sign in with it and make their own tokens after that.
          </EmptyState>
        </div>
      ) : (
        <TableFrame label="Members" busy={!!users.loading && !!list}>
          <thead className="max-md:hidden">
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Name</th>
              <th scope="col" className={TH}>Handle</th>
              <th scope="col" className={TH}>Role</th>
              <th scope="col" className={TH}>Teams</th>
              <th scope="col" className={TH}>Git usernames</th>
              <th scope="col" className={cx(TH, "text-right")}>Added</th>
              <th scope="col" className={cx(TH, "w-px")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {!list ? (
              <SkeletonRows widths={["w-32", "w-16", "w-14", "w-28", "w-24", "w-20", "w-6"]} rows={6} mobile={<span className="block h-3 w-40 skeleton" />} />
            ) : (
              list.map((u) => {
                const self = u.handle === me.handle;
                const lastAdmin = u.role === "admin" && admins <= 1;
                return (
                  <tr
                    key={u.handle}
                    className={cx(
                      TR,
                      "max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-center max-md:gap-x-3 max-md:gap-y-0.5 max-md:px-1 max-md:py-3",
                    )}
                  >
                    <td className={cx(TD, "max-md:h-auto max-md:min-w-0 max-md:p-0!")}>
                      <span className="flex min-w-0 items-center gap-2.5">
                        <PersonMark handle={u.handle} name={u.displayName} size={26} />
                        <span className="min-w-0 truncate font-medium text-fg">{u.displayName}</span>
                        {self && <span className="text-xs text-fg-subtle">you</span>}
                        <span className="font-mono text-xs text-fg-subtle md:hidden">{u.handle}</span>
                      </span>
                    </td>
                    <td className={cx(TD, "max-md:hidden")}>
                      <span className="font-mono text-[0.93em] text-fg-muted">{u.handle}</span>
                    </td>
                    <td className={cx(TD, "max-md:col-start-1 max-md:row-start-2 max-md:h-auto max-md:min-w-0 max-md:p-0!")}>
                      <span className={cx("max-md:ml-[34px] max-md:block", u.role === "admin" ? "text-fg" : "text-fg-muted")}>
                        {u.role === "admin" && <ShieldCheck className="mr-1.5 inline size-3.5 -translate-y-px text-fg-subtle" aria-hidden />}
                        {u.role === "admin" ? "Admin" : "Member"}
                        {u.teams.length > 0 && <span className="block text-fg-subtle md:hidden">Teams: {u.teams.map((t) => teamName(t.slug)).join(", ")}</span>}
                        {(u.gitIdentities ?? []).length > 0 && (
                          <span className="block text-fg-subtle md:hidden">
                            Git: <span className="font-mono text-xs">{u.gitIdentities.map((g) => g.username).join(", ")}</span>
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={cx(TD, "max-md:hidden")}>
                      {u.teams.length ? (
                        <span className="text-fg-muted">
                          {u.teams.map((t, i) => (
                            <span key={t.slug}>
                              {i > 0 && ", "}
                              <Link to={`/teams/${t.slug}`} className="rounded-sm text-fg-muted underline decoration-transparent underline-offset-[0.18em] hover:text-fg hover:decoration-line-control">
                                {teamName(t.slug)}
                              </Link>
                              {t.role === "maintainer" && <span className="text-fg-subtle"> (maintainer)</span>}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">No team</span>
                      )}
                    </td>
                    <td className={cx(TD, "max-md:hidden")}>
                      {(u.gitIdentities ?? []).length ? (
                        <span className="flex flex-col gap-0.5 py-1.5">
                          {u.gitIdentities.map((g) => (
                            <span key={g.provider} className="flex items-baseline gap-1.5 whitespace-nowrap" title={PROVIDER_LABEL[g.provider]}>
                              <span className="text-xs text-fg-subtle">{g.provider === "github" ? "GitHub" : "Bitbucket"}</span>
                              <span className="font-mono text-[13px] text-fg-muted">{g.username}</span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="text-fg-subtle">Not linked</span>
                      )}
                    </td>
                    <td className={cx(TD, "text-right whitespace-nowrap text-fg-muted tabular max-md:hidden")} title={formatDateTime(u.createdAt)}>
                      {formatDate(u.createdAt)}
                    </td>
                    <td className={cx(TD, "w-px text-right max-md:w-auto max-md:col-start-2 max-md:row-span-2 max-md:row-start-1 max-md:h-auto max-md:min-w-0 max-md:p-0!")}>
                      <Menu
                        label={`Actions for ${u.displayName}`}
                        size="sm"
                        items={[
                          { label: "Edit git usernames", onSelect: () => setEditingGit(u) },
                          ...(u.role === "admin"
                            ? [
                                {
                                  label: "Make member",
                                  disabled: self || lastAdmin || busy === u.handle,
                                  hint: self ? "This is you" : lastAdmin ? "Only admin" : undefined,
                                  onSelect: () => void setRole(u, "member", { undoable: true }),
                                },
                              ]
                            : [
                                {
                                  label: "Make admin",
                                  disabled: busy === u.handle,
                                  onSelect: () => (setErr(undefined), setPromote(u)),
                                },
                              ]),
                        ]}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </TableFrame>
      )}

      <ConfirmDialog
        open={!!promote}
        onClose={() => setPromote(null)}
        onConfirm={() => promote && void setRole(promote, "admin")}
        title={`Make ${promote?.displayName ?? ""} an admin?`}
        description="Admins can read every private skill, change access on any skill, manage every team, add people and change roles, including yours."
        confirmLabel="Make admin"
        busy={!!busy}
        error={err}
      />

      <Dialog
        open={!!editingGit}
        onClose={() => setEditingGit(null)}
        title={`Git usernames for ${editingGit?.displayName ?? ""}`}
        description="The registry uses these to make sure a pull request this person proposed is approved by someone else. One username per host."
      >
        {editingGit && (
          <div className="pb-5">
            <GitIdentityForm
              key={editingGit.handle}
              idBase={`m-git-${editingGit.handle}`}
              user={editingGit}
              save={(ids) => api.setUserGitIdentities(editingGit.handle, ids)}
              onSaved={(u) => {
                users.setData((users.data ?? []).map((x) => (x.handle === u.handle ? u : x)));
                setEditingGit(null);
                toast({ message: `Saved git usernames for ${u.displayName}` });
              }}
            />
          </div>
        )}
      </Dialog>

      <AddMemberDialog open={addOpen} onClose={() => setAddOpen(false)} onCreated={(u) => (users.data ? users.setData([...users.data, u]) : users.reload())} />
    </Page>
  );
}

const handleFrom = (name: string) =>
  name
    .trim()
    .split(/\s+/)[0]!
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]/g, "");

function AddMemberDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (u: User) => void }) {
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [handleTouched, setHandleTouched] = useState(false);
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [made, setMade] = useState<{ user: User; token: string } | null>(null);
  const handleOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(handle);
  const close = () => {
    onClose();
    setDisplayName("");
    setHandle("");
    setHandleTouched(false);
    setRole("member");
    setErr(undefined);
    setMade(null);
  };
  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const r = await api.createUser({ handle, displayName: displayName.trim(), role });
      onCreated(r.user);
      setMade(r);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const canSubmit = !!displayName.trim() && handleOk;
  return (
    <Dialog
      open={open}
      onClose={close}
      width={made ? "max-w-xl" : "max-w-md"}
      title={made ? `${made.user.displayName} can sign in now` : "Add member"}
      description={made ? "Their first token is below. They can make more tokens under Settings once signed in." : "They get a first token to sign in with."}
      footer={
        made ? (
          <Button variant="primary" onClick={close}>
            Done, I copied it
          </Button>
        ) : (
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={submit}>
              Add member
            </Button>
          </>
        )
      }
    >
      {made ? (
        <TokenReveal token={made.token} who={made.user.displayName} />
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) void submit();
          }}
        >
          <Field label="Name" htmlFor="u-name">
            <Input
              id="u-name"
              autoFocus
              autoComplete="off"
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
                if (!handleTouched) setHandle(handleFrom(e.target.value));
              }}
            />
          </Field>
          <Field
            label="Handle"
            htmlFor="u-handle"
            error={handle && !handleOk ? "Use lowercase letters, digits and single hyphens." : undefined}
            hint="Shows in grants, the audit log and the CLI. It cannot be changed later."
          >
            <Input
              id="u-handle"
              mono
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!handle && !handleOk}
              value={handle}
              onChange={(e) => {
                setHandleTouched(true);
                setHandle(e.target.value.toLowerCase());
              }}
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span id="u-role" className="text-sm font-medium">
              Role
            </span>
            <div aria-labelledby="u-role">
              <Segmented<Role>
                label="Role"
                value={role}
                onChange={setRole}
                options={[
                  { value: "member", label: "Member" },
                  { value: "admin", label: "Admin" },
                ]}
              />
            </div>
            <p className="text-sm text-fg-subtle">
              {role === "admin" ? "Admins manage every team, person and skill, and read every private skill." : "Members act through the teams they join and the grants they get."}
            </p>
          </div>
          <InlineError error={err} />
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}
