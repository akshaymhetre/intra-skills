// Shared pieces for the admin and account pages (Teams, Members, Settings, Activity).
// Tables here follow references/app-ui.md: text left, numbers right, tabular figures, 40 px rows
// (44 px on touch), one visible action plus an overflow menu, and on phones each row becomes a
// stacked composition of its own instead of a table squeezed sideways.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, TriangleAlert } from "lucide-react";
import type { User } from "@intra-skills/shared/types";
import { CopyCommand, Skeleton, cx } from "../../components/ui";
import { PersonMark } from "../../components/fx";
import { useRegistryMeta } from "../../lib/meta";

export { useDocTitle } from "../../lib/meta";

// ---------- tables ----------

/** Cell padding: the first and last cell line up with SkillRow's inset, inside the page column. */
export const CELL = "px-3 first:pl-1 last:pr-1 md:first:pl-3 md:last:pr-3";
export const TH = cx(CELL, "h-9 text-left align-middle text-xs font-medium whitespace-nowrap text-fg-subtle");
export const TD = cx(CELL, "h-10 align-middle");
/** Row hover only on devices that hover (Tailwind v4 wraps `hover:` in `@media (hover:hover)`). */
export const TR = "border-b border-line last:border-b-0 transition-colors duration-[120ms] hover:bg-surface-2/60";

/** `stackBelow="lg"` keeps the stacked phone composition up to 1023px, for tables too wide for a tablet. */
export function TableFrame({ children, label, busy, stackBelow = "md" }: { children: ReactNode; label: string; busy?: boolean; stackBelow?: "md" | "lg" }) {
  return (
    <div className={cx("border-y border-line", busy && "opacity-60 transition-opacity duration-[120ms]")}>
      <table
        aria-label={label}
        className={cx("w-full border-collapse text-sm", stackBelow === "md" ? "max-md:block max-md:[&>tbody]:block" : "max-lg:block max-lg:[&>tbody]:block")}
      >
        {children}
      </table>
    </div>
  );
}

/** Skeleton rows shaped like the real ones; widths are fractions of each column so nothing shifts when data lands. */
export function SkeletonRows({ widths, rows = 5, mobile }: { widths: string[]; rows?: number; mobile?: ReactNode }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden className="border-b border-line last:border-b-0">
          {widths.map((w, c) => (
            <td key={c} className={cx(TD, c > 0 && "max-md:hidden")}>
              {c === 0 && mobile ? (
                <>
                  <span className="md:hidden">{mobile}</span>
                  <Skeleton className={cx("h-3 max-md:hidden", w)} />
                </>
              ) : (
                <Skeleton className={cx("h-3", w, c > 0 && "ml-auto md:ml-0")} />
              )}
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------- sections ----------

export function SectionHead({ id, title, count, children, description }: { id: string; title: string; count?: number; children?: ReactNode; description?: ReactNode }) {
  return (
    <div className={cx("flex flex-wrap justify-between gap-x-6 gap-y-3 pt-8 pb-4", description ? "items-end" : "items-center")}>
      <div className="min-w-0">
        <h2 id={id} className="display text-xl">
          {title}
          {count !== undefined && <span className="ml-2 font-normal text-fg-subtle tabular">{count}</span>}
        </h2>
        {description && <p className="mt-0.5 max-w-[62ch] text-sm text-fg-muted">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

// ---------- people ----------

/**
 * Combobox over people (WAI-ARIA 1.2 combobox with a listbox popup). Type a name or a handle;
 * arrows move, Enter picks, Escape closes. `value` is a handle or "".
 */
export function PersonCombobox({
  people,
  value,
  onChange,
  id,
  disabled,
  placeholder = "Name or handle",
  className,
}: {
  people: User[];
  value: string;
  onChange: (handle: string) => void;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const listId = `${inputId}-list`;
  const picked = people.find((p) => p.handle === value);
  const [text, setText] = useState(picked?.displayName ?? "");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!value) setText("");
  }, [value]);

  const matches = useMemo(() => {
    const q = text.trim().toLowerCase().replace(/^@/, "");
    const list = picked && text === picked.displayName ? people : people.filter((p) => !q || p.displayName.toLowerCase().includes(q) || p.handle.includes(q));
    return list.slice(0, 8);
  }, [people, text, picked]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const choose = (p: User) => {
    onChange(p.handle);
    setText(p.displayName);
    setOpen(false);
  };

  return (
    <div ref={wrap} className={cx("relative min-w-0", className)}>
      <input
        id={inputId}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${matches[active]!.handle}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={text}
        placeholder={placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
          setOpen(true);
          if (value) onChange("");
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, matches.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && open && matches[active]) {
            e.preventDefault();
            choose(matches[active]!);
          } else if (e.key === "Escape" && open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className="h-8 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-fg placeholder:text-fg-subtle transition-colors duration-[120ms] hover:border-line-control focus-visible:border-focus disabled:opacity-60 max-md:min-h-11"
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label="People"
          className="float-in absolute inset-x-0 top-[calc(100%+4px)] z-40 max-h-72 overflow-y-auto rounded-md border border-line bg-surface p-1 shadow-float"
        >
          {matches.length === 0 ? (
            <li role="presentation" className="px-2 py-2 text-sm text-fg-subtle">
              {people.length ? `Nobody matches "${text.trim()}"` : "Everyone is already on this team"}
            </li>
          ) : (
            matches.map((p, i) => (
              <li
                key={p.handle}
                id={`${listId}-${p.handle}`}
                role="option"
                aria-selected={p.handle === value}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                onMouseMove={() => setActive(i)}
                className={cx(
                  "flex h-9 items-center gap-2 rounded-[4px] px-2 text-sm max-md:h-11",
                  i === active ? "bg-surface-2 text-fg" : "text-fg",
                )}
              >
                <PersonMark handle={p.handle} name={p.displayName} size={20} />
                <span className="min-w-0 truncate">{p.displayName}</span>
                <span className="min-w-0 truncate font-mono text-xs text-fg-subtle">{p.handle}</span>
                {p.handle === value && <Check className="ml-auto size-3.5 shrink-0 text-fg-muted" aria-hidden />}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ---------- tokens ----------

/** Tokens are one long word: let them break anywhere rather than push the dialog wider than a phone. */
const WRAP_ANYWHERE = "[&_code]:[overflow-wrap:anywhere] [&_code>span:last-child>span]:whitespace-normal";

/**
 * A freshly minted token, shown once. The warning comes first; the token and a ready-to-run login
 * command follow, each with a copy action.
 */
export function TokenReveal({ token, who }: { token: string; who?: string }) {
  const meta = useRegistryMeta();
  const origin = meta?.publicUrl ?? window.location.origin;
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-2 rounded-md border border-warning-line bg-warning-soft px-3 py-2.5 text-sm text-warning-text">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          <strong className="font-semibold">You will not see this token again.</strong> Copy it now{who ? ` and send it to ${who} over a private channel` : ""}.
          The registry keeps only a hash of it.
        </span>
      </p>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Token</p>
        <CopyCommand command={token} label="Copy token" className={WRAP_ANYWHERE} />
      </div>
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium">Sign in from a terminal</p>
        <CopyCommand command={`intra login --registry ${origin} --token ${token}`} label="Copy login command" className={WRAP_ANYWHERE} />
      </div>
    </div>
  );
}
