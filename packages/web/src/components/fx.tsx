// v2 visual primitives: the wordmark, people and team marks, trust and health marks, the
// sparkline, section headings with one marked word, and the spotlight tile. Effects are CSS
// classes in styles.css (.beam, .spotlight, .lift, .rule-dots, .mark-word); these components
// only arrange them. Spec: design/DIRECTION.md.
import { useCallback, type CSSProperties, type ElementType, type PointerEvent, type ReactNode } from "react";
import { BadgeCheck, CircleDot } from "lucide-react";
import type { Health, Trust } from "@intra-skills/shared/types";
import { cx } from "../lib/cx";

// ---------- wordmark ----------

/** `> intra-skills` with the amber block cursor: the terminal where every install happens. */
export function Wordmark({ className, name = "intra-skills" }: { className?: string; name?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 font-mono text-[15px] font-medium tracking-[-0.02em] text-fg", className)}>
      <span aria-hidden className="text-fg-subtle">
        &gt;
      </span>
      <span>{name}</span>
      <span aria-hidden className="cursor-block" />
    </span>
  );
}

// ---------- people and teams ----------

// Low-chroma grounds spread in hue and lightness so neighbouring people are told apart in
// greyscale too. They never reach the amber signal's chroma.
const PERSON_TONES = [
  ["#efe3d6", "#6b4f33"],
  ["#dfe8e0", "#3d5a44"],
  ["#e2e3ee", "#454a6e"],
  ["#eee0e3", "#6e4450"],
  ["#e7e5d5", "#58542d"],
  ["#dbe6ea", "#36586a"],
] as const;
const PERSON_TONES_DARK = [
  ["#3a2c20", "#e8cdb3"],
  ["#22322a", "#b9d7c1"],
  ["#272a3d", "#c3c7ea"],
  ["#3a252b", "#e8c0ca"],
  ["#33311d", "#dcd6a6"],
  ["#1f3038", "#b3d3e0"],
] as const;

function hashIndex(s: string, n: number): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h % n;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

/** A person's initials on a tone keyed to their handle, so the same person always looks the same. */
export function PersonMark({ handle, name, size = 22, className }: { handle: string; name?: string; size?: number; className?: string }) {
  const i = hashIndex(handle, PERSON_TONES.length);
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(9, Math.round(size * 0.4)),
    "--pm-bg": PERSON_TONES[i]![0],
    "--pm-fg": PERSON_TONES[i]![1],
    "--pm-bg-d": PERSON_TONES_DARK[i]![0],
    "--pm-fg-d": PERSON_TONES_DARK[i]![1],
  } as CSSProperties;
  return (
    <span
      aria-hidden
      title={name ?? handle}
      className={cx("person-mark inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-[-0.02em]", className)}
      style={style}
    >
      {initials(name ?? handle)}
    </span>
  );
}

/** Overlapping marks for a small group, with a "+n" for the rest. */
export function PeopleStack({ people, max = 4, size = 20 }: { people: { handle: string; displayName: string }[]; max?: number; size?: number }) {
  const shown = people.slice(0, max);
  return (
    <span className="inline-flex items-center">
      {shown.map((p, i) => (
        <PersonMark key={p.handle} handle={p.handle} name={p.displayName} size={size} className={cx("ring-2 ring-bg", i > 0 && "-ml-1")} />
      ))}
      {people.length > max && (
        <span className="-ml-1 inline-flex h-5 items-center rounded-full bg-surface-3 px-1.5 text-xs text-fg-muted ring-2 ring-bg tabular">
          +{people.length - max}
        </span>
      )}
    </span>
  );
}

/** A team's monogram on a rounded square: teams are places, people are circles. */
export function TeamMark({ slug, name, size = 28, className }: { slug: string; name?: string; size?: number; className?: string }) {
  const i = hashIndex(slug, PERSON_TONES.length);
  const style = {
    width: size,
    height: size,
    fontSize: Math.max(10, Math.round(size * 0.38)),
    "--pm-bg": PERSON_TONES[i]![0],
    "--pm-fg": PERSON_TONES[i]![1],
    "--pm-bg-d": PERSON_TONES_DARK[i]![0],
    "--pm-fg-d": PERSON_TONES_DARK[i]![1],
  } as CSSProperties;
  return (
    <span
      aria-hidden
      className={cx("person-mark inline-flex shrink-0 items-center justify-center rounded-[28%] font-mono font-semibold tracking-[-0.04em]", className)}
      style={style}
    >
      {initials(name ?? slug).slice(0, 2)}
    </span>
  );
}

// ---------- trust, health, verified ----------

/** Works / broken from teammates, as a split bar plus the counts. Nothing when nobody voted. */
export function TrustBar({ trust, className, showLabel = true }: { trust: Trust; className?: string; showLabel?: boolean }) {
  const total = trust.works + trust.broken;
  if (total === 0) return showLabel ? <span className={cx("text-xs text-fg-subtle", className)}>No votes yet</span> : null;
  const pct = Math.round((trust.works / total) * 100);
  return (
    <span className={cx("inline-flex items-center gap-2", className)} title={`${trust.works} works, ${trust.broken} broken`}>
      <span aria-hidden className="relative h-1.5 w-12 overflow-hidden rounded-full bg-danger">
        <span className="absolute inset-y-0 left-0 rounded-full bg-ok-text" style={{ width: `${pct}%` }} />
      </span>
      {showLabel && (
        <span className="text-xs text-fg-muted tabular">
          {pct}% works <span className="text-fg-subtle">· {total}</span>
        </span>
      )}
    </span>
  );
}

export function HealthMark({ health, className }: { health: Health; className?: string }) {
  return (
    <span
      className={cx("inline-flex items-center gap-1 text-xs", health === "active" ? "text-ok-text" : "text-fg-subtle", className)}
      title={health === "active" ? "A version was published recently" : "No new version in a while"}
    >
      <CircleDot aria-hidden className="size-3" />
      {health === "active" ? "Active" : "Stale"}
    </span>
  );
}

export function VerifiedMark({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-1 text-xs font-medium text-ok-text", className)} title="An admin reviewed this version">
      <BadgeCheck aria-hidden className="size-3.5" />
      {compact ? <span className="sr-only">Verified</span> : "Verified"}
    </span>
  );
}

// ---------- sparkline ----------

/** Installs per day. Encodes real data; the last point (today) is marked. */
export function Sparkline({ values, width = 64, height = 18, className, label }: { values: number[]; width?: number; height?: number; className?: string; label?: string }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const pts = values.map((v, i) => [i * step, height - 2 - (v / max) * (height - 4)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cx("overflow-visible", className)}
      role="img"
      aria-label={label ?? `${total} installs in the last ${values.length} days`}
    >
      <path d={`${d} L${width} ${height} L0 ${height} Z`} className="fill-surface-3" />
      <path d={d} fill="none" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" className="stroke-fg-subtle" />
      {last && total > 0 && <circle cx={last[0]} cy={last[1]} r={2} className="fill-fg-muted" />}
    </svg>
  );
}

// ---------- headings and rules ----------

/**
 * Section heading in display type. `mark` names the ONE word that carries the amber underline;
 * it must appear in `children` text.
 */
export function SectionHeading({
  children,
  mark,
  as: Tag = "h2",
  size = "lg",
  description,
  actions,
  id,
  cursor = false,
}: {
  children: string;
  mark?: string;
  /** The still amber block cursor after the title: hero titles only (Home, Get started). */
  cursor?: boolean;
  as?: ElementType;
  size?: "md" | "lg" | "xl" | "hero";
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  let content: ReactNode = children;
  // Underlining the whole of a one-word title reads as a link: the mark needs other words around it.
  if (mark && mark.trim() !== children.trim()) {
    const at = children.indexOf(mark);
    if (at >= 0)
      content = (
        <>
          {children.slice(0, at)}
          <span className="mark-word whitespace-nowrap">{mark}</span>
          {children.slice(at + mark.length)}
        </>
      );
  }
  const sz =
    size === "hero"
      ? "text-[2.25rem] leading-[1.08] md:text-[2.75rem] xl:text-[3.25rem]"
      : size === "xl"
        ? "text-3xl md:text-4xl"
        : size === "lg"
          ? "text-2xl md:text-3xl"
          : "text-xl";
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
      <div className="min-w-0">
        <Tag id={id} className={cx("display text-fg", sz)}>
          {content}
          {cursor && <span aria-hidden className="cursor-still" />}
        </Tag>
        {description && <p className="mt-2 max-w-2xl text-base text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function DottedRule({ className }: { className?: string }) {
  return <div aria-hidden className={cx("rule-dots", className)} />;
}

/** Two-digit rank numeral for ranked lists; the top three read in ink, the rest muted. */
export function Rank({ n, className }: { n: number; className?: string }) {
  return (
    <span className={cx("w-6 shrink-0 font-mono text-sm tabular", n <= 3 ? "font-semibold text-fg" : "text-fg-subtle", className)}>
      {String(n).padStart(2, "0")}
    </span>
  );
}

// ---------- spotlight tile ----------

/** A surface whose glow follows the pointer. Use for team and stack tiles only. */
export function SpotlightTile<T extends ElementType = "div">({
  as,
  className,
  children,
  ...rest
}: { as?: T; className?: string; children: ReactNode } & Omit<React.ComponentPropsWithoutRef<T>, "as" | "className" | "children">) {
  const Tag = (as ?? "div") as ElementType;
  const onPointerMove = useCallback((e: PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, []);
  return (
    <Tag {...rest} onPointerMove={onPointerMove} className={cx("spotlight lift", className)}>
      {children}
    </Tag>
  );
}
