// The signature surface: a command card inside the amber border beam. Used ONCE per page, for the
// page's primary install line (a skill's install, the bootstrap on Home and Get started).
// Tabs switch between ways to run it (terminal, agent prompt, MCP, project); each tab is one
// copyable line plus a one-sentence note on what it does and where files land.
import { useId, useState, type ReactNode } from "react";
import { cx } from "../lib/cx";
import { CopyCommand } from "./CopyCommand";
import { CopyButton } from "./ui";

export interface InstallTab {
  id: string;
  label: string;
  command: string;
  /** Plain words: what running this does, where the files land. */
  note?: ReactNode;
  /** Prose to paste (an agent prompt) instead of a shell command: no `$` prompt is drawn. */
  prose?: boolean;
}

export function InstallCard({
  title,
  tabs,
  footer,
  lead,
  className,
  beam = true,
}: {
  title?: ReactNode;
  tabs: InstallTab[];
  footer?: ReactNode;
  /** A step that comes before every tab (a plugin's one-time connect), shown between the title and the tabs. */
  lead?: ReactNode;
  className?: string;
  /** Off only where a second card would put two beams on one page. */
  beam?: boolean;
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  const id = useId();
  const tab = tabs.find((t) => t.id === active) ?? tabs[0];
  if (!tab) return null;
  return (
    <section className={cx("rounded-xl border border-line bg-surface", beam && "beam", className)} aria-label={typeof title === "string" ? title : "Install"}>
      {lead && (
        <div className="px-4 pt-3">
          {title && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
          <div className="mt-3">{lead}</div>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-3">
        {title && !lead && <h2 className="text-sm font-semibold text-fg">{title}</h2>}
        {tabs.length > 1 && (
          <div role="tablist" aria-label="How to install" className="-mb-px flex gap-1 overflow-x-auto">
            {tabs.map((t) => {
              const on = t.id === tab.id;
              return (
                <button
                  key={t.id}
                  role="tab"
                  type="button"
                  id={`${id}-${t.id}`}
                  aria-selected={on}
                  aria-controls={`${id}-panel`}
                  onClick={() => setActive(t.id)}
                  className={cx(
                    "relative h-8 shrink-0 rounded-md px-2.5 text-sm transition-colors duration-[120ms] max-md:h-11",
                    on ? "font-medium text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  {t.label}
                  <span aria-hidden className={cx("absolute inset-x-2.5 bottom-0 h-0.5 rounded-full", on ? "bg-sel-fill" : "bg-transparent")} />
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab.id}`} className="px-4 pt-3 pb-4">
        {tab.prose ? <ProseCopy text={tab.command} /> : <CopyCommand command={tab.command} size="lg" className="bg-panel" />}
        {tab.note && <p className="mt-2 text-sm text-fg-muted">{tab.note}</p>}
        {footer && <div className="mt-3 border-t border-line pt-3 text-sm">{footer}</div>}
      </div>
    </section>
  );
}

/** A sentence to paste into an agent: shown as text, copied whole. */
function ProseCopy({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-panel py-2 pr-1 pl-3">
      <p className="min-w-0 flex-1 py-0.5 text-sm leading-relaxed text-fg">{text}</p>
      <CopyButton text={text} label="Copy prompt" showText />
    </div>
  );
}
