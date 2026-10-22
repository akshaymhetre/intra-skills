# Write and publish skills, plugins and rules

The registry holds three kinds of package.
They share the same teams, stacks, versions, review and trust features; only the marker file and where they install differ.

| Kind | Marker file | Installs into |
|---|---|---|
| Skill | `SKILL.md` | Each tool's skills folder, globally or in a project |
| Claude Code plugin | `.claude-plugin/plugin.json` | Claude Code's own plugin system, from the marketplace the registry serves |
| Rule | `RULE.md` | `.cursor/rules/<name>.mdc`, `.claude/rules/<name>.md` and a managed block in `AGENTS.md`, in a project |

## Start a package

```sh
intra init deploy-check --team platform               # a skill
intra init release-kit --kind plugin --team platform  # a Claude Code plugin
intra init backend-logging --kind rule --team platform
```

Each command creates a folder that already passes `intra validate`, with `TODO` lines to replace.

### Skills

A skill is a folder with a `SKILL.md` and any files it refers to, such as scripts or reference pages.
The frontmatter is what people search and filter by:

```yaml
---
name: deploy-check
description: Verify an ECS deploy is healthy before declaring it done. Use after any deploy to staging or prod.
metadata:
  version: "1.2.0"
  team: platform
  stacks: "aws, docker"
  areas: "infra, backend"
  tags: "ecs, deploys"
  tools: "claude, codex, cursor"
---
```

- `description` is how an agent decides to use the skill, so say what it does and when.
- `team` is the owning team's slug. Its members can publish new versions.
- `stacks`, `areas` and `tags` place it on the Stacks pages and in the catalog filters.
- `tools` lists the tools it was written for; leave it out when it works everywhere.

### Plugins

A Claude Code plugin is a folder with `.claude-plugin/plugin.json` and the usual plugin parts: `commands/`, `agents/`, `skills/`, `hooks/`, `.mcp.json` and `bin/`.

```json
{
  "name": "release-kit",
  "version": "0.1.0",
  "description": "Say what it adds to Claude Code and when to install it.",
  "metadata": { "team": "platform" }
}
```

The registry lists each component on the plugin's page.
Hooks, local MCP servers, `bin/` executables and monitors run code on their own, so they are always flagged as behaviors to approve before installing.

### Rules

A rule is a folder with a `RULE.md`:

```yaml
---
name: backend-logging
description: Logging conventions for backend services. Cursor's agent reads this line to decide whether to apply the rule.
globs:
  - "services/**/*.ts"
alwaysApply: false
metadata:
  version: "1.1.0"
  team: platform
---
- Log through `logger` from the shared observability package; never `console.log` in a service.
- Never log a request body, a header or a token.
```

`globs` limits the rule to matching files.
Delete it and set `alwaysApply: true` for a rule that applies everywhere.
The rule page's **Renders as** tab shows the exact file each tool will get.

## Check it

```sh
intra validate deploy-check
```

`validate` checks the marker file, the frontmatter, the file paths and sizes, and scans for likely secrets such as API keys and private keys.
`publish` runs the same checks before anything leaves your machine.

## Publish it

```sh
intra publish deploy-check
intra publish deploy-check --bump minor --changelog "covers ECS rollbacks"
intra publish ~/.claude/skills/*        # import a whole folder of existing skills
```

What happens next depends on whether the registry has a repository connected.

**Without a repository**, the version is published straight away.
Versions are immutable: a new version must be greater than every earlier one, and a published version never changes.

**With a repository**, the same checks run and the files are sent as a proposal instead:

1. The registry pushes a branch and opens a pull request in the skills repository, using its own credential.
2. A reviewer other than you approves it and merges it on the git host.
3. The registry sees the merge and publishes the version from the merged files, with the commit and pull request recorded on it.

Follow your proposals with:

```sh
intra proposals
```

or on the console's **Proposals** page, which says in plain words what each one is waiting for.
You need a linked git username before you can propose: `intra identity set github <username>`, or `bitbucket-cloud`.

People can also edit files in the repository directly and open a pull request themselves.
The registry publishes any merged change under the skills, plugins or rules folders, with the same approval rule.
Raise the version in `SKILL.md`, `RULE.md` or `plugin.json` in the same pull request, because a version that is not greater than the last one is skipped.

## After publishing

```sh
intra yank deploy-check@1.2.0       # hide a broken version from new installs; lockfiles keep working
intra deprecate deploy-check        # mark it deprecated (or --undo)
intra visibility deploy-check private
intra grant deploy-check --team frontend --perm read
```

An admin can **verify** a version after reading its files, from the console's **Review** page.
A later version keeps the badge only if it adds no new behavior marked `ask`.
Teammates vote **works** or **broken** with a one-line note, and a skill with no new version in 90 days shows as stale.
