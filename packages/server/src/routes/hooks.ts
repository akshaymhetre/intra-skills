// POST /hooks/:sourceId (public): a git host says something changed. The only proof is the HMAC
// signature over the raw body with the source's webhook secret; a source without a secret refuses,
// so an open endpoint can never be used to trigger syncs.
import { Hono } from "hono";
import type { Db } from "../db.js";
import type { AppEnv } from "../auth.js";
import { HttpError } from "../http.js";
import type { GitService } from "../git/service.js";
import { sourceRow } from "../git/store.js";
import { verifySignature } from "../git/provider.js";

export function hookRoutes(db: Db, git: GitService): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/hooks/:sourceId", async (c) => {
    const raw = await c.req.text();
    const row = sourceRow(db, c.req.param("sourceId"));
    const secret = row ? git.webhookSecret(row) : null;
    // Same answer for unknown source, no secret and bad signature, so the endpoint reveals nothing.
    if (!row || !secret || !verifySignature(row.provider, c.req.raw.headers, raw, secret))
      throw new HttpError("unauthenticated", "webhook signature does not verify");
    if (row.enabled !== 1) return c.json({ queued: false }, 202);
    git.trigger(row.id);
    return c.json({ queued: true }, 202);
  });

  return r;
}
