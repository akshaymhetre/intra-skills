// Access: who can read, who can publish. Visibility, the owning team, and grants beyond it.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Lock, Users } from "lucide-react";
import type { Grant, Permission, PrincipalType, SkillDetail, Team, User, Visibility } from "@intra-skills/shared/types";
import { api } from "../../api";
import { useAsync } from "../../lib/useAsync";
import { Avatar, Button, ConfirmDialog, InlineError, Menu, Select, Skeleton, cx, useToast } from "../../components/ui";

export function AccessTab({ skill, onChanged }: { skill: SkillDetail; onChanged: (s: SkillDetail) => void }) {
  const toast = useToast();
  const canAdmin = skill.permissions.canAdmin;
  const teams = useAsync(() => api.listTeams(), []);
  const users = useAsync(() => api.listUsers(), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();

  const teamName = (slug: string | null) => (slug ? (teams.data?.find((t) => t.slug === slug)?.name ?? slug) : null);

  const patch = async (key: string, p: Parameters<typeof api.patchSkill>[1], done: string) => {
    setBusy(key);
    setErr(undefined);
    try {
      onChanged(await api.patchSkill(skill.name, p));
      toast({ message: done });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(null);
    }
  };

  const owner = teamName(skill.team);
  const options: { v: Visibility; title: string; body: string }[] = [
    { v: "org", title: "Everyone in the organisation", body: "Anyone signed in to this registry can find it in the catalog and install it." },
    {
      v: "private",
      title: "Private",
      body: `Only ${owner ? `members of ${owner}` : "its owning team"}, @${skill.createdBy}, admins and the grants below can see it. Everyone else gets "not found", even with the exact name.`,
    },
  ];
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const onRadioKey = (e: KeyboardEvent, i: number) => {
    const d = ["ArrowDown", "ArrowRight"].includes(e.key) ? 1 : ["ArrowUp", "ArrowLeft"].includes(e.key) ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    radios.current[n]?.focus();
    const o = options[n]!;
    if (o.v !== skill.visibility) void patch("visibility", { visibility: o.v }, o.v === "private" ? `${skill.name} is now private` : `${skill.name} is now visible to everyone`);
  };

  return (
    <div className="flex max-w-[720px] flex-col gap-8">
      {!canAdmin && (
        <p className="border-l-2 border-line-strong pl-3 text-sm text-fg-muted">
          You can publish and edit this skill. Only admins, its creator <span className="font-mono text-fg">@{skill.createdBy}</span>
          {owner && (
            <>
              {" "}
              and maintainers of <span className="text-fg">{owner}</span>
            </>
          )}{" "}
          can change who sees it, so the controls below are read-only for you.
        </p>
      )}
      <InlineError error={err} />

      <section aria-labelledby="vis-h">
        <h2 id="vis-h" className="text-base font-semibold">
          Who can read it
        </h2>
        <div role="radiogroup" aria-labelledby="vis-h" className="mt-3 flex flex-col gap-2">
          {options.map((o, i) => {
            const on = skill.visibility === o.v;
            return (
              <button
                key={o.v}
                ref={(el) => {
                  radios.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                aria-disabled={!canAdmin || undefined}
                tabIndex={on ? 0 : -1}
                onKeyDown={(e) => canAdmin && onRadioKey(e, i)}
                onClick={() =>
                  canAdmin && !on && busy === null && void patch("visibility", { visibility: o.v }, o.v === "private" ? `${skill.name} is now private` : `${skill.name} is now visible to everyone`)
                }
                className={cx(
                  "flex w-full gap-3 rounded-lg border px-4 py-3 text-left transition-[border-color,background-color,box-shadow] duration-[120ms]",
                  on
                    ? "border-sel bg-[color-mix(in_oklch,var(--sel)_5%,var(--raised))] shadow-[0_0_0_1px_var(--sel)]"
                    : cx("border-line bg-surface", canAdmin && "hover:border-line-strong hover:bg-surface-2"),
                  !canAdmin && "cursor-default",
                )}
              >
                <span
                  aria-hidden
                  className={cx(
                    "mt-[3px] flex size-3.5 shrink-0 items-center justify-center rounded-full border",
                    on ? "border-sel bg-sel" : "border-line-control bg-surface",
                  )}
                >
                  {on && <span className="size-1.5 rounded-full bg-surface" />}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-fg">
                    {o.v === "private" && <Lock className="size-3.5" aria-hidden />}
                    {o.title}
                  </span>
                  <span className="mt-0.5 block text-sm text-fg-muted">{o.body}</span>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="team-h">
        <h2 id="team-h" className="text-base font-semibold">
          Owning team
        </h2>
        <p className="mt-1 max-w-[60ch] text-sm text-fg-muted">Members of the owning team can publish versions and yank them. Its maintainers can also change access.</p>
        <div className="mt-3 flex items-center gap-3">
          {teams.data ? (
            <Select
              aria-labelledby="team-h"
              value={skill.team ?? ""}
              disabled={!canAdmin || busy !== null}
              onChange={(e) => {
                const next = e.target.value || null;
                void patch("team", { team: next }, next ? `${teamName(next)} now owns ${skill.name}` : `${skill.name} has no owning team`);
              }}
              className="min-w-[240px]"
            >
              <option value="">No owning team</option>
              {teams.data.map((t: Team) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </Select>
          ) : (
            <Skeleton className="h-8 w-60 rounded-md" />
          )}
        </div>
      </section>

      <GrantsEditor
        skill={skill}
        canAdmin={canAdmin}
        teams={teams.data ?? []}
        users={users.data ?? []}
        loading={!teams.data || !users.data}
        onSaved={(g) => onChanged({ ...skill, grants: g })}
      />
    </div>
  );
}

function GrantsEditor({
  skill,
  canAdmin,
  teams,
  users,
  loading,
  onSaved,
}: {
  skill: SkillDetail;
  canAdmin: boolean;
  teams: Team[];
  users: User[];
  loading: boolean;
  onSaved: (g: Grant[]) => void;
}) {
  const toast = useToast();
  const grants = skill.grants ?? [];
  const [type, setType] = useState<PrincipalType>("team");
  const [principal, setPrincipal] = useState("");
  const [perm, setPerm] = useState<Permission>("read");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const [removing, setRemoving] = useState<Grant | null>(null);

  const taken = new Set(grants.filter((g) => g.principalType === type).map((g) => g.principal));
  const options =
    type === "team"
      ? teams.filter((t) => !taken.has(t.slug) && t.slug !== skill.team).map((t) => ({ v: t.slug, l: t.name }))
      : users.filter((u) => !taken.has(u.handle)).map((u) => ({ v: u.handle, l: `${u.displayName} (@${u.handle})` }));
  useEffect(() => setPrincipal(""), [type]);

  const label = (g: Grant) =>
    g.principalType === "team" ? (teams.find((t) => t.slug === g.principal)?.name ?? g.principal) : (users.find((u) => u.handle === g.principal)?.displayName ?? g.principal);

  const save = async (next: Grant[], done?: string) => {
    setBusy(true);
    setErr(undefined);
    try {
      onSaved(await api.setGrants(skill.name, next));
      setPrincipal("");
      if (done) toast({ message: done });
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="grants-h">
      <h2 id="grants-h" className="text-base font-semibold">
        Grants
      </h2>
      <p className="mt-1 max-w-[60ch] text-sm text-fg-muted">
        Access for a team or a person beyond the owning team. <span className="text-fg">Read</span> lets them see and install a private skill.{" "}
        <span className="text-fg">Write</span> also lets them publish, yank and edit metadata.
      </p>

      <div className="mt-3 overflow-hidden rounded-lg border border-line bg-surface">
        {loading && grants.length > 0 ? (
          <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label="Loading grants">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : grants.length === 0 ? (
          <p className="px-4 py-4 text-sm text-fg-muted">No grants. Access comes from visibility and the owning team only.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-panel text-left text-fg-muted">
              <tr>
                <th scope="col" className="px-4 py-2 font-normal">
                  Who
                </th>
                <th scope="col" className="px-2 py-2 font-normal max-sm:hidden">
                  Type
                </th>
                <th scope="col" className="px-2 py-2 font-normal">
                  Permission
                </th>
                <th scope="col" className="w-px px-3 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {grants.map((g) => (
                <tr key={`${g.principalType}:${g.principal}`} className="h-12">
                  <td className="px-4 py-2">
                    <span className="flex min-w-0 items-center gap-2.5">
                      {g.principalType === "team" ? (
                        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-fg-subtle">
                          <Users className="size-3.5" aria-hidden />
                        </span>
                      ) : (
                        <Avatar name={label(g)} handle={g.principal} size={24} />
                      )}
                      <span className="min-w-0">
                        <span className="block truncate text-fg">{label(g)}</span>
                        <span className="block truncate font-mono text-xs text-fg-subtle">{g.principalType === "team" ? g.principal : `@${g.principal}`}</span>
                      </span>
                    </span>
                  </td>
                  <td className="px-2 py-2 text-fg-muted max-sm:hidden">{g.principalType === "team" ? "Team" : "Person"}</td>
                  <td className="px-2 py-2 text-fg">{g.permission === "write" ? "Write" : "Read"}</td>
                  <td className="px-3 py-2 text-right">
                    {canAdmin && (
                      <Menu
                        label={`Actions for ${label(g)}`}
                        size="sm"
                        items={[
                          g.permission === "read"
                            ? {
                                label: "Change to write",
                                onSelect: () => void save(grants.map((x) => (x === g ? { ...x, permission: "write" } : x)), `${label(g)} can now write`),
                              }
                            : {
                                label: "Change to read",
                                onSelect: () => void save(grants.map((x) => (x === g ? { ...x, permission: "read" } : x)), `${label(g)} can now only read`),
                              },
                          "separator",
                          { label: "Remove grant", danger: true, onSelect: () => setRemoving(g) },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {canAdmin && (
          <form
            aria-label="Add a grant"
            className="flex flex-wrap items-center gap-2 border-t border-line bg-panel px-3 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (principal) {
                const who = type === "team" ? (teams.find((t) => t.slug === principal)?.name ?? principal) : `@${principal}`;
                void save([...grants, { principalType: type, principal, permission: perm }], `${who} can now ${perm}`);
              }
            }}
          >
            <Select aria-label="Grant to a" value={type} onChange={(e) => setType(e.target.value as PrincipalType)}>
              <option value="team">Team</option>
              <option value="user">Person</option>
            </Select>
            <Select aria-label={type === "team" ? "Team" : "Person"} value={principal} onChange={(e) => setPrincipal(e.target.value)} className="min-w-[180px] flex-1">
              <option value="">{options.length ? (type === "team" ? "Choose a team" : "Choose a person") : type === "team" ? "Every team has access" : "Everyone has a grant"}</option>
              {options.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.l}
                </option>
              ))}
            </Select>
            <Select aria-label="Permission" value={perm} onChange={(e) => setPerm(e.target.value as Permission)}>
              <option value="read">Read</option>
              <option value="write">Write</option>
            </Select>
            <Button type="submit" variant="secondary" disabled={!principal} loading={busy}>
              Add grant
            </Button>
          </form>
        )}
      </div>
      <div className="mt-2">
        <InlineError error={err} />
      </div>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          const who = label(removing);
          if (await save(grants.filter((x) => x !== removing), `Removed ${who}'s grant`)) setRemoving(null);
        }}
        title={removing ? `Remove ${label(removing)}'s access?` : "Remove access?"}
        description={
          removing &&
          (skill.visibility === "private"
            ? `${label(removing)} loses ${removing.permission} access to ${skill.name}. On a private skill that means it disappears for them unless their team owns it.`
            : `${label(removing)} loses ${removing.permission === "write" ? "write access; they can still read it, because everyone in the organisation can" : "this grant; they can still read it, because everyone in the organisation can"}.`)
        }
        confirmLabel="Remove grant"
        danger
        busy={busy}
        error={err}
      />
    </section>
  );
}
