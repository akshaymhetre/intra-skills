// Command palette (Cmd/Ctrl+K): jump to a skill, stack, team, collection or page, copy a skill's
// install line, or switch the theme, all from the keyboard. Combobox + listbox with
// aria-activedescendant: focus never leaves the input. The open palette carries the beam, because
// it is where an install starts from the keyboard (design/DIRECTION.md, Motion budget).
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Copy,
  FolderGit2,
  GitPullRequest,
  Home,
  KeyRound,
  Layers,
  Library,
  Monitor,
  Moon,
  Package,
  Search,
  Settings,
  Shield,
  SlidersHorizontal,
  Sun,
  Users,
} from "lucide-react";
import type { Collection, FacetCount, SkillSummary, Team } from "@intra-skills/shared/types";
import { stackLabel } from "@intra-skills/shared/stacks";
import { api } from "../api";
import { useMe } from "../auth";
import { cx } from "../lib/cx";
import { copyText } from "../lib/useCopy";
import { useRegistryMeta } from "../lib/meta";
import { kindOf, marketplaceOf, primaryInstallCommand } from "../lib/kinds";
import { parseQuery, hasQualifiers } from "../lib/query";
import { resolvedTheme, useTheme } from "../lib/theme";
import { CommandText, Kbd } from "./ui";
import { useToast } from "./Toast";
import { TeamMark } from "./fx";

type Group = "Skills" | "Stacks" | "Teams" | "Collections" | "Pages" | "Actions";
const GROUP_ORDER: Group[] = ["Skills", "Stacks", "Teams", "Collections", "Pages", "Actions"];

interface Item {
  id: string;
  group: Group;
  label: ReactNode;
  /** Text matched against the query. */
  text: string;
  /** Extra text matched with lower weight (a description, tags). */
  extra?: string;
  hint?: ReactNode;
  icon: ReactNode;
  run: () => void;
}

interface Sources {
  skills: SkillSummary[];
  stacks: FacetCount[];
  teams: Team[];
  collections: Collection[];
}

function score(q: string, text: string, extra?: string): number {
  const t = text.toLowerCase();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  const words = t.split(/[\s\-_/@]+/);
  if (words.some((w) => w.startsWith(q))) return 60;
  if (t.includes(q)) return 40;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i++;
  if (i === q.length && q.length > 1) return 20;
  if (extra?.toLowerCase().includes(q)) return 10;
  return 0;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();
  const toast = useToast();
  const me = useMe();
  const marketplace = marketplaceOf(useRegistryMeta());
  const { set: setTheme } = useTheme();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [src, setSrc] = useState<Sources | null>(null);
  const [srcError, setSrcError] = useState(false);
  const baseId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      setQuery("");
      setActive(0);
      d.showModal();
      input.current?.focus();
      setSrcError(false);
      // Teams and collections are optional extras: a failure there must not hide the skills.
      Promise.all([
        api.listSkills({ sort: "trending" }),
        api.listTeams().catch(() => [] as Team[]),
        api.listCollections().catch(() => [] as Collection[]),
      ]).then(
        ([s, teams, collections]) => setSrc({ skills: s.skills, stacks: s.facets.stacks, teams, collections }),
        () => setSrcError(true),
      );
    }
    if (!open && d.open) {
      d.close();
      returnTo.current?.focus?.();
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => navigate(to);
    const admin = me.role === "admin";
    const page = (id: string, label: string, to: string, text: string, icon: ReactNode): Item => ({ id: `p-${id}`, group: "Pages", label, text: `${label} ${text}`, icon, run: go(to) });
    const pages: Item[] = [
      page("home", "Home", "/", "start dashboard", <Home />),
      page("skills", "Skills", "/skills", "catalog search browse", <Package />),
      page("stacks", "Stacks", "/stacks", "technology", <Layers />),
      page("teams", "Teams", "/teams", "people groups", <Users />),
      page("proposals", "Proposals", "/proposals", "pull requests prs", <GitPullRequest />),
      page("get-started", "Get started", "/get-started", "setup install cli onboarding", <BookOpen />),
      page("activity", "Activity", "/activity", "audit log history", <Activity />),
      page("settings", "Settings", "/settings", "tokens profile git identity", <Settings />),
      ...(admin
        ? [
            page("review", "Review", "/admin/review", "admin verify queue", <BadgeCheck />),
            page("repositories", "Repositories", "/admin/repositories", "admin git sources github bitbucket", <FolderGit2 />),
            page("members", "Members", "/admin/members", "admin users people", <Shield />),
            page("registry", "Registry", "/admin/registry", "admin settings org url", <SlidersHorizontal />),
          ]
        : []),
    ];

    const next = resolvedTheme() === "dark" ? "light" : "dark";
    const actions: Item[] = [
      { id: "a-token", group: "Actions", label: "Create an API token", text: "create api token new key", icon: <KeyRound />, run: go("/settings?create=token") },
      { id: "a-theme", group: "Actions", label: `Switch to the ${next} theme`, text: `switch theme ${next} mode appearance`, icon: next === "dark" ? <Moon /> : <Sun />, run: () => setTheme(next) },
      { id: "a-system", group: "Actions", label: "Follow the system theme", text: "system theme appearance", icon: <Monitor />, run: () => setTheme("system") },
    ];

    const s = src;
    const skillItems: Item[] = (s?.skills ?? []).map((k) => ({
      id: `s-${k.name}`,
      group: "Skills",
      label: <span className="font-mono">{k.name}</span>,
      text: k.name,
      extra: `${k.description} ${k.tags.join(" ")} ${k.stacks.join(" ")}`,
      hint: <span className="truncate">{k.description}</span>,
      icon: <Package />,
      run: go(`/skills/${encodeURIComponent(k.name)}`),
    }));
    const stackItems: Item[] = (s?.stacks ?? []).map((f) => ({
      id: `k-${f.value}`,
      group: "Stacks",
      label: stackLabel(f.value),
      text: `${stackLabel(f.value)} ${f.value}`,
      hint: <span className="font-mono">{f.count}</span>,
      icon: <Layers />,
      run: go(`/stacks/${encodeURIComponent(f.value)}`),
    }));
    const teamItems: Item[] = (s?.teams ?? []).map((t) => ({
      id: `t-${t.slug}`,
      group: "Teams",
      label: t.name,
      text: `${t.name} ${t.slug}`,
      extra: t.description,
      hint: <span className="truncate">{t.description}</span>,
      icon: <TeamMark slug={t.slug} name={t.name} size={16} />,
      run: go(`/teams/${encodeURIComponent(t.slug)}`),
    }));
    const collectionItems: Item[] = (s?.collections ?? []).map((c) => ({
      id: `c-${c.team}/${c.slug}`,
      group: "Collections",
      label: c.title,
      text: `${c.title} @${c.team}/${c.slug}`,
      extra: `${c.description} ${c.skills.join(" ")}`,
      hint: <span className="truncate font-mono">@{c.team}/{c.slug}</span>,
      icon: <Library />,
      run: go(`/collections/${encodeURIComponent(c.team)}/${encodeURIComponent(c.slug)}`),
    }));
    const copyItem = (name: string): Item => ({
      id: `i-${name}`,
      group: "Actions",
      label: (
        <>
          Copy install command for <span className="font-mono">{name}</span>
        </>
      ),
      text: `copy install ${name}`,
      icon: <Copy />,
      run: () => {
        const found = s?.skills.find((k) => k.name === name);
        const cmd = primaryInstallCommand(name, found ? kindOf(found) : "skill", marketplace);
        void copyText(cmd).then(() =>
          toast({
            message: (
              <>
                Copied <CommandText command={cmd} className="text-[0.93em]" />
              </>
            ),
          }),
        );
      },
    });

    const raw = query.trim();
    const q = raw.toLowerCase();
    const searchItem: Item = {
      id: "a-search",
      group: "Actions",
      label: (
        <>
          Search skills for <span className="font-mono whitespace-nowrap">{raw}</span>
        </>
      ),
      text: q,
      icon: <Search />,
      run: go(`/skills?q=${encodeURIComponent(raw)}`),
    };

    // Nothing typed: the trending skills, then where to go, then what to do.
    if (!q) return [...skillItems.slice(0, 5), ...pages.slice(0, 6), ...actions.slice(0, 2)];
    // A frontmatter query (`stack:terraform`) is a catalog search, nothing else.
    if (hasQualifiers(parseQuery(raw))) return [searchItem];

    const rank = (arr: Item[], max: number) =>
      arr
        .map((i) => ({ i, s: score(q, i.text, i.extra) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, max)
        .map((x) => x.i);
    const matchedSkills = rank(skillItems, 6);
    // "copy install x" types straight to the action; otherwise offer it for the best skill matches.
    const copyMatches = q.startsWith("copy") || q.startsWith("install") ? rank(skillItems.map((i) => copyItem(i.text)), 5) : matchedSkills.slice(0, 2).map((i) => copyItem(i.text));
    return [
      ...matchedSkills,
      ...rank(stackItems, 4),
      ...rank(teamItems, 4),
      ...rank(collectionItems, 4),
      ...rank(pages, 5),
      ...copyMatches,
      ...rank(actions, 3),
      searchItem,
    ];
  }, [src, query, me.role, navigate, setTheme, toast, marketplace]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const run = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  // Items are already grouped in display order; keep a flat index for keyboard movement.
  const groups: { name: Group; items: { item: Item; index: number }[] }[] = [];
  items.forEach((item, index) => {
    let g = groups.find((x) => x.name === item.group);
    if (!g) groups.push((g = { name: item.group, items: [] }));
    g.items.push({ item, index });
  });
  groups.sort((a, b) => GROUP_ORDER.indexOf(a.name) - GROUP_ORDER.indexOf(b.name));
  const ordered = groups.flatMap((g) => g.items);
  const position = (index: number) => ordered.findIndex((x) => x.index === index);
  const at = (pos: number) => ordered[pos]?.index ?? 0;
  const optId = (i: number) => `${baseId}-opt-${i}`;
  const loading = !src && !srcError;

  return (
    <dialog
      ref={ref}
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className="mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-[620px] overflow-visible border-0 bg-transparent p-0 text-fg max-sm:mt-3"
    >
      {open && (
        <div className="float-in beam flex max-h-[min(580px,76vh)] flex-col rounded-xl border border-line bg-surface shadow-float">
          <div className="flex items-center gap-3 border-b border-line px-4">
            <span aria-hidden className="font-mono text-sm text-sel-text select-none">
              &gt;
            </span>
            <input
              ref={input}
              role="combobox"
              aria-expanded="true"
              aria-controls={`${baseId}-list`}
              aria-activedescendant={items.length ? optId(active) : undefined}
              aria-autocomplete="list"
              aria-label="Jump to a skill, stack, team, collection or page"
              placeholder="Jump to a skill, stack, team or page"
              value={query}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const pos = position(active);
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setActive(at(Math.min(ordered.length - 1, pos + 1)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setActive(at(Math.max(0, pos - 1)));
                } else if (e.key === "Home" && e.ctrlKey) {
                  setActive(at(0));
                } else if (e.key === "End" && e.ctrlKey) {
                  setActive(at(ordered.length - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  run(items[active]);
                }
              }}
              className="h-13 min-w-0 flex-1 bg-transparent text-base text-fg caret-sel outline-none placeholder:text-fg-subtle focus-visible:outline-none max-sm:text-[16px]"
            />
            <Kbd className="max-sm:hidden">Esc</Kbd>
          </div>
          <div ref={list} id={`${baseId}-list`} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
            {groups.map((g) => (
              <div key={g.name} role="group" aria-labelledby={`${baseId}-g-${g.name}`} className="mb-1 last:mb-0">
                <div id={`${baseId}-g-${g.name}`} className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-fg-subtle">
                  {g.name}
                </div>
                {g.items.map(({ item, index }) => {
                  const on = index === active;
                  return (
                    <div
                      key={item.id}
                      id={optId(index)}
                      data-index={index}
                      role="option"
                      aria-selected={on}
                      onMouseMove={() => !on && setActive(index)}
                      onClick={() => run(item)}
                      className={cx(
                        "relative flex h-9 items-center gap-3 rounded-md px-2.5 text-sm select-none max-sm:h-11",
                        on ? "bg-surface-2 text-fg before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sel-fill" : "text-fg",
                      )}
                    >
                      <span className={cx("flex size-4 shrink-0 items-center justify-center [&_svg]:size-4", on ? "text-fg" : "text-fg-subtle")} aria-hidden>
                        {item.icon}
                      </span>
                      <span className={cx("min-w-0 truncate", item.hint ? "max-w-[60%] shrink-0 max-sm:max-w-none max-sm:shrink" : "shrink")}>{item.label}</span>
                      {item.hint && <span className="flex min-w-0 flex-1 text-fg-subtle max-sm:hidden">{item.hint}</span>}
                      {on && <ArrowRight className="ml-auto size-3.5 shrink-0 text-fg-muted" aria-hidden />}
                    </div>
                  );
                })}
              </div>
            ))}
            {loading && !query && <p className="px-2.5 py-2 text-sm text-fg-subtle">Loading skills, stacks and teams</p>}
            {srcError && <p className="px-2.5 py-2 text-sm text-fg-subtle">Skills did not load. Pages and actions still work.</p>}
          </div>
          <div className="flex items-center gap-4 border-t border-line px-4 py-2 text-xs text-fg-subtle max-sm:hidden">
            <span className="flex items-center gap-1.5">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span className="flex items-center gap-1.5">
              <Kbd>Enter</Kbd> open
            </span>
            <span className="ml-auto">
              Type <span className="font-mono text-fg-muted">stack:terraform</span> to search the catalog
            </span>
          </div>
        </div>
      )}
    </dialog>
  );
}
