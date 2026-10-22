import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import type { User } from "@intra-skills/shared/types";
import { api, ApiError } from "./api";
import { useRegistryMeta } from "./lib/meta";
import { Spinner, ErrorState } from "./components/ui";
import { Wordmark } from "./components/fx";

interface AuthState {
  user: User | null;
  status: "loading" | "signed-in" | "signed-out" | "error";
  error: unknown;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [error, setError] = useState<unknown>();

  const refresh = useCallback(async () => {
    try {
      const u = await api.me();
      setUserState(u);
      setStatus("signed-in");
    } catch (e) {
      setUserState(null);
      if (e instanceof ApiError && e.isUnauthenticated) setStatus("signed-out");
      else {
        setError(e);
        setStatus("error");
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setUser = useCallback((u: User | null) => {
    setUserState(u);
    setStatus(u ? "signed-in" : "signed-out");
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }, [setUser]);

  return <Ctx.Provider value={{ user, status, error, refresh, setUser, signOut }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

export function useMe(): User {
  const { user } = useAuth();
  if (!user) throw new Error("useMe needs a signed-in user");
  return user;
}

/**
 * Gate for every signed-in screen. Sends the reader to sign in with the page they wanted as `next`,
 * or to the first-run setup page while the registry has no admin yet.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, error, refresh } = useAuth();
  const meta = useRegistryMeta();
  const loc = useLocation();
  if (status === "loading" || (status === "signed-out" && !meta))
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4" aria-busy="true">
        <Wordmark name={meta?.name || "intra-skills"} className="text-lg" />
        <p className="flex items-center gap-2 text-sm text-fg-subtle">
          <Spinner />
          Connecting to the registry
        </p>
      </div>
    );
  if (status === "error")
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState error={error} title="Could not reach the registry" onRetry={() => void refresh()} />
      </div>
    );
  if (status === "signed-out") {
    if (meta?.needsSetup) return <Navigate to="/setup" replace />;
    const next = loc.pathname + loc.search + loc.hash;
    return <Navigate to={next === "/" ? "/signin" : `/signin?next=${encodeURIComponent(next)}`} replace />;
  }
  return <>{children}</>;
}
