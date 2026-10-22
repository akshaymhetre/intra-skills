import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  KIND_MARKER,
  KINDS,
  NAME_RE,
  PLUGIN_MANIFEST,
  RULE_FILE,
  SKILL_FILE,
  bumpVersion,
  compareVersions,
  detectKind,
  isValidVersion,
  parsePackage,
  setSkillMdVersion,
  validateBundleFiles,
  type PackageKind,
  type ParsedPackage,
  type ParsedSkill,
  type Proposal,
  type PublishMode,
  type PublishRequest,
  type ValidationIssue,
  type Visibility,
} from "@intra-skills/shared";
import { list, str, type Command, type Ctx } from "../command.js";
import { ApiError, CliError, UsageError } from "../errors.js";
import { collectFiles, isBinary, scanSecrets, type LocalFile, type SecretHit } from "../files.js";
import { gitInfo } from "../git.js";
import { confirm } from "../prompt.js";

interface Inspection {
  dir: string;
  name: string;
  /** null when the folder has no kind marker, or more than one. */
  kind: PackageKind | null;
  pkg: ParsedPackage | null;
  /** Identity and facets in the same shape for every kind. */
  skill: ParsedSkill | null;
  /** Text of the kind's marker file (SKILL.md, RULE.md or .claude-plugin/plugin.json). */
  markerText: string | null;
  files: LocalFile[];
  issues: ValidationIssue[];
  secrets: SecretHit[];
}

/** Everything `validate` checks, shared with `publish`. Never throws for package problems. */
export function inspect(dir: string, opts: { override?: { path: string; text: string } } = {}): Inspection {
  const abs = resolve(dir);
  const name = basename(abs);
  const res: Inspection = { dir: abs, name, kind: null, pkg: null, skill: null, markerText: null, files: [], issues: [], secrets: [] };
  if (!existsSync(abs)) {
    res.issues.push({ level: "error", field: "files", message: `no such directory ${abs}` });
    return res;
  }
  try {
    res.files = collectFiles(abs);
  } catch (err) {
    res.issues.push({ level: "error", field: "files", message: (err as Error).message });
    return res;
  }
  const detected = detectKind(res.files.map((f) => f.path));
  if (!detected.kind) {
    res.issues.push({ level: "error", field: "files", message: `${detected.issue} in ${abs}` });
    return res;
  }
  res.kind = detected.kind;
  const o = opts.override;
  if (o) res.files = res.files.map((f) => (f.path === o.path ? { ...f, data: Buffer.from(o.text) } : f));
  res.issues.push(...validateBundleFiles(res.files.map((f) => ({ path: f.path, size: f.data.length }))));
  res.markerText = res.files.find((f) => f.path === KIND_MARKER[detected.kind!])?.data.toString("utf8") ?? null;
  const parsed = parsePackage(
    res.files.map((f) => ({ path: f.path, text: isBinary(f.data) ? null : f.data.toString("utf8") })),
    name,
  );
  res.pkg = parsed.pkg;
  res.skill = parsed.pkg?.skill ?? null;
  res.issues.push(...parsed.issues);
  if (res.skill && /^todo\b/i.test(res.skill.description))
    res.issues.push({ level: "warning", field: "description", message: "still the TODO placeholder from `intra init`; describe what it does and when to use it" });
  res.secrets = scanSecrets(res.files);
  return res;
}

/** Set the version in a plugin.json, keeping the author's formatting when a plain replace is exact. */
export function setPluginJsonVersion(text: string, version: string): string {
  const obj = JSON.parse(text) as Record<string, unknown>;
  const want = JSON.stringify({ ...obj, version });
  const replaced = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  try {
    if (replaced !== text && JSON.stringify(JSON.parse(replaced)) === want) return replaced;
  } catch {
    /* fall through to a rewrite */
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
    if (k === "name" && !("version" in obj)) out.version = version;
  }
  out.version = version;
  return JSON.stringify(out, null, 2) + "\n";
}

/** The marker file rewritten to carry `version`: metadata.version for skills and rules, plugin.json version for plugins. */
function withVersion(kind: PackageKind, text: string, version: string): { path: string; text: string } {
  if (kind === "plugin") return { path: PLUGIN_MANIFEST, text: setPluginJsonVersion(text, version) };
  return { path: KIND_MARKER[kind], text: setSkillMdVersion(text, version) };
}

const VERSION_HOME: Record<PackageKind, string> = { skill: "metadata.version in SKILL.md", rule: "metadata.version in RULE.md", plugin: `version in ${PLUGIN_MANIFEST}` };

function printIssues(ctx: Ctx, issues: ValidationIssue[], secrets: SecretHit[], allowSecrets: boolean): void {
  for (const i of issues) {
    const tag = i.level === "error" ? ctx.out.c("red", "error") : ctx.out.c("yellow", "warning");
    ctx.out.line(`  ${tag} ${i.field}: ${i.message}`);
  }
  for (const s of secrets) {
    const tag = allowSecrets ? ctx.out.c("yellow", "warning") : ctx.out.c("red", "error");
    ctx.out.line(`  ${tag} possible ${s.kind} at ${s.path}:${s.line} (${s.preview})`);
  }
}

const errorsOf = (i: Inspection, allowSecrets: boolean) =>
  i.issues.filter((x) => x.level === "error").length + (allowSecrets ? 0 : i.secrets.length);

const titleOf = (name: string) => name.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** The files `intra init` writes for each kind, relative to the package folder. */
export function scaffold(kind: PackageKind, name: string, o: { team?: string; areas: string[]; tags: string[] }): { path: string; text: string }[] {
  if (kind === "plugin") {
    const metadata: Record<string, unknown> = {};
    if (o.team) metadata.team = o.team;
    if (o.areas.length) metadata.areas = o.areas;
    if (o.tags.length) metadata.tags = o.tags;
    const manifest = {
      name,
      version: "0.1.0",
      description: `TODO - say what ${name} adds to Claude Code and when to install it. People and agents decide by this line.`,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
    return [
      { path: PLUGIN_MANIFEST, text: JSON.stringify(manifest, null, 2) + "\n" },
      {
        path: `commands/${name}.md`,
        text: `---
description: TODO - what /${name} does, shown in Claude Code's command list
---
TODO: the prompt Claude Code runs for /${name}. $ARGUMENTS holds what the user typed after the command.
`,
      },
    ];
  }
  const meta = [`  version: "0.1.0"`];
  if (o.team) meta.push(`  team: ${o.team}`);
  if (o.areas.length) meta.push(`  areas: "${o.areas.join(", ")}"`);
  if (o.tags.length) meta.push(`  tags: "${o.tags.join(", ")}"`);
  if (kind === "rule")
    return [
      {
        path: RULE_FILE,
        text: `---
name: ${name}
description: TODO - say what ${name} asks of the agent and when it applies. Cursor's agent reads this line to decide whether to apply the rule.
globs:
  - "src/**/*.ts"
alwaysApply: false
metadata:
${meta.join("\n")}
---
# ${titleOf(name)}

- TODO: the rule, as short imperative lines the agent must follow.
- \`globs\` limits it to matching files (Claude Code loads it when one is in context); delete it and set
  \`alwaysApply: true\` for a rule that applies everywhere.
`,
      },
    ];
  return [
    {
      path: SKILL_FILE,
      text: `---
name: ${name}
description: TODO - say what ${name} does and when an agent should use it, e.g. "Use when the user asks to ...". Agents pick skills by this line.
metadata:
${meta.join("\n")}
---
# ${titleOf(name)}

## When to use

- TODO: the situations that should trigger this skill.

## Instructions

1. TODO: the steps the agent should follow.
`,
    },
  ];
}

export const init: Command = {
  name: "init",
  summary: "Scaffold a new skill, rule or Claude Code plugin",
  help: `Usage: intra init [name] [--kind skill|plugin|rule] [--dir <parent>] [--team <slug>] [--area a,b] [--tags t,u]

Creates <parent>/<name>/ (parent defaults to the current directory) with a package that passes
\`intra validate\`. Without a name, scaffolds into --dir itself and uses its directory name.

Kinds:
  skill   SKILL.md (default)
  plugin  .claude-plugin/plugin.json (name, version 0.1.0, description, metadata) and commands/<name>.md
  rule    RULE.md with description, a globs example, alwaysApply: false and metadata.version

Options:
  --kind <kind>    skill (default), plugin or rule
  --dir <path>     parent directory (default: .)
  --team <slug>    owning team, written to metadata.team
  --area <list>    comma list of work areas (frontend, backend, infra, ...)
  --tags <list>    comma list of tags`,
  options: {
    kind: { type: "string" },
    dir: { type: "string" },
    team: { type: "string" },
    area: { type: "string", multiple: true },
    tags: { type: "string", multiple: true },
  },
  async run(ctx, v, pos) {
    const kind = (str(v.kind) ?? "skill") as PackageKind;
    if (!KINDS.includes(kind)) throw new UsageError(`--kind must be skill, plugin or rule, got "${String(v.kind)}"`);
    const parent = resolve(ctx.io.cwd, str(v.dir) ?? ".");
    const name = pos[0] ?? basename(parent);
    const dir = pos[0] ? join(parent, name) : parent;
    if (!NAME_RE.test(name) || name.length > 64)
      throw new UsageError(`"${name}" is not a valid ${kind} name: lowercase letters, digits and single hyphens, max 64 chars`);
    for (const k of KINDS)
      if (existsSync(join(dir, KIND_MARKER[k]))) throw new CliError(`${join(dir, KIND_MARKER[k])} already exists; refusing to overwrite it`, "exists");
    const files = scaffold(kind, name, { team: str(v.team), areas: list(v.area), tags: list(v.tags) });
    const check = parsePackage(files, name);
    if (!check.pkg) throw new CliError(`internal: scaffold failed validation: ${check.issues.map((i) => i.message).join("; ")}`);
    for (const f of files) if (existsSync(join(dir, f.path))) throw new CliError(`${join(dir, f.path)} already exists; refusing to overwrite it`, "exists");
    for (const f of files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.text);
    }
    const paths = files.map((f) => join(dir, f.path));
    for (const p of paths) ctx.out.line(`Created ${p}`);
    ctx.out.line(`Next: replace the TODOs, then \`intra validate ${dir}\` and \`intra publish ${dir}\`.`);
    ctx.out.result({ name, kind, dir, file: paths[0], files: paths });
  },
};

export const validate: Command = {
  name: "validate",
  summary: "Check package directories locally (kind, files, paths, sizes, manifest, secrets)",
  help: `Usage: intra validate [dir...] [--allow-secrets] [--json]

Validates each package directory (default: .): a skill (SKILL.md), a Claude Code plugin
(.claude-plugin/plugin.json) or a rule (RULE.md), recognised by the file at its top.
Exits 1 if any has errors.`,
  options: { "allow-secrets": { type: "boolean" } },
  async run(ctx, v, pos) {
    const allow = Boolean(v["allow-secrets"]);
    const dirs = (pos.length ? pos : ["."]).map((d) => resolve(ctx.io.cwd, d));
    const results = dirs.map((d) => inspect(d));
    let failed = 0;
    for (const r of results) {
      const errs = errorsOf(r, allow);
      if (errs) failed++;
      const head = errs ? ctx.out.c("red", "✗") : ctx.out.c("green", "✓");
      ctx.out.line(`${head} ${r.kind && r.kind !== "skill" ? `${r.kind} ` : ""}${r.skill?.name ?? r.name} ${ctx.out.c("dim", `(${r.dir}, ${r.files.length} files)`)}`);
      printIssues(ctx, r.issues, r.secrets, allow);
    }
    ctx.out.result({
      valid: failed === 0,
      skills: results.map((r) => ({
        dir: r.dir,
        name: r.skill?.name ?? r.name,
        kind: r.kind,
        version: r.skill?.version ?? null,
        fileCount: r.files.length,
        valid: errorsOf(r, allow) === 0,
        issues: r.issues,
        secrets: r.secrets,
      })),
    });
    return failed ? 1 : 0;
  },
};

interface PublishOutcome {
  dir: string;
  name: string;
  kind?: PackageKind;
  version?: string;
  status: "published" | "proposed" | "dry-run" | "failed" | "skipped";
  sha256?: string;
  fileCount?: number;
  /** Pull-request mode: the proposal the registry opened or updated. */
  proposal?: Proposal;
  error?: string;
}

/** How this registry takes new versions. An older server without /api/meta publishes directly. */
async function publishModeOf(api: ReturnType<Ctx["api"]>): Promise<PublishMode> {
  try {
    return (await api.meta()).publishMode ?? "direct";
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return "direct";
    throw err;
  }
}

/** The fix for a proposal refused because the caller has no git identity. */
export function identityHint(details: unknown): string {
  const provider = (details as { provider?: unknown } | undefined)?.provider;
  if (provider === "bitbucket-cloud") return "run `intra identity set bitbucket-cloud <your-bitbucket-username>`";
  if (provider === "github") return "run `intra identity set github <your-github-username>`";
  return "run `intra identity set github <your-github-username>` (or `intra identity set bitbucket-cloud <your-bitbucket-username>`)";
}

export const publish: Command = {
  name: "publish",
  summary: "Publish skills, rules and plugins (as pull requests when the registry asks for them)",
  help: `Usage: intra publish [dir...] [options]

Publishes each package directory in turn (default: .) and reports per package, so
\`intra publish ~/.claude/skills/*\` bulk-imports a whole folder. The kind comes from the file at
the top of the folder: SKILL.md (skill), .claude-plugin/plugin.json (plugin) or RULE.md (rule),
and the same local checks as \`intra validate\` run before anything is uploaded.

Version: --version wins; else --bump from the registry's latest (or from the folder's own version
for a new package); else the folder's version as is. The folder's version is metadata.version
in SKILL.md or RULE.md, and "version" in plugin.json. When the version changes, that file is
rewritten with the new version before the bundle is read (not with --dry-run).

When the registry publishes through pull requests (GET /api/meta says publishMode
"pull-request"), the same checks run and the files are sent as a proposal instead: the
registry opens a pull request in the skills repo, and the version appears once it is approved
and merged. You need a linked git username first: \`intra identity set github <username>\`.
Follow it with \`intra proposals\`.

Options:
  --bump <patch|minor|major>   bump from the latest published version
  --version <x.y.z>            publish exactly this version
  --changelog <text>           release notes for this version
  --private                    first publish only: visibility private (default org)
  --team <slug>                first publish only: owning team (overrides metadata.team)
  --dry-run                    validate and show what would be sent; send nothing, change nothing
  --allow-secrets              publish even if the secret scan finds something
  --yes                        do not ask for confirmation on a terminal
  --json                       print the per-skill results as JSON`,
  options: {
    bump: { type: "string" },
    version: { type: "string" },
    changelog: { type: "string" },
    private: { type: "boolean" },
    team: { type: "string" },
    "dry-run": { type: "boolean" },
    "allow-secrets": { type: "boolean" },
    yes: { type: "boolean" },
  },
  async run(ctx, v, pos) {
    const bump = str(v.bump);
    if (bump && !["patch", "minor", "major"].includes(bump)) throw new UsageError("--bump must be patch, minor or major");
    const explicit = str(v.version);
    if (explicit && !isValidVersion(explicit)) throw new UsageError(`--version "${explicit}" is not semver (x.y.z)`);
    if (explicit && bump) throw new UsageError("pass --version or --bump, not both");
    const dryRun = Boolean(v["dry-run"]);
    const allowSecrets = Boolean(v["allow-secrets"]);
    const dirs = (pos.length ? pos : ["."]).map((d) => resolve(ctx.io.cwd, d));
    if (explicit && dirs.length > 1) throw new UsageError("--version applies to one skill; use --bump for several");
    const api = ctx.api();
    const mode = { value: await publishModeOf(api) };
    const outcomes: PublishOutcome[] = [];

    for (const dir of dirs) {
      const name = basename(dir);
      try {
        outcomes.push(await publishOne(ctx, api, dir, { bump, explicit, dryRun, allowSecrets, v, mode }));
      } catch (err) {
        if (!(err instanceof CliError)) throw err;
        outcomes.push({ dir, name, status: "failed", error: err.message });
        ctx.out.line(`${ctx.out.c("red", "✗")} ${name}: ${err.message}`);
      }
    }
    if (dirs.length > 1) {
      const ok = outcomes.filter((o) => o.status !== "failed").length;
      ctx.out.line(`\n${ok}/${outcomes.length} ${dryRun ? "checked" : mode.value === "pull-request" ? "proposed" : "published"}.`);
    }
    const failed = outcomes.filter((o) => o.status === "failed").length;
    ctx.out.result({ ok: failed === 0, publishMode: mode.value, results: outcomes });
    return failed ? 1 : 0;
  },
};

async function publishOne(
  ctx: Ctx,
  api: ReturnType<Ctx["api"]>,
  dir: string,
  o: { bump?: string; explicit?: string; dryRun: boolean; allowSecrets: boolean; v: Record<string, unknown>; mode: { value: PublishMode } },
): Promise<PublishOutcome> {
  // 1. Validate before touching anything, so a refused skill is never rewritten.
  const first = inspect(dir);
  if (!first.skill || errorsOf(first, o.allowSecrets)) {
    printIssues(ctx, first.issues, first.secrets, o.allowSecrets);
    const secretNote = !o.allowSecrets && first.secrets.length
      ? ` (possible secrets: ${first.secrets.map((s) => `${s.path}:${s.line}`).join(", ")}; remove them or pass --allow-secrets)`
      : "";
    throw new CliError(`not published: ${errorsOf(first, o.allowSecrets)} problem(s)${secretNote}`, "invalid_skill");
  }
  for (const i of first.issues) if (i.level === "warning") ctx.out.warn(`${first.name}: ${i.field}: ${i.message}`);
  if (o.allowSecrets) for (const s of first.secrets) ctx.out.warn(`${first.name}: possible ${s.kind} at ${s.path}:${s.line}, publishing anyway`);
  const skill = first.skill;

  // 2. Choose the version.
  let existing: string[] = [];
  try {
    existing = (await api.skill(skill.name)).versions.map((x) => x.version);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err;
  }
  const latest = existing.reduce<string | null>((m, x) => (m === null || compareVersions(x, m) > 0 ? x : m), null);
  let version: string;
  if (o.explicit) version = o.explicit;
  else if (o.bump) version = bumpVersion(latest ?? skill.version ?? "0.0.0", o.bump as "patch" | "minor" | "major");
  else if (skill.version) version = skill.version;
  else throw new CliError(`${skill.name} has no ${VERSION_HOME[first.kind as PackageKind]}; add one or pass --bump/--version`, "no_version");
  if (latest && compareVersions(version, latest) <= 0)
    throw new CliError(`${skill.name}@${version} is not newer than the published ${latest}; use --bump patch|minor|major`, "conflict");

  // 3. Rewrite the marker file BEFORE reading the bundle, so what is published carries the version.
  let final = first;
  const kind = first.kind as PackageKind;
  if (version !== skill.version) {
    const next = withVersion(kind, first.markerText as string, version);
    if (!o.dryRun) writeFileSync(join(dir, next.path), next.text);
    final = inspect(dir, o.dryRun ? { override: next } : {});
    if (!final.skill || errorsOf(final, o.allowSecrets)) throw new CliError(`${next.path} failed validation after the version rewrite`, "invalid_skill");
  }

  const git = gitInfo(dir);
  if (git?.dirty) ctx.out.warn(`${skill.name}: ${dir} has uncommitted changes; the published bundle will not match commit ${git.commit.slice(0, 12)}`);
  const size = final.files.reduce((n, f) => n + f.data.length, 0);
  const req: PublishRequest = {
    version,
    files: final.files.map((f) => ({ path: f.path, mode: f.mode, contentBase64: f.data.toString("base64") })),
    git,
  };
  const changelog = str(o.v.changelog as string | undefined);
  if (changelog) req.changelog = changelog;
  if (!latest) {
    if (o.v.private) req.visibility = "private" satisfies Visibility;
    const team = str(o.v.team as string | undefined);
    if (team) req.team = team;
  } else if (o.v.private || o.v.team) {
    ctx.out.warn(`${skill.name}: --private/--team apply only on first publish; use \`intra visibility\` or the console`);
  }

  const summary = `${kind === "skill" ? "" : `${kind} `}${skill.name}@${version} (${final.files.length} files, ${size} bytes${latest ? `, was ${latest}` : `, new ${kind}`})`;
  const verb = () => (o.mode.value === "pull-request" ? "propose" : "publish");
  if (o.dryRun) {
    ctx.out.line(`${ctx.out.c("cyan", "dry-run")} would ${verb()} ${summary} to ${api.registry}${o.mode.value === "pull-request" ? " as a pull request" : ""}`);
    for (const f of final.files) ctx.out.line(ctx.out.c("dim", `  ${f.mode.toString(8)} ${String(f.data.length).padStart(8)}  ${f.path}`));
    return { dir, name: skill.name, kind, version, status: "dry-run", fileCount: final.files.length };
  }
  if (ctx.io.stdin.isTTY && !o.v.yes && !ctx.out.json) {
    if (!(await confirm(ctx, `${verb() === "propose" ? "Propose" : "Publish"} ${summary} to ${api.registry}?`))) {
      ctx.out.line(`skipped ${skill.name}`);
      return { dir, name: skill.name, version, status: "skipped" };
    }
  }
  try {
    if (o.mode.value === "direct") {
      try {
        const meta = await api.publish(skill.name, req);
        ctx.out.line(`${ctx.out.c("green", "✓")} published ${summary}`);
        return { dir, name: skill.name, kind, version: meta.version, status: "published", sha256: meta.sha256, fileCount: meta.fileCount };
      } catch (err) {
        // A git source was enabled after we read /api/meta: switch to proposals for this and later skills.
        if (!(err instanceof ApiError && err.status === 403 && (err.details as { publishMode?: string } | undefined)?.publishMode === "pull-request")) throw err;
        o.mode.value = "pull-request";
        ctx.out.warn("this registry now publishes through pull requests; sending a proposal instead");
      }
    }
    return await proposeOne(ctx, api, skill.name, version, req, summary, dir);
  } catch (err) {
    if (err instanceof ApiError && err.code === "invalid_skill" && Array.isArray(err.details))
      printIssues(ctx, err.details as ValidationIssue[], [], true);
    throw err;
  }
}

async function proposeOne(
  ctx: Ctx,
  api: ReturnType<Ctx["api"]>,
  name: string,
  version: string,
  req: PublishRequest,
  summary: string,
  dir: string,
): Promise<PublishOutcome> {
  let p: Proposal;
  try {
    p = await api.propose(name, req);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 403)) throw err;
    const noIdentity =
      /identit/i.test(err.message) ||
      (err.details as { reason?: string } | undefined)?.reason === "no_git_identity" ||
      ((await api.me().catch(() => null))?.gitIdentities ?? [null]).length === 0;
    if (!noIdentity) throw err;
    throw new CliError(`not proposed: ${err.message}. Link your git username first: ${identityHint(err.details)}`, "no_git_identity", 1, err.details);
  }
  ctx.out.line(`${ctx.out.c("green", "✓")} proposed ${summary}`);
  if (p.pullRequest) ctx.out.line(`    pull request: ${p.pullRequest.url}`);
  if (p.statusMessage) ctx.out.line(`    ${p.statusMessage}`);
  ctx.out.line(ctx.out.c("dim", "    The version is created once the pull request is approved and merged; follow it with `intra proposals`."));
  return { dir, name, kind: p.packageKind, version: p.version, status: "proposed", proposal: p };
}
