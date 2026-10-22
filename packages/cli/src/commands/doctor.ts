import { accessSync, constants, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { TOOLS, TOOL_DIRS, type ToolId } from "@intra-skills/shared";
import { Api } from "../api.js";
import { projectRoot, type Command, type Ctx, type Values } from "../command.js";
import { loadConfig, readConfigFile } from "../config.js";
import { ApiError, CliError } from "../errors.js";
import { classify } from "../install.js";
import { readInstalled, readLockfile } from "../lockfile.js";
import { configPath, findProjectRoot, globalToolDir, isDir } from "../paths.js";
import { planSync } from "./manage.js";

export type State = "ok" | "warn" | "fail" | "unknown";
export interface Check {
  name: string;
  state: State;
  detail: string;
  fix?: string;
}

function writable(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Nearest existing ancestor, to say whether a missing dir could be created. */
function nearestExisting(p: string): string {
  let d = p;
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
  return d;
}

export const doctor: Command = {
  name: "doctor",
  summary: "Check config, registry, token, tool directories, links and the project lockfile",
  help: `Usage: intra doctor [--project[=dir]] [--json]

Every failing line names its own fix. Exits 1 if any check fails.
Token state is "unknown" (not "fail") when the registry cannot be reached.`,
  options: { project: { type: "string" } },
  async run(ctx, v) {
    const checks = await collectChecks(ctx, v);
    const o = ctx.out;
    const mark: Record<State, string> = { ok: o.c("green", "ok  "), warn: o.c("yellow", "warn"), fail: o.c("red", "FAIL"), unknown: o.c("dim", "??  ") };
    for (const c of checks) {
      o.line(`${mark[c.state]} ${c.name.padEnd(16)} ${c.detail}`);
      if (c.fix && c.state !== "ok") o.line(`     ${"".padEnd(16)} ${o.c("dim", `fix: ${c.fix}`)}`);
    }
    const failed = checks.filter((c) => c.state === "fail").length;
    o.line(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed.");
    o.result({ healthy: failed === 0, checks });
    return failed ? 1 : 0;
  },
};

/** Every doctor check, without printing. `intra setup` shows a summary of the same list. */
export async function collectChecks(ctx: Ctx, v: Values): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // 1. config
  try {
    const fileCfg = readConfigFile();
    if (fileCfg) add({ name: "config", state: "ok", detail: configPath() });
    else add({ name: "config", state: "fail", detail: `${configPath()} does not exist`, fix: "run `intra setup --registry <url>`" });
  } catch (err) {
    add({ name: "config", state: "fail", detail: (err as Error).message, fix: "fix the JSON or run `intra login` again" });
  }
  const cfg = loadConfig();

  // 2-3. registry + token
  if (!cfg.registry) {
    add({ name: "registry", state: "fail", detail: "no registry configured", fix: "run `intra setup --registry <url>`" });
    add({ name: "token", state: "unknown", detail: "no registry to check against" });
  } else {
    const api = new Api(cfg.registry, cfg.token);
    let reachable = false;
    try {
      const h = await api.health();
      reachable = true;
      add({ name: "registry", state: "ok", detail: `${cfg.registry} (server ${h.version})` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      add({ name: "registry", state: "fail", detail: msg, fix: "check the network/VPN, or fix the URL with `intra config set registry <url>`" });
    }
    if (!cfg.token) add({ name: "token", state: "fail", detail: "no token saved", fix: "run `intra login`" });
    else if (!reachable) add({ name: "token", state: "unknown", detail: "registry unreachable; cannot verify the token" });
    else {
      try {
        const me = await api.me();
        add({ name: "token", state: "ok", detail: `valid, logged in as ${me.handle}` });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401)
          add({ name: "token", state: "fail", detail: "the registry rejected the token", fix: "run `intra login` to sign in again" });
        else if (err instanceof ApiError && err.offline) add({ name: "token", state: "unknown", detail: err.message });
        else add({ name: "token", state: "unknown", detail: (err as Error).message });
      }
    }
  }

  // 4. target dirs
  const installed = (() => {
    try {
      return readInstalled();
    } catch (err) {
      add({ name: "installed.json", state: "fail", detail: (err as Error).message, fix: "fix or delete the file, then reinstall" });
      return {};
    }
  })();
  const skillEntries = Object.entries(installed).filter(([, e]) => (e.kind ?? "skill") === "skill");
  const tools = new Set<ToolId>([...cfg.defaultTargets, ...skillEntries.flatMap(([, e]) => e.targets)]);
  for (const t of TOOLS.filter((x) => tools.has(x))) {
    const dir = globalToolDir(t);
    if (isDir(dir)) {
      if (writable(dir)) add({ name: `${t} dir`, state: "ok", detail: dir });
      else add({ name: `${t} dir`, state: "fail", detail: `${dir} is not writable`, fix: `run \`chmod u+w ${dir}\`` });
    } else {
      const base = nearestExisting(dir);
      if (writable(base)) add({ name: `${t} dir`, state: "warn", detail: `${dir} does not exist yet`, fix: `it is created on the first \`intra install --to ${t}\`` });
      else add({ name: `${t} dir`, state: "fail", detail: `${dir} does not exist and ${base} is not writable`, fix: `run \`mkdir -p ${dir}\` with the right permissions` });
    }
  }

  // 5. managed links resolve; installed.json agrees with disk
  let links = 0;
  for (const t of TOOLS) {
    const dir = globalToolDir(t);
    if (!isDir(dir)) continue;
    for (const name of readdirSync(dir)) {
      const st = classify(join(dir, name), name);
      if (st.kind !== "link") continue;
      links++;
      if (st.dangling) {
        const ver = installed[name]?.version;
        add({
          name: `link ${t}/${name}`,
          state: "fail",
          detail: `${join(dir, name)} -> ${st.target} is dangling (the store entry is gone)`,
          fix: `run \`intra install ${name}${ver ? `@${ver}` : ""} --to ${t}\``,
        });
      }
    }
  }
  for (const [name, e] of skillEntries)
    for (const t of e.targets) {
      const st = classify(join(globalToolDir(t), name), name);
      if (st.kind === "missing")
        add({ name: `link ${t}/${name}`, state: "fail", detail: `installed.json lists ${name} for ${TOOL_DIRS[t].label} but ${join(globalToolDir(t), name)} is missing`, fix: `run \`intra install ${name}@${e.version} --to ${t}\`` });
      else if (st.kind === "unmanaged")
        add({ name: `link ${t}/${name}`, state: "warn", detail: `${join(globalToolDir(t), name)} was replaced by a non-intra directory`, fix: `run \`intra remove ${name} --to ${t}\` to stop tracking it, or \`intra install ${name} --to ${t} --force\`` });
    }
  if (!checks.some((c) => c.name.startsWith("link ") && c.state !== "ok"))
    add({ name: "links", state: "ok", detail: `${links} managed link(s) resolve` });

  // 6. project lockfile drift
  const root = projectRoot(ctx, v.project) ?? findProjectRoot(ctx.io.cwd);
  try {
    const lock = readLockfile(root);
    if (lock) {
      const changes = planSync(root, lock);
      if (!changes.length) add({ name: "lockfile", state: "ok", detail: `${root} matches skills.lock.json` });
      else
        add({
          name: "lockfile",
          state: "fail",
          detail: `${changes.length} difference(s) from skills.lock.json in ${root}: ${changes.map((c) => `${c.name} (${c.target}) ${c.reason}`).join("; ")}`,
          fix: changes.some((c) => c.action === "blocked") ? "run `intra sync --force` (backs up the directories in the way)" : "run `intra sync`",
        });
    }
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    add({ name: "lockfile", state: "fail", detail: err.message, fix: "fix or regenerate skills.lock.json" });
  }

  return checks;
}
