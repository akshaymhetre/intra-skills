// Test harness: a fresh temp-dir database and an in-process app driven through app.request().
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BundleFile } from "@intra-skills/shared";
import { openDb, tx, type Db } from "../db.js";
import { createApp, type AppOptions } from "../app.js";
import { createUser } from "../routes/users.js";

export interface Res {
  status: number;
  json: any;
  text: string;
  headers: Headers;
}

export interface CallOpts {
  token?: string;
  cookie?: string;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
}

export class Harness {
  dir = mkdtempSync(join(tmpdir(), "srv-test-"));
  db: Db = openDb(join(this.dir, "registry.db"));
  app: ReturnType<typeof createApp>;
  adminToken: string;

  constructor(opts: AppOptions = {}) {
    this.app = createApp(this.db, { webDir: null, ...opts });
    this.adminToken = tx(this.db, () =>
      createUser(this.db, { handle: "root", displayName: "Root Admin", role: "admin" }),
    ).token;
  }

  close(): void {
    this.db.close();
    rmSync(this.dir, { recursive: true, force: true });
  }

  async call(method: string, path: string, o: CallOpts = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers.Authorization = `Bearer ${o.token}`;
    if (o.cookie) headers.Cookie = o.cookie;
    let body: string | undefined = o.rawBody;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers["Content-Type"] = "application/json";
    }
    const res = await this.app.request(path, { method, headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  async user(handle: string, role: "admin" | "member" = "member"): Promise<string> {
    const r = await this.call("POST", "/api/users", {
      token: this.adminToken,
      body: { handle, displayName: handle.toUpperCase(), role },
    });
    if (r.status !== 201) throw new Error(`create user ${handle}: ${r.status} ${r.text}`);
    return r.json.token as string;
  }

  async team(slug: string, members: Record<string, "maintainer" | "member"> = {}): Promise<void> {
    const r = await this.call("POST", "/api/teams", { token: this.adminToken, body: { slug, name: slug.toUpperCase() } });
    if (r.status !== 201) throw new Error(`create team ${slug}: ${r.status} ${r.text}`);
    for (const [h, role] of Object.entries(members)) {
      const m = await this.call("PUT", `/api/teams/${slug}/members/${h}`, { token: this.adminToken, body: { role } });
      if (m.status !== 200) throw new Error(`add ${h} to ${slug}: ${m.status} ${m.text}`);
    }
  }

  publish(token: string, name: string, version: string, files: BundleFile[], extra: Record<string, unknown> = {}) {
    return this.call("POST", `/api/skills/${name}/versions`, { token, body: { version, files, ...extra } });
  }
}

export interface MdOpts {
  description?: string;
  meta?: Record<string, string>;
  body?: string;
}

export function skillMd(name: string, o: MdOpts = {}): string {
  const meta = Object.entries(o.meta ?? {});
  const metaYaml = meta.length ? `metadata:\n${meta.map(([k, v]) => `  ${k}: "${v}"`).join("\n")}\n` : "";
  const desc = o.description ?? `Does the ${name} thing and should be used whenever ${name} work comes up.`;
  return `---\nname: ${name}\ndescription: ${desc}\n${metaYaml}---\n${o.body ?? `# ${name}\n\nStep one.\nStep two.\nStep three.\n`}`;
}

export function bundle(files: Record<string, string | Buffer>, mode: Record<string, number> = {}): BundleFile[] {
  return Object.entries(files).map(([path, content]) => ({
    path,
    mode: mode[path] ?? 0o644,
    contentBase64: Buffer.from(content).toString("base64"),
  }));
}

export function simple(name: string, o: MdOpts = {}, extra: Record<string, string | Buffer> = {}): BundleFile[] {
  return bundle({ "SKILL.md": skillMd(name, o), ...extra });
}
