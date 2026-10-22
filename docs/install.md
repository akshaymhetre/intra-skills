# Install intra-skills for your company

One registry serves one organization.
It is a single Node 24 process with one data directory, which holds a SQLite database and the key that encrypts stored git credentials.
There is no external database, queue or object store to run.

This guide uses Docker Compose with Caddy, which fetches the HTTPS certificate for you.
If you already have a reverse proxy or a load balancer, see [Behind your own proxy](#behind-your-own-proxy).

## Requirements

- A Linux machine (or a VM) with Docker Engine and the Compose plugin. 1 CPU and 1 GB of memory is plenty for hundreds of people.
- A host name such as `skills.example.com`, with DNS pointing at that machine.
- Ports 80 and 443 reachable from your network, so Caddy can answer the certificate challenge and serve HTTPS.
- On each teammate's machine: Node 20 or newer for the `intra` CLI.

HTTPS is not optional in practice: Claude Code installs plugins only from an HTTPS address that is not on the same machine.
Skills and rules work over plain HTTP too, but people's tokens then cross the network unencrypted.

## 1. Get the code and configure it

```sh
git clone https://github.com/akshaymhetre/intra-skills.git
cd intra-skills
cp .env.example .env
```

Edit `.env`:

| Setting | Example | What it is |
|---|---|---|
| `INTRA_SKILLS_PUBLIC_URL` | `https://skills.example.com` | The address people and agents use. Every command the registry prints is built from it. |
| `INTRA_SKILLS_DOMAIN` | `skills.example.com` | The host name Caddy fetches a certificate for. |
| `INTRA_SKILLS_ORG_NAME` | (empty) | Optional. The organization's name, shown in the console and used as the Claude Code marketplace name. Leave it empty to choose it in the setup wizard. |
| `INTRA_SKILLS_SECRET_KEY` | (empty) | Optional. Leave it empty and the server creates a key file on first start. |

Every setting is described in [configuration.md](configuration.md).

## 2. Start it

```sh
docker compose --profile https up -d --build
```

The first start builds the image, which takes a few minutes.
Check that it is healthy:

```sh
curl -fsS https://skills.example.com/api/health
```

The expected output is `{"ok":true,"version":"0.1.0"}`.
If the command hangs or fails on the certificate, check that DNS points at this machine and that ports 80 and 443 are open, then read `docker compose logs caddy`.

## 3. Create the first administrator

On the first start, the server prints a one-time setup link:

```sh
docker compose logs intra-skills | grep setup
```

The expected output is one line like `https://skills.example.com/setup?token=...`.
Open it straight away, because whoever completes it becomes the first administrator.
Choose the organization name and your handle, and store the token the page shows you.

The page signs you in to the console.
From there, add people under **Admin, Members**, and create teams under **Teams**.

## 4. Connect your skills repository (optional, recommended)

Without a repository, `intra publish` uploads a new version straight to the registry, checked by the same validation and behavior scan.
With a repository connected, every new skill and every update becomes a pull request that needs an approved merge, and the merge is what publishes it.

Follow the guide for your git host:

- [GitHub](git-hosts/github.md), including GitHub Enterprise Server
- [Bitbucket Cloud](git-hosts/bitbucket-cloud.md)

## 5. Get people started

Send each person the console's **Get started** page.
On their machine it comes down to one line, which installs the CLI and signs them in with a code they approve in the browser:

```sh
curl -fsSL https://skills.example.com/install.sh | sh && intra setup
```

The CLI installs into `~/.intra-skills` without sudo.
How to set up Claude Code, Codex, Cursor and MCP clients is in [agents.md](agents.md).

## Behind your own proxy

Start without the Caddy profile:

```sh
docker compose up -d --build
```

The registry then listens on port 7710 of the loopback interface only.
Point your proxy at `http://127.0.0.1:7710`, terminate TLS there, and set `INTRA_SKILLS_PUBLIC_URL` to the HTTPS address people use.
If the proxy runs on another machine, set `INTRA_SKILLS_BIND=0.0.0.0` in `.env` and allow only the proxy to reach port 7710.

The registry needs nothing special from the proxy: no websockets, no sticky sessions, and request bodies up to the size of your largest skill.

### On a tailnet

On a Tailscale network, `tailscale serve` gives the registry a trusted HTTPS address with no public DNS:

```sh
tailscale serve --bg 7710
```

Set `INTRA_SKILLS_PUBLIC_URL` to the `https://<machine>.<tailnet>.ts.net` address it prints, and restart the registry.

### Without Docker

```sh
pnpm install && pnpm build
INTRA_SKILLS_PUBLIC_URL=https://skills.example.com \
  node packages/server/dist/bin.js serve --data /var/lib/intra-skills --host 127.0.0.1 --port 7710
```

Run it under your service manager (systemd, launchd) with this process as the service itself, not a script that starts it in the background.
For a scripted install, `node packages/server/dist/bin.js init --data <dir> --admin <handle>` creates the first administrator and prints their token instead of a setup link.

## Backups

Everything lives in the data directory, which is the `intra-skills-data` Docker volume.
Two files matter:

- `registry.db` holds everything: people, teams, packages and every version's files.
- `secret.key` encrypts the stored git credentials. Without it you must re-enter every repository credential. If you set `INTRA_SKILLS_SECRET_KEY` instead, keep that value in your secret store.

Take a backup while the registry runs:

```sh
mkdir -p backups
stamp=$(date +%Y-%m-%d-%H%M)
docker compose exec intra-skills node /app/server/dist/bin.js backup --data /data --to /data/backups/$stamp
docker compose cp intra-skills:/data/backups/$stamp ./backups/$stamp
```

The expected output names the two files it wrote.
Use the `backup` command rather than copying `registry.db` yourself: a plain copy can catch the database halfway through a write.
The `backup` command refuses a folder that already holds files, so it never overwrites an older backup.
Copy `./backups` somewhere off the machine, and delete old copies from `/data/backups` once they are safe.

Without Docker, the same command is `node packages/server/dist/bin.js backup --data <dir> --to <new folder>`.

## Restore

Restoring replaces everything in the registry with the backup, so take a fresh backup first if the current data might matter.

1. Stop the registry:
   ```sh
   docker compose stop intra-skills
   ```
2. Copy the backup into the volume:
   ```sh
   docker compose cp ./backups/<stamp> intra-skills:/data/backups/<stamp>
   ```
3. Restore it, and give the files back to the user the server runs as:
   ```sh
   docker compose run --rm --no-deps --user root intra-skills \
     sh -c 'node /app/server/dist/bin.js restore --data /data --from /data/backups/<stamp> && chown -R node:node /data'
   ```
   The expected output is `Restored /data/registry.db` and `Restored /data/secret.key`.
   If it says the backup fails SQLite's integrity check, the backup is damaged and nothing was changed: pick an older one.
4. Start the registry again:
   ```sh
   docker compose start intra-skills
   ```

Without Docker, stop the service, run `node packages/server/dist/bin.js restore --data <dir> --from <backup folder>`, and start it again.
The `restore` command checks the backup, replaces `registry.db` and `secret.key`, and deletes the SQLite `-wal` and `-shm` files left beside the old database, which would otherwise be replayed onto the restored one.

## Upgrades

```sh
docker compose exec intra-skills node /app/server/dist/bin.js backup --data /data --to /data/backups/before-upgrade-$(date +%Y-%m-%d)
git pull
docker compose --profile https up -d --build
```

Database migrations run on start and only move forward.
A server older than its database refuses to start rather than guess, so to roll back, check out the older version and restore the backup you took before upgrading.

People's CLIs are served by the registry itself, so they pick up the new version the next time they run `install.sh`.
