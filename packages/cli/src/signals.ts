// What `intra suggest` sends: repo-relative file PATHS and dependency NAMES. Nothing else leaves
// the machine. The only files read are dependency manifests, and only the dependency names
// are taken from them (no versions, no scripts, no source).
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RepoSignals } from "@intra-skills/shared";

export const MAX_FILES = 5000;
export const MAX_PACKAGES = 2000;
/** Manifests read at most; a monorepo has many package.json files, the first ones are enough. */
const MAX_MANIFESTS = 200;
const MAX_MANIFEST_BYTES = 512 * 1024;

export const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "vendor", "target", "__pycache__", ".next"]);

const skipped = (path: string): boolean => path.split("/").some((part) => SKIP_DIRS.has(part));

/** `git ls-files` when dir is inside a work tree (tracked files only), else null. */
function gitFiles(dir: string): string[] | null {
  try {
    const inside = execFileSync("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (inside !== "true") return null;
    const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
    return out.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(abs).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(abs, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try {
        st = lstatSync(full); // symlinks are listed, never followed
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full, relPath);
      else out.push(relPath);
    }
  };
  walk(dir, "");
  return out;
}

const NAME = /^([A-Za-z0-9][A-Za-z0-9._-]*)/;

export function packageJsonDeps(text: string): string[] {
  try {
    const pkg = JSON.parse(text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    return [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
  } catch {
    return [];
  }
}

export function requirementsDeps(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line)) continue;
    const m = NAME.exec(line);
    if (m) out.push(m[1]!);
  }
  return out;
}

/** Name of a PEP 508 requirement string such as "fastapi[all]>=0.110; python_version>'3.8'". */
const pep508Name = (req: string): string | null => NAME.exec(req.trim())?.[1] ?? null;

/** [project] dependencies (array of strings) and [tool.poetry.*dependencies] tables (keys). */
export function pyprojectDeps(text: string): string[] {
  const out: string[] = [];
  let section = "";
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      continue;
    }
    if (section === "project" && /^dependencies\s*=/.test(line)) {
      let buf = line.slice(line.indexOf("=") + 1);
      while (!buf.includes("]") && i + 1 < lines.length) buf += "\n" + lines[++i]!.replace(/(^|\s)#.*$/, "");
      for (const m of buf.matchAll(/["']([^"']+)["']/g)) {
        const n = pep508Name(m[1]!);
        if (n) out.push(n);
      }
      continue;
    }
    if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(section)) {
      const key = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(line);
      if (key && key[1]!.toLowerCase() !== "python") out.push(key[1]!);
    }
  }
  return out;
}

export function goModDeps(text: string): string[] {
  const out: string[] = [];
  let block = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (block) {
      if (line.startsWith(")")) block = false;
      else if (line) out.push(line.split(/\s+/)[0]!);
      continue;
    }
    if (/^require\s*\($/.test(line)) block = true;
    else {
      const m = /^require\s+(\S+)/.exec(line);
      if (m) out.push(m[1]!);
    }
  }
  return out;
}

export function gemfileDeps(text: string): string[] {
  return [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}

export function cargoDeps(text: string): string[] {
  const out: string[] = [];
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = header[1]!.trim();
      const sub = /^(?:target\.[^\]]+\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section);
      if (sub) out.push(sub[1]!);
      continue;
    }
    if (/^(target\..+\.)?(dev-|build-)?dependencies$/.test(section)) {
      const key = /^["']?([A-Za-z0-9_-]+)["']?\s*=/.exec(line);
      if (key) out.push(key[1]!);
    }
  }
  return out;
}

type Parser = (text: string) => string[];

function parserFor(path: string): Parser | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (base === "package.json") return packageJsonDeps;
  if (/^requirements[^/]*\.txt$/.test(base)) return requirementsDeps;
  if (base === "pyproject.toml") return pyprojectDeps;
  if (base === "go.mod") return goModDeps;
  if (base === "Gemfile") return gemfileDeps;
  if (base === "Cargo.toml") return cargoDeps;
  return null;
}

export interface CollectedSignals extends RepoSignals {
  source: "git" | "walk";
  /** Manifests whose dependency names were read. */
  manifests: string[];
  truncated: { files: boolean; packages: boolean };
}

export function collectSignals(dir: string): CollectedSignals {
  const fromGit = gitFiles(dir);
  const all = (fromGit ?? walkFiles(dir)).filter((f) => !skipped(f));
  const files = all.slice(0, MAX_FILES);
  const manifests = files.filter((f) => parserFor(f)).slice(0, MAX_MANIFESTS);
  const packages = new Set<string>();
  for (const m of manifests) {
    let text: string;
    try {
      const p = join(dir, ...m.split("/"));
      const st = lstatSync(p);
      if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) continue; // a symlinked manifest is not followed
      text = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const name of parserFor(m)!(text)) packages.add(name);
  }
  const pkgList = [...packages].slice(0, MAX_PACKAGES);
  return {
    files,
    packages: pkgList,
    source: fromGit ? "git" : "walk",
    manifests,
    truncated: { files: all.length > MAX_FILES || (!fromGit && files.length >= MAX_FILES), packages: packages.size > MAX_PACKAGES },
  };
}
