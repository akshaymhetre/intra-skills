# Architecture

intra-skills is a pnpm workspace with four packages.
The server, the CLI and the console all import one shared package for the wire contract, so they cannot drift apart.

```
packages/
  shared/   the wire types and the rules every side agrees on
  server/   the registry: API, console hosting, MCP, git sync, plugin marketplace
  cli/      intra, shipped as one file by the registry
  web/      the console, a React single-page app the server serves
scripts/
  dev/      a seeded development registry (up.sh, down.sh, seed.ts, data.ts)
  e2e.sh    the real server and the real CLI in a sandbox home directory
deploy/     the Caddyfile for docker-compose.yml
docs/       this documentation
```

## shared

- `types.ts`: every JSON shape on the wire. [API.md](API.md) describes the routes that carry them.
- `kinds.ts`: how a folder becomes a skill, plugin or rule, and how a rule renders for Cursor, Claude Code and `AGENTS.md`.
- `skill.ts`, `semver.ts`, `hash.ts`: frontmatter parsing, version ranges and the bundle hash.
- `scan.ts`: the fixed-pattern behavior scan and the context-token estimate.
- `secrets.ts`: the secret scan `intra validate` and `intra publish` run before upload.
- `stacks.ts`: the tech-stack vocabulary and detection from file and dependency names.

## server

Node 24, Hono, and the built-in `node:sqlite`.

- `db.ts`: the schema and forward-only migrations. A server older than its database refuses to start.
- `publish.ts`: the one path that turns files into an immutable version, used by a direct publish and by git sync alike. File bytes are stored once each, by sha256, in a `blobs` table.
- `access.ts`: the one place that decides who may read, write or administer a package.
- `auth.ts`, `routes/device.ts`: API tokens, the session cookie, and the browser-approved device login the CLI uses.
- `git/`: the GitHub and Bitbucket Cloud providers behind one `GitProvider` interface, plus `propose.ts` (opening pull requests), `sync.ts` (publishing merged ones) and `fake.ts`, an in-memory host the tests drive.
- `mcp.ts`: the MCP server, a thin read-only adapter over the same API.
- `agent-docs.ts`: `/agent.md`, `/llms.txt`, `/SKILL.md` and `/install.sh`, built from the registry's real address.
- `routes/marketplace.ts`, `zip.ts`, `archive.ts`: the Claude Code marketplace and its deterministic plugin archives.
- `backup.ts`: online backup and restore of the data directory.

## cli

`intra` is TypeScript bundled into one file with esbuild, targeting Node 20, and served by the registry at `/cli/intra.mjs`.
Installs are verified file by file against the registry's hashes before anything is written, and the CLI never overwrites a folder it did not write.
Every command takes `--json`, which prints one JSON document on stdout, errors included, so agents can drive it.

## web

React 19, React Router and Tailwind CSS 4, built with Vite.
The console only calls the public API, so anything it shows can also be done from the CLI.
Colours, type and spacing are tokens in `src/styles.css`; the reasoning behind them is in [`packages/web/design/DIRECTION.md`](../packages/web/design/DIRECTION.md).

## Conventions

- One path per decision: publishing goes through `publish.ts`, permissions through `access.ts`, and wire shapes through `shared/types.ts`.
- Versions are immutable. A fix is a new version; a bad one is yanked, never edited.
- The registry holds the git credential, never the people who publish.
- Every admin change and every publish writes an audit entry.
- Development and tests run against the real server: `scripts/dev/seed.ts` seeds through the API, and there is no mock server to drift from it.
- Copy is plain, specific and in sentence case.
