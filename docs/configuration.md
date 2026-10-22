# Configuration

intra-skills reads a handful of environment variables at start.
Organization settings can also be changed in the console under **Admin, Registry**.
A setting pinned by an environment variable shows as read-only there, so the variable always wins.

## Organization settings

These are editable on the Registry page unless pinned.

| Variable | Default | Meaning |
|---|---|---|
| `INTRA_SKILLS_PUBLIC_URL` | the request's origin | The URL people and agents use. Every command the console, the CLI installer and the agent documents print is built from it. Set it whenever the registry sits behind a proxy. |
| `INTRA_SKILLS_ORG_NAME` | `intra-skills` | The organization's name: the console's wordmark, page titles, and the name of its Claude Code plugin marketplace. |
| `INTRA_SKILLS_STALE_DAYS` | `90` | Days without a new version before a skill shows as stale. |
| `INTRA_SKILLS_POLL_SECONDS` | `60` | How often each connected repository is checked for merged pull requests. A webhook makes this a fallback. |

## Server

| Variable | Default | Meaning |
|---|---|---|
| `INTRA_SKILLS_DATA` | (required) | The data directory. The Docker image uses `/data`. |
| `PORT`, `HOST` | `7710`, `127.0.0.1` | Listen address. The Docker image listens on `0.0.0.0` inside the container. |
| `INTRA_SKILLS_SECRET_KEY` | `<data>/secret.key` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts stored git credentials and webhook secrets with AES-256-GCM. Without it, the server creates `secret.key` on first start. |
| `INTRA_SKILLS_WEB_DIR` | the built console | Where the built console lives. Set by the Docker image. |
| `INTRA_SKILLS_CLI_BUNDLE` | the built CLI | The single-file CLI the registry hands out at `/install.sh`. Set by the Docker image. |

## Docker Compose only

These are read by `docker-compose.yml` from `.env`, not by the server.

| Variable | Default | Meaning |
|---|---|---|
| `INTRA_SKILLS_DOMAIN` | (required with `--profile https`) | The host name Caddy fetches a certificate for. |
| `INTRA_SKILLS_BIND` | `127.0.0.1` | The host address port 7710 is published on. Use `0.0.0.0` only when your own proxy runs on another machine. |

## The CLI

Each person's `intra` CLI keeps its settings in `~/.intra-skills/config.json`.
`intra config` reads and changes them, and these variables override them:

| Variable | Meaning |
|---|---|
| `INTRA_SKILLS_HOME` | Where the CLI keeps its config, token and installed versions. Default `~/.intra-skills`. |
| `INTRA_SKILLS_REGISTRY` | The registry URL, for CI. |
| `INTRA_SKILLS_TOKEN` | An API token, for CI. Create one under **Settings, API tokens**. |
| `INTRA_CLAUDE_BIN` | The `claude` executable used to install plugins, when it is not on `PATH`. |
| `NO_COLOR` | Plain output. |

`intra config set defaultTargets claude,codex,cursor` chooses which tools a plain `intra install` writes into.

## Roles and permissions

- **Admins** do everything: people, teams, repositories, verification and registry settings.
- **Members** browse, install, vote and publish to the skills their teams own.
- Within a team, **maintainers** also manage who is on it.
- A skill is visible to the whole organization or private. A private skill is readable by admins, its creator, members of its owning team, and any team or user it was granted to. Anyone else gets a 404, so they cannot tell it exists.
- Publishing a new version needs write access: admins, the creator, members of the owning team, or a `write` grant. With a repository connected, the pull request review is a second gate.

Every change is written to the activity log, shown in the console under **Activity**.

## API tokens

Tokens look like `isk_` followed by 32 characters.
The server stores only a hash of each one.
People make one per machine under **Settings**, and `intra login` makes one for them through a browser approval.

A **plugin key** is a separate, read-only token whose only use is the Claude Code marketplace URL, because that URL is stored in Claude Code's settings in plain text.
It can list and download plugins and nothing else.
