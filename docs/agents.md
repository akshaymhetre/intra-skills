# Connect your coding agents

There are three ways to put a registry in front of an agent.
Most people only need the first.

1. **The CLI**, which installs skills into each tool's own folder and teaches the agent to use the registry.
2. **MCP**, for tools without a shell, or when you want the agent to search the registry itself.
3. **A URL**, for an agent that can only read web pages.

In the examples, `https://skills.example.com` stands for your registry's address.
The console's **Get started** page shows every command with your real address filled in.

## 1. The CLI

### Set up a machine

```sh
curl -fsSL https://skills.example.com/install.sh | sh
intra setup
```

The installer puts the `intra` CLI in `~/.intra-skills` without sudo; it needs Node 20 or newer.
`intra setup` then:

1. signs you in: a browser tab opens on the registry and asks you to approve a code;
2. installs the registry's own skill, `intra-registry`, into Claude Code and Codex, so the agent knows how to search and install skills;
3. prints the lines that connect Claude Code and Codex to the MCP server (it never edits their config files itself);
4. connects Claude Code to the registry's plugin marketplace, when `claude` is on your `PATH`;
5. checks every folder it uses and prints a summary.

Cursor is included with `intra setup --to claude,codex,cursor`.

### Or let the agent do it

Paste this into Claude Code or Codex:

> Set up our skills registry at https://skills.example.com for me. Read https://skills.example.com/agent.md first and follow it.

`agent.md` tells the agent how to install the CLI and how to run the sign-in so that you approve the code.
After that you can ask it things like "find a skill for reviewing Terraform changes and install it".

### Where packages land

| Tool | Skills, global | Skills, project | Rules (always project) |
|---|---|---|---|
| Claude Code | `~/.claude/skills/<name>` | `.claude/skills/<name>` | `.claude/rules/<name>.md` |
| Codex | `~/.agents/skills/<name>` | `.agents/skills/<name>` | a managed block in `AGENTS.md` |
| Cursor | `~/.cursor/skills/<name>` | `.cursor/skills/<name>` | `.cursor/rules/<name>.mdc` |

A global skill install keeps one verified copy in `~/.intra-skills/store/<name>/<version>/` and links it into each tool.
Cursor also reads `.claude/skills` and `.agents/skills`, so the default targets are Claude Code and Codex.
The CLI never overwrites a folder or rule file it did not write; `--force` moves the existing one to a backup first.

Plugins install through Claude Code's own plugin system:

```sh
intra plugins connect            # once per machine
intra install deploy-tools       # runs: claude plugin install deploy-tools@<marketplace>
```

### Projects and CI

`--project` copies skills into the repository and records exact versions and hashes in `skills.lock.json`, so the whole team and CI use the same files:

```sh
intra install pr-review --project
git add .claude .agents skills.lock.json && git commit -m "add pr-review skill"
```

A teammate or a CI job then runs:

```sh
intra sync --frozen
```

`--frozen` fails instead of changing anything when the project no longer matches its lockfile.
In CI, set `INTRA_SKILLS_REGISTRY` and `INTRA_SKILLS_TOKEN` instead of signing in.

## 2. MCP

The registry is a streamable HTTP MCP server at `https://skills.example.com/api/mcp`.
It needs an API token as a bearer header: create one under **Settings, API tokens**, or run `intra setup`, which prints these lines with a token filled in.

Claude Code:

```sh
claude mcp add --transport http intra-skills https://skills.example.com/api/mcp \
  --header "Authorization: Bearer <token>"
```

Codex, in `~/.codex/config.toml`, with the token in the `INTRA_SKILLS_TOKEN` environment variable:

```toml
[mcp_servers.intra-skills]
url = "https://skills.example.com/api/mcp"
bearer_token_env_var = "INTRA_SKILLS_TOKEN"
```

Any other MCP client that supports streamable HTTP with a custom header works the same way.

The tools are read-only and none of them writes to your machine:

| Tool | What it does |
|---|---|
| `search_skills` | Search by text, kind, team or stack. |
| `get_skill` | A package's description, versions, behaviors and readme. |
| `install_command` | The exact command to install a package. It returns the command; it never runs it. |
| `suggest_for_repo` | Recommendations from a repository's file and dependency names. |

## 3. A URL

An agent that can only fetch pages can read:

- `https://skills.example.com/agent.md`: how to set up and use the registry, step by step.
- `https://skills.example.com/SKILL.md`: the `intra-registry` skill itself.
- `https://skills.example.com/llms.txt`: the API, for agents that call it directly with a token.

## What the agent is told about risk

Every version is scanned when it is published for behaviors a reader should see first, such as piping a download into a shell, deleting folders recursively, reading credential files, pushing to git, or, for plugins, hooks, MCP servers and executables.
The ones marked **ask** are shown before `intra run`, by `intra update`, in the console and in the MCP answers, and the bootstrap skill tells the agent to show them to you and wait for a yes before following the skill.
The scan looks for fixed patterns, so it misses deliberately hidden code: it supports review, it does not replace it.
