// Device login (docs/API.md "v2 additions"): the CLI asks the registry for a short code, a person
// approves it in the console, and the CLI polls until it receives a fresh token. No token paste.
// The pending code can be saved to $INTRA_SKILLS_HOME/device.json so an agent can split the
// flow into `intra login --start` (show the code) and `intra login --wait` (block until approved).
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import type { DeviceStart, User } from "@intra-skills/shared";
import { Api } from "./api.js";
import type { Ctx } from "./command.js";
import { DEFAULT_TARGETS, readConfigFile, writeConfig } from "./config.js";
import { ApiError, CliError } from "./errors.js";
import { intraHome } from "./paths.js";

export interface PendingDevice {
  registry: string;
  clientName: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  interval: number;
  expiresAt: string;
}

export const devicePath = (): string => join(intraHome(), "device.json");

export function clientName(): string {
  return `intra CLI on ${hostname()}`;
}

export async function startDevice(registry: string): Promise<PendingDevice> {
  const name = clientName();
  const s: DeviceStart = await new Api(registry, null).deviceStart(name);
  return {
    registry,
    clientName: name,
    deviceCode: s.deviceCode,
    userCode: s.userCode,
    verificationUri: s.verificationUri,
    verificationUriComplete: s.verificationUriComplete,
    interval: s.interval,
    expiresAt: new Date(Date.now() + s.expiresIn * 1000).toISOString(),
  };
}

export function savePending(p: PendingDevice): void {
  const file = devicePath();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(p, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readPending(): PendingDevice | null {
  try {
    const p = JSON.parse(readFileSync(devicePath(), "utf8")) as PendingDevice;
    return typeof p.deviceCode === "string" && typeof p.registry === "string" ? p : null;
  } catch {
    return null;
  }
}

export function clearPending(): void {
  rmSync(devicePath(), { force: true });
}

/** What a person or an agent needs to see; never includes the device code itself. */
export function publicView(p: PendingDevice) {
  return {
    registry: p.registry,
    userCode: p.userCode,
    verificationUri: p.verificationUri,
    verificationUriComplete: p.verificationUriComplete,
    interval: p.interval,
    expiresIn: Math.max(0, Math.round((Date.parse(p.expiresAt) - Date.now()) / 1000)),
    expiresAt: p.expiresAt,
  };
}

/** Print the code and URL. In --json mode they go to stderr so stdout keeps exactly one document. */
export function announce(ctx: Ctx, p: PendingDevice): void {
  const minutes = Math.max(1, Math.round((Date.parse(p.expiresAt) - Date.now()) / 60000));
  const lines = [
    "To sign in, open this page and approve the code:",
    `  ${p.verificationUriComplete}`,
    `  code: ${p.userCode}`,
    `Waiting for approval (the code expires in ${minutes} minute${minutes === 1 ? "" : "s"})...`,
  ];
  if (ctx.out.json) ctx.io.stderr.write(lines.join("\n") + "\n");
  else for (const l of lines) ctx.out.line(l);
}

/** Best effort; a missing opener is not an error because the URL is already on screen. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no opener on this machine */
  }
}

/** Poll until the code is approved, denied or expired. Network blips are retried until expiry. */
export async function waitForApproval(ctx: Ctx, p: PendingDevice): Promise<{ token: string; user: User }> {
  const api = new Api(p.registry, null);
  const intervalMs = Math.max(1, p.interval || 3) * 1000;
  const deadline = Date.parse(p.expiresAt);
  let warned = false;
  for (;;) {
    if (Date.now() > deadline) throw expired();
    await ctx.sleep(intervalMs);
    let poll;
    try {
      poll = await api.devicePoll(p.deviceCode);
    } catch (err) {
      if (err instanceof ApiError && err.offline) {
        if (!warned) ctx.out.warn(`${err.message}; still waiting`);
        warned = true;
        continue;
      }
      throw err;
    }
    if (poll.status === "approved") return { token: poll.token, user: poll.user };
    if (poll.status === "denied") throw new CliError("the sign-in request was denied in the console; run `intra login` to try again", "device_denied");
    if (poll.status === "expired") throw expired();
  }
}

const expired = () => new CliError("the sign-in code expired before it was approved; run `intra login` to get a new one", "device_expired");

/** Write registry + token the same way `intra login --token` does. */
export function saveLogin(registry: string, token: string): void {
  const existing = readConfigFile();
  writeConfig({ registry, token, defaultTargets: existing?.defaultTargets ?? DEFAULT_TARGETS });
}

/** The whole interactive flow: start, show, maybe open the browser, poll, save. */
export async function deviceLogin(ctx: Ctx, registry: string, opts: { browser: boolean }): Promise<{ token: string; user: User }> {
  const p = await startDevice(registry);
  announce(ctx, p);
  if (opts.browser && ctx.io.stdout.isTTY && !ctx.out.json) openBrowser(p.verificationUriComplete);
  const res = await waitForApproval(ctx, p);
  saveLogin(registry, res.token);
  return res;
}
