// Serves the built web console with an SPA fallback to index.html for any non-/api GET.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { Context } from "hono";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const NOT_BUILT = `<!doctype html><html><head><meta charset="utf-8"><title>intra-skills</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>intra-skills registry</h1><p>The registry API is running at <code>/api</code>, but the web console is not built.</p>
<p>Build it with <code>pnpm --filter @intra-skills/web run build</code>, or point <code>INTRA_SKILLS_WEB_DIR</code> at a built console.</p>
</body></html>`;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export function staticHandler(webDir: string | null) {
  const root = webDir ? resolve(webDir) : null;
  return (c: Context): Response => {
    const index = root ? join(root, "index.html") : null;
    if (!root || !index || !existsSync(index)) return c.html(NOT_BUILT);
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      rel = "/";
    }
    const target = resolve(root, "." + rel);
    const inside = target === root || target.startsWith(root + sep);
    if (inside && rel !== "/" && !rel.includes("\0") && isFile(target)) {
      const type = TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
      const immutable = rel.startsWith("/assets/");
      return c.body(readFileSync(target), 200, {
        "Content-Type": type,
        "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
        "X-Content-Type-Options": "nosniff",
      });
    }
    return c.body(readFileSync(index), 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
  };
}
