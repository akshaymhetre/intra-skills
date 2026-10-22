import type { Grant, Permission, PrincipalType, TeamRole } from "@intra-skills/shared";
import { str, type Command } from "../command.js";
import { UsageError } from "../errors.js";

const need = (cond: unknown, usage: string): void => {
  if (!cond) throw new UsageError(`usage: ${usage}`);
};

export const yank: Command = {
  name: "yank",
  summary: "Hide a version from range resolution (lockfiles keep working)",
  help: `Usage: intra yank <name> <version> --reason <text>`,
  options: { reason: { type: "string" } },
  async run(ctx, v, [name, version]) {
    need(name && version && str(v.reason), "intra yank <name> <version> --reason <text>");
    const m = await ctx.api().yank(name!, version!, str(v.reason)!);
    ctx.out.line(`yanked ${name}@${m.version}: ${m.yanked}`);
    ctx.out.result({ version: m });
  },
};

export const unyank: Command = {
  name: "unyank",
  summary: "Restore a yanked version",
  help: `Usage: intra unyank <name> <version>`,
  async run(ctx, _v, [name, version]) {
    need(name && version, "intra unyank <name> <version>");
    const m = await ctx.api().unyank(name!, version!);
    ctx.out.line(`restored ${name}@${m.version}`);
    ctx.out.result({ version: m });
  },
};

export const deprecate: Command = {
  name: "deprecate",
  summary: "Mark a skill deprecated (or --undo)",
  help: `Usage: intra deprecate <name> --message <text>
       intra deprecate <name> --undo`,
  options: { message: { type: "string" }, undo: { type: "boolean" } },
  async run(ctx, v, [name]) {
    need(name && (str(v.message) || v.undo) && !(str(v.message) && v.undo), "intra deprecate <name> --message <text> | --undo");
    const s = await ctx.api().patchSkill(name!, { deprecated: v.undo ? null : str(v.message)! });
    ctx.out.line(s.deprecated ? `deprecated ${s.name}: ${s.deprecated}` : `${s.name} is no longer deprecated`);
    ctx.out.result({ skill: s });
  },
};

export const visibility: Command = {
  name: "visibility",
  summary: "Make a skill visible to the whole org or private",
  help: `Usage: intra visibility <name> org|private`,
  async run(ctx, _v, [name, vis]) {
    need(name && (vis === "org" || vis === "private"), "intra visibility <name> org|private");
    const s = await ctx.api().patchSkill(name!, { visibility: vis as "org" | "private" });
    ctx.out.line(`${s.name} is now ${s.visibility}`);
    ctx.out.result({ skill: s });
  },
};

function principal(v: Record<string, unknown>, usage: string): { principalType: PrincipalType; principal: string } {
  const team = str(v.team as string | undefined);
  const user = str(v.user as string | undefined);
  need(Boolean(team) !== Boolean(user), usage);
  return team ? { principalType: "team", principal: team } : { principalType: "user", principal: user! };
}

const same = (a: Grant, b: { principalType: PrincipalType; principal: string }) => a.principalType === b.principalType && a.principal === b.principal;

export const grant: Command = {
  name: "grant",
  summary: "Give a team or user read or write access to a skill",
  help: `Usage: intra grant <name> (--team <slug> | --user <handle>) --perm read|write`,
  options: { team: { type: "string" }, user: { type: "string" }, perm: { type: "string" } },
  async run(ctx, v, [name]) {
    const usage = "intra grant <name> (--team <slug> | --user <handle>) --perm read|write";
    const perm = str(v.perm);
    need(name && (perm === "read" || perm === "write"), usage);
    const p = principal(v, usage);
    const api = ctx.api();
    const grants = (await api.grants(name!)).filter((g) => !same(g, p));
    const next = await api.setGrants(name!, [...grants, { ...p, permission: perm as Permission }]);
    ctx.out.line(`${p.principalType} ${p.principal} can now ${perm} ${name}`);
    ctx.out.result({ grants: next });
  },
};

export const revoke: Command = {
  name: "revoke",
  summary: "Remove a team's or user's grant on a skill",
  help: `Usage: intra revoke <name> (--team <slug> | --user <handle>)`,
  options: { team: { type: "string" }, user: { type: "string" } },
  async run(ctx, v, [name]) {
    const usage = "intra revoke <name> (--team <slug> | --user <handle>)";
    need(name, usage);
    const p = principal(v, usage);
    const api = ctx.api();
    const grants = await api.grants(name!);
    const next = grants.filter((g) => !same(g, p));
    if (next.length === grants.length) {
      ctx.out.line(`${p.principalType} ${p.principal} had no grant on ${name}`);
      ctx.out.result({ grants });
      return;
    }
    const saved = await api.setGrants(name!, next);
    ctx.out.line(`revoked ${p.principalType} ${p.principal} on ${name}`);
    ctx.out.result({ grants: saved });
  },
};

export const team: Command = {
  name: "team",
  summary: "List, create and manage teams",
  help: `Usage: intra team list
       intra team create <slug> --name <name> [--description <text>]   (admin)
       intra team add <slug> <handle> [--role member|maintainer]
       intra team remove <slug> <handle>`,
  options: { name: { type: "string" }, description: { type: "string" }, role: { type: "string" } },
  async run(ctx, v, [sub, slug, handle]) {
    const api = ctx.api();
    if (sub === "list" || sub === undefined) {
      const teams = await api.teams();
      if (!teams.length) ctx.out.line("No teams.");
      else ctx.out.table(["SLUG", "NAME", "MEMBERS", "SKILLS", "DESCRIPTION"], teams.map((t) => [t.slug, t.name, String(t.memberCount), String(t.skillCount), t.description]), { maxWidth: ctx.out.width, flex: 4 });
      ctx.out.result({ teams });
      return;
    }
    if (sub === "create") {
      need(slug, "intra team create <slug> --name <name> [--description <text>]");
      const t = await api.createTeam({ slug: slug!, name: str(v.name) ?? slug!, description: str(v.description) });
      ctx.out.line(`created team ${t.slug}`);
      ctx.out.result({ team: t });
      return;
    }
    if (sub === "add") {
      const role = (str(v.role) ?? "member") as TeamRole;
      need(slug && handle && (role === "member" || role === "maintainer"), "intra team add <slug> <handle> [--role member|maintainer]");
      const t = await api.setMember(slug!, handle!, role);
      ctx.out.line(`${handle} is a ${role} of ${t.slug}`);
      ctx.out.result({ team: t });
      return;
    }
    if (sub === "remove") {
      need(slug && handle, "intra team remove <slug> <handle>");
      const t = await api.removeMember(slug!, handle!);
      ctx.out.line(`removed ${handle} from ${t.slug}`);
      ctx.out.result({ team: t });
      return;
    }
    throw new UsageError(`unknown subcommand "${sub}"; use list, create, add or remove`);
  },
};

export const user: Command = {
  name: "user",
  summary: "Create users (admin)",
  help: `Usage: intra user create <handle> [--name <display name>] [--role member|admin]

Prints the new user's first token ONCE; hand it to them over a private channel.`,
  options: { name: { type: "string" }, role: { type: "string" } },
  async run(ctx, v, [sub, handle]) {
    need(sub === "create" && handle, "intra user create <handle> [--name <display name>] [--role member|admin]");
    const role = str(v.role);
    if (role && role !== "member" && role !== "admin") throw new UsageError("--role must be member or admin");
    const res = await ctx.api().createUser({ handle: handle!, displayName: str(v.name) ?? handle!, role });
    ctx.out.line(`created ${res.user.handle} (${res.user.role})`);
    ctx.out.line(`token (shown once): ${res.token}`);
    ctx.out.line(ctx.out.c("dim", `they run: intra login --registry ${ctx.api().registry} --token <token>`));
    ctx.out.result({ user: res.user, token: res.token });
  },
};

export const token: Command = {
  name: "token",
  summary: "List, create and revoke your API tokens",
  help: `Usage: intra token list
       intra token create <name>
       intra token revoke <id>`,
  async run(ctx, _v, [sub, arg]) {
    const api = ctx.api();
    if (sub === "list" || sub === undefined) {
      const tokens = await api.tokens();
      if (!tokens.length) ctx.out.line("No tokens.");
      else ctx.out.table(["ID", "NAME", "PREFIX", "CREATED", "LAST USED"], tokens.map((t) => [t.id, t.name, t.prefix, t.createdAt.slice(0, 10), t.lastUsedAt?.slice(0, 10) ?? "never"]));
      ctx.out.result({ tokens });
      return;
    }
    if (sub === "create") {
      need(arg, "intra token create <name>");
      const res = await api.createToken(arg!);
      ctx.out.line(`token ${res.meta.name} (${res.meta.id}), shown once:`);
      ctx.out.line(res.token);
      ctx.out.result({ token: res.token, meta: res.meta });
      return;
    }
    if (sub === "revoke") {
      need(arg, "intra token revoke <id>");
      await api.revokeToken(arg!);
      ctx.out.line(`revoked token ${arg}`);
      ctx.out.result({ revoked: arg });
      return;
    }
    throw new UsageError(`unknown subcommand "${sub}"; use list, create or revoke`);
  },
};
