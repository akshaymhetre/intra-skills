import { execFileSync } from "node:child_process";
import type { GitInfo } from "@intra-skills/shared";

function git(dir: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Commit, origin URL and dirtiness (of this directory only) when `dir` is inside a git work tree. */
export function gitInfo(dir: string): GitInfo | null {
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  const commit = git(dir, ["rev-parse", "HEAD"]);
  if (!commit) return null; // repo with no commits yet
  const repo = git(dir, ["config", "--get", "remote.origin.url"]) || null;
  const status = git(dir, ["status", "--porcelain", "--", "."]);
  return { commit, repo, dirty: Boolean(status) };
}
