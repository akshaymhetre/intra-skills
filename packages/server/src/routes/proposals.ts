// Proposals: a new version offered as a pull request on the skill's git source.
import { Hono } from "hono";
import { NAME_RE, type ProposalStatus } from "@intra-skills/shared";
import type { Db } from "../db.js";
import type { AppEnv } from "../auth.js";
import { invalid, jsonBody, notFound } from "../http.js";
import type { GitService } from "../git/service.js";
import { canSeeProposal, proposalRow, proposalRows, toProposal } from "../git/store.js";
import { parsePublishBody } from "./versions.js";

const STATUSES: ProposalStatus[] = ["open", "merged", "published", "closed", "failed"];

export function proposalRoutes(db: Db, git: GitService): Hono<AppEnv> {
  const r = new Hono<AppEnv>();

  r.post("/skills/:name/proposals", async (c) => {
    const actor = c.get("actor");
    const name = c.req.param("name");
    if (name.length > 64 || !NAME_RE.test(name)) throw invalid("invalid skill name");
    const raw = await jsonBody(c);
    if (raw.source !== undefined && (typeof raw.source !== "string" || raw.source.length > 64))
      throw invalid("source must be a git source id");
    const body = parsePublishBody(raw);
    const { proposal, updated } = await git.propose(actor, name, body, raw.source as string | undefined);
    return c.json(proposal, updated ? 200 : 201);
  });

  r.get("/proposals", (c) => {
    const actor = c.get("actor");
    const status = c.req.query("status");
    const skill = c.req.query("skill");
    const mine = c.req.query("mine") === "1";
    if (status !== undefined && !STATUSES.includes(status as ProposalStatus))
      throw invalid(`status must be one of ${STATUSES.join(", ")}`);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (status) where.push("p.status = ?"), params.push(status);
    if (skill) where.push("p.skill_name = ?"), params.push(skill);
    if (mine) where.push("p.proposer_id = ?"), params.push(actor.id);
    const rows = proposalRows(db, where.length ? `WHERE ${where.join(" AND ")}` : "", params);
    return c.json(rows.filter((row) => canSeeProposal(db, actor, row)).map(toProposal));
  });

  const visible = (actor: Parameters<typeof canSeeProposal>[1], id: string) => {
    const row = proposalRow(db, id);
    if (!row || !canSeeProposal(db, actor, row)) throw notFound("proposal not found");
    return row;
  };

  r.get("/proposals/:id", (c) => c.json(toProposal(visible(c.get("actor"), c.req.param("id")))));

  r.post("/proposals/:id/refresh", async (c) => {
    const row = visible(c.get("actor"), c.req.param("id"));
    return c.json(await git.refreshProposal(row.id));
  });

  return r;
}
