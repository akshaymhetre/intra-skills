// Page frame for the account and admin screens (Teams, Proposals, Get started, Settings, Members,
// Review, Repositories, Registry, Activity). Same visual language as Home: a display-type title with
// one marked word, a dotted rule under the intro, then sections with smaller display headings.
// Spec: design/DIRECTION.md.
import type { ReactNode } from "react";
import { DottedRule, SectionHeading } from "../fx";
import { cx } from "../../lib/cx";

/** Content column, left-aligned with every other page. `wide` for tables (1180), `narrow` for forms and reading (760). */
export function Page({ children, width = "wide", className }: { children: ReactNode; width?: "wide" | "narrow"; className?: string }) {
  return (
    <div className={cx("mx-auto w-full max-w-[1180px] px-5 pb-20 md:px-10", className)}>
      {width === "wide" ? children : <div className="max-w-[760px]">{children}</div>}
    </div>
  );
}

/** The page's h1 in display type, an optional lead, meta line and actions, then the dotted rule. */
export function PageIntro({
  title,
  mark,
  description,
  actions,
  meta,
  lead,
  rule = true,
}: {
  title: string;
  /** The ONE word of the title that carries the amber underline. */
  mark?: string;
  description?: ReactNode;
  actions?: ReactNode;
  meta?: ReactNode;
  /** Something drawn before the title (a team mark). */
  lead?: ReactNode;
  rule?: boolean;
}) {
  return (
    <>
      <header className="pt-9 pb-7 md:pt-12 md:pb-9">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="flex min-w-0 items-start gap-4">
            {lead && <div className="shrink-0 pt-1">{lead}</div>}
            <div className="min-w-0">
              <SectionHeading as="h1" size="lg" mark={mark}>
                {title}
              </SectionHeading>
              {description && <div className="mt-3 max-w-[62ch] text-base text-fg-muted">{description}</div>}
              {meta && <div className="mt-3">{meta}</div>}
            </div>
          </div>
          {/* One rule on every page: the primary action sits on the title's row, at the right. */}
          {actions && <div className="flex flex-wrap items-center gap-2 md:pt-1.5">{actions}</div>}
        </div>
      </header>
      {rule && <DottedRule />}
    </>
  );
}

/** One section of a page: a smaller display heading, an optional line under it, actions on the right. */
export function PageSection({
  id,
  title,
  mark,
  count,
  description,
  actions,
  children,
  className,
}: {
  id: string;
  title: string;
  mark?: string;
  count?: number;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={id} className={cx("pt-10 md:pt-12", className)}>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h2 id={id} className="display text-xl text-fg">
            {mark && title.includes(mark) ? (
              <>
                {title.slice(0, title.indexOf(mark))}
                <span className="mark-word">{mark}</span>
                {title.slice(title.indexOf(mark) + mark.length)}
              </>
            ) : (
              title
            )}
            {count !== undefined && <span className="ml-2.5 font-mono text-base font-normal tracking-normal text-fg-subtle tabular">{count}</span>}
          </h2>
          {description && <p className="mt-1.5 max-w-[62ch] text-sm text-fg-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** A plain-words status line with an icon and tone, used for sync results, checks and proposal states. */
export function StatusText({
  tone,
  icon,
  children,
  className,
}: {
  tone: "ok" | "bad" | "warn" | "neutral" | "sel";
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const color =
    tone === "ok" ? "text-ok-text" : tone === "bad" ? "text-danger-text" : tone === "warn" ? "text-warning-text" : tone === "sel" ? "text-sel-text" : "text-fg-muted";
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-sm", color, className)}>
      {icon && <span className="shrink-0 [&_svg]:size-3.5">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** A labelled numbered step: the numeral in mono, the title, a body, and the expected result. */
export function Step({
  n,
  title,
  children,
  expect,
  id,
}: {
  n: number;
  title: string;
  children: ReactNode;
  /** What the reader sees when the step worked. */
  expect?: ReactNode;
  id?: string;
}) {
  return (
    <li className="grid grid-cols-1 gap-y-1 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:gap-x-3 md:grid-cols-[3.5rem_minmax(0,1fr)] md:gap-x-4">
      <span aria-hidden className="font-mono text-base font-medium text-fg-subtle tabular sm:pt-1 md:text-lg">
        {String(n).padStart(2, "0")}
      </span>
      <div className="min-w-0">
        <h2 id={id} className="display text-xl text-fg">
          <span className="sr-only">Step {n}: </span>
          {title}
        </h2>
        <div className="mt-3">{children}</div>
        {expect && (
          <p className="mt-3 flex gap-2 text-sm text-fg-muted">
            <span className="shrink-0 font-medium text-fg">Expected:</span>
            <span className="min-w-0">{expect}</span>
          </p>
        )}
      </div>
    </li>
  );
}
