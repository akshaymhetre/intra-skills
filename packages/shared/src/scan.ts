// Behaviors scan and token estimate, computed once at publish and stored with the version.
// The scan is a fixed list of patterns, not a review: it finds what a reader should look at,
// and it misses anything obfuscated. Browser-safe: no node imports.
import type { Behavior, TokenEstimate } from "./types.js";
import { SKILL_FILE, splitFrontmatter } from "./skill.js";

interface Rule {
  id: string;
  tier: Behavior["tier"];
  label: string;
  re: RegExp;
}

// Order matters only for display. Each rule reports at most 5 hits per file.
const LINE_RULES: Rule[] = [
  {
    id: "pipe-to-shell",
    tier: "ask",
    label: "Downloads a script and runs it",
    re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  },
  { id: "delete-recursive", tier: "ask", label: "Deletes files recursively", re: /\brm\s+-[a-z]*r[a-z]*f?\b|\brm\s+-[a-z]*f[a-z]*r\b/ },
  { id: "sudo", tier: "ask", label: "Runs commands as root", re: /(^|[\s;&|`(])sudo\s+\S/ },
  {
    id: "credentials",
    tier: "ask",
    label: "Reads credential files",
    re: /~\/\.(aws|ssh|netrc|npmrc|docker\/config\.json|kube\/config)|\bid_(rsa|ed25519)\b|\.env\b(?!\.example)/,
  },
  { id: "git-push", tier: "ask", label: "Pushes to a git remote", re: /\bgit\s+push\b/ },
  { id: "force", tier: "ask", label: "Uses a force flag on git", re: /\bgit\s+(push|reset|clean)\b[^\n]*(--force\b|-f\b|--hard\b)/ },
  {
    id: "network",
    tier: "info",
    label: "Calls the network",
    re: /\b(curl|wget|fetch\(|axios\.|requests\.(get|post)|http\.request|urllib)\b|https?:\/\/(?!(www\.)?(example\.com|localhost|127\.0\.0\.1))/,
  },
  { id: "package-install", tier: "info", label: "Installs packages", re: /\b(npm|pnpm|yarn)\s+(i|install|add)\b|\bpip3?\s+install\b|\bbrew\s+install\b|\bapt(-get)?\s+install\b|\bnpx\s+\S/ },
  { id: "writes-config", tier: "info", label: "Edits shell or agent config", re: /~\/\.(zshrc|bashrc|zshenv|profile|claude\/settings\.json|codex\/config\.toml)/ },
];

const SCRIPT_EXT = /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;

export interface ScanFile {
  path: string;
  mode: number;
  /** Text content, or null for binary files. */
  text: string | null;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > 120 ? `${t.slice(0, 117)}...` : t;
}

/** Fixed-pattern scan of every text file, plus executable scripts and model-invocation flags. */
export function scanBehaviors(files: ScanFile[]): Behavior[] {
  const out: Behavior[] = [];
  for (const f of [...files].sort((a, b) => (a.path === SKILL_FILE ? -1 : b.path === SKILL_FILE ? 1 : a.path < b.path ? -1 : 1))) {
    if ((f.mode & 0o111) !== 0 || SCRIPT_EXT.test(f.path))
      out.push({ id: "script", tier: "info", label: "Ships a script the agent can run", file: f.path, line: null, match: f.path });
    if (f.text === null) continue;
    const lines = f.text.split(/\r?\n/);
    for (const rule of LINE_RULES) {
      let hits = 0;
      for (let i = 0; i < lines.length && hits < 5; i++) {
        const line = lines[i]!;
        const m = rule.re.exec(line);
        if (!m) continue;
        hits++;
        out.push({ id: rule.id, tier: rule.tier, label: rule.label, file: f.path, line: i + 1, match: clip(line) });
      }
    }
    if (f.path === SKILL_FILE) {
      const fm = splitFrontmatter(f.text);
      if (fm && /^\s*disable-model-invocation:\s*true\b/m.test(fm.frontmatter))
        out.push({
          id: "manual-only",
          tier: "info",
          label: "Runs only when called by name",
          file: f.path,
          line: null,
          match: "disable-model-invocation: true",
        });
      if (fm && /^\s*allowed-tools:/m.test(fm.frontmatter)) {
        const line = fm.frontmatter.split(/\r?\n/).find((l) => /^\s*allowed-tools:/.test(l)) ?? "allowed-tools";
        out.push({ id: "allowed-tools", tier: "info", label: "Pre-approves tools", file: f.path, line: null, match: clip(line) });
      }
    }
  }
  return out;
}

/** The distinct `ask`-tier rule ids, sorted. Two versions with the same set need no new review. */
export function askBehaviorIds(behaviors: Behavior[]): string[] {
  return [...new Set(behaviors.filter((b) => b.tier === "ask").map((b) => b.id))].sort();
}

/** True when `next` asks for something `prev` did not. */
export function addsAskBehavior(prev: Behavior[], next: Behavior[]): boolean {
  const before = new Set(askBehaviorIds(prev));
  return askBehaviorIds(next).some((id) => !before.has(id));
}

/** About 4 characters per token for English prose and code. Good enough to compare skills. */
export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateTokens(files: ScanFile[], name: string, description: string): TokenEstimate {
  const skill = files.find((f) => f.path === SKILL_FILE);
  const body = skill?.text ? (splitFrontmatter(skill.text)?.body ?? skill.text) : "";
  const references = files
    .filter((f) => f.path !== SKILL_FILE && f.text !== null)
    .reduce((n, f) => n + approxTokens(f.text as string), 0);
  return { metadata: approxTokens(`${name}: ${description}`), body: approxTokens(body), references };
}
