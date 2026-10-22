import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSkillMd } from "@intra-skills/shared";
import { Harness } from "./test/harness.js";
import { bootstrapSkillMd, installSh, isSafeOrigin, shQuote } from "./agent-docs.js";

const URL_ = "https://skills.acme.test";
let h: Harness | null = null;
const dirs: string[] = [];
afterEach(() => {
  h?.close();
  h = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const get = async (harness: Harness, path: string, origin = URL_) => {
  const res = await harness.app.request(`${origin}${path}`);
  return { status: res.status, type: res.headers.get("content-type") ?? "", text: await res.text() };
};

describe("agent documents", () => {
  it("every document carries the request's public URL and needs no sign-in", async () => {
    h = new Harness();
    const docs = {
      "/agent.md": "text/markdown",
      "/llms.txt": "text/plain",
      "/SKILL.md": "text/markdown",
      "/install.sh": "text/plain",
    };
    for (const [path, type] of Object.entries(docs)) {
      const r = await get(h, path);
      expect(r.status, path).toBe(200);
      expect(r.type, path).toContain(type);
      expect(r.text, path).toContain(URL_);
      expect(r.text, path).not.toContain("http://localhost");
    }
    const agent = (await get(h, "/agent.md")).text;
    expect(agent).toContain(`curl -fsSL ${URL_}/install.sh | sh`);
    expect(agent).toContain("intra setup");
    expect(agent).toContain(`claude mcp add --transport http intra-skills ${URL_}/api/mcp --header "Authorization: Bearer <token>"`);
    expect(agent).toContain("[mcp_servers.intra-skills]");
    expect(agent).toContain("never overrides");
    expect((await get(h, "/llms.txt")).text).toContain(`${URL_}/api/meta`);
  });

  it("the publicUrl setting wins over the request origin", async () => {
    h = new Harness();
    await h.call("PATCH", "/api/settings", { token: h.adminToken, body: { publicUrl: "https://registry.example.org" } });
    const r = await get(h, "/install.sh", "http://10.0.0.5:7710");
    expect(r.text).toContain("REGISTRY='https://registry.example.org'");
    expect(r.text).not.toContain("10.0.0.5");
  });

  it("the bootstrap SKILL.md is a valid skill named intra-registry", () => {
    const { skill, issues } = parseSkillMd(bootstrapSkillMd(URL_), "intra-registry");
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(skill?.name).toBe("intra-registry");
    expect(skill?.description).toMatch(/Use when/);
    expect(skill?.body).toContain("intra run");
    expect(skill?.body).toContain("ask");
  });

  it("install.sh passes sh -n", () => {
    const res = spawnSync("sh", ["-n"], { input: installSh(URL_) });
    expect(res.stderr.toString()).toBe("");
    expect(res.status).toBe(0);
  });

  it("install.sh installs, links into a writable PATH dir, sets the registry, and is idempotent", () => {
    const home = mkdtempSync(join(tmpdir(), "srv-install-"));
    dirs.push(home);
    // Fake curl and node so the script runs offline and we can see what it did.
    const fake = join(home, "fakebin");
    mkdirSync(fake);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    const cli = `#!/bin/sh\necho "$@" >> "$HOME/calls.log"\n`;
    writeFileSync(join(fake, "curl"), `#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then shift; printf '%s' '${cli.replace(/'/g, "")}' > "$1"; fi; shift; done\n`);
    writeFileSync(join(fake, "node"), `#!/bin/sh\nif [ "$1" = -p ]; then echo 24; else echo v24.0.0; fi\n`);
    chmodSync(join(fake, "curl"), 0o755);
    chmodSync(join(fake, "node"), 0o755);
    const env = { HOME: home, PATH: `${fake}:${join(home, ".local", "bin")}:/usr/bin:/bin` };
    const script = join(home, "install.sh");
    writeFileSync(script, installSh(URL_));
    for (let run = 0; run < 2; run++) {
      const out = execFileSync("sh", [script], { env, encoding: "utf8" });
      expect(out).toContain(`registry set to ${URL_}`);
    }
    const target = join(home, ".intra-skills", "bin", "intra");
    expect(lstatSync(target).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(home, ".local", "bin", "intra")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(home, "calls.log"), "utf8").trim().split("\n")).toEqual([
      `config set registry ${URL_}`,
      `config set registry ${URL_}`,
    ]);
    expect(existsSync(`${target}.download.1`)).toBe(false);
  });

  it("install.sh refuses an old node with a clear message", () => {
    const home = mkdtempSync(join(tmpdir(), "srv-install-"));
    dirs.push(home);
    writeFileSync(join(home, "node"), `#!/bin/sh\nif [ "$1" = -p ]; then echo 18; else echo v18.0.0; fi\n`);
    chmodSync(join(home, "node"), 0o755);
    const res = spawnSync("sh", ["-c", installSh(URL_)], { env: { HOME: home, PATH: `${home}:/usr/bin:/bin` }, encoding: "utf8" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("Node.js 20 or newer is required");
  });

  it("refuses to bake a non-origin Host into documents", async () => {
    expect(isSafeOrigin("https://skills.acme.test:8443")).toBe(true);
    expect(isSafeOrigin("http://[::1]:7710")).toBe(true);
    expect(isSafeOrigin("https://x.test'; rm -rf ~ #")).toBe(false);
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it("/cli/intra.mjs streams the bundle, or 404s with an explanation", async () => {
    h = new Harness();
    const missing = await get(h, "/cli/intra.mjs");
    expect(missing.status).toBe(404);
    expect(missing.text).toContain("not available");
    h.close();
    const dir = mkdtempSync(join(tmpdir(), "srv-cli-"));
    dirs.push(dir);
    const bundle = join(dir, "intra.mjs");
    writeFileSync(bundle, "console.log('intra');\n");
    h = new Harness({ cliBundlePath: bundle });
    const ok = await get(h, "/cli/intra.mjs");
    expect(ok.status).toBe(200);
    expect(ok.type).toContain("text/javascript");
    expect(ok.text).toBe("console.log('intra');\n");
  });
});
