// Public agent documents (outside /api) and the MCP endpoint (inside /api, Bearer token required).
import { createReadStream, existsSync } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import type { Db } from "../db.js";
import type { AppEnv } from "../auth.js";
import { type AppOptions, SERVER_VERSION } from "../app.js";
import { getSettings, marketplaceName, publicUrl } from "../settings.js";
import { CLI_NOT_BUILT, agentMd, bootstrapSkillMd, installSh, isSafeOrigin, llmsTxt } from "../agent-docs.js";
import { type InternalCall, handleMcpMessage, originAllowed } from "../mcp.js";

export type { InternalCall } from "../mcp.js";

/**
 * The URL baked into every document. The request origin comes from the Host header, so anything
 * that is not a plain origin is refused rather than written into a shell script.
 */
function docUrl(db: Db, requestUrl: string): string | null {
  const url = publicUrl(db, requestUrl);
  return isSafeOrigin(url) ? url : null;
}

const BAD_URL =
  "This registry's public URL could not be determined safely. An admin sets it under Settings (publicUrl) or with INTRA_SKILLS_PUBLIC_URL.\n";

/** Public, outside /api: /agent.md, /llms.txt, /SKILL.md, /install.sh, /cli/intra.mjs. */
export function agentDocRoutes(db: Db, opts: AppOptions): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const doc = (path: string, type: string, render: (url: string) => string) =>
    r.get(path, (c) => {
      const url = docUrl(db, c.req.url);
      if (!url) return c.text(BAD_URL, 500);
      return c.body(render(url), 200, { "Content-Type": type, "Cache-Control": "no-cache" });
    });

  doc("/agent.md", "text/markdown; charset=utf-8", (url) => agentMd(url, getSettings(db).name, marketplaceName(db)));
  doc("/llms.txt", "text/plain; charset=utf-8", (url) => llmsTxt(url, getSettings(db).name, marketplaceName(db)));
  doc("/SKILL.md", "text/markdown; charset=utf-8", (url) => bootstrapSkillMd(url, marketplaceName(db)));
  // text/plain so a browser shows the script for reading instead of downloading it.
  doc("/install.sh", "text/plain; charset=utf-8", installSh);

  r.get("/cli/intra.mjs", (c) => {
    const path = opts.cliBundlePath ?? null;
    if (!path || !existsSync(path)) return c.text(CLI_NOT_BUILT, 404);
    const stream = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    return c.body(stream, 200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
  });

  return r;
}

/** POST /mcp (signed in by Bearer token): stateless MCP over streamable HTTP, a thin adapter over the REST API. */
export function mcpRoutes(db: Db, call: InternalCall): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const noStreams = () =>
    new Response(JSON.stringify({ error: { code: "method_not_allowed", message: "POST JSON-RPC messages to this endpoint; there is no SSE stream" } }), {
      status: 405,
      headers: { "Content-Type": "application/json", Allow: "POST" },
    });
  r.get("/mcp", noStreams);
  r.delete("/mcp", noStreams);

  r.post("/mcp", async (c) => {
    const rpc = (status: number, body: unknown) =>
      new Response(body === null ? null : JSON.stringify(body), {
        status,
        headers: body === null ? {} : { "Content-Type": "application/json" },
      });
    // A browser's session cookie is never enough here: the MCP endpoint is for configured tokens.
    if (c.get("authVia") !== "bearer")
      return rpc(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Authorization: Bearer <token> is required" } });
    if (!originAllowed(c, publicUrl(db, c.req.url)))
      return rpc(403, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Origin not allowed" } });
    const text = await c.req.text();
    try {
      const reply = await handleMcpMessage(text, (n) => c.req.header(n), c.req.header("Authorization")!, call, SERVER_VERSION);
      return rpc(reply.status, reply.body);
    } catch (e) {
      // Never echo internals (or anything from the request) back; log the message only.
      console.error(`[intra-skills] mcp request failed: ${(e as Error).message}`);
      let id: unknown = null;
      try {
        id = (JSON.parse(text) as { id?: unknown }).id ?? null;
      } catch {
        /* unparseable: id stays null */
      }
      return rpc(200, { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } });
    }
  });

  return r;
}
