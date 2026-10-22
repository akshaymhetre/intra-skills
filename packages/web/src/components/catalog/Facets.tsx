// The catalog's facet rail. First `kind` (skill, plugin, rule), shown only once the registry holds more
// than skills. Then each group is labelled with the key exactly as a SKILL.md writes it
// (`team`, `stacks`, `areas`, `tools`, `tags`), then the registry's own facts (`visibility`, `health`,
// `verified`, `deprecated`). Clicking a value writes its qualifier into the query, so the rail and the
// query field are two views of the same text.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { TOOL_DIRS, type FacetCount, type SkillListResponse, type ToolId } from "@intra-skills/shared/types";
import { stackLabel } from "@intra-skills/shared/stacks";
import type { DeprecatedMode, FacetKey, FrontmatterQuery } from "../../lib/query";
import { cx } from "../../lib/cx";
import { formatNumber } from "../../lib/format";
import { Button, Skeleton } from "../ui";
import { KIND_LABELS } from "../../lib/kinds";

export function FacetRail({
  facets,
  query,
  teamName,
  onToggle,
  onDeprecated,
}: {
  facets: SkillListResponse["facets"];
  query: FrontmatterQuery;
  teamName: (slug: string) => string;
  onToggle: (k: FacetKey | "is", v: string) => void;
  onDeprecated: (mode: Exclude<DeprecatedMode, "include">) => void;
}) {
  // A registry of skills alone has nothing to choose between, so the group stays out of the way.
  const order = ["skill", "plugin", "rule"];
  const kinds = [...(facets.kinds ?? [])].sort((a, b) => order.indexOf(a.value) - order.indexOf(b.value));
  const showKinds = kinds.some((k) => k.value !== "skill") || query.kind.length > 0;
  return (
    <div className="flex flex-col gap-6">
      {showKinds && (
        <FacetGroup
          k="kind"
          qualifier="kind"
          items={kinds}
          selected={query.kind}
          label={(v) => KIND_LABELS[v as keyof typeof KIND_LABELS] ?? v}
          onToggle={(v) => onToggle("kind", v)}
        />
      )}
      <FacetGroup k="team" qualifier="team" items={facets.teams} selected={query.team} label={teamName} onToggle={(v) => onToggle("team", v)} />
      <FacetGroup k="stacks" qualifier="stack" items={facets.stacks} selected={query.stack} label={stackLabel} limit={8} onToggle={(v) => onToggle("stack", v)} />
      <FacetGroup k="areas" qualifier="area" items={facets.areas} selected={query.area} limit={8} onToggle={(v) => onToggle("area", v)} />
      <FacetGroup
        k="tools"
        qualifier="tool"
        items={facets.tools}
        selected={query.tool}
        label={(v) => TOOL_DIRS[v as ToolId]?.label ?? v}
        onToggle={(v) => onToggle("tool", v)}
      />
      <FacetGroup k="tags" qualifier="tag" items={facets.tags} selected={query.tag} limit={8} onToggle={(v) => onToggle("tag", v)} />
      <FacetGroup
        k="visibility"
        qualifier="is"
        items={facets.visibility}
        selected={query.visibility}
        label={(v) => (v === "private" ? "Private" : v === "org" ? "Whole org" : v)}
        onToggle={(v) => onToggle("is", v)}
      />
      <Group k="health">
        <FacetValue on={query.health === "active"} onClick={() => onToggle("is", "active")} qualifier="is:active">
          Active
        </FacetValue>
        <FacetValue on={query.health === "stale"} onClick={() => onToggle("is", "stale")} qualifier="is:stale">
          Stale
        </FacetValue>
      </Group>
      <Group k="verified">
        <FacetValue on={query.verified} onClick={() => onToggle("is", "verified")} qualifier="is:verified">
          Verified only
        </FacetValue>
      </Group>
      <Group k="deprecated">
        <FacetValue on={query.deprecated === "exclude"} onClick={() => onDeprecated("exclude")} qualifier="-is:deprecated">
          Hide
        </FacetValue>
        <FacetValue on={query.deprecated === "only"} onClick={() => onDeprecated("only")} qualifier="is:deprecated">
          Only deprecated
        </FacetValue>
      </Group>
    </div>
  );
}

function Group({ k, children, footer }: { k: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1.5 px-2 font-mono text-xs text-fg-subtle">{k}</legend>
      <ul className="flex flex-col">{children}</ul>
      {footer}
    </fieldset>
  );
}

function FacetGroup({
  k,
  qualifier,
  items,
  selected,
  label = (v) => v,
  onToggle,
  limit,
}: {
  /** The frontmatter key, printed as the group's label. */
  k: string;
  /** The qualifier a value writes into the query. */
  qualifier: string;
  items: FacetCount[];
  selected: string[];
  label?: (v: string) => ReactNode;
  onToggle: (v: string) => void;
  limit?: number;
}) {
  const [all, setAll] = useState(false);
  // A selected value always stays visible, even when other filters took its count to zero.
  const merged = [...items];
  for (const v of selected) if (!merged.some((i) => i.value === v)) merged.push({ value: v, count: 0 });
  if (!merged.length) return null;
  const head = limit && !all ? merged.slice(0, limit) : merged;
  const shown = [...head, ...merged.filter((i) => !head.includes(i) && selected.includes(i.value))];
  return (
    <Group
      k={k}
      footer={
        limit && merged.length > limit ? (
          <button
            type="button"
            onClick={() => setAll((a) => !a)}
            aria-expanded={all}
            className="mt-0.5 h-7 rounded-sm px-2 text-sm text-fg-muted underline decoration-line-control underline-offset-4 transition-colors duration-[120ms] hover:text-fg max-[899px]:h-11"
          >
            {all ? "Show fewer" : `Show all ${merged.length}`}
          </button>
        ) : null
      }
    >
      {shown.map((i) => (
        <FacetValue key={i.value} on={selected.includes(i.value)} onClick={() => onToggle(i.value)} count={i.count} qualifier={`${qualifier}:${i.value}`}>
          {label(i.value)}
        </FacetValue>
      ))}
    </Group>
  );
}

function FacetValue({ on, onClick, count, qualifier, children }: { on: boolean; onClick: () => void; count?: number; qualifier: string; children: ReactNode }) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={on}
        title={on ? `Remove ${qualifier}` : `Add ${qualifier}`}
        onClick={onClick}
        className={cx(
          "relative flex h-7 w-full items-center gap-2 rounded-[4px] px-2 text-left text-sm transition-colors duration-[120ms] hover:bg-surface-2 max-[899px]:h-11",
          on ? "font-medium text-fg before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-sel-fill" : "text-fg-muted hover:text-fg",
        )}
      >
        <span className="min-w-0 truncate">{children}</span>
        <span aria-hidden className="flex flex-1 items-center text-sel-text">
          {on && <Check className="size-3.5" strokeWidth={2.25} />}
        </span>
        {count !== undefined && <span className={cx("font-mono text-xs font-normal tabular", on ? "text-fg-muted" : "text-fg-subtle")}>{count}</span>}
      </button>
    </li>
  );
}

export function FacetSkeleton() {
  return (
    <div className="flex flex-col gap-7" aria-hidden>
      {[4, 6, 5, 3].map((n, g) => (
        <div key={g} className="flex flex-col gap-3 px-2">
          <Skeleton className="h-3 w-14" />
          {Array.from({ length: n }, (_, i) => (
            <Skeleton key={i} className="h-3.5" />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Phones and narrow windows: the same rail in a bottom sheet. */
export function FilterSheet({
  open,
  onClose,
  total,
  noun = (n: number) => (n === 1 ? "skill" : "skills"),
  onClear,
  canClear,
  children,
}: {
  open: boolean;
  onClose: () => void;
  total: number;
  noun?: (n: number) => string;
  onClear: () => void;
  canClear: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      d.showModal();
    }
    if (!open && d.open) {
      d.close();
      returnTo.current?.focus?.();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby="filter-sheet-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className="mx-0 mt-auto mb-0 max-h-[85dvh] w-full max-w-none rounded-t-xl border-t border-line bg-surface p-0 text-fg shadow-float min-[900px]:hidden"
    >
      {open && (
        <div className="sheet-in flex max-h-[85dvh] flex-col">
          <div className="flex items-center justify-between border-b border-line py-1.5 pr-1.5 pl-5">
            <h2 id="filter-sheet-title" className="text-lg font-semibold">
              Filter
            </h2>
            <div className="flex items-center">
              {canClear && (
                <Button variant="ghost" onClick={onClear}>
                  Clear filters
                </Button>
              )}
              <button type="button" autoFocus aria-label="Close filters" onClick={onClose} className="inline-flex size-11 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2">
                <X className="size-4" aria-hidden />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4">{children}</div>
          <div className="border-t border-line px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <Button variant="primary" size="lg" className="w-full" onClick={onClose}>
              Show {formatNumber(total)} {noun(total)}
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}
