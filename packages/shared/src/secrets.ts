// Likely-secret patterns, checked by the CLI before upload and by the server before it writes
// anything to a git host. A hit is refused, never redacted: a skill that needs a credential
// should read it from the environment at run time. Browser-safe: no node imports.

export interface SecretHit {
  path: string;
  line: number;
  kind: string;
  /** First 8 characters of the match, never the whole secret. */
  preview: string;
}

export const SECRET_PATTERNS: { kind: string; re: RegExp }[] = [
  { kind: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { kind: "GitHub fine-grained token", re: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { kind: "Bitbucket access token", re: /\bATCTT3xFfGN0[A-Za-z0-9_=-]{20,}|\bATBB[A-Za-z0-9]{28,}/ },
  { kind: "Atlassian API token", re: /\bATATT3xFfGF0[A-Za-z0-9_=-]{20,}/ },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "Slack token", re: /\bxox[bp]-[A-Za-z0-9-]{10,}/ },
  { kind: "intra-skills token", re: /\bisk_[A-Za-z0-9]{32}\b/ },
];

/** Placeholder credentials published in vendor documentation; never real. */
const DOCUMENTED_EXAMPLES = new Set(["AKIAIOSFODNN7EXAMPLE", "AKIAI44QH8DHBEXAMPLE"]);

/** Line-level scan. Pass `text: null` for binary files; they are skipped. */
export function scanSecrets(files: { path: string; text: string | null }[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const f of files) {
    if (f.text === null) continue;
    f.text.split("\n").forEach((line, i) => {
      for (const { kind, re } of SECRET_PATTERNS) {
        const m = re.exec(line);
        if (m && !DOCUMENTED_EXAMPLES.has(m[0])) hits.push({ path: f.path, line: i + 1, kind, preview: `${m[0].slice(0, 8)}…` });
      }
    });
  }
  return hits;
}
