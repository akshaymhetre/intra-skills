import { describe, expect, it } from "vitest";
import { normalizeProjectFlag } from "./command.js";
import { normalizeRange } from "./commands/manage.js";
import { scanSecrets } from "./files.js";
import { parseSpec } from "./install.js";
import { serializeLockfile } from "./lockfile.js";
import { renderTable, truncate } from "./output.js";

describe("truncate", () => {
  it("cuts on a word boundary with an ellipsis", () => {
    expect(truncate("Review pull requests for correctness bugs", 20)).toBe("Review pull…");
    expect(truncate("short", 20)).toBe("short");
  });
  it("keeps table columns within the width", () => {
    const t = renderTable(["A", "DESC"], [["x", "word ".repeat(40)]], { maxWidth: 40, flex: 1 });
    for (const line of t.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
  });
});

describe("secret scan", () => {
  const f = (text: string) => [{ path: "a.md", mode: 0o644, data: Buffer.from(text) }];
  it("finds each kind with its line", () => {
    const text = [
      "ok",
      "-----BEGIN RSA PRIVATE KEY-----",
      `ghp_${"a".repeat(36)}`,
      `sk-ant-api03-${"x".repeat(30)}`,
      "xoxb-1234567890-abc",
      `isk_${"Z".repeat(32)}`,
      `github_pat_${"1".repeat(40)}`,
    ].join("\n");
    expect(scanSecrets(f(text)).map((h) => h.line)).toEqual([2, 3, 4, 5, 6, 7]);
  });
  it("does not flag a bare prefix mentioned in prose", () => {
    expect(scanSecrets(f("GitHub tokens start with ghp_ and Slack ones with xoxb-"))).toEqual([]);
    expect(scanSecrets(f("aws_access_key_id = AKIAIOSFODNN7EXAMPLE"))).toEqual([]);
    expect(scanSecrets(f("aws_access_key_id = AKIAIOSFODNN7EXAMPLF"))).toHaveLength(1);
  });
});

describe("specs and ranges", () => {
  it("parses name@range", () => {
    expect(parseSpec("a")).toEqual({ name: "a", range: null });
    expect(parseSpec("a@^1")).toEqual({ name: "a", range: "^1" });
  });
  it("normalizes partial ranges", () => {
    expect(normalizeRange("^1")).toBe("^1.0.0");
    expect(normalizeRange("1")).toBe("^1.0.0");
    expect(normalizeRange("~1.2")).toBe("~1.2.0");
    expect(normalizeRange(null)).toBe("latest");
    expect(normalizeRange("1.2.3")).toBe("1.2.3");
    expect(() => normalizeRange("^x")).toThrow();
  });
  it("--project takes a path-like value only", () => {
    expect(normalizeProjectFlag(["a", "--project"])).toEqual(["a", "--project="]);
    expect(normalizeProjectFlag(["--project", "./p", "a"])).toEqual(["--project=./p", "a"]);
    expect(normalizeProjectFlag(["--project", "a"])).toEqual(["--project=", "a"]);
  });
});

describe("lockfile", () => {
  it("serializes with stable key order and a trailing newline", () => {
    const text = serializeLockfile({
      lockfileVersion: 1,
      registry: "http://r",
      skills: {
        zeta: { targets: ["codex", "claude"], sha256: "s", version: "1.0.0", range: "^1.0.0" } as never,
        alpha: { range: "1.0.0", version: "1.0.0", sha256: "t", targets: ["cursor"] },
      },
    });
    expect(text.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(text).skills)).toEqual(["alpha", "zeta"]);
    expect(text).toContain('"range": "^1.0.0",\n      "version": "1.0.0",\n      "sha256": "s",\n      "targets": [\n        "claude",\n        "codex"');
  });
});
