// Teams: a dense table of every team (who is on it, what it owns, when it last published), and the
// team page: header, its skills as ranked rows, its collections with their one-line installs, and its
// members. Maintainers and admins edit the team and manage members, as in v1.
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowRight } from "lucide-react";
import type { Collection, SkillSummary, Team, TeamDetail, TeamRole } from "@intra-skills/shared/types";
import { api, ApiError } from "../api";
import { useMe } from "../auth";
import { useAsync } from "../lib/useAsync";
import { formatDate, formatDateTime, formatNumber, plural, relativeTime } from "../lib/format";
import { collectionInstallCommand } from "../lib/commands";
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
  Menu,
  Select,
  Skeleton,
  cx,
  useToast,
} from "../components/ui";
import { PeopleStack, PersonMark, TeamMark } from "../components/fx";
import { SkillList, SkillRow } from "../components/SkillRow";
import { Page, PageIntro, PageSection } from "../components/admin/Page";
import { NotFound } from "./NotFound";
import { PersonCombobox, SkeletonRows, TD, TH, TR, TableFrame, useDocTitle } from "./admin/parts";

const slugify = (n: string) =>
  n
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const patchTeam = api.patchTeam;

/** The newest skill update per team, as "last publish". Built from one catalog request. */
function lastPublishByTeam(skills: SkillSummary[] | undefined) {
  const m = new Map<string, string>();
  for (const s of skills ?? []) if (s.team && (!m.has(s.team) || s.updatedAt > m.get(s.team)!)) m.set(s.team, s.updatedAt);
  return m;
}

function RoleText({ role }: { role: TeamRole | null | undefined }) {
  if (!role) return <span className="text-fg-subtle">-</span>;
  return <span className={role === "maintainer" ? "text-fg" : "text-fg-muted"}>{role === "maintainer" ? "Maintainer" : "Member"}</span>;
}

const sortMembers = (ms: TeamDetail["members"]) =>
  [...ms].sort((a, b) => (a.role === b.role ? a.displayName.localeCompare(b.displayName) : a.role === "maintainer" ? -1 : 1));

export function Teams() {
  useDocTitle("Teams");
  const me = useMe();
  const teams = useAsync(() => api.listTeams(), []);
  // Members per team, for the faces column. Teams are few; one request each, in parallel.
  const details = useAsync(async () => {
    const list = await api.listTeams();
    const all = await Promise.all(list.map((t) => api.getTeam(t.slug).catch(() => null)));
    return new Map(all.filter((d): d is TeamDetail => !!d).map((d) => [d.slug, d]));
  }, []);
  const skills = useAsync(() => api.listSkills({ deprecated: "include" }), []);
  const collections = useAsync(() => api.listCollections(), []);
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const lastPublish = useMemo(() => lastPublishByTeam(skills.data?.skills), [skills.data]);
  const collCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of collections.data ?? []) m.set(c.team, (m.get(c.team) ?? 0) + 1);
    return m;
  }, [collections.data]);
  const list = teams.data
    ? [...teams.data].sort((a, b) => {
        // Your teams first, then by name.
        const am = me.teams.some((t) => t.slug === a.slug) ? 0 : 1;
        const bm = me.teams.some((t) => t.slug === b.slug) ? 0 : 1;
        return am - bm || a.name.localeCompare(b.name);
      })
    : null;
  const isAdmin = me.role === "admin";

  return (
    <Page>
      <PageIntro
        title="Teams"
       
        description="A team owns skills and the collections that bundle them. Members publish to its skills; maintainers also manage who is on it."
        actions={
          isAdmin && (
            <Button variant="primary" onClick={() => setOpen(true)}>
              New team
            </Button>
          )
        }
        rule={false}
      />

      {teams.error ? (
        <div className="border-y border-line">
          <ErrorState error={teams.error} onRetry={teams.reload} title="Could not load teams" />
        </div>
      ) : list && list.length === 0 ? (
        <div className="border-y border-line">
          <EmptyState
            title="No teams yet"
            action={
              isAdmin && (
                <Button variant="primary" onClick={() => setOpen(true)}>
                  New team
                </Button>
              )
            }
          >
            {isAdmin
              ? "A team gives skills an owner, so people know who to ask. Skills join a team through metadata.team in their SKILL.md."
              : "An admin has not created any teams yet. Skills without a team still install as usual."}
          </EmptyState>
        </div>
      ) : (
        <TableFrame label="Teams">
          <thead className="max-md:hidden">
            <tr className="border-b border-line">
              <th scope="col" className={TH}>Team</th>
              <th scope="col" className={cx(TH, "w-28")}>Your role</th>
              <th scope="col" className={cx(TH, "w-40")}>Members</th>
              <th scope="col" className={cx(TH, "w-16 text-right")}>Skills</th>
              <th scope="col" className={cx(TH, "w-24 text-right")}>Collections</th>
              <th scope="col" className={cx(TH, "w-32 text-right")}>Last publish</th>
            </tr>
          </thead>
          <tbody>
            {!list ? (
              <SkeletonRows widths={["w-48", "w-16", "w-20", "w-6", "w-6", "w-20"]} rows={5} mobile={<span className="block h-3 w-48 skeleton" />} />
            ) : (
              list.map((t) => (
                <TeamRow
                  key={t.slug}
                  team={t}
                  detail={details.data?.get(t.slug)}
                  collections={collections.data ? (collCount.get(t.slug) ?? 0) : undefined}
                  myRole={me.teams.find((x) => x.slug === t.slug)?.role}
                  last={skills.data ? (lastPublish.get(t.slug) ?? null) : undefined}
                />
              ))
            )}
          </tbody>
        </TableFrame>
      )}

      <TeamFormDialog
        mode="create"
        open={open}
        onClose={() => setOpen(false)}
        onSaved={(t) => {
          setOpen(false);
          navigate(`/teams/${t.slug}`);
        }}
      />
    </Page>
  );
}

function TeamRow({
  team: t,
  detail,
  collections,
  myRole,
  last,
}: {
  team: Team;
  detail?: TeamDetail;
  /** undefined while loading. */
  collections?: number;
  myRole?: TeamRole;
  /** undefined while loading, null when the team has published nothing. */
  last: string | null | undefined;
}) {
  const people = detail ? sortMembers(detail.members) : null;
  return (
    <tr
      className={cx(
        TR,
        "relative max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-start max-md:gap-x-3 max-md:gap-y-2 max-md:px-1 max-md:py-3.5",
      )}
    >
      <td className={cx(TD, "py-3 md:max-w-0 max-md:h-auto max-md:min-w-0 max-md:p-0!")}>
        <span className="flex min-w-0 items-start gap-3">
          <TeamMark slug={t.slug} name={t.name} size={32} className="mt-0.5" />
          <span className="min-w-0">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <Link
                to={`/teams/${t.slug}`}
                className="text-[15px] font-semibold tracking-[-0.01em] text-fg outline-none after:absolute after:inset-0 after:content-[''] hover:underline hover:decoration-line-control hover:underline-offset-4 focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-focus"
              >
                {t.name}
              </Link>
              <span className="font-mono text-xs text-fg-subtle">{t.slug}</span>
            </span>
            {t.description ? (
              <span className="mt-0.5 block text-sm text-fg-muted md:truncate">{t.description}</span>
            ) : (
              <span className="mt-0.5 block text-sm text-fg-subtle">No description</span>
            )}
          </span>
        </span>
      </td>
      <td className={cx(TD, "whitespace-nowrap max-md:col-start-2 max-md:row-start-1 max-md:h-auto max-md:min-w-0 max-md:p-0! max-md:pt-1 max-md:text-right")}>
        {myRole ? <RoleText role={myRole} /> : <span className="text-fg-subtle max-md:hidden">-<span className="sr-only">Not a member</span></span>}
      </td>
      <td className={cx(TD, "max-md:col-span-2 max-md:row-start-2 max-md:h-auto max-md:min-w-0 max-md:p-0! max-md:pl-11!")}>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {people ? (
            people.length > 0 ? (
              <PeopleStack people={people} max={4} />
            ) : null
          ) : (
            <Skeleton className="h-5 w-16 rounded-full" />
          )}
          <span className="text-sm whitespace-nowrap text-fg-muted tabular">
            {formatNumber(t.memberCount)}
            <span className="md:sr-only"> {t.memberCount === 1 ? "member" : "members"}</span>
          </span>
          <span className="flex flex-wrap gap-x-3 text-sm whitespace-nowrap text-fg-subtle tabular md:hidden">
            <span>{plural(t.skillCount, "skill")}</span>
            {last && <span>published {relativeTime(last)}</span>}
          </span>
        </span>
      </td>
      <td className={cx(TD, "text-right text-fg-muted tabular max-md:hidden")}>{formatNumber(t.skillCount)}</td>
      <td className={cx(TD, "text-right text-fg-muted tabular max-md:hidden")}>
        {collections === undefined ? <Skeleton className="ml-auto h-3 w-5" /> : collections === 0 ? <span className="text-fg-subtle">0</span> : formatNumber(collections)}
      </td>
      <td className={cx(TD, "text-right whitespace-nowrap max-md:hidden")}>
        {last === undefined ? (
          <Skeleton className="ml-auto h-3 w-16" />
        ) : last ? (
          <time dateTime={last} title={formatDateTime(last)} className="text-fg-muted tabular">
            {relativeTime(last)}
          </time>
        ) : (
          <span className="text-fg-subtle">Never</span>
        )}
      </td>
    </tr>
  );
}

// ---------- create / edit ----------

function TeamFormDialog({
  mode,
  open,
  onClose,
  onSaved,
  team,
}: {
  mode: "create" | "edit";
  open: boolean;
  onClose: () => void;
  onSaved: (t: TeamDetail) => void;
  team?: TeamDetail;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [slug, setSlug] = useState(team?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState(team?.description ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>();
  const slugOk = SLUG_RE.test(slug);
  const canSubmit = !!name.trim() && (mode === "edit" || slugOk);

  const reset = () => {
    setName(team?.name ?? "");
    setSlug(team?.slug ?? "");
    setSlugTouched(false);
    setDescription(team?.description ?? "");
    setErr(undefined);
  };
  const close = () => {
    onClose();
    reset();
  };
  const submit = async () => {
    setBusy(true);
    setErr(undefined);
    try {
      const saved =
        mode === "create"
          ? await api.createTeam({ slug, name: name.trim(), description: description.trim() || undefined })
          : await patchTeam(team!.slug, { name: name.trim(), description: description.trim() });
      onSaved(saved);
      reset();
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
      title={mode === "create" ? "New team" : `Edit ${team?.name ?? "team"}`}
      description={mode === "create" ? "Skills join a team by naming its slug in their SKILL.md metadata." : undefined}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!canSubmit} onClick={submit}>
            {mode === "create" ? "Create team" : "Save changes"}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void submit();
        }}
      >
        <Field label="Name" htmlFor="team-name">
          <Input
            id="team-name"
            value={name}
            autoFocus
            autoComplete="off"
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              if (mode === "create" && !slugTouched) setSlug(slugify(e.target.value));
            }}
          />
        </Field>
        {mode === "create" ? (
          <Field
            label="Slug"
            htmlFor="team-slug"
            error={slug && !slugOk ? "Use lowercase letters, digits and single hyphens." : undefined}
            hint={
              <>
                Skills name it as <code className="font-mono text-[0.93em] text-fg-muted">team: {slug || "mobile"}</code>. It cannot change later.
              </>
            }
          >
            <Input
              id="team-slug"
              mono
              autoComplete="off"
              spellCheck={false}
              aria-invalid={!!slug && !slugOk}
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
          </Field>
        ) : (
          <p className="text-sm text-fg-muted">
            Slug <code className="font-mono text-[0.93em] text-fg">{team?.slug}</code> stays the same, so SKILL.md files that name it keep working.
          </p>
        )}
        <Field label="Description" htmlFor="team-desc" hint="Optional. One line on what the team owns.">
          <Input id="team-desc" value={description} maxLength={200} autoComplete="off" onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <InlineError error={err} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------- team page ----------

export function TeamPage() {
  const { slug = "" } = useParams();
  const me = useMe();
  const toast = useToast();
  const team = useAsync(() => api.getTeam(slug), [slug]);
  const users = useAsync(() => api.listUsers(), []);
  const skills = useAsync(() => api.listSkills({ team: [slug], deprecated: "include", sort: "trending" }), [slug]);
  const collections = useAsync(() => api.listCollections(slug), [slug]);
  const [addHandle, setAddHandle] = useState("");
  const [addRole, setAddRole] = useState<TeamRole>("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>();
  const [removing, setRemoving] = useState<{ handle: string; displayName: string; role: TeamRole } | null>(null);
  const [editing, setEditing] = useState(false);
  useDocTitle(team.data?.name ?? slug);

  if (team.error) {
    if (team.error instanceof ApiError && team.error.isNotFound) return <NotFound title={`No team "${slug}"`} body="No team uses this slug. It may have been renamed, or the link has a typo." />;
    return (
      <Page>
        <div className="pt-10">
          <ErrorState error={team.error} onRetry={team.reload} title="Could not load this team" />
        </div>
      </Page>
    );
  }
  const t = team.data;
  const myRole = me.teams.find((x) => x.slug === slug)?.role;
  const canManage = me.role === "admin" || myRole === "maintainer";

  const mutate = async (key: string, fn: () => Promise<TeamDetail>, after?: (d: TeamDetail) => void) => {
    setBusy(key);
    setErr(undefined);
    try {
      const d = await fn();
      team.setData(d);
      after?.(d);
      return true;
    } catch (e) {
      setErr(e);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const nameOf = (h: string) => t?.members.find((m) => m.handle === h)?.displayName ?? users.data?.find((u) => u.handle === h)?.displayName ?? h;
  const candidates = (users.data ?? []).filter((u) => !t?.members.some((m) => m.handle === u.handle));
  const members = t ? sortMembers(t.members) : null;

  const add = () =>
    void mutate("add", () => api.setTeamMember(slug, addHandle, addRole), () => {
      toast({ message: `Added ${nameOf(addHandle)} to ${t?.name ?? slug} as ${addRole}` });
      setAddHandle("");
      setAddRole("member");
    });

  const changeRole = (m: { handle: string; displayName: string; role: TeamRole }, role: TeamRole) =>
    void mutate(m.handle, () => api.setTeamMember(slug, m.handle, role), () =>
      toast({
        message: `${m.displayName} is now a ${role} of ${t?.name ?? slug}`,
        action: { label: "Undo", onClick: () => void mutate(m.handle, () => api.setTeamMember(slug, m.handle, m.role)) },
      }),
    );

  const remove = async () => {
    if (!removing) return;
    const r = removing;
    const ok = await mutate(r.handle, () => api.removeTeamMember(slug, r.handle));
    if (!ok) return;
    setRemoving(null);
    toast({
      message: `Removed ${r.displayName} from ${t?.name ?? slug}`,
      action: { label: "Undo", onClick: () => void mutate(r.handle, () => api.setTeamMember(slug, r.handle, r.role)) },
    });
  };

  const skillCount = skills.data?.total;

  return (
    <Page>
      {t ? (
        <PageIntro
          title={t.name}
          lead={<TeamMark slug={t.slug} name={t.name} size={48} />}
          description={t.description || (canManage ? <span className="text-fg-subtle">No description yet. Edit the team to add one line on what it owns.</span> : undefined)}
          meta={
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-fg-subtle">
              {members && members.length > 0 && (
                <span className="flex items-center gap-2">
                  <PeopleStack people={members} max={5} size={22} />
                  <span className="tabular">{plural(members.length, "member")}</span>
                </span>
              )}
              <span>
                <span className="font-mono text-xs">team</span> <span className="font-mono text-[13px] text-fg-muted">{t.slug}</span>
              </span>
              <span className="tabular" title={formatDateTime(t.createdAt)}>
                Created {formatDate(t.createdAt)}
              </span>
              {myRole && <span className="text-fg-muted">You are a {myRole}</span>}
            </div>
          }
          actions={
            <>
              {skillCount !== undefined && skillCount > 0 && (
                <Link
                  to={`/skills?q=${encodeURIComponent(`team:${slug}`)}`}
                  className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm text-fg-muted transition-colors duration-[120ms] hover:text-fg max-md:h-11"
                >
                  Open in catalog
                  <ArrowRight className="size-3.5" aria-hidden />
                </Link>
              )}
              {canManage && <Button onClick={() => setEditing(true)}>Edit team</Button>}
            </>
          }
        />
      ) : (
        <div className="pt-12 pb-9" aria-busy="true" aria-label="Loading team">
          <div className="flex items-start gap-4">
            <Skeleton className="size-12 rounded-[28%]" />
            <div className="flex-1 space-y-3">
              <Skeleton className="h-8 w-56" />
              <Skeleton className="h-4 w-96 max-w-full" />
            </div>
          </div>
        </div>
      )}

      <PageSection id="team-skills-h" title="Skills it owns" count={skillCount} description="Ranked by installs this week.">
        {skills.error ? (
          <div className="border-y border-line">
            <ErrorState error={skills.error} onRetry={skills.reload} title="Could not load this team's skills" />
          </div>
        ) : !skills.data ? (
          <div className="space-y-2 border-y border-line py-3" aria-busy="true" aria-label="Loading skills">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : skills.data.skills.length === 0 ? (
          <div className="border-y border-line">
            <EmptyState title="No skills yet" align="start" className="px-1 py-8 md:px-3">
              A skill joins this team when its SKILL.md says <code className="font-mono text-[0.93em] text-fg">team: {slug}</code> under metadata. Publish one with{" "}
              <code className="font-mono text-[0.93em] text-fg">intra init --team {slug}</code>.
            </EmptyState>
          </div>
        ) : (
          <SkillList label={`Skills owned by ${t?.name ?? slug}`}>
            {skills.data.skills.map((s, i) => (
              <SkillRow key={s.name} skill={s} rank={i + 1} showTeam={false} />
            ))}
          </SkillList>
        )}
      </PageSection>

      <PageSection
        id="team-coll-h"
        title="Collections"
        count={collections.data?.length}
        description="Sets of this team's skills that install together in one command."
      >
        {collections.error ? (
          <div className="border-y border-line">
            <ErrorState error={collections.error} onRetry={collections.reload} title="Could not load collections" />
          </div>
        ) : !collections.data ? (
          <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label="Loading collections">
            <Skeleton className="h-40" />
            <Skeleton className="h-40 max-md:hidden" />
          </div>
        ) : collections.data.length === 0 ? (
          <div className="border-y border-line">
            <EmptyState title="No collections yet" align="start" className="px-1 py-8 md:px-3">
              A collection is an ordered set of skills people install as <code className="font-mono text-[0.93em] text-fg">@{slug}/&lt;name&gt;</code>.
              {" Members of this team and admins can create one."}
            </EmptyState>
          </div>
        ) : (
          <ul className={cx("grid gap-4", collections.data.length > 1 && "md:grid-cols-2")}>
            {collections.data.map((c) => (
              <CollectionCard key={c.slug} c={c} />
            ))}
          </ul>
        )}
      </PageSection>

      <PageSection
        id="members-h"
        title="Members"
        count={t?.members.length}
        description="Members publish new versions of this team's skills. Maintainers also manage members and access."
        actions={
          canManage &&
          t && (
            <form
              aria-label={`Add a member to ${t.name}`}
              className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
              onSubmit={(e) => {
                e.preventDefault();
                if (addHandle) add();
              }}
            >
              <label htmlFor="add-person" className="sr-only">
                Person to add
              </label>
              <PersonCombobox id="add-person" people={candidates} value={addHandle} onChange={setAddHandle} className="w-full sm:w-60" placeholder="Add a person by name or handle" />
              <Select aria-label="Role for the new member" value={addRole} onChange={(e) => setAddRole(e.target.value as TeamRole)} className="max-sm:flex-1">
                <option value="member">Member</option>
                <option value="maintainer">Maintainer</option>
              </Select>
              <Button type="submit" disabled={!addHandle} loading={busy === "add"} className="max-sm:flex-1">
                Add to team
              </Button>
            </form>
          )
        }
      >
        {err != null && !removing && (
          <div className="pb-3">
            <InlineError error={err} />
          </div>
        )}
        {members && members.length === 0 ? (
          <div className="border-y border-line">
            <EmptyState title="Nobody on this team yet" align="start" className="px-1 py-8 md:px-3">
              {canManage ? "Add the people who own these skills. Maintainers manage members and access; members publish." : "A maintainer or an admin adds people here."}
            </EmptyState>
          </div>
        ) : (
          <TableFrame label={`Members of ${t?.name ?? slug}`}>
            <thead className="max-md:hidden">
              <tr className="border-b border-line">
                <th scope="col" className={TH}>Name</th>
                <th scope="col" className={cx(TH, "w-44")}>Role</th>
                {canManage && (
                  <th scope="col" className={cx(TH, "w-px")}>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {!members ? (
                <SkeletonRows widths={canManage ? ["w-40", "w-24", "w-6"] : ["w-40", "w-20"]} rows={4} mobile={<span className="block h-3 w-40 skeleton" />} />
              ) : (
                members.map((m) => {
                  const self = m.handle === me.handle;
                  return (
                    <tr key={m.handle} className={cx(TR, "max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto_auto] max-md:items-center max-md:gap-x-2 max-md:px-1 max-md:py-2")}>
                      <td className={cx(TD, "h-12 md:w-full max-md:h-auto max-md:min-w-0 max-md:p-0!")}>
                        <span className="flex min-w-0 items-center gap-2.5">
                          <PersonMark handle={m.handle} name={m.displayName} size={26} />
                          <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 max-md:flex-col">
                            <span className="truncate font-medium text-fg">
                              {m.displayName}
                              {self && <span className="ml-1.5 text-xs font-normal text-fg-subtle">you</span>}
                            </span>
                            <span className="font-mono text-xs text-fg-subtle">{m.handle}</span>
                          </span>
                        </span>
                      </td>
                      <td className={cx(TD, "whitespace-nowrap max-md:h-auto max-md:w-auto max-md:p-0!")}>
                        {canManage ? (
                          <Select
                            aria-label={`Role of ${m.displayName} in ${t?.name ?? slug}`}
                            value={m.role}
                            disabled={!!busy}
                            className="w-[8.5rem]"
                            onChange={(e) => changeRole(m, e.target.value as TeamRole)}
                          >
                            <option value="member">Member</option>
                            <option value="maintainer">Maintainer</option>
                          </Select>
                        ) : (
                          <RoleText role={m.role} />
                        )}
                      </td>
                      {canManage && (
                        <td className={cx(TD, "w-px text-right max-md:h-auto max-md:w-auto max-md:min-w-0 max-md:p-0!")}>
                          <Menu
                            label={`Actions for ${m.displayName}`}
                            size="sm"
                            items={[
                              {
                                label: `Remove from ${t?.name ?? "team"}`,
                                text: "Remove",
                                danger: true,
                                onSelect: () => (setErr(undefined), setRemoving(m)),
                              },
                            ]}
                          />
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </TableFrame>
        )}
      </PageSection>

      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        title={`Remove ${removing?.displayName ?? ""} from ${t?.name ?? "this team"}?`}
        description={
          removing?.handle === me.handle && me.role !== "admin"
            ? "You lose write access to this team's skills and can no longer manage its members. Only an admin or a maintainer can add you back."
            : "They lose write access to this team's skills and read access to its private ones, unless a grant covers them."
        }
        confirmLabel="Remove member"
        danger
        busy={!!busy}
        error={err}
      />

      {t && (
        <TeamFormDialog
          key={`${t.slug}-${t.name}-${t.description}`}
          mode="edit"
          team={t}
          open={editing}
          onClose={() => setEditing(false)}
          onSaved={(d) => {
            team.setData(d);
            setEditing(false);
            toast({ message: `Saved ${d.name}` });
          }}
        />
      )}
    </Page>
  );
}

function CollectionCard({ c }: { c: Collection }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <div className="min-w-0">
        <Link to={`/collections/${c.team}/${c.slug}`} className="text-[15px] font-semibold tracking-[-0.01em] text-fg hover:underline hover:decoration-line-control hover:underline-offset-4">
          {c.title}
        </Link>
        {c.description && <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{c.description}</p>}
      </div>
      <p className="font-mono text-xs text-fg-subtle">
        {c.skills.length ? c.skills.join(" · ") : "No skills you can read"}
        <span className="ml-2 font-sans">({plural(c.skills.length, "skill")})</span>
      </p>
      <CopyCommand command={collectionInstallCommand(c.team, c.slug)} size="sm" label={`Copy install command for @${c.team}/${c.slug}`} className="mt-auto" />
    </li>
  );
}
