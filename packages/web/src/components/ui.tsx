// Console primitives. Tokens live in styles.css; spec in design/DIRECTION.md.
// Pages import everything from here, including the primitives that live in their own files below.
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { Asterisk, Check, ChevronDown, ChevronRight, CircleAlert, Copy, LoaderCircle, MousePointer2, SquareTerminal, X } from "lucide-react";
import { TOOL_DIRS, TOOLS, type ToolId } from "@intra-skills/shared/types";
import { ApiError } from "../api";
import { cx } from "../lib/cx";
import { useCopy } from "../lib/useCopy";

export { cx } from "../lib/cx";
export { useCopy, copyText } from "../lib/useCopy";
export { Menu, type MenuEntry, type MenuItem } from "./Menu";
export { ToastProvider, useToast, type ToastOptions } from "./Toast";
export { CopyCommand, CommandText } from "./CopyCommand";

// ---------- buttons ----------

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  // Ink-filled: the primary action is the foreground colour, never a hue.
  primary: "bg-primary text-on-primary border-transparent hover:bg-primary-hover",
  secondary: "bg-surface text-fg border-line-strong hover:bg-surface-2 hover:border-line-control",
  ghost: "bg-transparent text-fg-muted border-transparent hover:bg-surface-2 hover:text-fg",
  // Quiet danger: text in danger, no fill. Used for "Revoke", "Yank" triggers that open a confirm.
  danger: "bg-transparent text-danger-text border-line-strong hover:bg-danger-soft hover:border-danger-line",
  // Solid danger: only the final confirm of a destructive action.
  destructive: "bg-danger text-on-danger border-transparent hover:bg-danger-hover",
};
const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-sm gap-1.5 max-md:min-h-11",
  md: "h-8 px-3 text-sm gap-1.5 max-md:min-h-11",
  lg: "h-9 px-3.5 text-base gap-2 max-md:min-h-11",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "relative inline-flex shrink-0 items-center justify-center rounded-md border font-medium whitespace-nowrap select-none",
        "transition-[background-color,border-color,color,transform] duration-[120ms] active:not-disabled:scale-[0.98]",
        VARIANT[variant],
        // Disabled reads as unavailable, never as a heavier block: outline, muted text, no fill.
        "disabled:border-line disabled:bg-transparent disabled:text-fg-subtle disabled:hover:bg-transparent",
        SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: "sm" | "md" }>(
  function IconButton({ label, className, children, size = "md", type = "button", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        aria-label={label}
        title={label}
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg disabled:opacity-50 max-md:size-11",
          size === "sm" ? "size-7" : "size-8",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

// ---------- form controls ----------

const FIELD =
  "w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 text-base text-fg placeholder:text-fg-subtle transition-colors duration-[120ms] hover:border-line-control focus-visible:border-focus disabled:opacity-60 aria-[invalid=true]:border-danger-text";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input(
  { className, mono, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(FIELD, "h-9 max-md:min-h-11", mono && "font-mono text-sm", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cx("relative inline-flex", className)}>
      <select className={cx(FIELD, "h-8 appearance-none pr-7 text-sm max-md:min-h-11")} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2 text-fg-subtle" aria-hidden />
    </span>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p className="flex items-start gap-1.5 text-sm text-danger-text">
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      ) : (
        hint && <p className="text-sm text-fg-subtle">{hint}</p>
      )}
    </div>
  );
}

/**
 * Radio group drawn as joined segments. The chosen segment is a selection, so it takes the
 * selection-blue soft fill with a hairline in the same hue: readable in both themes.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; title?: string }[];
  label: string;
  size?: "sm" | "md";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    refs.current[n]?.focus();
    onChange(options[n]!.value);
  };
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-line-strong bg-surface p-px">
      {options.map((o, i) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            title={o.title}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cx(
              "inline-flex items-center gap-1.5 rounded-[4px] border px-2.5 font-medium transition-colors duration-[120ms] max-md:min-h-11",
              size === "sm" ? "h-6 text-xs" : "h-7 text-sm",
              on ? "border-line-strong bg-surface-3 text-fg" : "border-transparent text-fg-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
  className,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx("flex items-center gap-2 text-sm select-none max-md:min-h-11", disabled ? "opacity-60" : "cursor-pointer", className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="size-3.5 shrink-0 cursor-pointer rounded-sm"
      />
      {children}
    </label>
  );
}

// ---------- metadata ----------

/**
 * One frontmatter fact printed as `key value`: the key in mono (as written in SKILL.md), the value in sans.
 * The direction's "keys, not pills". Pass `mono` when the value is itself an identifier (a version, a path).
 */
export function MetaKey({
  k,
  children,
  mono,
  className,
  title,
  keys = "frontmatter",
}: {
  k: string;
  children: ReactNode;
  mono?: boolean;
  className?: string;
  title?: string;
  /** "frontmatter" prints the key in mono (a real SKILL.md key); "label" prints a sans label. */
  keys?: "frontmatter" | "label";
}) {
  return (
    <span title={title} className={cx("inline-flex min-w-0 items-baseline gap-1.5 text-sm", className)}>
      <span className={cx("shrink-0", keys === "frontmatter" ? "font-mono text-xs text-fg-subtle" : "text-fg-subtle")}>{k}</span>
      <span className={cx("min-w-0 text-fg-muted", mono && "font-mono text-xs tabular")}>{children}</span>
    </span>
  );
}

/**
 * A definition list of facts. Labels are sans sentence case ("Published", "Size"); pass
 * `keys="frontmatter"` only when the labels are real SKILL.md frontmatter keys, which print in mono.
 * Pass `mono` on an item when its VALUE is an identifier (a hash, a commit, a version).
 */
export function KeyValue({
  items,
  className,
  keys = "label",
}: {
  items: { k: string; v: ReactNode; mono?: boolean; hidden?: boolean }[];
  className?: string;
  keys?: "label" | "frontmatter";
}) {
  return (
    <dl className={cx("grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm", className)}>
      {items
        .filter((i) => !i.hidden)
        .map((i) => (
          <div key={i.k} className="contents">
            <dt className={cx(keys === "frontmatter" ? "pt-px font-mono text-xs text-fg-subtle" : "text-fg-muted")}>{i.k}</dt>
            <dd className={cx("min-w-0 text-fg", i.mono && "font-mono text-[13px] tabular break-all")}>{i.v}</dd>
          </div>
        ))}
    </dl>
  );
}

/** An identifier (skill name, version, handle) in running text: mono, and never broken mid-token. */
export function Id({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[0.93em] whitespace-nowrap", className)}>{children}</span>;
}

// ---------- badges ----------

type Tone = "neutral" | "brand" | "sel" | "ok" | "warn" | "bad" | "outline";
const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-muted border-line",
  outline: "bg-transparent text-fg-muted border-line-strong",
  // `latest` and other selection markers.
  sel: "bg-sel-soft text-sel-text border-sel-line",
  brand: "bg-sel-soft text-sel-text border-sel-line",
  ok: "bg-ok-soft text-ok-text border-transparent",
  warn: "bg-warning-soft text-warning-text border-warning-line",
  bad: "bg-danger-soft text-danger-text border-danger-line",
};

/** Small status marker. Use for states that change what installs (yanked, deprecated) and `latest`, not for every fact. */
export function Badge({ tone = "neutral", children, className, mono, title }: { tone?: Tone; children: ReactNode; className?: string; mono?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium whitespace-nowrap",
        mono && "font-mono font-normal tabular",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong bg-surface px-1 font-sans text-xs font-medium text-fg-subtle",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

// ---------- tools ----------

const TOOL_ICON: Record<ToolId, typeof Asterisk> = { claude: Asterisk, codex: SquareTerminal, cursor: MousePointer2 };

/** Kept for the install target picker. Rows print tool labels as text instead (see ToolMarks). */
export function ToolIcon({ tool, className }: { tool: ToolId; className?: string }) {
  const Icon = TOOL_ICON[tool] ?? SquareTerminal;
  return <Icon className={cx("size-3.5", className)} aria-hidden />;
}

export const toolLabel = (t: string) => TOOL_DIRS[t as ToolId]?.label ?? t;
export const supportsAllTools = (tools: ToolId[]) => TOOLS.every((t) => tools.includes(t));

/** Tool support as text labels. Pass `onlyIfRestricted` to print nothing when every tool is supported. */
export function ToolMarks({ tools, onlyIfRestricted, className }: { tools: ToolId[]; onlyIfRestricted?: boolean; className?: string }) {
  if (onlyIfRestricted && supportsAllTools(tools)) return null;
  const ordered = TOOLS.filter((t) => tools.includes(t));
  return (
    <MetaKey k="tools" className={className}>
      {ordered.map(toolLabel).join(", ")}
    </MetaKey>
  );
}

// ---------- feedback ----------

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cx("skeleton block", className)} />;
}

export function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return <LoaderCircle className={cx("size-4 animate-spin text-fg-subtle", className)} role="status" aria-label={label} />;
}

/**
 * Empty state: what will appear here, and the one action that fills it. Text-led; an optional icon
 * renders bare (never in a tile).
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  className,
  inset = true,
  align = "center",
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  /** false = no side padding, for states inside an already padded column. */
  inset?: boolean;
  align?: "center" | "start";
}) {
  const center = align === "center";
  return (
    <div className={cx("flex flex-col py-12", inset && "px-6", center ? "items-center text-center" : "items-start", className)}>
      {icon && <div className="mb-3 text-fg-subtle [&_svg]:size-5">{icon}</div>}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {children && <div className={cx("mt-1 max-w-md text-sm text-fg-muted", center && "text-balance")}>{children}</div>}
      {action && <div className={cx("mt-4 flex flex-wrap gap-2", center && "justify-center")}>{action}</div>}
    </div>
  );
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "The request failed without an error message.";
}

export function ErrorState({
  error,
  onRetry,
  title = "Could not load this",
  className,
  inset = true,
  align = "center",
}: {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
  /** false = no side padding, for states inside an already padded column. */
  inset?: boolean;
  align?: "center" | "start";
}) {
  const center = align === "center";
  const code = error instanceof ApiError ? error.code : null;
  const status = error instanceof ApiError && error.status ? error.status : null;
  return (
    <div role="alert" className={cx("flex flex-col py-12", inset && "px-6", center ? "items-center text-center" : "items-start", className)}>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <CircleAlert className="size-4 text-danger-text" aria-hidden />
        {title}
      </h3>
      <p className={cx("mt-1 max-w-md text-sm text-fg-muted", center && "text-balance")}>{errorMessage(error)}</p>
      {/* The status and code help whoever runs the registry; without an HTTP status (a network failure) they say nothing. */}
      {status && (
        <p className="mt-2 font-mono text-xs text-fg-subtle tabular">
          {status ? `${status} ` : ""}
          {code}
        </p>
      )}
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-1.5 rounded-md border border-danger-line bg-danger-soft px-2.5 py-2 text-sm text-danger-text">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>{errorMessage(error)}</span>
    </p>
  );
}

/** A warning line (dirty publish, deprecation reason). Not a banner: one line, icon plus text. */
export function WarningLine({ children, className, icon }: { children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <p className={cx("flex items-start gap-1.5 text-sm text-warning-text", className)}>
      <span className="mt-0.5 shrink-0 [&_svg]:size-3.5">{icon ?? <CircleAlert aria-hidden />}</span>
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// ---------- copy ----------

export function CopyButton({ text, label = "Copy", className, showText }: { text: string; label?: string; className?: string; showText?: boolean }) {
  const { copied, copy } = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(text)}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cx(
        "inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-1.5 text-sm font-medium transition-colors duration-[120ms] max-md:min-h-11 max-md:min-w-11",
        copied ? "text-fg" : "text-fg-muted hover:bg-surface-3 hover:text-fg",
        className,
      )}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {showText && <span>{copied ? "Copied" : "Copy"}</span>}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied to clipboard" : ""}
      </span>
    </button>
  );
}

/** A one-line code value with a copy button. For commands, prefer CopyCommand. */
export function CodeLine({ children, copyText: text, className }: { children: ReactNode; copyText: string; className?: string }) {
  return (
    <div className={cx("flex items-center gap-2 rounded-md border border-line bg-panel py-1 pr-1 pl-3", className)}>
      <code className="min-w-0 flex-1 overflow-x-auto py-1 font-mono text-sm whitespace-pre text-fg">{children}</code>
      <CopyButton text={text} showText />
    </div>
  );
}

// ---------- disclosure ----------

/** Native details/summary, closed by default. */
export function Disclosure({
  summary,
  meta,
  children,
  defaultOpen,
  className,
}: {
  summary: ReactNode;
  meta?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  return (
    <details open={defaultOpen} className={cx("group rounded-md border border-line", className)}>
      <summary className="flex min-h-9 list-none items-center gap-2 rounded-md px-3 text-sm font-medium text-fg select-none hover:bg-surface-2 max-md:min-h-11 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-fg-subtle transition-transform duration-[120ms] group-open:rotate-90" aria-hidden />
        <span className="min-w-0 flex-1">{summary}</span>
        {meta && <span className="text-xs text-fg-subtle tabular">{meta}</span>}
      </summary>
      <div className="border-t border-line px-3 py-3">{children}</div>
    </details>
  );
}

// ---------- dialog ----------

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-md",
  initialFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
  /** CSS selector inside the dialog to focus on open; defaults to the first field or button. */
  initialFocus?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      d.showModal();
      const target =
        (initialFocus && d.querySelector<HTMLElement>(initialFocus)) ||
        d.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ||
        d.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select") ||
        d.querySelector<HTMLElement>("[data-dialog-body] button, footer button");
      target?.focus();
    }
    if (!open && d.open) {
      d.close();
      returnTo.current?.focus?.();
    }
  }, [open, initialFocus]);
  useEffect(
    () => () => {
      if (ref.current?.open) returnTo.current?.focus?.();
    },
    [],
  );
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cx("m-auto w-[calc(100%-2rem)] rounded-lg border border-line bg-surface p-0 text-fg shadow-float", width)}
    >
      {open && (
        <div className="float-in flex flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pt-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && <div className="mt-1 text-sm text-fg-muted">{description}</div>}
            </div>
            <IconButton label="Close" size="sm" onClick={onClose} className="-mr-2">
              <X className="size-4" aria-hidden />
            </IconButton>
          </div>
          {children && (
            <div data-dialog-body className="px-5 pt-4">
              {children}
            </div>
          )}
          {footer ? <footer className="mt-5 flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer> : <div className="h-5" />}
        </div>
      )}
    </dialog>
  );
}

/**
 * Confirm for an action that cannot be taken back. The title names the object ("Yank 1.4.2?").
 * Danger confirms open with focus on Cancel, so Enter never destroys anything by accident.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  danger,
  busy,
  error,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      initialFocus={children ? undefined : "[data-confirm-cancel]"}
      footer={
        <>
          <Button data-confirm-cancel onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? "destructive" : "primary"} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {(children || !!error) && (
        <div className="flex flex-col gap-3">
          {children}
          <InlineError error={error} />
        </div>
      )}
    </Dialog>
  );
}

// ---------- tabs (WAI-ARIA, arrow keys move between tabs) ----------

export function Tabs<T extends string>({
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
    const i = tabs.findIndex((t) => t.value === value);
    // Scroll the tab row only; scrollIntoView would also scroll the page when the row is below the fold.
    const list = listRef.current;
    const tab = refs.current[i];
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
  // On narrow screens the tab row scrolls; mask the edge that has more tabs behind it.
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
      className="-mb-px flex gap-4 overflow-x-auto [scrollbar-width:none]"
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
              "relative inline-flex h-10 shrink-0 items-center gap-1.5 text-sm font-medium whitespace-nowrap transition-colors duration-[120ms] max-md:h-11",
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

// ---------- avatar ----------

/** Initials on one neutral surface. No per-person hues: colour here would carry no meaning. */
export function Avatar({ name, size = 20 }: { name: string; handle?: string; size?: number }) {
  const parts = name.trim().split(/\s+/);
  const ini = ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase();
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-2 font-medium text-fg-muted"
      style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.4)) }}
    >
      {ini || "?"}
    </span>
  );
}

// ---------- page scaffolding ----------

export function PageHeader({ title, description, actions, meta }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 px-5 pt-6 pb-4 md:px-8">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-[-0.01em]">{title}</h1>
        {description && <p className="mt-0.5 max-w-2xl text-sm text-fg-muted">{description}</p>}
        {meta}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-line bg-surface", className)}>{children}</div>;
}

export function SectionTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <h2 className="text-sm font-semibold">{children}</h2>
      {actions}
    </div>
  );
}
