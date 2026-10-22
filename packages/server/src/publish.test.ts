import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundleSha256, sha256Hex } from "@intra-skills/shared";
import { Harness, bundle, simple, skillMd } from "./test/harness.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(() => h.close());

describe("publishing", () => {
  it("publishes 1.0.0 then 1.1.0; detail lists newest first with server-computed hashes", async () => {
    const files = simple("pr-review", { meta: { version: "1.0.0", tags: "git, review", areas: "backend" } }, {
      "scripts/run.sh": "#!/bin/sh\necho hi\n",
    });
    files[1]!.mode = 0o755;
    const v1 = await h.publish(h.adminToken, "pr-review", "1.0.0", files, { changelog: "first" });
    expect(v1.status).toBe(201);
    expect(v1.json).toMatchObject({
      version: "1.0.0",
      fileCount: 2,
      changelog: "first",
      publishedBy: "root",
      yanked: null,
      downloads: 0,
      git: null,
    });
    const md = Buffer.from(files[0]!.contentBase64, "base64");
    const sh = Buffer.from(files[1]!.contentBase64, "base64");
    expect(v1.json.size).toBe(md.length + sh.length);
    expect(v1.json.sha256).toBe(
      bundleSha256([
        { path: "SKILL.md", mode: 0o644, sha256: sha256Hex(md) },
        { path: "scripts/run.sh", mode: 0o755, sha256: sha256Hex(sh) },
      ]),
    );

    const v2 = await h.publish(h.adminToken, "pr-review", "1.1.0", simple("pr-review", { meta: { tags: "git" } }), {
      git: { commit: "abc1234", repo: "github.com/x/y", dirty: false },
    });
    expect(v2.status).toBe(201);
    expect(v2.json.git).toEqual({ commit: "abc1234", repo: "github.com/x/y", dirty: false });

    const d = await h.call("GET", "/api/skills/pr-review", { token: h.adminToken });
    expect(d.status).toBe(200);
    expect(d.json.versions.map((v: { version: string }) => v.version)).toEqual(["1.1.0", "1.0.0"]);
    expect(d.json.latestVersion).toBe("1.1.0");
    expect(d.json.createdBy).toBe("root");
    expect(d.json.visibility).toBe("org");
    // facets refreshed from the 1.1.0 SKILL.md
    expect(d.json.tags).toEqual(["git"]);
    expect(d.json.areas).toEqual([]);
    expect(d.json.tools).toEqual(["claude", "codex", "cursor"]);
    expect(d.json.permissions).toEqual({ canWrite: true, canAdmin: true });
    expect(d.json.grants).toEqual([]);

    const vd = await h.call("GET", "/api/skills/pr-review/versions/1.0.0", { token: h.adminToken });
    expect(vd.json.name).toBe("pr-review");
    expect(vd.json.skillMd).toBe(md.toString());
    expect(vd.json.files).toEqual([
      { path: "SKILL.md", mode: 0o644, size: md.length, sha256: sha256Hex(md) },
      { path: "scripts/run.sh", mode: 0o755, size: sh.length, sha256: sha256Hex(sh) },
    ]);
  });

  it("versions are immutable and strictly increasing", async () => {
    expect((await h.publish(h.adminToken, "s", "1.0.0", simple("s"))).status).toBe(201);
    expect((await h.publish(h.adminToken, "s", "1.1.0", simple("s"))).status).toBe(201);
    const again = await h.publish(h.adminToken, "s", "1.1.0", simple("s"));
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("conflict");
    const older = await h.publish(h.adminToken, "s", "1.0.5", simple("s"));
    expect(older.status).toBe(409);
    const count = h.db.prepare("SELECT count(*) AS n FROM versions").get() as { n: number };
    expect(count.n).toBe(2);
  });

  it("invalid SKILL.md is 422 with ValidationIssue[] details", async () => {
    const ok = await h.publish(h.adminToken, "good", "1.0.0", simple("good"));
    expect(ok.status).toBe(201);
    const r = await h.publish(h.adminToken, "bad", "1.0.0", bundle({ "SKILL.md": "no frontmatter here" }));
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe("invalid_skill");
    expect(r.json.error.details).toEqual([
      { level: "error", field: "frontmatter", message: "SKILL.md must start with YAML frontmatter between --- lines" },
    ]);
    const wrongName = await h.publish(h.adminToken, "bad", "1.0.0", simple("other"));
    expect(wrongName.status).toBe(422);
    expect(wrongName.json.error.details.some((i: { field: string }) => i.field === "name")).toBe(true);
    const missing = await h.publish(h.adminToken, "bad", "1.0.0", bundle({ "README.md": "x" }));
    expect(missing.status).toBe(422);
    expect((await h.call("GET", "/api/skills/bad", { token: h.adminToken })).status).toBe(404);
  });

  it("warnings do not block a publish", async () => {
    const r = await h.publish(h.adminToken, "short", "1.0.0", simple("short", { description: "tiny desc" }));
    expect(r.status).toBe(201);
  });

  it("metadata.version must equal the request version", async () => {
    const ok = await h.publish(h.adminToken, "mv", "2.0.0", simple("mv", { meta: { version: "2.0.0" } }));
    expect(ok.status).toBe(201);
    const r = await h.publish(h.adminToken, "mv", "2.1.0", simple("mv", { meta: { version: "2.0.9" } }));
    expect(r.status).toBe(422);
    expect(r.json.error.details).toContainEqual(expect.objectContaining({ field: "metadata.version", level: "error" }));
  });

  it("path traversal and bad input are refused", async () => {
    const ok = await h.publish(h.adminToken, "pt", "1.0.0", simple("pt", {}, { "references/a.md": "a" }));
    expect(ok.status).toBe(201);
    const trav = await h.publish(h.adminToken, "pt", "1.1.0", simple("pt", {}, { "../evil.sh": "rm -rf" }));
    expect(trav.status).toBe(422);
    expect(trav.json.error.details).toContainEqual({ level: "error", field: "files", message: 'unsafe path "../evil.sh"' });
    const abs = await h.publish(h.adminToken, "pt", "1.1.0", simple("pt", {}, { "/etc/passwd": "x" }));
    expect(abs.status).toBe(422);
    const badB64 = await h.publish(h.adminToken, "pt", "1.1.0", [{ path: "SKILL.md", mode: 420, contentBase64: "!!!" }]);
    expect(badB64.status).toBe(400);
    const badVer = await h.publish(h.adminToken, "pt", "v1", simple("pt"));
    expect(badVer.status).toBe(400);
    const badName = await h.publish(h.adminToken, "Bad_Name", "1.0.0", simple("bad-name"));
    expect(badName.status).toBe(400);
  });

  it("unknown team is 400; known team is applied on first publish", async () => {
    await h.team("platform");
    const ok = await h.publish(h.adminToken, "t1", "1.0.0", simple("t1", { meta: { team: "platform" } }));
    expect(ok.status).toBe(201);
    expect((await h.call("GET", "/api/skills/t1", { token: h.adminToken })).json.team).toBe("platform");
    const r = await h.publish(h.adminToken, "t2", "1.0.0", simple("t2", { meta: { team: "ghosts" } }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("invalid");
    const r2 = await h.publish(h.adminToken, "t3", "1.0.0", simple("t3"), { team: "ghosts" });
    expect(r2.status).toBe(400);
  });
});

describe("resolve, yank, bundle", () => {
  async function seed() {
    for (const v of ["1.0.0", "1.2.0", "1.3.0", "2.0.0"])
      expect((await h.publish(h.adminToken, "res", v, simple("res", { body: `version ${v}\n` }))).status).toBe(201);
  }

  it("resolves ranges to the highest match", async () => {
    await seed();
    const q = async (range: string) =>
      h.call("GET", `/api/skills/res/resolve?range=${encodeURIComponent(range)}`, { token: h.adminToken });
    expect((await q("^1.0.0")).json).toEqual({ version: "1.3.0" });
    expect((await q("~1.2.0")).json).toEqual({ version: "1.2.0" });
    expect((await q("latest")).json).toEqual({ version: "2.0.0" });
    expect((await q("1.0.0")).json).toEqual({ version: "1.0.0" });
    expect((await q("^3.0.0")).status).toBe(404);
    expect((await q("nonsense")).status).toBe(400);
  });

  it("latest skips yanked; yanked exact version still downloads; unyank restores", async () => {
    await seed();
    const yank = await h.call("POST", "/api/skills/res/versions/2.0.0/yank", {
      token: h.adminToken,
      body: { reason: "broken install" },
    });
    expect(yank.status).toBe(200);
    expect(yank.json).toMatchObject({ version: "2.0.0", yanked: "broken install" });

    const latest = await h.call("GET", "/api/skills/res/resolve?range=latest", { token: h.adminToken });
    expect(latest.json).toEqual({ version: "1.3.0" });
    const vl = await h.call("GET", "/api/skills/res/versions/latest", { token: h.adminToken });
    expect(vl.json.version).toBe("1.3.0");
    const d = await h.call("GET", "/api/skills/res", { token: h.adminToken });
    expect(d.json.latestVersion).toBe("1.3.0");
    expect(d.json.versions[0]).toMatchObject({ version: "2.0.0", yanked: "broken install" });

    const b = await h.call("GET", "/api/skills/res/versions/2.0.0/bundle", { token: h.adminToken });
    expect(b.status).toBe(200);
    expect(b.json.version).toBe("2.0.0");

    // yank 1.3.0 too: ^1.0.0 now resolves to 1.2.0
    await h.call("POST", "/api/skills/res/versions/1.3.0/yank", { token: h.adminToken, body: { reason: "x" } });
    expect((await h.call("GET", "/api/skills/res/resolve?range=^1.0.0", { token: h.adminToken })).json.version).toBe("1.2.0");

    const un = await h.call("DELETE", "/api/skills/res/versions/2.0.0/yank", { token: h.adminToken });
    expect(un.status).toBe(200);
    expect(un.json.yanked).toBeNull();
    expect((await h.call("GET", "/api/skills/res/resolve", { token: h.adminToken })).json.version).toBe("2.0.0");
  });

  it("bundle sha256 equals bundleSha256 recomputed from the returned files; downloads count", async () => {
    const files = simple("bun", {}, { "bin/tool": Buffer.from([0, 1, 2, 255]), "references/x.md": "ref\n" });
    files[1]!.mode = 0o700; // normalised to 0o755
    const pub = await h.publish(h.adminToken, "bun", "1.0.0", files);
    expect(pub.status).toBe(201);
    const b = await h.call("GET", "/api/skills/bun/versions/1.0.0/bundle", { token: h.adminToken });
    expect(b.status).toBe(200);
    const recomputed = bundleSha256(
      b.json.files.map((f: { path: string; mode: number; contentBase64: string }) => ({
        path: f.path,
        mode: f.mode,
        sha256: sha256Hex(Buffer.from(f.contentBase64, "base64")),
      })),
    );
    expect(b.json.sha256).toBe(recomputed);
    expect(b.json.sha256).toBe(pub.json.sha256);
    expect(b.json.files.find((f: { path: string }) => f.path === "bin/tool").mode).toBe(0o755);
    expect(Buffer.from(b.json.files.find((f: { path: string }) => f.path === "bin/tool").contentBase64, "base64")).toEqual(
      Buffer.from([0, 1, 2, 255]),
    );

    await h.call("GET", "/api/skills/bun/versions/latest/bundle", { token: h.adminToken });
    const d = await h.call("GET", "/api/skills/bun", { token: h.adminToken });
    expect(d.json.downloads).toBe(2);
    expect(d.json.versions[0].downloads).toBe(2);
  });

  it("raw files: text as utf-8, binary as octet-stream, unknown path 404", async () => {
    await h.publish(h.adminToken, "raw", "1.0.0", simple("raw", {}, { "bin/blob": Buffer.from([0, 159, 146]), "docs/a b.md": "hello" }));
    const md = await h.call("GET", "/api/skills/raw/versions/1.0.0/files/SKILL.md", { token: h.adminToken });
    expect(md.status).toBe(200);
    expect(md.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(md.text).toBe(skillMd("raw"));
    const bin = await h.call("GET", "/api/skills/raw/versions/1.0.0/files/bin/blob", { token: h.adminToken });
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    const spaced = await h.call("GET", "/api/skills/raw/versions/1.0.0/files/docs/a%20b.md", { token: h.adminToken });
    expect(spaced.text).toBe("hello");
    const nope = await h.call("GET", "/api/skills/raw/versions/1.0.0/files/missing.md", { token: h.adminToken });
    expect(nope.status).toBe(404);
  });
});

describe("diff", () => {
  it("reports modified, added, removed and unchanged files with unified patches", async () => {
    await h.publish(
      h.adminToken,
      "df",
      "1.0.0",
      bundle({
        "SKILL.md": skillMd("df", { body: "line1\nline2\nline3\n" }),
        "old.md": "gone\n",
        "same.md": "same\n",
        "img.bin": Buffer.from([0, 1]),
      }),
    );
    await h.publish(
      h.adminToken,
      "df",
      "1.1.0",
      bundle({
        "SKILL.md": skillMd("df", { body: "line1\nline2 changed\nline3\n" }),
        "new.md": "fresh\n",
        "same.md": "same\n",
        "img.bin": Buffer.from([0, 2]),
      }),
    );
    const r = await h.call("GET", "/api/skills/df/diff?from=1.0.0&to=1.1.0", { token: h.adminToken });
    expect(r.status).toBe(200);
    expect(r.json.from).toBe("1.0.0");
    expect(r.json.to).toBe("1.1.0");
    const by = Object.fromEntries(r.json.files.map((f: { path: string }) => [f.path, f]));
    expect(Object.keys(by).sort()).toEqual(["SKILL.md", "img.bin", "new.md", "old.md", "same.md"]);
    expect(by["SKILL.md"].status).toBe("modified");
    expect(by["SKILL.md"].patch).toContain("-line2\n+line2 changed\n");
    expect(by["SKILL.md"].patch).toContain("--- a/SKILL.md\t1.0.0");
    expect(by["new.md"]).toMatchObject({ status: "added", binary: false });
    expect(by["new.md"].patch).toContain("+fresh");
    expect(by["old.md"].status).toBe("removed");
    expect(by["old.md"].patch).toContain("-gone");
    expect(by["same.md"]).toEqual({ path: "same.md", status: "unchanged", patch: null, binary: false });
    expect(by["img.bin"]).toEqual({ path: "img.bin", status: "modified", patch: null, binary: true });

    expect((await h.call("GET", "/api/skills/df/diff?from=1.0.0", { token: h.adminToken })).status).toBe(400);
    expect((await h.call("GET", "/api/skills/df/diff?from=1.0.0&to=9.9.9", { token: h.adminToken })).status).toBe(404);
  });
});

describe("audit", () => {
  it("records publish, patch, grant and yank in order with actor and detail", async () => {
    await h.user("alice");
    await h.publish(h.adminToken, "au", "1.0.0", simple("au"));
    await h.call("PATCH", "/api/skills/au", { token: h.adminToken, body: { deprecated: "use au2" } });
    await h.call("PUT", "/api/skills/au/grants", {
      token: h.adminToken,
      body: [{ principalType: "user", principal: "alice", permission: "write" }],
    });
    await h.call("POST", "/api/skills/au/versions/1.0.0/yank", { token: h.adminToken, body: { reason: "bad" } });
    const r = await h.call("GET", "/api/audit?target=au", { token: h.adminToken });
    expect(r.status).toBe(200);
    expect(r.json.map((e: { action: string }) => e.action)).toEqual([
      "version.yank",
      "grants.set",
      "skill.patch",
      "skill.publish",
    ]);
    expect(r.json.every((e: { actor: string; target: string }) => e.actor === "root" && e.target === "au")).toBe(true);
    expect(r.json[0].detail).toEqual({ version: "1.0.0", reason: "bad" });
    expect(r.json[1].detail).toEqual({ grants: [{ principalType: "user", principal: "alice", permission: "write" }] });
    expect(r.json[3].detail).toMatchObject({ version: "1.0.0", created: true });

    const all = await h.call("GET", "/api/audit?limit=2", { token: h.adminToken });
    expect(all.json).toHaveLength(2);
    const page2 = await h.call("GET", `/api/audit?limit=100&before=${all.json[1].id}`, { token: h.adminToken });
    expect(page2.json[0].id).toBeLessThan(all.json[1].id);
    expect(page2.json.map((e: { action: string }) => e.action)).toContain("user.create");
  });

  it("a failed publish writes no audit entry", async () => {
    await h.publish(h.adminToken, "fa", "1.0.0", simple("fa"));
    await h.publish(h.adminToken, "fa", "1.0.0", simple("fa"));
    const r = await h.call("GET", "/api/audit?target=fa", { token: h.adminToken });
    expect(r.json.map((e: { action: string }) => e.action)).toEqual(["skill.publish"]);
  });
});
