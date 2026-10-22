import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
  NAME_RE,
  TEAM_RE,
  TOOLS,
  addsAskBehavior,
  askBehaviorIds,
  compareVersions,
  isValidRange,
  parseVersion,
  type Behavior,
  type PackageKind,
  type SkillDetail,
  type ToolId,
} from "@intra-skills/shared";
import type { Api } from "../api.js";
import { list, projectRoot, type Command, type Ctx, type Values } from "../command.js";
import { loadConfig, parseTargets } from "../config.js";
import { ApiError, CliError, UsageError } from "../errors.js";
import { hashDir } from "../files.js";
import {
  classify,
  cursorDuplicateNote,
  installVersion,
  isManaged,
  parseSpec,
  removeManaged,
  targetPath,
  type InstallResult,
  type Scope,
} from "../install.js";
import { kindOf, readInstalled, readLockfile, sortTargets, writeInstalled, writeLockfile, lockfilePath, type LockEntry, type Lockfile } from "../lockfile.js";
import { claudeBin, claudePlugin, connectionFor, connectMarketplace, NO_CLAUDE } from "../plugins.js";
import { installRule, planRuleSync, removeRule, RULE_TARGETS } from "../rules.js";
import { findProjectRoot, globalToolDir, isDir, projectToolDir, storeRoot } from "../paths.js";
import { confirm, interactive } from "../prompt.js";

/** `^1` -> `^1.0.0`, `~1.2` -> `~1.2.0`, `1` -> `^1.0.0`, `1.2` -> `~1.2.0`, empty/`*` -> `latest`. */
export function normalizeRange(range: string | null): string {
  const r = (range ?? "").trim();
  if (r === "" || r === "*" || r === "latest") return "latest";
  const op = r.startsWith("^") || r.startsWith("~") ? r[0] : "";
  const body = op ? r.slice(1) : r;
  let out = r;
  if (/^\d+$/.test(body)) out = `${op || "^"}${body}.0.0`;
  else if (/^\d+\.\d+$/.test(body)) out = `${op || "~"}${body}.0`;
  if (!isValidRange(out)) throw new UsageError(`"${range}" is not a valid range; use 1.2.3, ^1.2.3, ~1.2.3 or latest`);
  return out;
}

/** What to record when the user gave no range: caret on the resolved version (npm-style). */
const defaultRange = (version: string): string => (parseVersion(version)?.pre.length ? version : `^${version}`);

function scopeOf(ctx: Ctx, v: Values): Scope {
  const root = projectRoot(ctx, v.project);
  return root ? { kind: "project", root } : { kind: "global" };
}

function where(scope: Scope): string {
  return scope.kind === "global" ? "global" : `project ${scope.root}`;
}

function reportInstall(ctx: Ctx, r: InstallResult & { kind?: PackageKind; scope?: string }, verb: string): void {
  const what = r.kind === "plugin" ? `Claude Code (${r.scope ?? "user"})` : r.targets.join(", ");
  ctx.out.line(`${ctx.out.c("green", "✓")} ${verb} ${r.kind && r.kind !== "skill" ? `${r.kind} ` : ""}${ctx.out.c("bold", `${r.name}@${r.version}`)} -> ${what}`);
  for (const p of r.paths) ctx.out.line(ctx.out.c("dim", `    ${p}`));
  for (const b of r.backups) ctx.out.line(`    backed up the previous contents to ${b}`);
}

function warnRegistryMismatch(ctx: Ctx, lock: Lockfile | null, api: Api): void {
  if (lock && lock.registry && lock.registry !== api.registry)
    ctx.out.warn(`skills.lock.json was written against ${lock.registry} but you are logged in to ${api.registry}`);
}

const PROJECT_HELP = `  --project[=dir]     work on a project instead of globally: copies into <root>/.claude/skills etc.
                      and records skills.lock.json. Root = dir (use ./name or a path), else the
                      nearest ancestor with .git, else the current directory`;

export const install: Command = {
  name: "install",
  summary: "Install skills, rules and Claude Code plugins",
  help: `Usage: intra install <name[@range] | @team/collection>... [options]

Ranges: 1.2.3 (exact), ^1.2.3, ~1.2.3, latest (default; records ^<resolved version>).
@team/collection installs every package in a team's collection (each is recorded on its own,
whatever its kind). Every bundle is verified (per-file and bundle sha256) before anything is written.

Skills, global (default): extract to $INTRA_SKILLS_HOME/store/<name>/<version>/ and symlink
~/.claude/skills/<name>, ~/.agents/skills/<name> (codex), ~/.cursor/skills/<name>.

Rules are always a project install (Cursor reads project rules only, Codex reads the repo's
AGENTS.md). Without --project they go into the nearest ancestor with .git. Targets default to
claude,codex,cursor; --to narrows:
  claude  .claude/rules/<name>.md        cursor  .cursor/rules/<name>.mdc
  codex   a managed block in the project's root AGENTS.md (created when missing)
A rule file intra did not write, or one edited since, is never overwritten without --force.

Plugins install through Claude Code: intra connects the registry's plugin marketplace once
(\`intra plugins connect\`, run for you on first use), then runs
\`claude plugin install <name>@<marketplace> --scope user\`. With --project it uses
--scope project, which records the plugin in the project's .claude/settings.json so everyone
who clones gets it; each teammate runs \`intra plugins connect\` once. Claude Code installs
the latest version the marketplace offers, so a range is ignored. Set INTRA_CLAUDE_BIN to use
a \`claude\` that is not on PATH.

Options:
  --to <list>         targets: claude,codex,cursor (skills default: config defaultTargets, initially
                      claude,codex; rules default: all three; plugins: Claude Code only)
${PROJECT_HELP}
  --global            skills and plugins: the default; rules refuse it
  --copy              skills, global only: copy the files (plus a marker) instead of symlinking
  --force             move an existing non-intra directory or rule file aside to
                      $INTRA_SKILLS_HOME/backup/<timestamp>/ instead of refusing
  --json              print the results as JSON

Examples:
  intra install pr-review
  intra install pr-review@^1 terraform-plan --to claude,cursor
  intra install pr-review --project
  intra install no-default-exports --project      (a rule)
  intra install release-tools                     (a plugin)
  intra install @platform/starter`,
  options: {
    to: { type: "string", multiple: true },
    project: { type: "string" },
    global: { type: "boolean" },
    force: { type: "boolean" },
    copy: { type: "boolean" },
  },
  async run(ctx, v, pos) {
    if (!pos.length) throw new UsageError("usage: intra install <name[@range] | @team/collection>...");
    if (v.global && v.project !== undefined) throw new UsageError("pass --global or --project, not both");
    const api = ctx.api();
    const requestedTo = list(v.to).length ? parseTargets(list(v.to).join(",")) : null;
    const scope = scopeOf(ctx, v);
    const lock: Lockfile | null = scope.kind === "project" ? readLockfile(scope.root) : null;
    warnRegistryMismatch(ctx, lock, api);
    const results: (InstallOutcome & { range: string })[] = [];
    const failures: { spec: string; error: string }[] = [];
    const collections: { spec: string; skills: string[] }[] = [];
    const notes: string[] = [];
    const note = (text: string) => {
      if (notes.includes(text)) return;
      notes.push(text);
      ctx.out.line(ctx.out.c("dim", `note: ${text}`));
    };
    const specs: string[] = [];
    for (const spec of pos) {
      const c = /^@([^/@]+)\/([^/@]+)$/.exec(spec);
      if (!c) {
        specs.push(spec);
        continue;
      }
      try {
        if (!TEAM_RE.test(c[1]!) || !TEAM_RE.test(c[2]!)) throw new UsageError(`"${spec}" is not a collection; use @team/slug`);
        const col = await api.collection(c[1]!, c[2]!).catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 404) throw new CliError(`no collection ${spec} (or it is not visible to you)`, "not_found");
          throw err;
        });
        collections.push({ spec, skills: col.skills });
        ctx.out.line(`${spec}: ${col.title || spec} (${col.skills.length} package${col.skills.length === 1 ? "" : "s"})`);
        if (!col.skills.length) ctx.out.warn(`${spec} has no packages you can read`);
        for (const n of col.skills) if (!specs.includes(n)) specs.push(n);
      } catch (err) {
        if (!(err instanceof CliError) || err instanceof UsageError) throw err;
        failures.push({ spec, error: err.message });
        ctx.out.line(`${ctx.out.c("red", "✗")} ${spec}: ${err.message}`);
      }
    }
    for (const spec of specs) {
      const { name, range } = parseSpec(spec);
      try {
        if (!NAME_RE.test(name)) throw new UsageError(`"${name}" is not a valid package name`);
        const norm = normalizeRange(range);
        const detail = await packageDetail(api, name);
        const kind: PackageKind = detail.kind ?? "skill";
        let r: InstallOutcome & { range: string };
        if (kind === "plugin") {
          if (range) note(`${name} is a plugin: Claude Code installs the latest version its marketplace offers, so "@${range}" is ignored`);
          if (requestedTo && !requestedTo.includes("claude")) note(`${name} is a plugin; plugins install into Claude Code only`);
          r = await installPlugin(ctx, api, detail, scope, note);
        } else {
          const version = await resolveVersion(api, name, norm);
          const recorded = range ? norm : defaultRange(version);
          if (kind === "rule") {
            if (v.global)
              throw new CliError(
                `${name} is a rule, and rules are project files (Cursor reads project rules only; Codex reads the repo's AGENTS.md). Run it without --global, or with --project[=dir]`,
                "rule_global",
              );
            const root = scope.kind === "project" ? scope.root : findProjectRoot(ctx.io.cwd);
            if (scope.kind !== "project") note(`rules always install into a project; using ${root} (pass --project[=dir] to choose another)`);
            const prev = readLockfile(root)?.skills[name];
            const defaults = RULE_TARGETS.filter((t) => !detail.tools?.length || detail.tools.includes(t));
            const targets = sortTargets([...new Set([...(prev?.targets ?? []), ...(requestedTo ?? (defaults.length ? defaults : RULE_TARGETS))])]);
            const res = await installRule({ api, name, version, root, targets, prev, force: Boolean(v.force) });
            recordEntry({ kind: "project", root }, api, name, {
              kind: "rule",
              range: recorded,
              version,
              sha256: res.sha256,
              targets,
              rendered: { ...(prev?.rendered ?? {}), ...res.rendered },
            });
            r = { name, kind, version, sha256: res.sha256, targets, paths: res.paths, backups: res.backups, scope: `project ${root}`, range: recorded };
          } else {
            const prev = scope.kind === "global" ? readInstalled()[name] : lock?.skills[name];
            // One version per skill per scope: re-point targets installed earlier as well.
            const targets = sortTargets([...new Set([...(prev?.targets ?? []), ...(requestedTo ?? loadConfig().defaultTargets)])]);
            const res = await installVersion({ api, name, version, targets, scope, force: Boolean(v.force), copy: Boolean(v.copy) });
            recordEntry(scope, api, name, { range: recorded, version, sha256: res.sha256, targets });
            r = { ...res, kind, scope: where(scope), range: recorded };
            const dup = cursorDuplicateNote(targets);
            if (dup) ctx.out.line(ctx.out.c("dim", dup));
          }
        }
        results.push(r);
        reportInstall(ctx, r, "installed");
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        if (err instanceof UsageError) throw err;
        failures.push({ spec, error: err.message });
        ctx.out.line(`${ctx.out.c("red", "✗")} ${spec}: ${err.message}`);
      }
    }
    ctx.out.result({
      scope: where(scope),
      installed: results,
      failed: failures,
      ...(collections.length ? { collections } : {}),
      ...(notes.length ? { notes } : {}),
    });
    return failures.length ? 1 : 0;
  },
};

export interface InstallOutcome extends InstallResult {
  kind: PackageKind;
  /** Where it went: "global", "project <root>", or for plugins "claude user" / "claude project <root>". */
  scope: string;
}

async function packageDetail(api: Api, name: string): Promise<SkillDetail> {
  return api.skill(name).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) throw new CliError(`no package ${name} in the registry (or it is not visible to you)`, "not_found");
    throw err;
  });
}

async function resolveVersion(api: Api, name: string, norm: string): Promise<string> {
  return api.resolve(name, norm).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404)
      throw new CliError(`no version of ${name} matches ${norm} (or the skill does not exist / is not visible to you)`, "not_found");
    throw err;
  });
}

/** Connect the marketplace when needed, then `claude plugin install`. Nothing is minted without `claude`. */
async function installPlugin(ctx: Ctx, api: Api, detail: SkillDetail, scope: Scope, note: (t: string) => void): Promise<InstallOutcome & { range: string }> {
  const name = detail.name;
  if (!claudeBin()) throw new CliError(NO_CLAUDE, "no_claude");
  const conn = await connectMarketplace(api, ctx.io.cwd);
  if (conn.status === "connected") ctx.out.line(`${ctx.out.c("green", "✓")} connected the ${conn.marketplaceName} plugin marketplace to Claude Code`);
  const pscope = scope.kind === "project" ? "project" : "user";
  const cwd = scope.kind === "project" ? scope.root : ctx.io.cwd;
  claudePlugin(["install", `${name}@${conn.marketplaceName}`, "--scope", pscope], cwd);
  const version = detail.latestVersion ?? (await resolveVersion(api, name, "latest"));
  const sha256 = detail.versions.find((x) => x.version === version)?.sha256 ?? "";
  recordEntry(scope, api, name, { kind: "plugin", range: "latest", version, sha256, targets: ["claude"], scope: pscope });
  if (pscope === "project")
    note(`Claude Code recorded the plugin in ${cwd}/.claude/settings.json; commit it, and each teammate runs \`intra plugins connect\` once`);
  return {
    name,
    kind: "plugin",
    version,
    sha256,
    targets: ["claude"],
    paths: [],
    backups: [],
    scope: pscope === "project" ? `claude project ${cwd}` : "claude user",
    range: "latest",
  };
}

function recordEntry(scope: Scope, api: Api, name: string, entry: LockEntry): void {
  if (scope.kind === "global") {
    const data = readInstalled();
    data[name] = { ...entry, installedAt: new Date().toISOString() };
    writeInstalled(data);
  } else {
    const lock = readLockfile(scope.root) ?? { lockfileVersion: 1 as const, registry: api.registry, skills: {} };
    lock.registry = api.registry;
    lock.skills[name] = entry;
    writeLockfile(scope.root, lock);
  }
}

interface Row {
  name: string;
  kind: PackageKind;
  range: string;
  version: string;
  targets: ToolId[];
  /** Plugins: the Claude Code scope. */
  scope?: "user" | "project";
  problems: string[];
  updateAvailable: string | null;
}

/** Resolve each entry's range; an offline registry is reported once and skipped, never fatal. */
async function checkUpdates(ctx: Ctx, rows: Row[]): Promise<void> {
  let api: Api;
  try {
    api = ctx.api();
  } catch {
    ctx.out.warn("not logged in; skipping the update check");
    return;
  }
  for (const r of rows) {
    try {
      const latest = await api.resolve(r.name, r.range);
      if (compareVersions(latest, r.version) > 0) r.updateAvailable = latest;
    } catch (err) {
      if (err instanceof ApiError && err.offline) {
        ctx.out.warn(`${err.message}; skipping the update check`);
        return;
      }
      if (err instanceof ApiError && err.status === 404) r.problems.push(`nothing in the registry matches ${r.range}`);
      else throw err;
    }
  }
}

function skillProblems(scope: Scope, name: string, e: LockEntry): string[] {
  const problems: string[] = [];
  for (const t of e.targets) {
    const st = classify(targetPath(scope, t, name), name);
    if (st.kind === "missing") problems.push(`${t}: missing`);
    else if (st.kind === "unmanaged") problems.push(`${t}: replaced by a non-intra directory`);
    else if (st.kind === "link" && st.dangling) problems.push(`${t}: dangling link`);
    else if (st.kind === "managed-dir" && st.version !== e.version) problems.push(`${t}: has ${st.version}`);
  }
  return problems;
}

export const listCmd: Command = {
  name: "list",
  summary: "Show installed skills, rules and plugins, and available updates",
  help: `Usage: intra list [--project[=dir]] [--kind skill|plugin|rule] [--offline] [--json]

Global (default): skills linked into your tools and plugins installed at Claude Code's user scope.
--project: what the project's skills.lock.json records (skills, rules, project-scope plugins).
Plugins are managed by Claude Code, so their files are not checked here.

Options:
${PROJECT_HELP}
  --kind <list>       only these kinds
  --offline           do not contact the registry for updates`,
  options: { project: { type: "string" }, offline: { type: "boolean" }, kind: { type: "string", multiple: true } },
  async run(ctx, v) {
    const scope = scopeOf(ctx, v);
    const kinds = parseKinds(v.kind);
    const entries: Record<string, LockEntry> = scope.kind === "global" ? readInstalled() : (readLockfile(scope.root)?.skills ?? {});
    const rows: Row[] = Object.entries(entries)
      .filter(([, e]) => !kinds || kinds.includes(kindOf(e)))
      .map(([name, e]) => {
        const kind = kindOf(e);
        const problems =
          kind === "skill"
            ? skillProblems(scope, name, e)
            : kind === "rule" && scope.kind === "project"
              ? planRuleSync(scope.root, name, e).map((d) => `${d.target}: ${d.reason}`)
              : [];
        return { name, kind, range: e.range, version: e.version, targets: e.targets, ...(e.scope ? { scope: e.scope } : {}), problems, updateAvailable: null };
      });
    if (rows.length && !v.offline) await checkUpdates(ctx, rows);
    if (!rows.length) ctx.out.line(`Nothing installed (${where(scope)}).`);
    else
      ctx.out.table(
        ["NAME", "KIND", "VERSION", "RANGE", "TARGETS", "STATUS"],
        rows.map((r) => [
          r.name,
          r.kind,
          r.version,
          r.range,
          r.kind === "plugin" ? `claude (${r.scope ?? "user"} scope)` : r.targets.join(","),
          [r.updateAvailable ? ctx.out.c("yellow", `update available: ${r.updateAvailable}`) : "", ...r.problems.map((p) => ctx.out.c("red", p))]
            .filter(Boolean)
            .join("; ") || "ok",
        ]),
      );
    ctx.out.result({ scope: where(scope), skills: rows });
  },
};

export function parseKinds(value: Values[string]): PackageKind[] | null {
  const ks = list(value);
  if (!ks.length) return null;
  for (const k of ks) if (k !== "skill" && k !== "plugin" && k !== "rule") throw new UsageError(`unknown kind "${k}"; use skill, plugin or rule`);
  return ks as PackageKind[];
}

/** The marketplace name to address a plugin by: the recorded connection, else what the registry says. */
async function marketplaceName(ctx: Ctx, registry: string): Promise<string> {
  const conn = connectionFor(registry);
  if (conn) return conn.marketplaceName;
  const meta = await ctx.api({ requireToken: false }).meta().catch(() => null);
  if (meta?.marketplaceName) return meta.marketplaceName;
  throw new CliError("this machine has no plugin marketplace connection; run `intra plugins connect`", "not_connected");
}

export const update: Command = {
  name: "update",
  summary: "Move installed packages to the newest version their range allows",
  help: `Usage: intra update [name...] [--project[=dir]] [--yes] [--force] [--json]

Re-resolves each stored range and installs newer versions. Global links are swapped
atomically; the old store version stays until \`intra prune\`. Rules are re-rendered into
every target they were installed to. Plugins run \`claude plugin update <name>@<marketplace>\`.

When a newer version asks for something the installed one did not (a behavior that needs
approval, e.g. "Downloads a script and runs it", or a plugin hook), update shows it and asks
first. Without a terminal, or with --json, that package is skipped and reported unless --yes is given.

Options:
${PROJECT_HELP}
  --yes               apply updates that add behaviors needing approval
  --force             back up non-intra directories or edited rule files in the way instead of refusing`,
  options: { project: { type: "string" }, force: { type: "boolean" }, yes: { type: "boolean" } },
  async run(ctx, v, pos) {
    const api = ctx.api();
    const scope = scopeOf(ctx, v);
    const lock = scope.kind === "project" ? readLockfile(scope.root) : null;
    if (scope.kind === "project" && !lock) throw new CliError(`no ${lockfilePath(scope.root)}; nothing to update`, "no_lockfile");
    warnRegistryMismatch(ctx, lock, api);
    const entries: Record<string, LockEntry> = scope.kind === "global" ? readInstalled() : (lock as Lockfile).skills;
    const names = pos.length ? pos : Object.keys(entries);
    const updated: { name: string; kind: PackageKind; from: string; to: string }[] = [];
    const failed: { name: string; error: string }[] = [];
    const skipped: { name: string; from: string; to: string; reason: string; behaviors: Behavior[] }[] = [];
    for (const name of names) {
      const e = entries[name];
      if (!e) {
        failed.push({ name, error: "not installed" });
        ctx.out.line(`${ctx.out.c("red", "✗")} ${name}: not installed (${where(scope)})`);
        continue;
      }
      const kind = kindOf(e);
      try {
        const latest = await api.resolve(name, e.range);
        if (compareVersions(latest, e.version) <= 0) {
          ctx.out.line(`  ${name}@${e.version} is up to date (${e.range})`);
          continue;
        }
        const added = await addedAskBehaviors(api, name, e.version, latest);
        if (added.length) {
          const labels = [...new Set(added.map((b) => b.label))].join("; ");
          let go = Boolean(v.yes);
          if (!go && interactive(ctx)) {
            ctx.out.line(`${name} ${e.version} -> ${latest} adds behaviors that need your approval:`);
            for (const b of added) ctx.out.line(`    ${b.label} (${b.file}${b.line !== null ? `:${b.line}` : ""})  ${ctx.out.c("dim", b.match)}`);
            go = await confirm(ctx, `Update ${name} to ${latest}?`);
          }
          if (!go) {
            const reason = `needs --yes: the new version adds: ${labels}`;
            skipped.push({ name, from: e.version, to: latest, reason, behaviors: added });
            ctx.out.line(`${ctx.out.c("yellow", "-")} skipped ${name} ${e.version} -> ${latest}: ${reason}`);
            continue;
          }
        }
        if (kind === "plugin") {
          const mp = await marketplaceName(ctx, api.registry);
          claudePlugin(["update", `${name}@${mp}`], scope.kind === "project" ? scope.root : ctx.io.cwd);
          const detail = await api.skill(name).catch(() => null);
          const sha256 = detail?.versions.find((x) => x.version === latest)?.sha256 ?? e.sha256;
          recordEntry(scope, api, name, { ...e, version: latest, sha256 });
        } else if (kind === "rule") {
          if (scope.kind !== "project") throw new CliError(`${name} is a rule; update it with --project`, "rule_global");
          const res = await installRule({ api, name, version: latest, root: scope.root, targets: e.targets, prev: e, force: Boolean(v.force) });
          recordEntry(scope, api, name, { ...e, version: latest, sha256: res.sha256, rendered: { ...(e.rendered ?? {}), ...res.rendered } });
        } else {
          const copy = scope.kind === "global" && e.targets.some((t) => classify(targetPath(scope, t, name), name).kind === "managed-dir");
          const r = await installVersion({ api, name, version: latest, targets: e.targets, scope, force: Boolean(v.force), copy });
          recordEntry(scope, api, name, { range: e.range, version: latest, sha256: r.sha256, targets: e.targets });
        }
        updated.push({ name, kind, from: e.version, to: latest });
        ctx.out.line(`${ctx.out.c("green", "✓")} ${name} ${e.version} -> ${ctx.out.c("bold", latest)}`);
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        failed.push({ name, error: err.message });
        ctx.out.line(`${ctx.out.c("red", "✗")} ${name}: ${err.message}`);
      }
    }
    if (updated.some((u) => u.kind === "skill") && scope.kind === "global") ctx.out.line(ctx.out.c("dim", "Old versions stay in the store until `intra prune`."));
    if (skipped.length) ctx.out.line(ctx.out.c("dim", `Review with \`intra info <name>\` or \`intra diff <name> <from>\`, then \`intra update <name> --yes\`.`));
    ctx.out.result({ scope: where(scope), updated: updated.map(({ kind: _k, ...u }) => u), skipped, failed });
    return failed.length ? 1 : 0;
  },
};

/**
 * Ask-tier behaviors in `to` whose rule id `from` did not have. A missing old version (deleted,
 * or not visible any more) counts as having none, so every ask behavior is new.
 */
export async function addedAskBehaviors(api: Api, name: string, from: string, to: string): Promise<Behavior[]> {
  const [prev, next] = await Promise.all([
    api.version(name, from).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) return null;
      throw err;
    }),
    api.version(name, to),
  ]);
  const before = prev?.behaviors ?? [];
  const after = next.behaviors ?? [];
  if (!addsAskBehavior(before, after)) return [];
  const old = new Set(askBehaviorIds(before));
  return after.filter((b) => b.tier === "ask" && !old.has(b.id));
}

export const remove: Command = {
  name: "remove",
  summary: "Uninstall packages (only what intra installed)",
  help: `Usage: intra remove <name>... [--project[=dir]] [--to claude,codex,cursor] [--force] [--json]

Skills: removes only links into the intra store and directories carrying an intra marker;
anything else at the same path is left alone.
Rules: deletes .cursor/rules/<name>.mdc and .claude/rules/<name>.md and removes the rule's block
from AGENTS.md (the rest of AGENTS.md is kept), but only where the content is still what intra
wrote; an edited file is reported and kept unless --force. Without --project, a rule is looked up
in the nearest project.
Plugins: runs \`claude plugin uninstall <name>@<marketplace> --scope <the scope it was installed at>\`.

Options:
${PROJECT_HELP}
  --to <list>         remove from these targets only (default: every target it was installed to)
  --force             rules: also remove rendered files that were edited since intra wrote them`,
  options: { project: { type: "string" }, to: { type: "string", multiple: true }, force: { type: "boolean" } },
  async run(ctx, v, pos) {
    if (!pos.length) throw new UsageError("usage: intra remove <name>...");
    const scope = scopeOf(ctx, v);
    const only = list(v.to).length ? parseTargets(list(v.to).join(",")) : null;
    const lock = scope.kind === "project" ? readLockfile(scope.root) : null;
    const installed = scope.kind === "global" ? readInstalled() : null;
    const removed: { name: string; kind: PackageKind; target: ToolId; path: string }[] = [];
    let problems = 0;
    // A rule removed without --project: the nearest project's lockfile, read on first need.
    const auto = { root: scope.kind === "global" ? findProjectRoot(ctx.io.cwd) : null, lock: undefined as Lockfile | null | undefined };
    const autoLock = () => (auto.lock === undefined ? (auto.lock = auto.root ? readLockfile(auto.root) : null) : auto.lock);
    let autoDirty = false;
    for (const name of pos) {
      let entry = installed ? installed[name] : lock?.skills[name];
      let ruleRoot: string | null = scope.kind === "project" ? scope.root : null;
      let ruleLock = lock;
      if (!entry && installed && autoLock()?.skills[name] && kindOf(autoLock()!.skills[name]!) === "rule") {
        entry = autoLock()!.skills[name];
        ruleRoot = auto.root;
        ruleLock = autoLock()!;
        ctx.out.line(ctx.out.c("dim", `note: ${name} is a rule in ${ruleRoot}`));
      }
      const kind = entry ? kindOf(entry) : "skill";
      try {
        if (kind === "plugin" && entry) {
          const mp = await marketplaceName(ctx, (loadConfig().registry ?? lock?.registry) as string);
          const pscope = entry.scope ?? "user";
          claudePlugin(["uninstall", `${name}@${mp}`, "--scope", pscope], pscope === "project" && scope.kind === "project" ? scope.root : ctx.io.cwd);
          removed.push({ name, kind, target: "claude", path: `claude ${pscope} scope` });
          ctx.out.line(`${ctx.out.c("green", "✓")} uninstalled plugin ${name} from Claude Code (${pscope} scope)`);
          if (installed) delete installed[name];
          else if (lock) delete lock.skills[name];
          continue;
        }
        if (kind === "rule" && entry && ruleRoot && ruleLock) {
          const targets = only ?? entry.targets;
          const res = removeRule(ruleRoot, name, entry, targets, Boolean(v.force));
          for (const r of res.removed) {
            removed.push({ name, kind, ...r });
            ctx.out.line(`${ctx.out.c("green", "✓")} removed ${r.target === "codex" ? `the ${name} block from ${r.path}` : r.path}`);
          }
          for (const l of res.left) ctx.out.warn(`left ${l.label} alone: it is not what intra wrote (re-run with --force to remove it anyway)`);
          const keep = entry.targets.filter((t) => !targets.includes(t) || res.left.some((l) => l.target === t));
          if (keep.length) {
            const rendered = Object.fromEntries(Object.entries(entry.rendered ?? {}).filter(([t]) => keep.includes(t as ToolId)));
            ruleLock.skills[name] = { ...entry, targets: keep, rendered };
          } else delete ruleLock.skills[name];
          if (ruleLock === lock) continue;
          autoDirty = true;
          continue;
        }
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        problems++;
        ctx.out.line(`${ctx.out.c("red", "✗")} ${name}: ${err.message}`);
        continue;
      }
      const targets = only ?? entry?.targets ?? [...TOOLS];
      let touched = false;
      for (const t of targets) {
        const p = targetPath(scope, t, name);
        const st = classify(p, name);
        if (isManaged(st)) {
          removeManaged(p);
          removed.push({ name, kind: "skill", target: t, path: p });
          touched = true;
          ctx.out.line(`${ctx.out.c("green", "✓")} removed ${p}`);
        } else if (st.kind === "unmanaged") {
          ctx.out.warn(`left ${p} alone: it was not installed by intra`);
        }
      }
      if (entry) {
        const left = entry.targets.filter((t) => !targets.includes(t));
        if (installed) {
          if (left.length) installed[name] = { ...entry, targets: left } as (typeof installed)[string];
          else delete installed[name];
        } else if (lock) {
          if (left.length) lock.skills[name] = { ...entry, targets: left };
          else delete lock.skills[name];
        }
      } else if (!touched) {
        problems++;
        ctx.out.line(`${ctx.out.c("red", "✗")} ${name} is not installed (${where(scope)})`);
      }
    }
    if (installed) writeInstalled(installed);
    if (lock && scope.kind === "project") writeLockfile(scope.root, lock);
    if (autoDirty && auto.root && auto.lock) writeLockfile(auto.root, auto.lock);
    ctx.out.result({ scope: where(scope), removed });
    return problems ? 1 : 0;
  },
};

interface SyncChange {
  action: "install" | "reinstall" | "remove" | "blocked";
  name: string;
  kind: PackageKind;
  target: ToolId;
  path: string;
  reason: string;
}

/** Compare a project's tool directories and rendered rules with its lockfile. Pure read. Plugins are Claude Code's. */
export function planSync(root: string, lock: Lockfile): SyncChange[] {
  const scope: Scope = { kind: "project", root };
  const changes: SyncChange[] = [];
  for (const [name, e] of Object.entries(lock.skills)) {
    const kind = kindOf(e);
    if (kind === "plugin") continue;
    if (kind === "rule") {
      for (const d of planRuleSync(root, name, e)) changes.push({ ...d, name, kind });
      continue;
    }
    for (const t of e.targets) {
      const p = targetPath(scope, t, name);
      const st = classify(p, name);
      if (st.kind === "missing") changes.push({ action: "install", name, kind, target: t, path: p, reason: "missing" });
      else if (st.kind === "unmanaged") changes.push({ action: "blocked", name, kind, target: t, path: p, reason: "a non-intra directory is in the way" });
      else if (st.kind === "link") changes.push({ action: "reinstall", name, kind, target: t, path: p, reason: "is a link, expected a copy" });
      else if (st.version !== e.version) changes.push({ action: "reinstall", name, kind, target: t, path: p, reason: `has ${st.version}, lockfile wants ${e.version}` });
      else if (hashDir(p) !== e.sha256) changes.push({ action: "reinstall", name, kind, target: t, path: p, reason: "files were modified on disk" });
    }
  }
  for (const t of TOOLS) {
    const dir = projectToolDir(root, t);
    if (!isDir(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".")) continue;
      const p = join(dir, name);
      const st = classify(p, name);
      if (st.kind !== "managed-dir") continue;
      const e = lock.skills[name];
      if (!e || kindOf(e) !== "skill" || !e.targets.includes(t))
        changes.push({ action: "remove", name, kind: "skill", target: t, path: p, reason: "installed by intra but not in skills.lock.json" });
    }
  }
  return changes;
}

export const sync: Command = {
  name: "sync",
  summary: "Make a project match skills.lock.json exactly",
  help: `Usage: intra sync [--project[=dir]] [--frozen] [--force] [--json]

Installs the exact locked versions (bundles must hash to the locked sha256), repairs
modified skill copies, re-renders rule files and AGENTS.md blocks that were edited by hand
(backing each up first), and removes intra-installed skills that are not in the lockfile.
Plugins in the lockfile are Claude Code's to install (the project's .claude/settings.json);
sync only checks this machine has the marketplace connected.
Run it after cloning, and in CI.

Options:
  --project[=dir]     project root (default: nearest ancestor with .git, else the current directory)
  --frozen            change nothing; exit 1 if anything differs from the lockfile
  --force             back up non-intra directories in the way instead of refusing`,
  options: { project: { type: "string" }, frozen: { type: "boolean" }, force: { type: "boolean" } },
  async run(ctx, v) {
    const root = projectRoot(ctx, v.project ?? "") ?? findProjectRoot(ctx.io.cwd);
    const lock = readLockfile(root);
    if (!lock) throw new CliError(`no skills.lock.json in ${root}; run \`intra install <name> --project\` first`, "no_lockfile");
    const plugins = Object.entries(lock.skills).filter(([, e]) => kindOf(e) === "plugin").map(([n]) => n);
    if (plugins.length && !connectionFor(lock.registry))
      ctx.out.warn(`this project enables Claude Code plugins (${plugins.join(", ")}); run \`intra plugins connect\` once so Claude Code can fetch them`);
    const changes = planSync(root, lock);
    const describe = (c: SyncChange) => `${c.action.padEnd(9)} ${c.name} (${c.target}) ${ctx.out.c("dim", `${c.path}: ${c.reason}`)}`;
    if (!changes.length) {
      ctx.out.line(`${ctx.out.c("green", "✓")} ${root} matches skills.lock.json (${Object.keys(lock.skills).length} packages)`);
      ctx.out.result({ root, inSync: true, changes: [] });
      return 0;
    }
    if (v.frozen) {
      ctx.out.line(`${ctx.out.c("red", "✗")} ${root} does not match skills.lock.json (--frozen):`);
      for (const c of changes) ctx.out.line(`  ${describe(c)}`);
      ctx.out.line("Run `intra sync` to fix it.");
      ctx.out.result({ root, inSync: false, changes });
      return 1;
    }
    const blocked = changes.filter((c) => c.action === "blocked");
    if (blocked.length && !v.force)
      throw new CliError(
        `refusing to overwrite ${blocked.map((b) => b.path).join(", ")}: not installed by intra. Move it away or re-run with --force to back it up`,
        "unmanaged_target",
      );
    const api = ctx.api();
    warnRegistryMismatch(ctx, lock, api);
    for (const c of changes.filter((x) => x.action === "remove")) {
      removeManaged(c.path);
      ctx.out.line(`  ${describe(c)}`);
    }
    const byName = new Map<string, ToolId[]>();
    for (const c of changes) if (c.action !== "remove") byName.set(c.name, [...(byName.get(c.name) ?? []), c.target]);
    let lockDirty = false;
    for (const [name, targets] of byName) {
      const e = lock.skills[name]!;
      if (kindOf(e) === "rule") {
        const res = await installRule({ api, name, version: e.version, root, targets, prev: e, force: Boolean(v.force), repair: true, expectSha256: e.sha256 });
        lock.skills[name] = { ...e, rendered: { ...(e.rendered ?? {}), ...res.rendered } };
        lockDirty = true;
        for (const b of res.backups) ctx.out.line(`    backed up the edited file to ${b}`);
      } else
        await installVersion({ api, name, version: e.version, targets, scope: { kind: "project", root }, force: Boolean(v.force), expectSha256: e.sha256 });
      for (const c of changes.filter((x) => x.name === name && x.action !== "remove")) ctx.out.line(`  ${describe(c)}`);
    }
    if (lockDirty) writeLockfile(root, lock);
    ctx.out.line(`${ctx.out.c("green", "✓")} ${root} now matches skills.lock.json`);
    ctx.out.result({ root, inSync: true, changes });
    return 0;
  },
};

export const prune: Command = {
  name: "prune",
  summary: "Delete store versions nothing links to any more",
  help: `Usage: intra prune [--dry-run] [--json]

A store version is kept while installed.json records it or any global tool link points at it.`,
  options: { "dry-run": { type: "boolean" } },
  async run(ctx, v) {
    const root = storeRoot();
    const keep = new Set<string>();
    for (const [name, e] of Object.entries(readInstalled())) if (kindOf(e) === "skill") keep.add(join(root, name, e.version));
    for (const t of TOOLS) {
      const dir = globalToolDir(t);
      if (!isDir(dir)) continue;
      for (const name of readdirSync(dir)) {
        const st = classify(join(dir, name), name);
        if (st.kind === "link") keep.add(st.target);
      }
    }
    const removed: string[] = [];
    if (existsSync(root))
      for (const name of readdirSync(root)) {
        const nd = join(root, name);
        if (!isDir(nd)) continue;
        for (const ver of readdirSync(nd)) {
          const p = join(nd, ver);
          if (keep.has(p)) continue;
          removed.push(relative(root, p));
          if (!v["dry-run"]) rmSync(p, { recursive: true, force: true });
        }
        if (!v["dry-run"] && readdirSync(nd).length === 0) rmSync(nd, { recursive: true, force: true });
      }
    if (!removed.length) ctx.out.line("Nothing to prune.");
    else for (const r of removed) ctx.out.line(`${v["dry-run"] ? "would remove" : "removed"} store/${r}`);
    ctx.out.result({ removed, dryRun: Boolean(v["dry-run"]) });
  },
};
