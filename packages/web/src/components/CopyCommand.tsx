// The install line. The one authored moment in the console: on copy, the `$` prompt turns into a
// check for 1.5 s (no travel under reduced motion). The command wraps only BETWEEN arguments, and a
// flag stays on the same line as its value, so a wrapped command reads one flag group per line.
import { Fragment, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { cx } from "../lib/cx";
import { useCopy } from "../lib/useCopy";

/** Splits a command into unbreakable groups: the program + subcommand, each positional, each flag with its value. */
export function commandGroups(cmd: string): string[] {
  const words = cmd.trim().split(/\s+/).filter(Boolean);
  const groups: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (i === 1 && groups.length === 1 && !w.startsWith("-")) {
      groups[0] += ` ${w}`; // "intra install" stays together
      continue;
    }
    const next = words[i + 1];
    // A flag keeps its value on the same line, except a URL: it is long enough to need its own line.
    if (w.startsWith("-") && !w.includes("=") && next && !next.startsWith("-") && !/^https?:\/\//.test(next) && i > 1) {
      groups.push(`${w} ${next}`);
      i++;
      continue;
    }
    groups.push(w);
  }
  return groups;
}

/** A long group (a URL, a long skill name) may break after a slash or hyphen, or before the `@` of a plugin reference, never mid-word; short groups never break. */
function breakable(g: string): ReactNode {
  if (g.length <= 28) return g;
  // Break after a path slash (never inside "://"), or after a hyphen in a long skill name.
  // A plugin reference (`name@marketplace`) breaks before its `@`, so neither half splits.
  const parts = g.includes("/") ? g.split(/(?<=[^:/]\/)/) : /^[^@\s]+@[^@\s]+$/.test(g) ? g.split(/(?=@)/) : g.split(/(?<=-)/);
  return parts.map((p, i) => (
    <Fragment key={i}>
      {p}
      {i < parts.length - 1 && <wbr />}
    </Fragment>
  ));
}

/** The command text with wrap points only between argument groups. */
export function CommandText({ command, className }: { command: string; className?: string }) {
  const groups = commandGroups(command);
  return (
    <code className={cx("font-mono break-normal", className)}>
      {groups.map((g, i) => (
        <span key={i}>
          <span className="whitespace-nowrap">{breakable(g)}</span>
          {i < groups.length - 1 ? " " : ""}
        </span>
      ))}
    </code>
  );
}

export function CopyCommand({
  command,
  label,
  className,
  size = "md",
  onCopied,
}: {
  command: string;
  /** Accessible name for the copy button; defaults to "Copy command". */
  label?: string;
  className?: string;
  /** lg = the page's hero install line (inside InstallCard): 14px mono, icon-only copy so the line fits. */
  size?: "sm" | "md" | "lg";
  onCopied?: () => void;
}) {
  const { copied, copy } = useCopy(1500);
  // `a && b` is shown as two prompts, one command per line, and copied as typed.
  const lines = command.split(" && ");
  const hero = size === "lg";
  return (
    <div
      className={cx(
        "group/cmd flex min-w-0 items-start gap-2 rounded-md border border-line bg-panel pr-1 pl-3 text-fg",
        size === "sm" ? "py-1 text-sm" : hero ? "py-2 text-base" : "py-1.5 text-sm",
        "max-md:py-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        {lines.map((line, i) => (
          <div key={i} className="flex min-w-0 items-start gap-2">
            <span aria-hidden className="relative -ml-0.5 flex h-7 w-3.5 shrink-0 items-center justify-center font-mono text-fg-subtle select-none max-md:h-11">
              {copied && i === 0 ? <Check key="ok" className="prompt-swap size-3.5 text-fg" /> : <span key="p">$</span>}
            </span>
            <CommandText command={line} className={cx("min-w-0 flex-1 py-1 max-md:py-3", hero ? "leading-6" : "leading-5")} />
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={async () => {
          await copy(command);
          onCopied?.();
        }}
        aria-label={copied ? "Copied" : (label ?? "Copy command")}
        title={hero ? (copied ? "Copied" : "Copy") : undefined}
        className={cx(
          "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-[4px] font-sans text-sm font-medium text-fg-muted transition-colors duration-[120ms] hover:bg-surface-3 hover:text-fg max-md:min-h-11 max-md:min-w-11",
          hero ? "w-8" : "px-2",
        )}
      >
        <Copy className="size-3.5" aria-hidden />
        {!hero && <span className="max-sm:sr-only">{copied ? "Copied" : "Copy"}</span>}
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? "Command copied to clipboard" : ""}
      </span>
    </div>
  );
}
