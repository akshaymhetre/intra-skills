// /collections/:team/:slug: a team's named, ordered set of skills, installed in one line as
// `intra install @team/slug`. Team members and admins can edit the title, description and the ordered
// skill list, or delete the collection.
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowDown, ArrowLeft, ArrowUp, Pencil, Plus, X } from "lucide-react";
import type { Collection, SkillSummary } from "@intra-skills/shared/types";
import { api, ApiError } from "../api";
import { useMe } from "../auth";
import { useAsync } from "../lib/useAsync";
import { useRegistryMeta, useDocTitle } from "../lib/meta";
import { collectionAgentPrompt, collectionInstallCommand } from "../lib/commands";
import { plural, relativeTime } from "../lib/format";
import { DottedRule, PersonMark, Rank, SectionHeading, TeamMark } from "../components/fx";
import { InstallCard } from "../components/InstallCard";
import { SkillList, SkillRow } from "../components/SkillRow";
import { SkillListSkeleton } from "../components/catalog/SkillListSkeleton";
import { Button, ConfirmDialog, EmptyState, ErrorState, Field, IconButton, InlineError, Input, Select, Skeleton, useToast } from "../components/ui";

const PAGE = "mx-auto w-full max-w-[1180px] px-5 pb-20 md:px-10";
const MAX_SKILLS = 50;

export function CollectionPage() {
  const { team = "", slug = "" } = useParams();
  const me = useMe();
  const meta = useRegistryMeta();
  const col = useAsync(() => api.getCollection(team, slug), [team, slug]);
  const teamInfo = useAsync(() => api.getTeam(team), [team]);
  const skills = useAsync(() => api.listSkills({ deprecated: "include" }), []);
  const [editing, setEditing] = useState(false);

  useDocTitle(col.data?.title ?? `@${team}/${slug}`);
  useEffect(() => setEditing(false), [team, slug]);

  const byName = useMemo(() => new Map((skills.data?.skills ?? []).map((s) => [s.name, s])), [skills.data]);
  const canEdit = me.role === "admin" || me.teams.some((t) => t.slug === team);

  if (col.error && !col.data) {
    if (col.error instanceof ApiError && col.error.isNotFound) return <NotFoundState team={team} slug={slug} teamName={teamInfo.data?.name} />;
    return (
      <div className={PAGE}>
        <div className="-mx-6 pt-6">
          <ErrorState error={col.error} onRetry={col.reload} title="This collection did not load" align="start" />
        </div>
      </div>
    );
  }

  const c = col.data;
  const teamName = teamInfo.data?.name ?? team;
  const creator = c && (teamInfo.data?.members.find((m) => m.handle === c.createdBy)?.displayName ?? c.createdBy);
  const url = meta?.publicUrl ?? window.location.origin;
  const spec = `@${team}/${slug}`;

  return (
    <div className={PAGE}>
      <section className="grid gap-x-12 gap-y-8 pt-8 pb-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,440px)] lg:pt-10">
        <div className="min-w-0">
          <Link
            to={`/teams/${encodeURIComponent(team)}`}
            className="-ml-1 inline-flex h-8 items-center gap-2 rounded-md px-1 text-sm text-fg-muted transition-colors duration-[120ms] hover:text-fg max-md:h-11"
          >
            <TeamMark slug={team} name={teamName} size={22} />
            <span className="font-medium">{teamName}</span>
            <span className="font-mono text-xs text-fg-subtle">{spec}</span>
          </Link>
          {c ? (
            <>
              <div className="mt-3">
                <SectionHeading as="h1" size="lg">
                  {c.title}
                </SectionHeading>
              </div>
              {c.description && <p className="mt-3 max-w-xl text-base text-fg-muted">{c.description}</p>}
              <p className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-fg-subtle">
                <PersonMark handle={c.createdBy} name={creator ?? c.createdBy} size={18} />
                <span>
                  Put together by <span className="text-fg-muted">{creator}</span>
                </span>
                <span aria-hidden>·</span>
                <span>
                  updated <time dateTime={c.updatedAt}>{relativeTime(c.updatedAt)}</time>
                </span>
                <span aria-hidden>·</span>
                <span className="tabular">{plural(c.skills.length, "skill")}</span>
              </p>
              {canEdit && !editing && (
                <Button className="mt-5" icon={<Pencil className="size-3.5" aria-hidden />} onClick={() => setEditing(true)}>
                  Edit collection
                </Button>
              )}
            </>
          ) : (
            <div aria-busy="true" aria-label="Loading collection">
              <Skeleton className="mt-3 h-10 w-80 max-w-full" />
              <Skeleton className="mt-4 h-4 w-96 max-w-full" />
              <Skeleton className="mt-6 h-4 w-64" />
            </div>
          )}
        </div>
        <div className="min-w-0 lg:pt-2">
          <InstallCard
            title={c ? `Install all ${plural(c.skills.length, "skill")}` : "Install this collection"}
            tabs={[
              {
                id: "terminal",
                label: "Terminal",
                command: collectionInstallCommand(team, slug),
                note: "Installs every skill below for Claude Code and Codex, into ~/.claude/skills and ~/.agents/skills. Each one is recorded on its own, so you can update or remove it later.",
              },
              {
                id: "project",
                label: "Project",
                command: collectionInstallCommand(team, slug, true),
                note: "Run it in a repository. The skills land in .claude/skills and .agents/skills there, pinned in skills.lock.json for the whole team.",
              },
              {
                id: "agent",
                label: "Ask your agent",
                command: collectionAgentPrompt(url, team, slug),
                prose: true,
                note: "Paste this into Claude Code or Codex. The agent reads the setup steps and asks you before it runs anything.",
              },
            ]}
          />
        </div>
      </section>

      <DottedRule />

      {editing && c ? (
        <EditCollection
          team={team}
          slug={slug}
          spec={spec}
          collection={c}
          all={skills.data?.skills ?? []}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            col.setData(next);
            setEditing(false);
          }}
        />
      ) : (
        <section aria-labelledby="col-skills" className="pt-8">
          <SectionHeading id="col-skills" size="md" mark="order" description="The command installs them top to bottom.">
            Skills in install order
          </SectionHeading>
          {!c || !skills.data ? (
            <SkillListSkeleton rows={c?.skills.length || 4} ranked className="mt-5" />
          ) : c.skills.length === 0 ? (
            <EmptyState title="This collection is empty" align="start" className="-mx-6">
              {canEdit ? "Edit it to add the skills your team installs together." : `Nothing to install yet. Someone on ${teamName} can add skills to it.`}
            </EmptyState>
          ) : (
            <SkillList className="mt-5" label="Skills in this collection">
              {c.skills.map((name, i) => {
                const s = byName.get(name);
                return s ? <SkillRow key={name} skill={s} sequence={i + 1} /> : <MissingRow key={name} name={name} rank={i + 1} />;
              })}
            </SkillList>
          )}
        </section>
      )}
    </div>
  );
}

/** A listed skill the catalog did not return (it loaded with an error, or was removed since). */
function MissingRow({ name, rank }: { name: string; rank: number }) {
  return (
    <li className="flex items-start gap-4 border-b border-line px-1 py-3.5 last:border-b-0 md:px-3">
      <Rank n={rank} className="pt-0.5" />
      <div className="min-w-0">
        <Link to={`/skills/${encodeURIComponent(name)}`} className="font-mono text-[15px] font-medium text-fg hover:underline hover:underline-offset-4">
          {name}
        </Link>
        <p className="mt-1 text-sm text-fg-subtle">Details for this skill did not load.</p>
      </div>
    </li>
  );
}

// ---------- edit ----------

function EditCollection({
  team,
  slug,
  spec,
  collection,
  all,
  onCancel,
  onSaved,
}: {
  team: string;
  slug: string;
  spec: string;
  collection: Collection;
  all: SkillSummary[];
  onCancel: () => void;
  onSaved: (c: Collection) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [title, setTitle] = useState(collection.title);
  const [description, setDescription] = useState(collection.description);
  const [list, setList] = useState<string[]>(collection.skills);
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);

  const byName = useMemo(() => new Map(all.map((s) => [s.name, s])), [all]);
  const available = all.filter((s) => !list.includes(s.name)).sort((a, b) => a.name.localeCompare(b.name));
  const titleMissing = !title.trim();
  const full = list.length >= MAX_SKILLS;

  const move = (i: number, d: -1 | 1) =>
    setList((l) => {
      const n = [...l];
      const j = i + d;
      if (j < 0 || j >= n.length) return l;
      [n[i], n[j]] = [n[j]!, n[i]!];
      return n;
    });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (titleMissing) return;
    setSaving(true);
    setError(null);
    try {
      const next = await api.putCollection(team, slug, { title: title.trim(), description: description.trim(), skills: list });
      toast({ message: `Saved ${next.title}` });
      onSaved(next);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteCollection(team, slug);
      toast({ message: `Deleted ${collection.title}` });
      navigate(`/teams/${encodeURIComponent(team)}`);
    } catch (err) {
      setDeleteError(err);
      setDeleting(false);
    }
  };

  return (
    <form onSubmit={save} className="max-w-3xl pt-8" aria-labelledby="col-edit">
      <SectionHeading id="col-edit" size="md" description={`Changes apply to everyone who installs ${spec} from now on.`}>
        Edit collection
      </SectionHeading>

      <div className="mt-6 flex flex-col gap-5">
        <Field label="Title" htmlFor="col-title" error={titleMissing ? "A collection needs a title." : undefined}>
          <Input id="col-title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} aria-invalid={titleMissing || undefined} required />
        </Field>
        <Field label="Description" htmlFor="col-desc" hint="One sentence: who should install this, and when.">
          <textarea
            id="col-desc"
            value={description}
            rows={2}
            maxLength={280}
            onChange={(e) => setDescription(e.target.value)}
            className="w-full min-w-0 resize-y rounded-md border border-line-strong bg-surface px-2.5 py-2 text-base text-fg transition-colors duration-[120ms] placeholder:text-fg-subtle hover:border-line-control focus-visible:border-focus"
          />
        </Field>

        <fieldset className="min-w-0">
          <legend className="text-sm font-medium text-fg">
            Skills, in install order <span className="font-normal text-fg-subtle tabular">({list.length} of at most {MAX_SKILLS})</span>
          </legend>
          {list.length === 0 ? (
            <p className="mt-2 rounded-md border border-dashed border-line-strong px-3 py-4 text-sm text-fg-muted">No skills yet. Add the first one below.</p>
          ) : (
            <ol className="mt-2 border-y border-line">
              {list.map((name, i) => (
                <li key={name} className="flex items-center gap-3 border-b border-line py-2 pl-1 last:border-b-0 md:pl-3">
                  <span className="w-6 shrink-0 font-mono text-sm text-fg-subtle tabular">{String(i + 1).padStart(2, "0")}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-sm font-medium text-fg">{name}</p>
                    <p className="truncate text-sm text-fg-muted">{byName.get(name)?.description ?? " "}</p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <IconButton label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" aria-hidden />
                    </IconButton>
                    <IconButton label={`Move ${name} down`} disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" aria-hidden />
                    </IconButton>
                    <IconButton label={`Remove ${name}`} onClick={() => setList((l) => l.filter((x) => x !== name))} className="hover:text-danger-text">
                      <X className="size-4" aria-hidden />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ol>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="col-add" className="sr-only">
              Skill to add
            </label>
            <Select id="col-add" value={adding} onChange={(e) => setAdding(e.target.value)} disabled={full || available.length === 0} className="min-w-0 flex-1 sm:max-w-sm">
              <option value="">{available.length === 0 ? "Every skill is already in it" : full ? `At most ${MAX_SKILLS} skills` : "Choose a skill to add"}</option>
              {available.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Button
              icon={<Plus className="size-3.5" aria-hidden />}
              disabled={!adding || full}
              onClick={() => {
                setList((l) => [...l, adding]);
                setAdding("");
              }}
            >
              Add to the end
            </Button>
          </div>
        </fieldset>

        {!!error && <InlineError error={error} />}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button type="submit" variant="primary" loading={saving} disabled={titleMissing}>
          Save changes
        </Button>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="danger" className="ml-auto" onClick={() => setConfirm(true)} disabled={saving}>
          Delete collection
        </Button>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={() => void remove()}
        danger
        busy={deleting}
        error={deleteError}
        title={`Delete ${collection.title}?`}
        description={
          <>
            <span className="font-mono">intra install {spec}</span> stops working for everyone. The skills themselves stay, and anyone who installed them keeps them.
          </>
        }
        confirmLabel="Delete collection"
      />
    </form>
  );
}

function NotFoundState({ team, slug, teamName }: { team: string; slug: string; teamName?: string }) {
  return (
    <div className={PAGE}>
      <header className="pt-8 pb-6 lg:pt-10">
        <SectionHeading as="h1" size="lg">
          This collection does not exist
        </SectionHeading>
        <p className="mt-3 font-mono text-xs text-fg-subtle">
          @{team}/{slug}
        </p>
      </header>
      <DottedRule />
      <div className="max-w-xl pt-8">
        <p className="text-base text-fg-muted">It was deleted, renamed, or never existed. Every collection a team keeps is listed on the team's page.</p>
        <Link
          to={`/teams/${encodeURIComponent(team)}`}
          className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-on-primary hover:bg-primary-hover max-md:h-11"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to {teamName ?? team}
        </Link>
      </div>
    </div>
  );
}
