// Overflow / action menu (WAI-ARIA menu button).
// Keyboard: Enter, Space or ArrowDown opens on the first item, ArrowUp on the last; arrows move,
// Home/End jump, typing a letter jumps to the next item starting with it, Escape or Tab closes.
// Focus returns to the trigger on close. Rendered fixed so table overflow never clips it.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Ellipsis } from "lucide-react";
import { cx } from "../lib/cx";

export interface MenuItem {
  label: ReactNode;
  /** Plain text for typeahead when `label` is not a string. */
  text?: string;
  onSelect: () => void;
  icon?: ReactNode;
  /** Destructive items render in the danger text colour. */
  danger?: boolean;
  disabled?: boolean;
  /** Short right-aligned hint, e.g. a shortcut. */
  hint?: ReactNode;
  /** Renders a check mark: for "pick one" menus (theme). */
  checked?: boolean;
}
export type MenuEntry = MenuItem | "separator" | { heading: string };

export function Menu({
  label,
  items,
  trigger,
  align = "end",
  triggerClassName,
  size = "md",
}: {
  /** Accessible name of the trigger, e.g. "More actions for 1.4.2". */
  label: string;
  items: MenuEntry[];
  /** Trigger content; defaults to a horizontal ellipsis icon. */
  trigger?: ReactNode;
  align?: "start" | "end";
  triggerClassName?: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; up: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const firstFocus = useRef<"first" | "last">("first");
  const menuId = useId();

  const actionable = items.filter((i): i is MenuItem => typeof i === "object" && "onSelect" in i);
  const enabledEls = () => Array.from(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  }, []);

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const w = menu.current?.offsetWidth ?? 200;
    const h = menu.current?.offsetHeight ?? 0;
    const up = r.bottom + 4 + h > window.innerHeight - 8 && r.top - 4 - h > 8;
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ top: up ? r.top - 4 - h : r.bottom + 4, left, up });
  }, [align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const els = enabledEls();
    (firstFocus.current === "last" ? els[els.length - 1] : els[0])?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !btn.current?.contains(t)) close(false);
    };
    const onMove = () => close(false);
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, close]);

  const openWith = (where: "first" | "last") => {
    firstFocus.current = where;
    setOpen(true);
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openWith("first");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      openWith("last");
    }
  };

  const onMenuKey = (e: KeyboardEvent) => {
    const els = enabledEls();
    const i = els.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length]?.focus();
    };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(els.length - 1);
    else if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      close(false);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const order = [...els.slice(i + 1), ...els.slice(0, i + 1)];
      const hit = order.find((el) => (el.dataset.text ?? el.textContent ?? "").trim().toLowerCase().startsWith(ch));
      if (hit) {
        e.preventDefault();
        hit.focus();
      }
    }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        title={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : openWith("first"))}
        onKeyDown={onTriggerKey}
        className={cx(
          "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md text-fg-muted transition-colors duration-[120ms] hover:bg-surface-2 hover:text-fg aria-expanded:bg-surface-3 aria-expanded:text-fg max-md:min-h-11 max-md:min-w-11",
          !trigger && (size === "sm" ? "size-7" : "size-8"),
          triggerClassName,
        )}
      >
        {trigger ?? <Ellipsis className="size-4" aria-hidden />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKey}
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className="float-in fixed z-50 min-w-[200px] max-w-[320px] rounded-md border border-line bg-surface p-1 text-sm shadow-float"
          >
            {items.map((it, i) => {
              if (it === "separator") return <div key={i} role="separator" className="my-1 h-px bg-line" />;
              if ("heading" in it)
                return (
                  <div key={i} role="presentation" className="px-2 pt-1.5 pb-1 text-xs text-fg-subtle">
                    {it.heading}
                  </div>
                );
              const isCheck = it.checked !== undefined;
              return (
                <div
                  key={i}
                  role={isCheck ? "menuitemradio" : "menuitem"}
                  aria-checked={isCheck ? it.checked : undefined}
                  aria-disabled={it.disabled || undefined}
                  tabIndex={-1}
                  data-text={it.text ?? (typeof it.label === "string" ? it.label : undefined)}
                  onClick={() => {
                    if (it.disabled) return;
                    close();
                    it.onSelect();
                  }}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !it.disabled) {
                      e.preventDefault();
                      close();
                      it.onSelect();
                    }
                  }}
                  className={cx(
                    "flex h-8 items-center gap-2 rounded-[4px] px-2 select-none focus-visible:outline-offset-[-2px] max-md:h-11",
                    it.disabled ? "text-fg-subtle opacity-60" : "focus:bg-surface-2 hover:bg-surface-2",
                    it.danger && !it.disabled ? "text-danger-text" : "text-fg",
                  )}
                >
                  {isCheck ? (
                    <span className="flex size-3.5 shrink-0 items-center justify-center">{it.checked && <Check className="size-3.5" aria-hidden />}</span>
                  ) : (
                    it.icon && <span className="shrink-0 text-fg-subtle [&_svg]:size-3.5">{it.icon}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{it.label}</span>
                  {it.hint && <span className="shrink-0 text-xs text-fg-subtle">{it.hint}</span>}
                </div>
              );
            })}
            {actionable.length === 0 && <div className="px-2 py-1.5 text-fg-subtle">No actions</div>}
          </div>,
          document.body,
        )}
    </>
  );
}
