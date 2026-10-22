// The registry's public metadata (name, public URL, publish mode), fetched once per page load
// and shared by every component that asks, so the org name and URLs are never hardcoded.
import { useEffect, useState } from "react";
import type { RegistryMeta } from "@intra-skills/shared/types";
import { api } from "../api";

let cached: Promise<RegistryMeta> | null = null;

export function loadMeta(): Promise<RegistryMeta> {
  cached ??= api.meta().catch((e) => {
    cached = null;
    throw e;
  });
  return cached;
}

/** null until loaded; falls back to the page origin so commands still render if /meta fails. */
export function useRegistryMeta(): RegistryMeta | null {
  const [meta, setMeta] = useState<RegistryMeta | null>(null);
  useEffect(() => {
    let live = true;
    loadMeta()
      .then((m) => live && setMeta(m))
      .catch(() => {
        const origin = window.location.origin;
        if (live)
          setMeta({ name: "intra-skills", publicUrl: origin, version: "", needsSetup: false, publishMode: "direct", mcpUrl: `${origin}/api/mcp`, marketplaceName: "intra-skills" });
      });
    return () => {
      live = false;
    };
  }, []);
  return meta;
}

/** Sets the browser tab title to "<title> - <org name>", the same on every page. */
export function useDocTitle(title: string) {
  const meta = useRegistryMeta();
  useEffect(() => {
    document.title = `${title} - ${meta?.name || "intra-skills"}`;
  }, [title, meta?.name]);
}
