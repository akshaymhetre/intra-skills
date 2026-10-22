import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, Outlet, useLocation, useMatches, useNavigate } from "react-router";
import { ChevronRight, LogOut, Menu as MenuIcon, Monitor, Moon, Search, Sun, X } from "lucide-react";
import { useAuth, useMe } from "../auth";
import { cx } from "../lib/cx";
import { useTheme } from "../lib/theme";
import { useRegistryMeta } from "../lib/meta";
import { Kbd, Menu } from "./ui";
import { PersonMark, Wordmark } from "./fx";
import { CommandPalette } from "./CommandPalette";

export interface Crumb {
  label: ReactNode;
  to?: string;
}
export interface RouteHandle {
  crumbs?: (params: Record<string, string | undefined>) => Crumb[];
}

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";

/** The wordmark, carrying the org's registry name when an admin set one. */
export function Logo({ className }: { className?: string }) {
  const meta = useRegistryMeta();
  return <Wordmark className={className} name={meta?.name || "intra-skills"} />;
}

/**
 * Type-led navigation: no icons, the label is enough. `match` lists the path prefixes that keep the item
 * current, so a skill page still marks Skills and a team page still marks Teams.
 */
function NavItem({ to, match, children }: { to: string; match: string[]; children: ReactNode }) {
  const { pathname } = useLocation();
  const active = match.some((m) => (m === "/" ? pathname === "/" : pathname === m || pathname.startsWith(m + "/")));
  return (
    <Link
      to={to}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative flex h-8 items-center rounded-md px-2.5 text-sm transition-colors duration-[120ms] max-[899px]:h-11",
        active
          ? "bg-surface-3 font-medium text-fg before:absolute before:inset-y-1.5 before:-left-2.5 before:w-0.5 before:rounded-r-sm before:bg-sel"
          : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {children}
    </Link>
  );
}

function ThemeMenu() {
  const { pref, set } = useTheme();
  const Icon = pref === "light" ? Sun : pref === "dark" ? Moon : Monitor;
  return (
    <Menu
      label={`Theme: ${pref}`}
      trigger={<Icon className="size-4" aria-hidden />}
      triggerClassName="size-8"
      items={[
        { label: "System", checked: pref === "system", onSelect: () => set("system") },
        { label: "Light", checked: pref === "light", onSelect: () => set("light") },
        { label: "Dark", checked: pref === "dark", onSelect: () => set("dark") },
      ]}
    />
  );
}

function RailContent({ onNavigate }: { onNavigate?: () => void }) {
  const me = useMe();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col" onClick={(e) => (e.target as HTMLElement).closest("a") && onNavigate?.()}>
      <div className="flex h-12 shrink-0 items-center px-5 max-[899px]:h-14">
        <Link to="/" aria-label="Home" className="inline-flex h-8 items-center rounded-sm">
          <Logo />
        </Link>
      </div>
      <nav aria-label="Main" className="flex flex-1 flex-col gap-px overflow-y-auto px-2.5 pt-3">
        <NavItem to="/" match={["/"]}>
          Home
        </NavItem>
        <NavItem to="/skills" match={["/skills"]}>
          Skills
        </NavItem>
        <NavItem to="/stacks" match={["/stacks"]}>
          Stacks
        </NavItem>
        <NavItem to="/teams" match={["/teams", "/collections"]}>
          Teams
        </NavItem>
        <NavItem to="/proposals" match={["/proposals"]}>
          Proposals
        </NavItem>
        <NavItem to="/activity" match={["/activity"]}>
          Activity
        </NavItem>
        <div className="mt-6 mb-1 px-2.5 text-xs text-fg-subtle">You</div>
        <NavItem to="/get-started" match={["/get-started"]}>
          Get started
        </NavItem>
        <NavItem to="/settings" match={["/settings"]}>
          Settings
        </NavItem>
        {me.role === "admin" && (
          <>
            <div className="mt-6 mb-1 px-2.5 text-xs text-fg-subtle">Admin</div>
            <NavItem to="/admin/review" match={["/admin/review"]}>
              Review
            </NavItem>
            <NavItem to="/admin/repositories" match={["/admin/repositories"]}>
              Repositories
            </NavItem>
            <NavItem to="/admin/members" match={["/admin/members"]}>
              Members
            </NavItem>
            <NavItem to="/admin/registry" match={["/admin/registry"]}>
              Registry
            </NavItem>
          </>
        )}
      </nav>
      <div className="flex items-center gap-2.5 border-t border-line px-4 py-3">
        <PersonMark handle={me.handle} name={me.displayName} size={28} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate text-sm font-medium">{me.displayName}</div>
          <div className="truncate text-xs text-fg-subtle">
            @{me.handle}
            {me.role === "admin" && <span> (admin)</span>}
          </div>
        </div>
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={async () => {
            await signOut();
            navigate("/signin", { replace: true });
          }}
          className="inline-flex size-8 items-center justify-center rounded-md text-fg-subtle transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg max-[899px]:size-11"
        >
          <LogOut className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Breadcrumb only at depth 2 and below; a top-level page's h1 already says where you are. */
function Breadcrumbs() {
  const matches = useMatches();
  const crumbs: Crumb[] = [];
  for (const m of matches) {
    const h = m.handle as RouteHandle | undefined;
    if (h?.crumbs) crumbs.push(...h.crumbs(m.params));
  }
  if (crumbs.length < 2) return null;
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <li key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />}
              {c.to && !last ? (
                <Link to={c.to} className="truncate rounded-sm text-fg-muted hover:text-fg">
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className="truncate text-fg">
                  {c.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function isTyping(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

export function Shell() {
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const loc = useLocation();
  const drawerRef = useRef<HTMLDialogElement>(null);

  useEffect(() => setDrawer(false), [loc.pathname]);

  useEffect(() => {
    const d = drawerRef.current;
    if (!d) return;
    if (drawer && !d.open) d.showModal();
    if (!drawer && d.open) d.close();
  }, [drawer]);

  const openPalette = useCallback(() => setPalette(true), []);

  // Cmd/Ctrl+K opens the palette anywhere. `/` focuses the page's query field when it has one
  // (the catalog), otherwise opens the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (document.querySelector("dialog[open]")) return;
      e.preventDefault();
      const field = document.querySelector<HTMLInputElement>("[data-query-input]");
      if (field) {
        field.focus();
        field.setSelectionRange(field.value.length, field.value.length);
      } else setPalette(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="min-h-dvh min-[900px]:grid min-[900px]:grid-cols-[224px_minmax(0,1fr)]">
      <a
        href="#main"
        className="fixed top-2 left-2 z-[70] inline-flex min-h-11 -translate-y-20 items-center rounded-md bg-primary px-3 text-sm font-medium text-on-primary focus:translate-y-0"
      >
        Skip to content
      </a>
      {/* The column carries the panel colour and border for the full page height; the rail inside stays pinned. */}
      <div className="hidden border-r border-line bg-panel min-[900px]:block">
        <aside className="sticky top-0 h-dvh">
          <RailContent />
        </aside>
      </div>

      <dialog
        ref={drawerRef}
        aria-label="Navigation"
        onCancel={(e) => {
          e.preventDefault();
          setDrawer(false);
        }}
        onClick={(e) => e.target === drawerRef.current && setDrawer(false)}
        className="m-0 h-dvh max-h-dvh w-[280px] max-w-[85vw] border-r border-line bg-panel p-0 text-fg shadow-float min-[900px]:hidden"
      >
        {drawer && (
          <div className="fade-in relative flex h-full flex-col">
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setDrawer(false)}
              className="absolute top-1.5 right-1.5 inline-flex size-11 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2"
            >
              <X className="size-4" aria-hidden />
            </button>
            <RailContent onNavigate={() => setDrawer(false)} />
          </div>
        )}
      </dialog>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-bg px-3 max-[899px]:h-14 min-[900px]:px-5">
          <button
            type="button"
            aria-label="Open navigation"
            onClick={() => setDrawer(true)}
            className="inline-flex size-11 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 min-[900px]:hidden"
          >
            <MenuIcon className="size-5" aria-hidden />
          </button>
          <Link to="/" className="inline-flex h-11 items-center rounded-sm min-[900px]:hidden" aria-label="Home">
            <Logo />
          </Link>
          <div className="min-w-0 flex-1 max-[899px]:hidden">
            <Breadcrumbs />
          </div>
          <div className="flex flex-1 items-center justify-end gap-2 min-[900px]:flex-none">
            <button
              type="button"
              onClick={openPalette}
              aria-label="Search skills and pages"
              aria-keyshortcuts="Meta+K Control+K"
              className="inline-flex h-8 items-center gap-2 rounded-md border border-line-strong bg-surface pr-1.5 pl-2.5 text-sm text-fg-subtle transition-colors duration-[120ms] hover:border-line-control hover:text-fg-muted max-[899px]:size-11 max-[899px]:justify-center max-[899px]:border-transparent max-[899px]:bg-transparent max-[899px]:p-0 min-[900px]:w-[260px]"
            >
              <Search className="size-4 shrink-0" aria-hidden />
              <span className="flex-1 text-left max-[899px]:sr-only">Search or jump to…</span>
              <span className="flex items-center gap-0.5 max-[899px]:hidden">
                <Kbd>{MOD_KEY}</Kbd>
                <Kbd>K</Kbd>
              </span>
            </button>
            <ThemeMenu />
          </div>
        </header>
        <main id="main" className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
