// Development seed data: a fictional org (users, teams, ~15 skills with version history, changelogs,
// file trees, one deprecated skill and one yanked version). scripts/dev/seed.ts publishes it into a
// REAL registry through its API, so the console is always developed against the real server.
// Every name, person and repo here is invented.
type Role = "admin" | "member";
type TeamRole = "maintainer" | "member";
type ToolId = "claude" | "codex" | "cursor";
type Visibility = "org" | "private";
interface Grant {
  principalType: "team" | "user";
  principal: string;
  permission: "read" | "write";
}

export interface SeedUser {
  handle: string;
  displayName: string;
  role: Role;
  daysAgo: number;
}

export const SEED_USERS: SeedUser[] = [
  { handle: "maya", displayName: "Maya Chen", role: "admin", daysAgo: 210 },
  { handle: "ravi", displayName: "Ravi Iyer", role: "member", daysAgo: 190 },
  { handle: "lena", displayName: "Lena Ortiz", role: "member", daysAgo: 180 },
  { handle: "sam", displayName: "Sam Okafor", role: "member", daysAgo: 160 },
  { handle: "noor", displayName: "Noor Haddad", role: "admin", daysAgo: 150 },
  { handle: "jonas", displayName: "Jonas Berg", role: "member", daysAgo: 120 },
  { handle: "kim", displayName: "Kim Tran", role: "member", daysAgo: 95 },
  { handle: "dev", displayName: "Dev Patel", role: "member", daysAgo: 60 },
];

export interface SeedTeam {
  slug: string;
  name: string;
  description: string;
  daysAgo: number;
  members: [string, TeamRole][];
}

export const SEED_TEAMS: SeedTeam[] = [
  {
    slug: "platform",
    name: "Platform",
    description: "Cloud infrastructure, CI, deploy pipelines and the on-call rotation.",
    daysAgo: 200,
    members: [["maya", "maintainer"], ["ravi", "maintainer"], ["jonas", "member"]],
  },
  {
    slug: "frontend",
    name: "Frontend",
    description: "Web console, design system and component library.",
    daysAgo: 178,
    members: [["lena", "maintainer"], ["kim", "member"], ["dev", "member"]],
  },
  {
    slug: "data",
    name: "Data",
    description: "Warehouse, dbt models, pipelines and analytics notebooks.",
    daysAgo: 158,
    members: [["sam", "maintainer"], ["noor", "member"]],
  },
  {
    slug: "security",
    name: "Security",
    description: "AppSec reviews, secrets hygiene and dependency risk.",
    daysAgo: 148,
    members: [["noor", "maintainer"], ["jonas", "member"], ["maya", "member"]],
  },
];

export interface SeedVersion {
  v: string;
  daysAgo: number;
  by: string;
  changelog: string;
  commit?: string;
  dirty?: boolean;
  yanked?: string;
  downloads: number;
  /** Extra workflow steps that this version introduces (cumulative). */
  addSteps?: string[];
  /** Extra reference file this version introduces. */
  addFile?: [string, string];
}

export interface SeedSkill {
  name: string;
  title: string;
  description: string;
  team: string | null;
  areas: string[];
  tools: ToolId[];
  tags: string[];
  visibility: Visibility;
  deprecated?: string;
  createdBy: string;
  when: string;
  steps: string[];
  rules: string[];
  script: [string, string];
  checklist: string[];
  versions: SeedVersion[];
  grants?: Grant[];
}

export const SEED_SKILLS: SeedSkill[] = [
  {
    name: "terraform-module-review",
    title: "Terraform module review",
    description:
      "Review a Terraform or OpenTofu module change for blast radius, state moves, provider pinning and cost before it reaches plan. Use when a PR touches infra/ or any *.tf file.",
    team: "platform",
    areas: ["infra", "backend"],
    tools: ["claude", "codex"],
    tags: ["terraform", "opentofu", "aws", "iac", "review"],
    visibility: "org",
    createdBy: "ravi",
    when: "a pull request changes any `*.tf` file, a module under `infra/`, or a `.terraform.lock.hcl`",
    steps: [
      "Run `scripts/plan-summary.sh <dir>` and read the resource counts before reading any code.",
      "List every `moved` and `removed` block and confirm each one has a matching address in state.",
      "Check provider and module versions are pinned with `~>` and the lockfile changed with them.",
      "Flag any resource whose replacement would drop data: RDS, EBS, S3 buckets without `prevent_destroy`.",
    ],
    rules: [
      "Never suggest `-target` as a fix. It hides drift instead of resolving it.",
      "A destroy of a stateful resource is a blocking finding even if the author says it is intended.",
      "Quote the exact plan line for every finding.",
    ],
    script: [
      "scripts/plan-summary.sh",
      `#!/usr/bin/env bash
# Summarise a tofu/terraform plan as resource counts per action.
set -euo pipefail
dir="\${1:-.}"
bin="$(command -v tofu || command -v terraform)"
cd "$dir"
"$bin" plan -no-color -lock=false -out=/tmp/isk.plan >/dev/null
"$bin" show -json /tmp/isk.plan \\
  | jq -r '.resource_changes[] | .change.actions | join(",")' \\
  | sort | uniq -c | sort -rn
`,
    ],
    checklist: [
      "Provider versions pinned and lockfile updated",
      "No stateful resource replaced without a migration note",
      "`moved` blocks cover every renamed address",
      "Tags include `owner` and `cost-center`",
      "Outputs consumed elsewhere are not renamed",
    ],
    versions: [
      { v: "1.0.0", daysAgo: 142, by: "ravi", changelog: "Initial version: plan summary, pinning and stateful-destroy checks.", commit: "4be1c09", downloads: 41 },
      { v: "1.1.0", daysAgo: 96, by: "ravi", changelog: "Add `moved`/`removed` block verification against state.", commit: "9d03a7e", downloads: 88, addSteps: ["Diff `terraform state list` before and after to confirm nothing orphaned."] },
      { v: "1.2.0", daysAgo: 41, by: "jonas", changelog: "Cost check via infracost when available. New references/cost.md.", commit: "e21f5c4", downloads: 133, addSteps: ["If `infracost` is installed, run it and report the monthly delta."], addFile: ["references/cost.md", "# Cost review\n\nReport the monthly delta from `infracost diff`.\nAnything over $200/month needs a note from the owning team.\n"] },
      { v: "1.2.1", daysAgo: 9, by: "ravi", changelog: "Fix plan-summary.sh on OpenTofu 1.10 (binary detection).", commit: "a7c3f19", dirty: true, downloads: 57 },
    ],
  },
  {
    name: "k8s-incident-triage",
    title: "Kubernetes incident triage",
    description:
      "First 15 minutes of a Kubernetes incident: gather pod, event and rollout state, find the change that broke it, and write a timeline the on-call can paste into the incident channel.",
    team: "platform",
    areas: ["infra"],
    tools: ["claude", "codex", "cursor"],
    tags: ["kubernetes", "oncall", "sre", "incident"],
    visibility: "org",
    createdBy: "maya",
    when: "someone reports an outage, a pager fires for a service on EKS, or pods are crash looping",
    steps: [
      "Run `scripts/snapshot.sh <namespace>` and keep the output as evidence.",
      "Compare the current ReplicaSet with the previous one: image, env and resource limits.",
      "Read the last 50 events sorted by time, newest last.",
      "Write a timeline with UTC timestamps and a single suspected cause.",
    ],
    rules: [
      "Read-only. Never `kubectl delete`, `scale` or `rollout undo` without the on-call saying so.",
      "State the evidence rung for the suspected cause.",
    ],
    script: [
      "scripts/snapshot.sh",
      `#!/usr/bin/env bash
set -euo pipefail
ns="\${1:?namespace}"
kubectl -n "$ns" get pods -o wide
kubectl -n "$ns" get events --sort-by=.lastTimestamp | tail -50
kubectl -n "$ns" rollout history deploy
`,
    ],
    checklist: ["Snapshot captured", "Last deploy identified", "Timeline posted", "Rollback decision recorded"],
    versions: [
      { v: "0.9.0", daysAgo: 120, by: "maya", changelog: "Beta for the platform on-call rotation.", commit: "11af3e2", downloads: 22 },
      { v: "1.0.0", daysAgo: 77, by: "maya", changelog: "Stable. Adds the timeline template.", commit: "5c0de41", downloads: 160, addSteps: ["Post the timeline using the template in references/checklist.md."] },
      { v: "2.0.0", daysAgo: 3, by: "ravi", changelog: "Breaking: snapshot.sh now takes the namespace as a required argument.", commit: "f00d1e5", downloads: 31 },
    ],
  },
  {
    name: "aws-cost-guard",
    title: "AWS cost guard",
    description:
      "Estimate the monthly cost of new AWS resources in a diff and stop changes that blow the team budget. Reads Cost Explorer through a read-only role.",
    team: "platform",
    areas: ["infra"],
    tools: ["claude"],
    tags: ["aws", "cost", "finops"],
    visibility: "private",
    createdBy: "maya",
    when: "a change adds NAT gateways, RDS instances, large EC2 types or cross-region traffic",
    steps: ["List each new billable resource with its type and region.", "Price it with the on-demand rate for ap-south-1.", "Compare against the team budget in references/checklist.md."],
    rules: ["Never use production credentials. Use the `cost-readonly` profile."],
    script: ["scripts/price.sh", "#!/usr/bin/env bash\naws pricing get-products --service-code AmazonEC2 --region us-east-1 --filters \"$@\"\n"],
    checklist: ["Budget looked up", "Delta under 10 percent or approved"],
    versions: [
      { v: "0.1.0", daysAgo: 30, by: "maya", changelog: "Internal trial with the platform team.", commit: "77ab210", downloads: 6 },
      { v: "0.2.0", daysAgo: 12, by: "maya", changelog: "Budget table moved into references.", commit: "8810fe2", downloads: 4 },
    ],
    grants: [
      { principalType: "team", principal: "data", permission: "read" },
      { principalType: "user", principal: "noor", permission: "write" },
    ],
  },
  {
    name: "release-notes",
    title: "Release notes",
    description:
      "Draft customer-facing release notes from merged PRs since the last tag, grouped by feature, fix and breaking change, in the house voice.",
    team: null,
    areas: ["docs", "product"],
    tools: ["claude", "codex"],
    tags: ["release", "changelog", "writing"],
    visibility: "org",
    createdBy: "dev",
    when: "cutting a release or preparing the weekly changelog post",
    steps: ["Collect merged PRs with `scripts/prs-since-tag.sh`.", "Group by label and drop internal-only changes.", "Write one sentence per change, user benefit first."],
    rules: ["No ticket ids in customer copy.", "No em dashes."],
    script: ["scripts/prs-since-tag.sh", "#!/usr/bin/env bash\ngh pr list --state merged --search \"merged:>=$(git log -1 --format=%cI $(git describe --tags --abbrev=0))\" --json number,title,labels\n"],
    checklist: ["Breaking changes first", "Every entry links its PR"],
    versions: [
      { v: "1.0.0", daysAgo: 64, by: "dev", changelog: "First version.", commit: "c4d2a11", downloads: 75 },
      { v: "1.1.0", daysAgo: 18, by: "dev", changelog: "Skip dependabot PRs; group by label.", commit: "d901bb3", downloads: 49, addSteps: ["Skip PRs authored by dependabot and renovate."] },
    ],
  },
  {
    name: "react-component-audit",
    title: "React component audit",
    description:
      "Audit a React component for accessibility, render cost and design-token drift, then fix what it finds. Generates Storybook stories for every state it touches.",
    team: "frontend",
    areas: ["frontend", "design"],
    tools: ["claude", "cursor"],
    tags: ["react", "a11y", "tailwind", "storybook", "review"],
    visibility: "org",
    createdBy: "lena",
    when: "a PR adds or changes a component under `src/components/` or `packages/ui/`",
    steps: [
      "Render every state the props allow: loading, empty, error, overflowing text.",
      "Check keyboard reach, focus order and that every icon button has an aria-label.",
      "Replace raw hex colours with design tokens.",
      "Write or update a story per state.",
    ],
    rules: ["Do not memoise to fix a render problem caused by a fetch waterfall.", "Contrast is computed, never eyeballed."],
    script: ["scripts/contrast.sh", "#!/usr/bin/env bash\nnpx --yes wcag-contrast-cli \"$1\" \"$2\"\n"],
    checklist: ["All states rendered", "Keyboard path works", "No raw hex", "Stories updated"],
    versions: [
      { v: "1.0.0", daysAgo: 150, by: "lena", changelog: "Accessibility and token checks.", commit: "0aa31c2", downloads: 120 },
      { v: "1.3.0", daysAgo: 90, by: "kim", changelog: "Render-cost pass with React Profiler output.", commit: "3b77de0", downloads: 210 },
      { v: "2.0.0", daysAgo: 21, by: "lena", changelog: "Generates Storybook stories itself, replacing storybook-stories.", commit: "91fe0b8", downloads: 302, addSteps: ["Run `pnpm storybook --smoke-test` and fix any story that fails to render."] },
    ],
  },
  {
    name: "design-token-sync",
    title: "Design token sync",
    description: "Pull tokens from the design system's Figma variables into tokens.css and the Tailwind theme, keeping light and dark in step.",
    team: "frontend",
    areas: ["frontend", "design"],
    tools: ["cursor", "claude"],
    tags: ["design-tokens", "figma", "tailwind", "css"],
    visibility: "org",
    createdBy: "kim",
    when: "the design team publishes a new variables library version",
    steps: ["Export variables with `scripts/export.sh`.", "Map each to a semantic token, never a raw value.", "Verify dark overrides exist for every light token."],
    rules: ["A theme key must not reference a variable of the same name."],
    script: ["scripts/export.sh", "#!/usr/bin/env bash\nnode scripts/figma-export.mjs --file \"$FIGMA_FILE\" --out tokens.json\n"],
    checklist: ["Every light token has a dark value", "Contrast passes in both themes"],
    versions: [
      { v: "0.4.0", daysAgo: 80, by: "kim", changelog: "Supports Figma variable modes.", commit: "ab12cd3", downloads: 37 },
      { v: "0.5.0", daysAgo: 33, by: "kim", changelog: "Emits Tailwind v4 @theme inline block.", commit: "be45f60", downloads: 29 },
    ],
  },
  {
    name: "playwright-flow-writer",
    title: "Playwright flow writer",
    description:
      "Write end-to-end Playwright flows that assert on the network contract instead of fragile selectors, with one test per user goal.",
    team: "frontend",
    areas: ["qa", "frontend"],
    tools: ["claude", "codex", "cursor"],
    tags: ["playwright", "e2e", "testing"],
    visibility: "org",
    createdBy: "dev",
    when: "a user flow has no end-to-end coverage, or a flaky test needs rewriting",
    steps: ["Name the test after what the user should be able to do.", "Assert the API response that proves the goal, then the UI.", "Use role and label locators only."],
    rules: ["Never `waitForTimeout`.", "One user goal per test."],
    script: ["scripts/run.sh", "#!/usr/bin/env bash\nnpx playwright test --reporter=line \"$@\"\n"],
    checklist: ["Test name reads as a sentence", "Network assertion present"],
    versions: [
      { v: "1.0.0", daysAgo: 70, by: "dev", changelog: "First release.", commit: "6611aa0", downloads: 64 },
      { v: "1.1.0", daysAgo: 25, by: "dev", changelog: "Accidentally shipped a debug `page.pause()` in the template.", commit: "7712bb1", yanked: "Template paused every run waiting for the inspector. Use 1.1.1.", downloads: 12 },
      { v: "1.1.1", daysAgo: 24, by: "dev", changelog: "Remove the stray `page.pause()` from the template.", commit: "7713cc2", downloads: 58 },
    ],
  },
  {
    name: "storybook-stories",
    title: "Storybook stories",
    description: "Generate Storybook stories for a component's states from its prop types.",
    team: "frontend",
    areas: ["frontend"],
    tools: ["claude", "cursor"],
    tags: ["storybook", "react"],
    visibility: "org",
    deprecated: "Superseded by react-component-audit 2.0, which writes stories as part of the audit.",
    createdBy: "kim",
    when: "a component has no stories",
    steps: ["Read the prop types.", "Write one story per meaningful state."],
    rules: ["Stories must render without network access."],
    script: ["scripts/smoke.sh", "#!/usr/bin/env bash\npnpm storybook --smoke-test\n"],
    checklist: ["Every state has a story"],
    versions: [{ v: "1.0.0", daysAgo: 170, by: "kim", changelog: "First release.", commit: "1111abc", downloads: 96 }],
  },
  {
    name: "sql-migration-safety",
    title: "SQL migration safety",
    description:
      "Check a Postgres migration for table locks, long rewrites and missing down-paths before it runs against production. Knows which ALTERs take ACCESS EXCLUSIVE.",
    team: "data",
    areas: ["data", "backend"],
    tools: ["claude", "codex"],
    tags: ["postgres", "migrations", "alembic", "sql"],
    visibility: "org",
    createdBy: "sam",
    when: "a PR adds a file under `migrations/` or `alembic/versions/`",
    steps: [
      "Classify each statement by the lock it takes.",
      "Flag `ADD COLUMN ... DEFAULT` on large tables and non-concurrent index builds.",
      "Confirm the downgrade path exists and is tested.",
    ],
    rules: ["Assume every table has 50 million rows unless told otherwise."],
    script: ["scripts/lock-report.sh", "#!/usr/bin/env bash\npsql \"$DATABASE_URL\" -c \"select relname, n_live_tup from pg_stat_user_tables order by 2 desc limit 20\"\n"],
    checklist: ["No ACCESS EXCLUSIVE on hot tables", "Indexes built CONCURRENTLY", "Downgrade tested"],
    versions: [
      { v: "1.0.0", daysAgo: 110, by: "sam", changelog: "Lock classification for common ALTERs.", commit: "2f2f2f2", downloads: 140 },
      { v: "1.1.0", daysAgo: 45, by: "noor", changelog: "Alembic-aware: reads op.* calls, not only raw SQL.", commit: "3e3e3e3", downloads: 98, addSteps: ["For Alembic, check constraints are declared inline in create_table so SQLite dev databases work."] },
    ],
  },
  {
    name: "dbt-model-docs",
    title: "dbt model docs",
    description: "Write and check dbt model and column descriptions, tests and owners so the catalog stays usable.",
    team: "data",
    areas: ["data", "docs"],
    tools: ["codex", "claude"],
    tags: ["dbt", "analytics", "docs"],
    visibility: "org",
    createdBy: "noor",
    when: "a dbt model is added or its columns change",
    steps: ["Describe every column in plain words.", "Add `not_null` and `unique` tests on keys.", "Set `meta.owner`."],
    rules: ["Descriptions say what the value means, not how it is computed."],
    script: ["scripts/coverage.sh", "#!/usr/bin/env bash\ndbt ls --resource-type model --output json | jq length\n"],
    checklist: ["Every column described", "Keys tested", "Owner set"],
    versions: [{ v: "0.3.0", daysAgo: 52, by: "noor", changelog: "Adds owner check.", commit: "4d4d4d4", downloads: 33 }],
  },
  {
    name: "pii-scan-notebooks",
    title: "PII scan for notebooks",
    description: "Scan Jupyter notebooks and their saved outputs for personal data before they are shared or committed.",
    team: "data",
    areas: ["data", "security"],
    tools: ["claude"],
    tags: ["pii", "jupyter", "privacy"],
    visibility: "private",
    createdBy: "sam",
    when: "a notebook is about to be shared outside the data team or committed",
    steps: ["Strip outputs with `scripts/strip.sh` first.", "Scan cell sources for emails, phone numbers and PAN-like ids."],
    rules: ["Never print a matched value. Report the cell number and the pattern."],
    script: ["scripts/strip.sh", "#!/usr/bin/env bash\njupyter nbconvert --clear-output --inplace \"$@\"\n"],
    checklist: ["Outputs stripped", "No matches, or each one justified"],
    versions: [
      { v: "0.1.0", daysAgo: 40, by: "sam", changelog: "First cut.", commit: "5a5a5a5", downloads: 8 },
      { v: "0.2.0", daysAgo: 6, by: "sam", changelog: "Detects Indian PAN and Aadhaar formats.", commit: "6b6b6b6", downloads: 3 },
    ],
    grants: [{ principalType: "team", principal: "security", permission: "write" }],
  },
  {
    name: "secrets-sweep",
    title: "Secrets sweep",
    description:
      "Find committed secrets in a repo or diff with gitleaks, rank them by blast radius, and walk through rotation without printing the secret.",
    team: "security",
    areas: ["security"],
    tools: ["claude", "codex", "cursor"],
    tags: ["secrets", "gitleaks", "rotation"],
    visibility: "org",
    createdBy: "noor",
    when: "a repo is about to go public, a leak has been reported, or a PR needs a pre-merge secrets gate",
    steps: ["Run `scripts/sweep.sh` on the full history.", "Group findings by credential type.", "For each live credential, name the rotation owner."],
    rules: ["Never echo a secret value, even partially.", "Treat every finding as live until rotation is confirmed."],
    script: ["scripts/sweep.sh", "#!/usr/bin/env bash\ngitleaks detect --redact --report-format json --report-path /tmp/leaks.json\n"],
    checklist: ["History scanned", "Each finding has an owner", "Rotations confirmed"],
    versions: [
      { v: "2.0.0", daysAgo: 88, by: "noor", changelog: "Moves to gitleaks 8 and redacted reports.", commit: "7c7c7c7", downloads: 180 },
      { v: "2.1.0", daysAgo: 14, by: "jonas", changelog: "Ranks findings by blast radius.", commit: "8d8d8d8", downloads: 77, addSteps: ["Rank by blast radius: cloud root keys first, then deploy tokens, then everything else."] },
    ],
  },
  {
    name: "threat-model-lite",
    title: "Threat model lite",
    description: "A one-page STRIDE pass for a new feature: assets, trust boundaries, top five threats and the control for each.",
    team: "security",
    areas: ["security", "product"],
    tools: ["claude"],
    tags: ["threat-model", "stride", "design-review"],
    visibility: "private",
    createdBy: "noor",
    when: "a feature crosses a trust boundary or handles money or personal data",
    steps: ["Draw the data flow in text.", "Walk STRIDE per boundary.", "Pick the five threats that matter and name a control for each."],
    rules: ["One page. If it needs more, the feature is too big."],
    script: ["scripts/template.sh", "#!/usr/bin/env bash\ncat references/checklist.md\n"],
    checklist: ["Assets listed", "Boundaries drawn", "Five threats with controls"],
    versions: [{ v: "0.2.0", daysAgo: 20, by: "noor", changelog: "Shorter template.", commit: "9e9e9e9", downloads: 11 }],
    grants: [{ principalType: "team", principal: "platform", permission: "read" }],
  },
  {
    name: "dependency-cve-triage",
    title: "Dependency CVE triage",
    description:
      "Triage dependency vulnerabilities from npm audit, pip-audit or Dependabot: is the vulnerable path reachable, what is the upgrade, and what breaks.",
    team: "security",
    areas: ["security", "backend"],
    tools: ["claude", "codex"],
    tags: ["cve", "npm", "pip", "supply-chain"],
    visibility: "org",
    createdBy: "jonas",
    when: "an audit tool reports a high or critical advisory",
    steps: ["Find the import path to the vulnerable function.", "Decide reachable or not, with the evidence.", "Propose the smallest upgrade that fixes it."],
    rules: ["Reachability claims need a code path, not a guess."],
    script: ["scripts/audit.sh", "#!/usr/bin/env bash\nnpm audit --json || pip-audit -f json\n"],
    checklist: ["Reachability decided with evidence", "Upgrade tested"],
    versions: [
      { v: "1.0.0", daysAgo: 58, by: "jonas", changelog: "First release.", commit: "a1a1a1a", downloads: 45 },
      { v: "1.0.1", daysAgo: 1, by: "jonas", changelog: "Handles pnpm audit output.", commit: "b2b2b2b", downloads: 2 },
    ],
  },
  // Worst-case row: a long name, no owning team, published today, nobody has installed it yet.
  {
    name: "kubernetes-admission-policy-authoring",
    title: "Kubernetes admission policy authoring",
    description: "Write and test Kyverno or Gatekeeper admission policies from a plain-language rule, with a failing and a passing manifest for each.",
    team: null,
    areas: ["infra"],
    tools: ["claude", "codex", "cursor"],
    tags: ["kubernetes", "policy", "kyverno"],
    visibility: "org",
    createdBy: "lena",
    when: "a cluster rule needs to be enforced at admission time",
    steps: ["Restate the rule as a test case.", "Write the policy.", "Prove it with one manifest that fails and one that passes."],
    rules: ["Every policy ships with both manifests."],
    script: ["scripts/test.sh", "#!/usr/bin/env bash\nkyverno test .\n"],
    checklist: ["Failing manifest rejected", "Passing manifest admitted"],
    versions: [{ v: "0.1.0", daysAgo: 0.2, by: "lena", changelog: "First release.", commit: "c3c3c3c", downloads: 0 }],
  },
];

/** Build the files of one version. Later versions accumulate steps and files so diffs are realistic. */
const KNOWN_STACKS = ["terraform", "kubernetes", "aws", "react", "typescript", "python", "postgres", "playwright", "tailwind", "docker", "github-actions", "node"];
const STACK_ALIASES: Record<string, string> = { k8s: "kubernetes", opentofu: "terraform", storybook: "react", jupyter: "python", dbt: "python", sql: "postgres", npm: "node" };

/** Tech stacks a seed skill declares in metadata.stacks, derived from its tags. */
export function stacksOf(s: SeedSkill): string[] {
  const out: string[] = [];
  for (const t of s.tags) {
    const st = KNOWN_STACKS.includes(t) ? t : STACK_ALIASES[t];
    if (st && !out.includes(st)) out.push(st);
  }
  return out;
}

export function buildFiles(s: SeedSkill, versionIndex: number): Record<string, string> {
  const v = s.versions[versionIndex]!;
  const steps = [...s.steps];
  const extraFiles: Record<string, string> = {};
  for (let i = 0; i <= versionIndex; i++) {
    const sv = s.versions[i]!;
    if (sv.addSteps) steps.push(...sv.addSteps);
    if (sv.addFile) extraFiles[sv.addFile[0]] = sv.addFile[1];
  }
  const fm = [
    "---",
    `name: ${s.name}`,
    `description: ${s.description}`,
    "license: Proprietary - internal use only",
    "metadata:",
    `  version: "${v.v}"`,
    ...(s.team ? [`  team: ${s.team}`] : []),
    `  areas: "${s.areas.join(", ")}"`,
    ...(stacksOf(s).length ? [`  stacks: "${stacksOf(s).join(", ")}"`] : []),
    `  tags: "${s.tags.join(", ")}"`,
    `  tools: "${s.tools.join(", ")}"`,
    ...(s.visibility === "private" ? ["  visibility: private"] : []),
    "---",
  ].join("\n");
  const body = [
    `# ${s.title}`,
    "",
    `Use this skill when ${s.when}.`,
    "",
    "## Workflow",
    "",
    ...steps.map((x, i) => `${i + 1}. ${x}`),
    "",
    "## Rules",
    "",
    ...s.rules.map((r) => `- ${r}`),
    "",
    "## Output",
    "",
    "Reply with a short verdict first, then findings as a table:",
    "",
    "| Severity | Finding | Evidence |",
    "| --- | --- | --- |",
    "| blocking | ... | the exact line or command output |",
    "",
    "## References",
    "",
    "- [Review checklist](references/checklist.md)",
    ...Object.keys(extraFiles).map((p) => `- [${p.split("/").pop()}](${p})`),
    "",
    "```bash",
    `bash ${s.script[0]}`,
    "```",
    "",
  ].join("\n");
  const checklist = ["# Checklist", "", ...s.checklist.map((c) => `- [ ] ${c}`), ""].join("\n");
  let script = s.script[1];
  if (s.name === "terraform-module-review" && v.v === "1.2.1") {
    script = script.replace('bin="$(command -v tofu || command -v terraform)"', 'bin="$(command -v tofu 2>/dev/null || command -v terraform)"\n[ -n "$bin" ] || { echo "need tofu or terraform" >&2; exit 2; }');
  }
  return {
    "SKILL.md": `${fm}\n\n${body}`,
    [s.script[0]]: script,
    "references/checklist.md": checklist,
    ...extraFiles,
  };
}

// ---------- plugins and rules (invented, like everything else here) ----------

export interface SeedPackage {
  name: string;
  /** Who published it, and how many days ago. */
  by: string;
  daysAgo: number;
  team: string;
  visibility?: Visibility;
  files: Record<string, string>;
  /** Executable paths. */
  exec?: string[];
}

export const SEED_PLUGINS: SeedPackage[] = [
  {
    name: "deploy-tools",
    by: "ravi",
    daysAgo: 6,
    team: "platform",
    exec: ["bin/deployctl"],
    files: {
      ".claude-plugin/plugin.json": JSON.stringify(
        {
          name: "deploy-tools",
          version: "1.3.0",
          description: "Deploy, roll back and watch a service from Claude Code: a status command, a release reviewer agent, and a post-edit check.",
          author: { name: "Platform team" },
          keywords: ["deploys", "ecs"],
          metadata: { team: "platform", stacks: ["aws", "docker"], areas: ["infra"] },
        },
        null,
        2,
      ),
      "README.md": "# Deploy tools\n\nEverything the platform team uses to ship a service.\n\n- `/deploy-tools:status <service>` prints the running task definition, health and the last three deploys.\n- The `release-reviewer` agent reads a diff and the target environment and says what could go wrong.\n- A post-edit hook runs `deployctl lint` on any changed task definition.\n",
      "commands/status.md": "---\ndescription: Show a service's running version, health and last deploys\nargument-hint: <service>\n---\nRun `deployctl status $ARGUMENTS` and summarise the result in three lines.\n",
      "agents/release-reviewer.md": "---\nname: release-reviewer\ndescription: Reviews a release diff against the target environment before a deploy.\n---\nRead the diff, then list risky changes first: migrations, IAM, public endpoints.\n",
      "hooks/hooks.json": JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Write|Edit", hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}"/bin/deployctl lint --changed' }] }] } }, null, 2),
      ".mcp.json": JSON.stringify({ mcpServers: { "deploy-api": { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server/index.js"] } } }, null, 2),
      "bin/deployctl": "#!/bin/sh\n# Thin wrapper around the internal deploy API.\nexec node \"$(dirname \"$0\")/../server/cli.js\" \"$@\"\n",
      "server/index.js": "// MCP server: exposes deploy status and rollback as tools.\n",
      "server/cli.js": "// deployctl entry point.\n",
    },
  },
  {
    name: "design-review-kit",
    by: "lena",
    daysAgo: 15,
    team: "frontend",
    files: {
      ".claude-plugin/plugin.json": JSON.stringify(
        {
          name: "design-review-kit",
          version: "0.4.0",
          description: "Review a UI change against the design system: a contrast checker skill, an audit command and the design-tokens docs server.",
          author: { name: "Frontend team" },
          keywords: ["design-system", "a11y"],
          metadata: { team: "frontend", stacks: ["react", "tailwind"], areas: ["frontend", "design"] },
        },
        null,
        2,
      ),
      "README.md": "# Design review kit\n\nRun `/design-review-kit:audit` on a pull request that touches components.\nThe contrast skill computes ratios; it never eyeballs them.\n",
      "commands/audit.md": "---\ndescription: Audit changed components against the design system\n---\nList every changed component, then check tokens, focus states and contrast.\n",
      "skills/contrast-check/SKILL.md": "---\nname: contrast-check\ndescription: Compute WCAG contrast for every text and background pair in a component. Use when a component's colours change.\n---\n# Contrast check\n\nResolve each CSS variable, then compute the ratio. Report pairs under 4.5:1.\n",
      ".mcp.json": JSON.stringify({ mcpServers: { "design-tokens": { type: "http", url: "https://tokens.acme.example/mcp" } } }, null, 2),
    },
  },
];

export const SEED_RULES: SeedPackage[] = [
  {
    name: "backend-logging",
    by: "ravi",
    daysAgo: 12,
    team: "platform",
    files: {
      "RULE.md":
        '---\nname: backend-logging\ndescription: Logging conventions for backend services - structured logs through the shared logger, never console.log.\nglobs:\n  - "services/**/*.ts"\n  - "packages/server/**/*.ts"\nalwaysApply: false\nmetadata:\n  version: "1.1.0"\n  team: platform\n  stacks: "node, typescript"\n  areas: backend\n---\n# Backend logging\n\n- Log through `logger` from `@acme/observability`; never `console.log` in a service.\n- One event per line, with `service`, `requestId` and `durationMs` fields.\n- Never log a request body, a header or a token.\n',
    },
  },
  {
    name: "no-secrets-in-code",
    by: "noor",
    daysAgo: 30,
    team: "security",
    files: {
      "RULE.md":
        '---\nname: no-secrets-in-code\ndescription: Keep credentials out of code, fixtures and examples in every repository.\nalwaysApply: true\nmetadata:\n  version: "2.0.0"\n  team: security\n  areas: security\n---\n# No secrets in code\n\n- Read credentials from the environment or the secret store at run time.\n- Example values use the documented placeholders, never a real-looking key.\n- If you find a secret, stop and say where it is; do not print it.\n',
    },
  },
  {
    name: "react-component-conventions",
    by: "kim",
    daysAgo: 4,
    team: "frontend",
    files: {
      "RULE.md":
        '---\nname: react-component-conventions\ndescription: How components are written in the web apps - tokens over raw colours, every state designed, hooks above early returns.\nglobs: "apps/**/*.tsx, packages/ui/**/*.tsx"\nalwaysApply: false\nmetadata:\n  version: "1.0.0"\n  team: frontend\n  stacks: "react, tailwind"\n  areas: frontend\n---\n# React component conventions\n\n- Colours come from tokens; no raw hex in a component.\n- Every component renders its loading, empty and error states.\n- Call every hook above the first early return.\n',
    },
  },
];
