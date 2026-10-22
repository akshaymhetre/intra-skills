import type { Proposal, ProposalStatus } from "@intra-skills/shared";
import { str, type Command, type Ctx } from "../command.js";
import { UsageError } from "../errors.js";

const STATUSES: ProposalStatus[] = ["open", "merged", "published", "closed", "failed"];

function printProposal(ctx: Ctx, p: Proposal): void {
  const o = ctx.out;
  o.line(`${o.c("bold", `${p.skill}@${p.version}`)} ${p.status} ${o.c("dim", p.id)}`);
  if (p.pullRequest) o.line(`  pull request: ${p.pullRequest.url}`);
  if (p.statusMessage) o.line(`  ${p.statusMessage}`);
}

export const proposals: Command = {
  name: "proposals",
  summary: "List your skill proposals (pull requests) and their status",
  help: `Usage: intra proposals [--all] [--status <s>] [--skill <name>] [--json]
       intra proposals refresh <id> [--json]

When the registry publishes through pull requests, \`intra publish\` opens a proposal: a pull
request in the skills repo that becomes a version once it is approved and merged.
Statuses: open, merged (waiting for the next sync), published, closed, failed.

Options:
  --all             every proposal you can see, not only yours
  --status <s>      only this status
  --skill <name>    only proposals for this skill

\`refresh\` re-reads the pull request now instead of waiting for the next sync.`,
  options: { all: { type: "boolean" }, status: { type: "string" }, skill: { type: "string" } },
  async run(ctx, v, pos) {
    const api = ctx.api();
    if (pos[0] === "refresh") {
      if (!pos[1]) throw new UsageError("usage: intra proposals refresh <id>");
      const p = await api.refreshProposal(pos[1]);
      printProposal(ctx, p);
      ctx.out.result({ proposal: p });
      return;
    }
    if (pos.length) throw new UsageError("usage: intra proposals [--all] [--status s] | intra proposals refresh <id>");
    const status = str(v.status);
    if (status && !(STATUSES as string[]).includes(status)) throw new UsageError(`--status must be one of ${STATUSES.join(", ")}`);
    const list = await api.proposals({ mine: v.all ? undefined : "1", status, skill: str(v.skill) });
    if (!list.length) ctx.out.line(v.all ? "No proposals." : "You have no proposals. `intra proposals --all` shows everyone's.");
    else
      ctx.out.table(
        ["ID", "SKILL", "VERSION", "STATUS", "BY", "PULL REQUEST", "MESSAGE"],
        list.map((p) => [p.id, p.skill, p.version, p.status, p.proposer.handle, p.pullRequest?.url ?? "-", p.statusMessage]),
        { maxWidth: ctx.out.width, flex: 6 },
      );
    ctx.out.result({ proposals: list });
  },
};
