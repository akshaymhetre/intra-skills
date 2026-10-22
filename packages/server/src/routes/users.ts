// Users, the caller's own tokens, and the caller's identity (/me).
import { Hono } from "hono";
import type { CreateTokenResponse, CreateUserResponse, MarketplaceKeyResponse, Role } from "@intra-skills/shared";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import { type AppEnv, createToken, listTokens } from "../auth.js";
import { checkHandle, conflict, forbidden, invalid, jsonArrayBody, jsonBody, notFound, optionalJsonBody, optString, reqString } from "../http.js";
import { audit, getUser, listUsers, userIdByHandle } from "../model.js";
import { parseGitIdentities, replaceGitIdentities } from "./meta.js";
import { marketplaceName, publicUrl } from "../settings.js";

export const DEFAULT_MARKETPLACE_KEY_NAME = "Claude Code plugins";

/** Create a user plus a first token. Used by POST /api/users and `init`. */
export function createUser(
  db: Db,
  input: { handle: string; displayName: string; role: Role },
): { userId: number; token: string } {
  const userId = Number(
    db
      .prepare("INSERT INTO users (handle, display_name, role, created_at) VALUES (?, ?, ?, ?)")
      .run(input.handle, input.displayName, input.role, new Date().toISOString()).lastInsertRowid,
  );
  const { token } = createToken(db, userId, "initial");
  return { userId, token };
}

export function userRoutes(db: Db): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.get("/me", (c) => c.json(getUser(db, c.get("actor").id)));

  r.get("/users", (c) => c.json(listUsers(db)));

  r.post("/users", async (c) => {
    const actor = c.get("actor");
    if (actor.role !== "admin") throw forbidden("only admins can create users");
    const body = await jsonBody(c);
    const handle = checkHandle(reqString(body, "handle", 64).trim().toLowerCase());
    const displayName = reqString(body, "displayName", 100).trim();
    const role = (body.role ?? "member") as Role;
    if (role !== "admin" && role !== "member") throw invalid("role must be admin or member");
    if (userIdByHandle(db, handle) !== null) throw conflict(`user "${handle}" already exists`);
    const { userId, token } = tx(db, () => {
      const out = createUser(db, { handle, displayName, role });
      audit(db, actor, "user.create", "user", handle, { role, displayName });
      return out;
    });
    const res: CreateUserResponse = { user: getUser(db, userId), token };
    return c.json(res, 201);
  });

  r.patch("/users/:handle", async (c) => {
    const actor = c.get("actor");
    if (actor.role !== "admin") throw forbidden("only admins can change users");
    const handle = c.req.param("handle");
    const userId = userIdByHandle(db, handle);
    if (userId === null) throw notFound(`user "${handle}" not found`);
    const body = await jsonBody(c);
    const displayName = optString(body, "displayName", 100);
    if (displayName !== undefined && displayName.trim() === "") throw invalid("displayName cannot be empty");
    const role = body.role as Role | undefined;
    if (role !== undefined && role !== "admin" && role !== "member") throw invalid("role must be admin or member");
    tx(db, () => {
      if (role === "member") {
        const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: number }[];
        if (admins.length === 1 && admins[0]!.id === userId) throw conflict("cannot demote the last admin");
      }
      if (role !== undefined) db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, userId);
      if (displayName !== undefined)
        db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(displayName.trim(), userId);
      if (role !== undefined || displayName !== undefined)
        audit(db, actor, "user.update", "user", handle, {
          ...(role !== undefined ? { role } : {}),
          ...(displayName !== undefined ? { displayName: displayName.trim() } : {}),
        });
    });
    return c.json(getUser(db, userId));
  });

  r.put("/users/:handle/git-identities", async (c) => {
    const actor = c.get("actor");
    if (actor.role !== "admin") throw forbidden("only admins can change another user's git identities");
    const handle = c.req.param("handle");
    const row = db.prepare("SELECT id FROM users WHERE handle = ? AND system = 0").get(handle) as { id: number } | undefined;
    if (!row) throw notFound(`user "${handle}" not found`);
    const ids = parseGitIdentities(await jsonArrayBody(c));
    replaceGitIdentities(db, actor, row.id, handle, ids);
    return c.json(getUser(db, row.id));
  });

  r.get("/tokens", (c) => c.json(listTokens(db, c.get("actor").id)));

  r.post("/tokens", async (c) => {
    const actor = c.get("actor");
    const body = await jsonBody(c);
    const name = reqString(body, "name", 100).trim();
    const res: CreateTokenResponse = tx(db, () => {
      const out = createToken(db, actor.id, name);
      audit(db, actor, "token.create", "token", out.meta.id, { name, prefix: out.meta.prefix });
      return out;
    });
    return c.json(res, 201);
  });

  // A read-only key for Claude Code's plugin marketplace. A marketplace key never reaches this
  // route itself: the auth middleware refuses it everywhere but the marketplace routes.
  r.post("/tokens/marketplace", async (c) => {
    const actor = c.get("actor");
    const body = await optionalJsonBody(c);
    const raw = optString(body, "name", 100);
    const name = raw === undefined || raw.trim() === "" ? DEFAULT_MARKETPLACE_KEY_NAME : raw.trim();
    const out = tx(db, () => {
      const created = createToken(db, actor.id, name, "marketplace");
      audit(db, actor, "token.create", "token", created.meta.id, { name, prefix: created.meta.prefix, scope: "marketplace" });
      return created;
    });
    const res: MarketplaceKeyResponse = {
      token: out.token,
      meta: out.meta,
      marketplaceUrl: `${publicUrl(db, c.req.url)}/marketplace.json?key=${out.token}`,
      marketplaceName: marketplaceName(db),
    };
    return c.json(res, 201);
  });

  r.delete("/tokens/:id", (c) => {
    const actor = c.get("actor");
    const id = c.req.param("id");
    tx(db, () => {
      const res = db
        .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
        .run(new Date().toISOString(), id, actor.id);
      if (Number(res.changes) === 0) throw notFound("token not found");
      audit(db, actor, "token.revoke", "token", id, {});
    });
    return c.body(null, 204);
  });

  return r;
}
