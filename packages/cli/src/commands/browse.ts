import { NAME_RE, type Behavior, type PluginComponents, type RuleSpec, type SkillSummary, type TokenEstimate, type Trust } from "@intra-skills/shared";
import { list, str, type Command, type Ctx } from "../command.js";
import { ApiError, CliError, UsageError } from "../errors.js";
import { parseSpec } from "../install.js";
import { normalizeRange, parseKinds } from "./manage.js";

/** One line per non-empty plugin component group. */
export function componentLines(c: PluginComponents): [string, string][] {
  const rows: [string, string][] = [];
  const add = (k: string, v: string[]) => v.length && rows.push([k, v.join(", ")]);
  add("commands", c.commands.map((x) => `/${x}`));
  add("skills", c.skills);
  add("agents", c.agents);
  add("hooks", c.hooks);
  add("mcp", c.mcpServers.map((m) => `${m.name} (${m.transport === "stdio" ? "local process" : "remote"}: ${m.target})`));
  add("lsp", c.lspServers);
  add("bin", c.bin);
  add("monitors", c.monitors);
  add("styles", c.outputStyles);
  return rows;
}

export function ruleText(r: RuleSpec): string {
  if (r.mode === "always") return "applies in every session (alwaysApply)";
  if (r.mode === "globs") return `applies to files matching ${r.globs.join(", ")}`;
  return "the agent decides from the description (Claude Code loads it every session)";
}

/** How to install a package of this kind, for the human view. */
export function installHint(s: SkillSummary): string {
  if (s.kind === "plugin") return `intra install ${s.name}   (through Claude Code; --project to enable it for the repo)`;
  if (s.kind === "rule") return `intra install ${s.name} --project   (renders .claude/rules, .cursor/rules and AGENTS.md)`;
  return `intra install ${s.name}`;
}

/** Short flags after a skill name in tables: verified, stale, private, deprecated. */
function flags(s: SkillSummary): string {
  const f = [s.verified && "verified", s.health === "stale" && "stale", s.visibility === "private" && "private", s.deprecated && "deprecated"].filter(Boolean);
  return f.length ? ` (${f.join(", ")})` : "";
}

export function trustText(t: Trust | undefined): string {
  if (!t) return "-";
  return `${t.works} works, ${t.broken} broken${t.mine ? ` (you: ${t.mine})` : ""}`;
}

export function tokensText(t: TokenEstimate | null | undefined): string {
  if (!t) return "unknown (published before v2)";
  return `~${t.metadata} always loaded, ~${t.body} when used, ~${t.references} in other files`;
}

/** Ask-tier first, then info; one line each with file:line. */
export function behaviorLines(ctx: Ctx, behaviors: Behavior[], indent = "  "): string[] {
  const sorted = [...behaviors].sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "ask" ? -1 : 1));
  return sorted.map((b) => {
    const where = `${b.file}${b.line !== null ? `:${b.line}` : ""}`;
    const tag = b.tier === "ask" ? ctx.out.c("yellow", "ask ") : ctx.out.c("dim", "info");
    return `${indent}${tag} ${b.label} (${where})${b.match && b.match !== b.file ? ctx.out.c("dim", `  ${b.match}`) : ""}`;
  });
}

export const search: Command = {
  name: "search",
  summary: "Find skills, rules and plugins in the registry",
  help: `Usage: intra search [query] [--kind skill|plugin|rule] [--team t] [--stack s] [--area a] [--tool claude]
                    [--tag x] [--private] [--verified] [--sort updated|name|downloads|trending] [--json]

Filters repeat or take comma lists; values within one filter are OR, across filters AND.
--kind limits the results to skills, Claude Code plugins or rules.
--stack filters by tech stack (react, terraform, python, ...); \`intra suggest\` finds the ones your repo uses.`,
  options: {
    kind: { type: "string", multiple: true },
    team: { type: "string", multiple: true },
    stack: { type: "string", multiple: true },
    verified: { type: "boolean" },
    sort: { type: "string" },
    area: { type: "string", multiple: true },
    tool: { type: "string", multiple: true },
    tag: { type: "string", multiple: true },
    private: { type: "boolean" },
  },
  async run(ctx, v, pos) {
    const api = ctx.api();
    const kinds = parseKinds(v.kind);
    const res = await api.listSkills({
      q: pos.join(" ") || undefined,
      kind: kinds ?? undefined,
      team: list(v.team),
      area: list(v.area),
      tool: list(v.tool),
      tag: list(v.tag),
      stack: list(v.stack),
      visibility: v.private ? "private" : undefined,
      verified: v.verified ? "1" : undefined,
      sort: str(v.sort),
    });
    if (!res.skills.length) ctx.out.line(kinds ? `No ${kinds.join(" or ")} packages found.` : "Nothing found.");
    else {
      ctx.out.table(
        ["NAME", "KIND", "VERSION", "TEAM", "STACKS", "WEEK", "DESCRIPTION"],
        res.skills.map((s) => [
          s.name + flags(s),
          s.kind ?? "skill",
          s.latestVersion ?? "-",
          s.team ?? "-",
          (s.stacks ?? []).join(",") || "-",
          String(s.installsWeek ?? 0),
          s.description,
        ]),
        { maxWidth: ctx.out.width, flex: 6 },
      );
      if (res.total > res.skills.length) ctx.out.line(ctx.out.c("dim", `${res.skills.length} of ${res.total} shown`));
    }
    ctx.out.result({ skills: res.skills, total: res.total, facets: res.facets });
  },
};

export const info: Command = {
  name: "info",
  summary: "Show a package's details (skill, rule or plugin)",
  help: `Usage: intra info <name> [--kind skill|plugin|rule] [--versions] [--json]

Shows the kind, facets, trust, the latest version's behaviors, and what is inside: a plugin's
commands, skills, agents, hooks and servers, or when a rule applies.

Options:
  --kind <kind>   fail unless the package is this kind (useful in scripts)
  --versions      list every version`,
  options: { versions: { type: "boolean" }, kind: { type: "string" } },
  async run(ctx, v, pos) {
    const name = pos[0];
    if (!name) throw new UsageError("usage: intra info <name>");
    const want = parseKinds(v.kind);
    const s = await ctx.api().skill(name);
    const kind = s.kind ?? "skill";
    if (want && !want.includes(kind)) throw new CliError(`${name} is a ${kind}, not a ${want.join(" or ")}`, "wrong_kind");
    const o = ctx.out;
    o.line(`${o.c("bold", s.name)} ${s.latestVersion ?? "(no versions)"}${s.deprecated ? o.c("yellow", `  DEPRECATED: ${s.deprecated}`) : ""}`);
    o.line(s.description);
    o.line();
    const rows: [string, string][] = [
      ["kind", kind === "plugin" ? "plugin (Claude Code)" : kind],
      ["visibility", s.visibility],
      ["team", s.team ?? "-"],
      ["areas", s.areas.join(", ") || "-"],
      ["tools", s.tools.join(", ") || "-"],
      ["stacks", (s.stacks ?? []).join(", ") || "-"],
      ["tags", s.tags.join(", ") || "-"],
      ["health", s.health ?? "-"],
      ["verified", s.verified ? `yes${s.verification ? ` (${s.verification.version} by ${s.verification.by.handle})` : ""}` : "no"],
      ["trust", trustText(s.trust)],
      ["downloads", `${s.downloads} total, ${s.installsWeek ?? 0} this week`],
      ["source", s.source ? `${s.source.provider} ${s.source.repo} ${s.source.path} (edit it there: ${s.source.webUrl})` : "published here"],
      ["created", `${s.createdAt} by ${s.createdBy}`],
      ["updated", s.updatedAt],
      ["you can", [s.permissions.canWrite && "write", s.permissions.canAdmin && "admin"].filter(Boolean).join(", ") || "read"],
    ];
    for (const [k, val] of rows) o.line(`${o.c("dim", k.padEnd(11))}${val}`);
    if (s.grants?.length) o.line(`${o.c("dim", "grants".padEnd(11))}${s.grants.map((g) => `${g.principalType}:${g.principal}=${g.permission}`).join(", ")}`);
    const latest = s.versions.find((x) => x.version === s.latestVersion) ?? null;
    if (latest?.plugin) for (const [k, val] of componentLines(latest.plugin)) o.line(`${o.c("dim", k.padEnd(11))}${val}`);
    if (latest?.rule) o.line(`${o.c("dim", "applies".padEnd(11))}${ruleText(latest.rule)}`);
    o.line(`${o.c("dim", "install".padEnd(11))}${installHint({ ...s, kind })}`);
    if (latest) {
      o.line(`${o.c("dim", "tokens".padEnd(11))}${tokensText(latest.tokens)}`);
      const behaviors = latest.behaviors ?? [];
      o.line(`${o.c("dim", "behaviors".padEnd(11))}${behaviors.length ? `${behaviors.filter((b) => b.tier === "ask").length} to approve, ${behaviors.filter((b) => b.tier === "info").length} to know (${latest.version})` : "none found"}`);
      for (const l of behaviorLines(ctx, behaviors)) o.line(l);
    }
    if (s.proposals?.length)
      o.line(`${o.c("dim", "proposals".padEnd(11))}${s.proposals.map((p) => `${p.version} ${p.status}${p.pullRequest ? ` ${p.pullRequest.url}` : ""}`).join("; ")}`);
    if (v.versions) {
      o.line();
      o.table(
        ["VERSION", "PUBLISHED", "BY", "FILES", "SIZE", "STATUS", "CHANGELOG"],
        s.versions.map((x) => [
          x.version,
          x.publishedAt.slice(0, 10),
          x.publishedBy,
          String(x.fileCount),
          String(x.size),
          x.yanked ? `yanked: ${x.yanked}` : "",
          x.changelog,
        ]),
        { maxWidth: o.width, flex: 6 },
      );
    } else if (s.versions.length) o.line(o.c("dim", `${s.versions.length} version(s); --versions to list them`));
    o.result({ skill: s });
  },
};

export const diff: Command = {
  name: "diff",
  summary: "Show what changed between two versions",
  help: `Usage: intra diff <name> <from> [to] [--json]

<to> defaults to the latest version. Colourised when stdout is a terminal.`,
  async run(ctx, _v, pos) {
    const [name, from, toArg] = pos;
    if (!name || !from) throw new UsageError("usage: intra diff <name> <from> [to]");
    const api = ctx.api();
    const to = toArg ?? (await api.skill(name)).latestVersion;
    if (!to) throw new UsageError(`${name} has no published version to compare against`);
    const d = await api.diff(name, from, to);
    const o = ctx.out;
    const changed = d.files.filter((f) => f.status !== "unchanged");
    o.line(o.c("bold", `${name} ${d.from} -> ${d.to}: ${changed.length} file(s) changed`));
    for (const f of changed) {
      o.line();
      o.line(o.c("bold", `${f.status.toUpperCase()} ${f.path}`));
      if (f.binary) o.line(o.c("dim", "  (binary)"));
      else if (f.patch)
        for (const l of f.patch.replace(/\n$/, "").split("\n")) {
          if (l.startsWith("+++") || l.startsWith("---")) o.line(o.c("bold", l));
          else if (l.startsWith("+")) o.line(o.c("green", l));
          else if (l.startsWith("-")) o.line(o.c("red", l));
          else if (l.startsWith("@@")) o.line(o.c("cyan", l));
          else o.line(l);
        }
    }
    o.result({ diff: d });
  },
};

export const run: Command = {
  name: "run",
  summary: "Print a skill's SKILL.md for one task without installing it",
  help: `Usage: intra run <name[@range]> [--file <path>] [--json]

Resolves the version, prints a short header (version, owner team, source repo and every
behavior that needs the user's approval, with file:line), then SKILL.md, then the file list.
Writes nothing to disk. An agent can follow the printed SKILL.md for the current task.

Options:
  --file <path>   print one other file of that version instead (e.g. scripts/check.sh)
  --json          {name, version, skillMd, files, behaviors, tokens}`,
  options: { file: { type: "string" } },
  async run(ctx, v, pos) {
    if (!pos[0]) throw new UsageError("usage: intra run <name[@range]>");
    const { name, range } = parseSpec(pos[0]);
    if (!NAME_RE.test(name)) throw new UsageError(`"${name}" is not a valid skill name`);
    const norm = normalizeRange(range);
    const api = ctx.api();
    const version = await api.resolve(name, norm).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404)
        throw new CliError(`no version of ${name} matches ${norm} (or the skill does not exist / is not visible to you)`, "not_found");
      throw err;
    });
    const o = ctx.out;
    const file = str(v.file);
    if (file) {
      const content = await api.versionFile(name, version, file);
      if (!o.json) ctx.io.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
      o.result({ name, version, path: file, content });
      return;
    }
    const [detail, skill] = await Promise.all([api.version(name, version), api.skill(name)]);
    const behaviors = detail.behaviors ?? [];
    const ask = behaviors.filter((b) => b.tier === "ask");
    o.line(o.c("bold", `intra run ${name}@${version}`) + o.c("dim", " (nothing was installed or written)"));
    o.line(`owner team: ${skill.team ?? "none"}`);
    if (skill.source) o.line(`source: ${skill.source.provider} ${skill.source.repo} ${skill.source.path} ${skill.source.webUrl}`);
    if (ask.length) {
      o.line(o.c("yellow", "behaviors that need approval - show these to the user before following this skill:"));
      for (const l of behaviorLines(ctx, ask)) o.line(l);
    } else o.line("behaviors that need approval: none found by the scan");
    o.line(`tokens: ${tokensText(detail.tokens)}`);
    o.line(o.c("dim", "----- SKILL.md -----"));
    if (!o.json) ctx.io.stdout.write(detail.skillMd.endsWith("\n") ? detail.skillMd : `${detail.skillMd}\n`);
    o.line(o.c("dim", `----- files (read one with \`intra run ${name}@${version} --file <path>\`) -----`));
    for (const f of detail.files) o.line(`  ${String(f.size).padStart(8)}  ${f.path}`);
    o.result({ name, version, skillMd: detail.skillMd, files: detail.files, behaviors, tokens: detail.tokens ?? null });
  },
};

export const vote: Command = {
  name: "vote",
  summary: "Say whether a skill works for you (works or broken)",
  help: `Usage: intra vote <name> works|broken [--note "..."] [--json]

Records your vote on the latest version; a new vote replaces your previous one.
The tally shows in \`intra info\` and the console.

Options:
  --note <text>   one-line reason, at most 280 characters`,
  options: { note: { type: "string" } },
  async run(ctx, v, [name, verdict]) {
    if (!name || (verdict !== "works" && verdict !== "broken")) throw new UsageError("usage: intra vote <name> works|broken [--note \"...\"]");
    const note = str(v.note);
    if (note && note.length > 280) throw new UsageError("--note is at most 280 characters");
    const trust = await ctx.api().vote(name, { works: verdict === "works", ...(note ? { note } : {}) });
    ctx.out.line(`Recorded "${verdict}" for ${name}. Now ${trustText(trust)}.`);
    ctx.out.result({ name, trust });
  },
};
