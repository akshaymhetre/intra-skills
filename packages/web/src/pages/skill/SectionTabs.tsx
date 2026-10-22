// Local copy of the shared Tabs primitive (components/ui.tsx) with one change: keeping the active tab in view
// scrolls the tab row sideways only. The shared version calls scrollIntoView on mount, which also scrolls the
// PAGE when the tab row starts below the fold (the skill page on a phone loaded scrolled to y=122).
// Fold back into ui.tsx once the primitive takes the same fix.
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "../../components/ui";

export function SectionTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idBase,
}: {
  tabs: { value: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  idBase: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = () => {
    const el = listRef.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };
  useEffect(() => {
    const list = listRef.current;
    const tab = refs.current[tabs.findIndex((t) => t.value === value)];
    if (list && tab) {
      const l = tab.offsetLeft - list.offsetLeft;
      if (l < list.scrollLeft) list.scrollLeft = l;
      else if (l + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = l + tab.offsetWidth - list.clientWidth;
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, tabs.length]);
  const mask =
    edges.left && edges.right
      ? "linear-gradient(to right, transparent, black 28px, black calc(100% - 28px), transparent)"
      : edges.right
        ? "linear-gradient(to right, black calc(100% - 36px), transparent)"
        : edges.left
          ? "linear-gradient(to right, transparent, black 36px)"
          : undefined;
  const onKey = (e: KeyboardEvent, i: number) => {
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    if (next >= 0) {
      e.preventDefault();
      refs.current[next]?.focus();
      onChange(tabs[next]!.value);
    }
  };
  return (
    <div
      ref={listRef}
      onScroll={measure}
      role="tablist"
      aria-label={label}
      className="-mb-px flex gap-5 overflow-x-auto [scrollbar-width:none]"
      style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}
    >
      {tabs.map((t, i) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`${idBase}-tab-${t.value}`}
            aria-selected={active}
            aria-controls={`${idBase}-panel`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              "relative inline-flex h-11 shrink-0 items-center gap-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-[120ms]",
              active ? "text-fg" : "text-fg-muted hover:text-fg",
            )}
          >
            {t.label}
            {t.count !== undefined && <span className="text-xs text-fg-subtle tabular">{t.count}</span>}
            <span className={cx("absolute inset-x-0 bottom-0 h-0.5", active ? "bg-sel" : "bg-transparent")} />
          </button>
        );
      })}
    </div>
  );
}
