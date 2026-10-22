import { resolve } from "node:path";
import { stackLabel } from "@intra-skills/shared";
import { str, type Command } from "../command.js";
import { CliError, UsageError } from "../errors.js";
import { isDir } from "../paths.js";
import { collectSignals } from "../signals.js";

export const suggest: Command = {
  name: "suggest",
  summary: "Recommend skills for a repo from its file names and dependencies",
  help: `Usage: intra suggest [dir] [--limit n] [--json]

Sends the registry the repo's file PATHS (git ls-files in a git work tree, else a walk that
skips .git, node_modules, dist, build, .venv, vendor, target; at most 5000) and dependency
NAMES from package.json, requirements*.txt, pyproject.toml, go.mod, Gemfile and Cargo.toml
(at most 2000). No file contents leave the machine. The registry detects the stacks and ranks
the skills that match them.

Options:
  --limit <n>   show at most n skills (default 10)
  --json        {dir, stacks, skills, sent}`,
  options: { limit: { type: "string" } },
  async run(ctx, v, pos) {
    const dir = resolve(ctx.io.cwd, pos[0] ?? ".");
    if (!isDir(dir)) throw new CliError(`${dir} is not a directory`, "not_found");
    const limitArg = str(v.limit);
    const limit = limitArg === undefined ? 10 : Number(limitArg);
    if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive whole number");
    const api = ctx.api();
    const signals = collectSignals(dir);
    const res = await api.suggest({ files: signals.files, packages: signals.packages });
    const shown = res.skills.slice(0, limit);
    const sent = {
      files: signals.files.length,
      packages: signals.packages.length,
      manifestsRead: signals.manifests.length,
      fileList: signals.source === "git" ? "git ls-files" : "directory walk",
      truncated: signals.truncated,
      contents: false,
    };
    const o = ctx.out;
    o.line(
      o.c("dim", `Sent ${sent.files} file path(s) (${sent.fileList}) and ${sent.packages} dependency name(s) from ${sent.manifestsRead} manifest(s); no file contents left this machine.`),
    );
    o.line(`Stacks: ${res.stacks.length ? res.stacks.map(stackLabel).join(", ") : "none detected"}`);
    o.line();
    if (!shown.length) o.line("No skills in the registry match this repo's stacks yet.");
    else {
      o.table(
        ["#", "SKILL", "SCORE", "WHY", "INSTALL"],
        shown.map((r, i) => [String(i + 1), r.skill.name, r.score.toFixed(1), r.reasons.join(", "), `intra install ${r.skill.name}`]),
        { maxWidth: o.width, flex: 3 },
      );
      if (res.skills.length > shown.length) o.line(o.c("dim", `${shown.length} of ${res.skills.length} shown; --limit ${res.skills.length} for all`));
      o.line(o.c("dim", "Add --project to an install to pin it for this repo in skills.lock.json, or try one first with `intra run <name>`."));
    }
    o.result({ dir, stacks: res.stacks, skills: shown, sent });
  },
};
