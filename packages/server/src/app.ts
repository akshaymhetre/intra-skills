// createApp(db, opts) builds the whole Hono app. Tests drive it with app.request(); bin.ts serves it.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import type { Db } from "./db.js";
import { type AppEnv, SESSION_COOKIE, authMiddleware, authenticateToken } from "./auth.js";
import { HttpError, errorResponse, jsonBody, notFound } from "./http.js";
import { getUser } from "./model.js";
import { skillRoutes } from "./routes/skills.js";
import { versionRoutes } from "./routes/versions.js";
import { teamRoutes } from "./routes/teams.js";
import { userRoutes } from "./routes/users.js";
import { auditRoutes } from "./routes/audit.js";
import { homeRoutes } from "./routes/home.js";
import { collectionRoutes } from "./routes/collections.js";
import { trustRoutes } from "./routes/trust.js";
import { suggestRoutes } from "./routes/suggest.js";
import { metaRoutes } from "./routes/meta.js";
import { deviceRoutes } from "./routes/device.js";
import { agentDocRoutes, mcpRoutes } from "./routes/agent.js";
import { sourceRoutes } from "./routes/sources.js";
import { proposalRoutes } from "./routes/proposals.js";
import { hookRoutes } from "./routes/hooks.js";
import { marketplaceRoutes } from "./routes/marketplace.js";
import { GitService } from "./git/service.js";
import type { ProviderFactory } from "./git/provider.js";
import { staticHandler } from "./static.js";
import { secureCookie } from "./settings.js";

export const MAX_BODY_BYTES = 8 * 1024 * 1024;
const SESSION_MAX_AGE = 30 * 24 * 60 * 60;

export interface AppOptions {
  /** Directory of the built web console; null disables it (/ then explains the console is not built). */
  webDir?: string | null;
  /** Mark the session cookie Secure. Defaults to true only when the request arrived over https. */
  secureCookies?: boolean;
  /** Single-file CLI served at /cli/intra.mjs; null = not available. */
  cliBundlePath?: string | null;
  /** 32-byte key for stored git credentials. Tests may omit it (a random key is used). */
  secretKey?: Buffer;
  /** Tests inject a fake git host here. */
  providerFactory?: ProviderFactory;
  /** An existing git service (bin.ts creates one so it can start the poller). */
  git?: GitService;
}

/** /api routes that answer without a signed-in caller. Each one authenticates by other means or exposes nothing private. */
export const PUBLIC_API_PATHS = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/meta",
  "/api/setup",
  "/api/auth/device",
  "/api/auth/device/token",
]);
/** Webhooks: verified by the source's shared secret, not by a user token. Plugin archives: by their ?key=. */
export const PUBLIC_API_PREFIXES = ["/api/hooks/", "/api/plugins/"];

export function isPublicApiPath(pathname: string): boolean {
  return PUBLIC_API_PATHS.has(pathname) || PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p));
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION = readVersion();

export function createApp(db: Db, opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const git =
    opts.git ??
    new GitService(db, { secretKey: opts.secretKey ?? randomBytes(32), providerFactory: opts.providerFactory });

  app.onError((err, c) => {
    if (err instanceof HttpError) return errorResponse(c, err);
    // Never log request bodies or headers: they can carry tokens.
    console.error(`[intra-skills] ${c.req.method} ${new URL(c.req.url).pathname} failed: ${err.message}`);
    return errorResponse(c, new HttpError("internal", "internal server error"));
  });

  app.use(
    "/api/*",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => errorResponse(c, new HttpError("too_large", `request body exceeds ${MAX_BODY_BYTES} bytes`)),
    }),
  );

  app.get("/api/health", (c) => c.json({ ok: true, version: SERVER_VERSION }));

  app.post("/api/auth/login", async (c) => {
    const body = await jsonBody(c);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const actor = token ? authenticateToken(db, token) : null;
    if (!actor) throw new HttpError("unauthenticated", "invalid token");
    const secure = secureCookie(db, c.req.url, opts.secureCookies);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
      secure,
    });
    return c.json(getUser(db, actor.id));
  });

  const auth = authMiddleware(db);
  app.use("/api/*", async (c, next) => {
    const p = new URL(c.req.url).pathname;
    if (isPublicApiPath(p)) return next();
    return auth(c, next);
  });

  app.post("/api/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  app.route("/api", userRoutes(db));
  app.route("/api", teamRoutes(db));
  app.route("/api", skillRoutes(db));
  app.route("/api", versionRoutes(db));
  app.route("/api", auditRoutes(db));
  app.route("/api", homeRoutes(db));
  app.route("/api", collectionRoutes(db));
  app.route("/api", trustRoutes(db));
  app.route("/api", suggestRoutes(db));
  app.route("/api", metaRoutes(db, opts));
  app.route("/api", deviceRoutes(db));
  app.route("/api", mcpRoutes(db, (path, init) => Promise.resolve(app.request(path, init))));
  app.route("/api", sourceRoutes(db, git));
  app.route("/api", proposalRoutes(db, git));
  app.route("/api", hookRoutes(db, git));

  // Before the /api catch-all: it serves /api/plugins/* archives as well as /marketplace.json.
  app.route("/", marketplaceRoutes(db, opts));

  app.all("/api/*", () => {
    throw notFound("no such route");
  });

  app.route("/", agentDocRoutes(db, opts));

  const serveStatic = staticHandler(opts.webDir ?? null);
  app.get("*", (c) => serveStatic(c));

  return app;
}
