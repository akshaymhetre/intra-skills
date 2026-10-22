import { useCallback, useSyncExternalStore } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "isk-theme";

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let current: ThemePref = typeof window === "undefined" ? "system" : read();
const listeners = new Set<() => void>();

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export function setTheme(p: ThemePref) {
  try {
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    // Storage can be blocked (private window); the choice still applies for this tab.
  }
  current = p;
  apply(p);
  listeners.forEach((l) => l());
}

/** The theme actually rendered, resolving "system" against the OS setting. */
export function resolvedTheme(pref: ThemePref = current): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Shared across every caller (top bar, command palette), so two controls never disagree. */
export function useTheme() {
  const pref = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
    () => "system" as ThemePref,
  );
  const set = useCallback((p: ThemePref) => setTheme(p), []);
  return { pref, set };
}
