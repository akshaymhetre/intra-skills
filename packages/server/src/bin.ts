#!/usr/bin/env node
// intra-skills-server: `init` creates the database and first admin; `serve` runs the registry;
// `backup` copies the data directory safely while it runs; `restore` puts a backup back.
import { parseArgs } from "node:util";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { openDataDir, tx } from "./db.js";
import { createApp, SERVER_VERSION } from "./app.js";
import { GitService } from "./git/service.js";
import { loadSecretKey } from "./keys.js";
import { ensureSetupToken } from "./setup.js";
import { publicUrl } from "./settings.js";
import { createUser } from "./routes/users.js";
import { audit } from "./model.js";
import { checkHandle } from "./http.js";
import { backupDataDir, restoreDataDir } from "./backup.js";

const USAGE = `intra-skills-server ${SERVER_VERSION}

Usage:
  intra-skills-server init  --data <dir> --admin <handle> [--name "Display Name"]
  intra-skills-server serve --data <dir> [--port 7710] [--host 127.0.0.1]
  intra-skills-server backup --data <dir> --to <new folder>
  intra-skills-server restore --data <dir> --from <backup folder>   (stop the server first)

On first serve with an empty database, the server prints a one-time setup link: open it to
create the first admin from the browser (init is the scripted alternative).
backup is safe while the server runs: it writes registry.db and secret.key into a new folder.

Env fallbacks: INTRA_SKILLS_DATA, PORT, HOST, INTRA_SKILLS_WEB_DIR, INTRA_SKILLS_CLI_BUNDLE.
Org settings: INTRA_SKILLS_ORG_NAME, INTRA_SKILLS_PUBLIC_URL, INTRA_SKILLS_STALE_DAYS,
INTRA_SKILLS_POLL_SECONDS. Secrets: INTRA_SKILLS_SECRET_KEY (base64, 32 bytes; default
<data>/secret.key).`;

function fail(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(USAGE);
    return;
  }
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: {
        data: { type: "string" },
        admin: { type: "string" },
        name: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
        to: { type: "string" },
        from: { type: "string" },
      },
      strict: true,
    }));
  } catch (e) {
    fail(`${(e as Error).message}\n\n${USAGE}`);
  }
  const data = (values.data as string | undefined) ?? process.env.INTRA_SKILLS_DATA;
  if (!data) fail("--data <dir> is required (or set INTRA_SKILLS_DATA)");

  if (cmd === "init") {
    const handle = (values.admin as string | undefined)?.trim().toLowerCase();
    if (!handle) fail("--admin <handle> is required");
    try {
      checkHandle(handle);
    } catch {
      fail(`invalid handle "${handle}" (lowercase letters, digits, single . _ - separators)`);
    }
    const db = openDataDir(resolve(data));
    const count = (db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
    if (count > 0) fail("this database already has users; refusing to init again");
    const displayName = (values.name as string | undefined)?.trim() || handle;
    const { token } = tx(db, () => {
      const out = createUser(db, { handle, displayName, role: "admin" });
      audit(db, null, "user.create", "user", handle, { role: "admin", displayName, via: "init" });
      return out;
    });
    db.close();
    console.log(`Created admin "${handle}" in ${join(resolve(data), "registry.db")}.`);
    console.log(`Admin token (shown once, store it now):\n${token}`);
    return;
  }

  if (cmd === "backup") {
    const to = values.to as string | undefined;
    if (!to) fail("--to <new folder> is required");
    backupDataDir(resolve(data), resolve(to)).then(
      (out) => {
        console.log(`Backed up ${out.database}`);
        console.log(out.secretKey ? `Backed up ${out.secretKey}` : "No secret.key file: keep INTRA_SKILLS_SECRET_KEY in your secret store.");
      },
      (e: Error) => fail(e.message),
    );
    return;
  }

  if (cmd === "restore") {
    const from = values.from as string | undefined;
    if (!from) fail("--from <backup folder> is required");
    try {
      const out = restoreDataDir(resolve(from), resolve(data));
      console.log(`Restored ${out.database}`);
      console.log(out.secretKey ? `Restored ${out.secretKey}` : "The backup has no secret.key: set INTRA_SKILLS_SECRET_KEY to the key it was taken with.");
    } catch (e) {
      fail((e as Error).message);
    }
    return;
  }

  if (cmd === "serve") {
    const port = Number((values.port as string | undefined) ?? process.env.PORT ?? 7710);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("--port must be 1-65535");
    const hostname = (values.host as string | undefined) ?? process.env.HOST ?? "127.0.0.1";
    const here = dirname(fileURLToPath(import.meta.url));
    const webDir = process.env.INTRA_SKILLS_WEB_DIR
      ? resolve(process.env.INTRA_SKILLS_WEB_DIR)
      : resolve(here, "../../web/dist");
    const cliBundle = process.env.INTRA_SKILLS_CLI_BUNDLE
      ? resolve(process.env.INTRA_SKILLS_CLI_BUNDLE)
      : resolve(here, "../../cli/dist-bundle/intra.mjs");
    const dataDir = resolve(data);
    const db = openDataDir(dataDir);
    const git = new GitService(db, { secretKey: loadSecretKey(dataDir) });
    const app = createApp(db, {
      webDir: existsSync(webDir) ? webDir : null,
      cliBundlePath: existsSync(cliBundle) ? cliBundle : null,
      git,
    });
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      console.log(`intra-skills registry ${SERVER_VERSION} listening on http://${hostname}:${info.port}`);
      const setupToken = ensureSetupToken(db, dataDir);
      if (setupToken) {
        const base = publicUrl(db, `http://${hostname === "0.0.0.0" ? "127.0.0.1" : hostname}:${info.port}`);
        console.log(`\nNo admin yet. Open this link once to create one:\n  ${base}/setup?token=${setupToken}\n`);
      }
      git.start();
    });
    const shutdown = () => {
      void git.stop().finally(() =>
        server.close(() => {
          db.close();
          process.exit(0);
        }),
      );
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  fail(`unknown command "${cmd}"\n\n${USAGE}`);
}

main(process.argv.slice(2));
