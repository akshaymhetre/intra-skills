// Background confirmations ("Copied intra install pr-review", "Revoked token laptop cli") with an optional
// undo. Never for errors the user must act on: those belong beside the thing that failed.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

export interface ToastOptions {
  message: ReactNode;
  /** The undo slot: a short verb ("Undo") and what it does. */
  action?: { label: string; onClick: () => void };
  /** ms before it leaves; default 4000, 8000 when there is an action. */
  duration?: number;
}
interface Live extends ToastOptions {
  id: number;
}

const Ctx = createContext<((t: ToastOptions) => void) | null>(null);

export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Live[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((t: ToastOptions) => {
    const id = ++seq.current;
    // Newest replaces older ones beyond three, so the stack never covers the page.
    setToasts((cur) => [...cur.slice(-2), { ...t, id }]);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end sm:pr-5 sm:pb-5"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDone={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastItem({ toast: t, onDone }: { toast: Live; onDone: () => void }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover) return;
    const ms = t.duration ?? (t.action ? 8000 : 4000);
    const timer = window.setTimeout(onDone, ms);
    return () => window.clearTimeout(timer);
  }, [hover, t, onDone]);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="float-in pointer-events-auto flex max-w-[420px] min-w-0 items-center gap-3 rounded-md border border-line-strong bg-surface py-2 pr-1.5 pl-3.5 text-sm text-fg shadow-float"
    >
      <span className="min-w-0 flex-1">{t.message}</span>
      {t.action && (
        <button
          type="button"
          onClick={() => {
            t.action!.onClick();
            onDone();
          }}
          className="h-7 shrink-0 rounded-md px-2 font-medium text-fg underline decoration-line-control underline-offset-[0.18em] hover:bg-surface-2 hover:decoration-current max-md:min-h-11"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDone}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg max-md:size-11"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
