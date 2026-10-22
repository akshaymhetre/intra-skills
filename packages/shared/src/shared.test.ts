import { describe, expect, it } from "vitest";
import { frontmatterRows, parseSkillMd, setSkillMdVersion, satisfies, maxSatisfying, compareVersions, bumpVersion, bundleSha256, isSafeRelativePath } from "./index.js";

const md = `---
name: pr-review
description: Review a pull request for correctness bugs. Use when the user asks to review a PR or a diff.
metadata:
  version: "1.2.0"
  team: platform
  areas: "backend, infra"
  tags: "github, review"
  tools: "claude, codex"
---
# PR review
Do the thing.
`;

describe("parseSkillMd", () => {
  it("parses facets from metadata", () => {
    const { skill, issues } = parseSkillMd(md, "pr-review");
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(skill).toMatchObject({ name: "pr-review", version: "1.2.0", team: "platform", areas: ["backend", "infra"], tags: ["github", "review"], tools: ["claude", "codex"] });
  });
  it("rejects a name that does not match its directory", () => {
    expect(parseSkillMd(md, "other").skill).toBeNull();
  });
  it("rejects bad names and missing description", () => {
    const { issues } = parseSkillMd("---\nname: Bad--Name\n---\nbody", undefined);
    expect(issues.map((i) => i.field)).toEqual(expect.arrayContaining(["name", "description"]));
  });
  it("rejects missing frontmatter", () => {
    expect(parseSkillMd("# no frontmatter").skill).toBeNull();
  });
  it("defaults tools to all three", () => {
    const { skill } = parseSkillMd("---\nname: a\ndescription: does a thing when asked to do the thing please\n---\nx");
    expect(skill?.tools).toEqual(["claude", "codex", "cursor"]);
  });
});

describe("lenient parsing of real-world skills", () => {
  const loose = "---\nname: adr\ndescription: Write an ADR. Rule of thumb: if migrating away takes a sprint, it needs one.\nmetadata:\n  hermes:\n    tags: [a]\n---\nbody\n";
  it("accepts an unquoted colon in the description with a warning", () => {
    const { skill, issues } = parseSkillMd(loose, "adr");
    expect(skill?.description).toBe("Write an ADR. Rule of thumb: if migrating away takes a sprint, it needs one.");
    expect(issues.some((i) => i.level === "warning" && i.field === "frontmatter")).toBe(true);
  });
  it("still refuses a missing name under lenient parsing", () => {
    expect(parseSkillMd("---\ndescription: a: b\n---\nx").skill).toBeNull();
  });
  it("warns on nested metadata and ignores a non-semver version", () => {
    const { skill, issues } = parseSkillMd("---\nname: x\ndescription: does x when asked to do x thing\nmetadata:\n  version: \"42\"\n  hermes:\n    a: 1\n---\nb");
    expect(skill?.version).toBeNull();
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
  it("reads a top-level version", () => {
    expect(parseSkillMd("---\nname: x\ndescription: does x when asked to do x thing\nversion: \"3.18.3\"\n---\nb").skill?.version).toBe("3.18.3");
  });
  it("sets the version by text edit when YAML is loose, keeping other lines", () => {
    const out = setSkillMdVersion(loose, "1.0.0");
    expect(out).toContain('metadata:\n  version: "1.0.0"\n  hermes:');
    expect(out).toContain("Rule of thumb: if migrating");
    expect(parseSkillMd(out, "adr").skill?.version).toBe("1.0.0");
  });
});

describe("setSkillMdVersion", () => {
  it("rewrites the version and keeps the body", () => {
    const out = setSkillMdVersion(md, "1.3.0");
    const { skill } = parseSkillMd(out, "pr-review");
    expect(skill?.version).toBe("1.3.0");
    expect(out.endsWith("Do the thing.\n")).toBe(true);
  });
  it("keeps a long description on one line", () => {
    const long = "word ".repeat(40).trim();
    const out = setSkillMdVersion(`---\nname: a\ndescription: ${long}\n---\nbody\n`, "0.2.0");
    expect(out).toContain(`description: ${long}\n`);
  });
  it("adds metadata when absent", () => {
    const out = setSkillMdVersion("---\nname: a\ndescription: x\n---\nbody\n", "0.1.0");
    expect(out).toContain("version: 0.1.0");
  });
});

describe("semver", () => {
  it("compares with prereleases", () => {
    expect(compareVersions("1.0.0-beta.2", "1.0.0")).toBeLessThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
  });
  it("resolves ranges", () => {
    const vs = ["0.1.0", "1.0.0", "1.2.3", "1.9.0", "2.0.0", "2.1.0-rc.1"];
    expect(maxSatisfying(vs, "^1.0.0")).toBe("1.9.0");
    expect(maxSatisfying(vs, "~1.2.0")).toBe("1.2.3");
    expect(maxSatisfying(vs, "latest")).toBe("2.0.0");
    expect(maxSatisfying(vs, "2.1.0-rc.1")).toBe("2.1.0-rc.1");
    expect(satisfies("0.2.0", "^0.1.0")).toBe(false);
  });
  it("bumps", () => {
    expect(bumpVersion("1.2.3", "minor")).toBe("1.3.0");
  });
});

describe("hashing and paths", () => {
  it("bundle hash ignores order and normalises mode", () => {
    const a = [{ path: "b", mode: 0o100644, sha256: "1" }, { path: "a", mode: 0o100755, sha256: "2" }];
    const b = [{ path: "a", mode: 0o755, sha256: "2" }, { path: "b", mode: 0o600, sha256: "1" }];
    expect(bundleSha256(a)).toBe(bundleSha256(b));
  });
  it("rejects traversal", () => {
    expect(isSafeRelativePath("../x")).toBe(false);
    expect(isSafeRelativePath("scripts/run.sh")).toBe(true);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
  });
});

describe("frontmatterRows", () => {
  it("joins a plain multi-line description and flattens metadata", () => {
    const { rows } = frontmatterRows("---\nname: a\ndescription: first line\n  continues here.\nmetadata:\n  version: \"1.0.0\"\n---\nbody");
    expect(rows).toEqual([
      { key: "name", value: "a" },
      { key: "description", value: "first line continues here." },
      { key: "metadata.version", value: "1.0.0" },
    ]);
  });
});
