import { GIT_PROVIDERS, type GitIdentity, type GitProviderId, type User } from "@intra-skills/shared";
import { Api } from "../api.js";
import { list, str, type Command, type Ctx } from "../command.js";
import { DEFAULT_TARGETS, loadConfig, normalizeRegistry, parseTargets, readConfigFile, writeConfig } from "../config.js";
import { clearPending, deviceLogin, devicePath, publicView, readPending, savePending, saveLogin, startDevice, waitForApproval } from "../device.js";
import { CliError, UsageError } from "../errors.js";
import { configPath } from "../paths.js";

async function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  let data = "";
  for await (const chunk of stream) data += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
  return data;
}

export const login: Command = {
  name: "login",
  summary: "Sign in to a registry (approve a code in the browser, or pass a token)",
  help: `Usage: intra login [--registry <url>] [--no-browser]
       intra login --start [--registry <url>] --json   then   intra login --wait --json
       intra login --registry <url> --token <token>

Without --token, starts a device login: prints a short code and a URL, opens the browser
when this is a terminal, and waits until someone approves the code in the console. The
registry then mints a new token for you, saved to ${"$INTRA_SKILLS_HOME"}/config.json (mode 0600).

Agents (no terminal): run \`intra login --start --json\`, show the user the URL and code it prints,
then run \`intra login --wait --json\`, which blocks until the code is approved, denied or expired.
The pending code is kept in ${"$INTRA_SKILLS_HOME"}/device.json (mode 0600) between the two steps.

With --token, verifies it with GET /api/me and saves it. \`--token -\` reads it from stdin
(e.g. \`pbpaste | intra login --token -\`); INTRA_SKILLS_TOKEN is used when set.

Options:
  --registry <url>   registry base URL, e.g. https://skills.example.com (default: the saved one)
  --token <token>    API token (isk_...), or - to read it from stdin
  --start            start a device login, save it and print the code; do not wait
  --wait             wait for the device login started by --start
  --no-browser       do not try to open the approval page
  --json             print the result as JSON`,
  options: {
    registry: { type: "string" },
    token: { type: "string" },
    start: { type: "boolean" },
    wait: { type: "boolean" },
    "no-browser": { type: "boolean" },
  },
  async run(ctx, v) {
    if (v.start && v.wait) throw new UsageError("pass --start or --wait, not both");
    if (v.wait) {
      const pending = readPending();
      if (!pending) throw new CliError("no device login is waiting; run `intra login --start` first", "no_pending_login");
      if (str(v.registry) && normalizeRegistry(str(v.registry)!) !== pending.registry)
        throw new UsageError(`the pending login is for ${pending.registry}, not ${normalizeRegistry(str(v.registry)!)}; run \`intra login --start --registry <url>\` again`);
      let res;
      try {
        res = await waitForApproval(ctx, pending);
      } catch (err) {
        if (err instanceof CliError && (err.code === "device_denied" || err.code === "device_expired")) clearPending();
        throw err;
      }
      saveLogin(pending.registry, res.token);
      clearPending();
      return done(ctx, pending.registry, res.user);
    }

    const existing = readConfigFile();
    const registryArg = str(v.registry) ?? existing?.registry ?? process.env.INTRA_SKILLS_REGISTRY;
    if (!registryArg) throw new UsageError("--registry <url> is required on first login");
    const registry = normalizeRegistry(registryArg);
    let token = str(v.token);
    if (token === "-") token = (await readStdin(ctx.io.stdin)).trim();
    token ||= process.env.INTRA_SKILLS_TOKEN || undefined;

    if (token) {
      if (v.start) throw new UsageError("--start is for a device login; drop --token");
      const me = await new Api(registry, token).me().catch((err: unknown) => {
        if (err instanceof CliError && err.code === "unauthenticated")
          throw new CliError(`the registry rejected that token; create a new one in the console or with \`intra token create\``, "unauthenticated");
        throw err;
      });
      saveLogin(registry, token);
      return done(ctx, registry, me);
    }

    if (v.start) {
      const pending = await startDevice(registry);
      savePending(pending);
      ctx.out.line(`Open ${pending.verificationUriComplete} and approve the code ${ctx.out.c("bold", pending.userCode)}.`);
      ctx.out.line("Then run `intra login --wait` to finish signing in.");
      ctx.out.result({ ...publicView(pending), pendingFile: devicePath(), next: "intra login --wait --json" });
      return;
    }

    const res = await deviceLogin(ctx, registry, { browser: !v["no-browser"] });
    return done(ctx, registry, res.user);
  },
};

function done(ctx: Ctx, registry: string, me: User): void {
  ctx.out.line(`Logged in to ${registry} as ${ctx.out.c("bold", me.handle)} (${me.role}). Config: ${configPath()}`);
  ctx.out.result({ registry, user: me, config: configPath() });
}

export const logout: Command = {
  name: "logout",
  summary: "Forget the saved token",
  help: `Usage: intra logout

Removes the token from config.json; keeps the registry URL and default targets.`,
  async run(ctx) {
    const cfg = readConfigFile();
    if (cfg?.token) writeConfig({ ...cfg, token: null });
    ctx.out.line(cfg?.token ? "Logged out." : "Not logged in.");
    ctx.out.result({ loggedOut: Boolean(cfg?.token) });
  },
};

export const whoami: Command = {
  name: "whoami",
  summary: "Show the logged-in user",
  help: `Usage: intra whoami [--json]`,
  async run(ctx) {
    const api = ctx.api();
    const me = await api.me();
    ctx.out.line(`${ctx.out.c("bold", me.handle)} (${me.displayName}), ${me.role} on ${api.registry}`);
    if (me.teams.length) ctx.out.line(`teams: ${me.teams.map((t) => `${t.slug}${t.role === "maintainer" ? " (maintainer)" : ""}`).join(", ")}`);
    if (me.gitIdentities?.length) ctx.out.line(`git: ${me.gitIdentities.map((g) => `${g.provider} ${g.username}`).join(", ")}`);
    ctx.out.result({ registry: api.registry, user: me });
  },
};

const KEYS = ["registry", "defaultTargets", "token"] as const;

export const config: Command = {
  name: "config",
  summary: "Read or change CLI settings (registry, defaultTargets)",
  help: `Usage: intra config get [key]
       intra config set <key> <value>

Keys:
  registry         registry base URL
  defaultTargets   comma list of claude,codex,cursor used when --to is omitted (default: claude,codex)
  token            shown redacted; set it with \`intra login\``,
  async run(ctx, _v, pos) {
    const [sub, key, value] = pos;
    if (sub === "get") {
      const cfg = loadConfig();
      const view = { registry: cfg.registry, defaultTargets: cfg.defaultTargets, token: cfg.token ? `${cfg.token.slice(0, 8)}…` : null };
      if (key && !(KEYS as readonly string[]).includes(key)) throw new UsageError(`unknown key "${key}"; use ${KEYS.join(", ")}`);
      if (key) {
        const val = view[key as keyof typeof view];
        ctx.out.line(Array.isArray(val) ? val.join(",") : (val ?? ""));
        ctx.out.result({ key, value: val });
      } else {
        for (const [k, val] of Object.entries(view)) ctx.out.line(`${k} = ${Array.isArray(val) ? val.join(",") : (val ?? "")}`);
        ctx.out.result({ config: view });
      }
      return;
    }
    if (sub === "set") {
      if (!key || value === undefined) throw new UsageError("usage: intra config set <key> <value>");
      const cfg = readConfigFile() ?? { registry: null, token: null, defaultTargets: DEFAULT_TARGETS };
      if (key === "registry") cfg.registry = normalizeRegistry(value);
      else if (key === "defaultTargets") cfg.defaultTargets = parseTargets(list(value).join(","));
      else if (key === "token") throw new UsageError("set the token with `intra login` so it is verified first");
      else throw new UsageError(`unknown key "${key}"; use registry or defaultTargets`);
      writeConfig(cfg);
      const shown = key === "defaultTargets" ? cfg.defaultTargets.join(",") : cfg.registry;
      ctx.out.line(`${key} = ${shown}`);
      ctx.out.result({ key, value: key === "defaultTargets" ? cfg.defaultTargets : cfg.registry });
      return;
    }
    throw new UsageError("usage: intra config get [key] | intra config set <key> <value>");
  },
};

const USERNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98})$/;

function provider(value: string | undefined): GitProviderId {
  if (!value || !(GIT_PROVIDERS as readonly string[]).includes(value))
    throw new UsageError(`provider must be one of ${GIT_PROVIDERS.join(", ")}`);
  return value as GitProviderId;
}

export const identity: Command = {
  name: "identity",
  summary: "Show or link your usernames on git hosts (needed to propose skills)",
  help: `Usage: intra identity [--json]
       intra identity set <github|bitbucket-cloud> <username>
       intra identity remove <github|bitbucket-cloud>

When the registry publishes through pull requests, it needs your git username so a pull
request you proposed never counts as approved by you. One username per provider.`,
  async run(ctx, _v, pos) {
    const [sub, prov, username] = pos;
    const api = ctx.api();
    const me = await api.me();
    let ids: GitIdentity[] = me.gitIdentities ?? [];
    if (sub === "set") {
      const p = provider(prov);
      if (!username || !USERNAME_RE.test(username)) throw new UsageError("usage: intra identity set <provider> <username> (letters, digits, . _ -)");
      ids = [...ids.filter((g) => g.provider !== p), { provider: p, username }];
    } else if (sub === "remove") {
      const p = provider(prov);
      if (!ids.some((g) => g.provider === p)) throw new CliError(`no ${p} identity is linked`, "not_found");
      ids = ids.filter((g) => g.provider !== p);
    } else if (sub !== undefined) throw new UsageError("usage: intra identity [set <provider> <username> | remove <provider>]");
    const user = sub ? await api.setGitIdentities(ids) : me;
    const shown = user.gitIdentities ?? [];
    if (!shown.length) ctx.out.line("No git identities linked. Add one with `intra identity set github <your-github-username>`.");
    else for (const g of shown) ctx.out.line(`${g.provider.padEnd(16)} ${g.username}`);
    ctx.out.result({ gitIdentities: shown });
  },
};
