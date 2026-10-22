// Tech-stack detection from repo signals: file names and dependency names, never contents.
// The CLI runs it on a checkout for `intra suggest`; the server runs it on a skill's own files
// to SUGGEST metadata.stacks to an author (it never writes stacks the author did not declare).
// Browser-safe: no node imports.
import type { RepoSignals } from "./types.js";

export interface StackRule {
  stack: string;
  label: string;
  /** One match is enough: a manifest or config file that only this stack uses. */
  manifests?: RegExp[];
  /** Source files: two matches are needed, so one stray file does not tag a repo. */
  files?: RegExp[];
  /** Matched against each dependency name, exactly. */
  packages?: string[];
}

export const STACK_RULES: StackRule[] = [
  { stack: "react", label: "React", packages: ["react", "react-dom"], files: [/\.(jsx|tsx)$/] },
  { stack: "nextjs", label: "Next.js", packages: ["next"], manifests: [/(^|\/)next\.config\.(js|mjs|ts)$/] },
  { stack: "vue", label: "Vue", packages: ["vue", "nuxt"], files: [/\.vue$/] },
  { stack: "svelte", label: "Svelte", packages: ["svelte", "@sveltejs/kit"], files: [/\.svelte$/] },
  { stack: "tailwind", label: "Tailwind CSS", packages: ["tailwindcss"], manifests: [/(^|\/)tailwind\.config\./] },
  { stack: "node", label: "Node.js", manifests: [/(^|\/)package\.json$/] },
  { stack: "typescript", label: "TypeScript", packages: ["typescript"], manifests: [/(^|\/)tsconfig(\.[a-z]+)?\.json$/], files: [/\.tsx?$/] },
  { stack: "python", label: "Python", manifests: [/(^|\/)(pyproject\.toml|requirements[^/]*\.txt|setup\.py|Pipfile)$/], files: [/\.py$/] },
  { stack: "django", label: "Django", packages: ["django"], manifests: [/(^|\/)manage\.py$/] },
  { stack: "fastapi", label: "FastAPI", packages: ["fastapi"] },
  { stack: "go", label: "Go", manifests: [/(^|\/)go\.mod$/], files: [/\.go$/] },
  { stack: "rust", label: "Rust", manifests: [/(^|\/)Cargo\.toml$/], files: [/\.rs$/] },
  { stack: "java", label: "Java", manifests: [/(^|\/)(pom\.xml|build\.gradle)$/], files: [/\.java$/] },
  { stack: "kotlin", label: "Kotlin", manifests: [/(^|\/)build\.gradle\.kts$/], files: [/\.kt$/] },
  { stack: "ruby", label: "Ruby", manifests: [/(^|\/)Gemfile$/], files: [/\.rb$/] },
  { stack: "rails", label: "Rails", packages: ["rails"], manifests: [/(^|\/)config\/routes\.rb$/] },
  { stack: "terraform", label: "Terraform / OpenTofu", manifests: [/(^|\/)\.terraform\.lock\.hcl$/], files: [/\.tf$/] },
  { stack: "kubernetes", label: "Kubernetes", manifests: [/(^|\/)Chart\.yaml$/, /(^|\/)kustomization\.ya?ml$/], files: [/(^|\/)(k8s|kubernetes|manifests)\/[^/]+\.ya?ml$/] },
  { stack: "docker", label: "Docker", manifests: [/(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/] },
  { stack: "aws", label: "AWS", packages: ["boto3", "aws-cdk-lib", "@aws-sdk/client-s3"], manifests: [/(^|\/)cdk\.json$/] },
  { stack: "postgres", label: "PostgreSQL", packages: ["pg", "psycopg", "psycopg2", "postgres", "asyncpg"] },
  { stack: "playwright", label: "Playwright", packages: ["@playwright/test", "playwright"], manifests: [/(^|\/)playwright\.config\./] },
  { stack: "github-actions", label: "GitHub Actions", manifests: [/^\.github\/workflows\/[^/]+\.ya?ml$/] },
  { stack: "swift", label: "Swift / iOS", manifests: [/(^|\/)Package\.swift$/], files: [/\.swift$/] },
  { stack: "android", label: "Android", manifests: [/(^|\/)AndroidManifest\.xml$/] },
];

const LABELS = new Map(STACK_RULES.map((r) => [r.stack, r.label]));

/** Human label for a stack slug; unknown slugs come back unchanged. */
export function stackLabel(stack: string): string {
  return LABELS.get(stack) ?? stack;
}

/**
 * Stacks a repo uses, strongest evidence first. A stack needs a matching dependency, one
 * matching manifest, or at least two matching source files.
 */
export function detectStacks(signals: RepoSignals): { stack: string; evidence: string[] }[] {
  const pkgs = new Set(signals.packages.map((p) => p.toLowerCase()));
  const out: { stack: string; evidence: string[]; weight: number }[] = [];
  for (const rule of STACK_RULES) {
    const evidence: string[] = [];
    let weight = 0;
    let found = false;
    for (const p of rule.packages ?? [])
      if (pkgs.has(p)) {
        evidence.push(`depends on ${p}`);
        weight += 3;
        found = true;
      }
    for (const f of signals.files)
      if ((rule.manifests ?? []).some((re) => re.test(f))) {
        if (evidence.length < 4) evidence.push(f);
        weight += 2;
        found = true;
      }
    const sources = signals.files.filter((f) => (rule.files ?? []).some((re) => re.test(f)));
    if (sources.length >= 2) found = true;
    weight += sources.length;
    for (const f of sources.slice(0, Math.max(0, 4 - evidence.length))) evidence.push(f);
    if (found) out.push({ stack: rule.stack, evidence, weight });
  }
  return out.sort((a, b) => b.weight - a.weight || (a.stack < b.stack ? -1 : 1)).map(({ stack, evidence }) => ({ stack, evidence }));
}
