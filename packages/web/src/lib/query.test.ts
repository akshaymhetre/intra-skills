import { describe, expect, it } from "vitest";
import {
  emptyQuery,
  fromLegacyParams,
  matchesClientSide,
  normalizeQuery,
  parseQuery,
  qualifierList,
  removeQualifier,
  serializeQuery,
  toggleQualifier,
  tokenizeForDisplay,
  toSkillQuery,
  withDeprecated,
  withSort,
} from "./query";

describe("parseQuery", () => {
  it("reads every qualifier and keeps free text", () => {
    const q = parseQuery("team:platform stack:terraform area:infra tool:codex tag:aws is:private is:verified is:stale is:deprecated sort:trending review");
    expect(q).toEqual({
      kind: [],
      team: ["platform"],
      stack: ["terraform"],
      area: ["infra"],
      tool: ["codex"],
      tag: ["aws"],
      visibility: ["private"],
      deprecated: "only",
      verified: true,
      health: "stale",
      sort: "trending",
      text: ["review"],
    });
  });

  it("ORs repeated keys and drops duplicates", () => {
    const q = parseQuery("team:platform team:security team:platform");
    expect(q.team).toEqual(["platform", "security"]);
  });

  it("accepts the plural frontmatter keys as aliases", () => {
    const q = parseQuery("areas:infra tools:cursor tags:aws teams:data stacks:go");
    expect(q.stack).toEqual(["go"]);
    expect(q.area).toEqual(["infra"]);
    expect(q.tool).toEqual(["cursor"]);
    expect(q.tag).toEqual(["aws"]);
    expect(q.team).toEqual(["data"]);
  });

  it("handles quoted values and quoted phrases", () => {
    const q = parseQuery('tag:"code review" "exact phrase" plain');
    expect(q.tag).toEqual(["code review"]);
    expect(q.text).toEqual(["exact phrase", "plain"]);
  });

  it("tolerates an unclosed quote while typing", () => {
    expect(parseQuery('tag:"code rev').tag).toEqual(["code rev"]);
    expect(parseQuery('"half typed').text).toEqual(["half typed"]);
  });

  it("keeps unknown keys, empty values and bad values as free text", () => {
    const q = parseQuery("foo:bar team: is:shiny sort:random -team:x");
    expect(q.team).toEqual([]);
    expect(q.sort).toBeNull();
    expect(q.text).toEqual(["foo:bar", "team:", "is:shiny", "sort:random", "-team:x"]);
  });

  it("reads -is:deprecated as exclude and visibility:org as is:org", () => {
    const q = parseQuery("-is:deprecated visibility:org is:public");
    expect(q.deprecated).toBe("exclude");
    expect(q.visibility).toEqual(["org"]);
  });

  it("lowercases keys and qualifier values but not free text", () => {
    const q = parseQuery("TEAM:Platform Review");
    expect(q.team).toEqual(["platform"]);
    expect(q.text).toEqual(["Review"]);
  });

  it("reads kind: for the three package kinds and leaves other values as text", () => {
    const q = parseQuery("kind:plugin kinds:Rule kind:widget -kind:skill");
    expect(q.kind).toEqual(["plugin", "rule"]);
    expect(q.text).toEqual(["kind:widget", "-kind:skill"]);
  });

  it("returns an empty query for blank input", () => {
    expect(parseQuery("   ")).toEqual(emptyQuery());
  });
});

describe("serializeQuery", () => {
  it("round-trips the canonical form unchanged", () => {
    const canonical = 'team:platform team:security stack:terraform area:infra tool:codex tag:"code review" is:private is:verified is:active -is:deprecated sort:name terraform "drift check"';
    expect(normalizeQuery(canonical)).toBe(canonical);
    expect(parseQuery(serializeQuery(parseQuery(canonical)))).toEqual(parseQuery(canonical));
  });

  it("puts kind first in the canonical form", () => {
    expect(normalizeQuery("team:data review kind:rule")).toBe("kind:rule team:data review");
  });

  it("orders qualifiers before free text", () => {
    expect(normalizeQuery("review tool:codex team:platform")).toBe("team:platform tool:codex review");
  });

  it("keeps an unknown quoted qualifier exactly as typed", () => {
    expect(normalizeQuery('owner:"maya k"')).toBe('owner:"maya k"');
  });
});

describe("editing helpers", () => {
  it("toggles a facet value on and off", () => {
    const on = toggleQualifier("review", "team", "platform");
    expect(on).toBe("team:platform review");
    expect(toggleQualifier(on, "team", "platform")).toBe("review");
  });

  it("toggles is:private and is:deprecated", () => {
    expect(toggleQualifier("", "is", "private")).toBe("is:private");
    expect(toggleQualifier("is:deprecated", "is", "deprecated")).toBe("");
  });

  it("toggles is:verified and is:stale, and is:active replaces is:stale", () => {
    expect(toggleQualifier("x", "is", "verified")).toBe("is:verified x");
    expect(toggleQualifier("is:verified x", "is", "verified")).toBe("x");
    expect(toggleQualifier("", "is", "stale")).toBe("is:stale");
    expect(toggleQualifier("is:stale", "is", "active")).toBe("is:active");
    expect(toggleQualifier("is:stale", "is", "stale")).toBe("");
  });

  it("toggles a kind, sends it to the API, and lists it as a chip", () => {
    const on = toggleQualifier("review", "kind", "plugin");
    expect(on).toBe("kind:plugin review");
    expect(toggleQualifier(on, "kind", "plugin")).toBe("review");
    expect(toSkillQuery(parseQuery(on)).kind).toEqual(["plugin"]);
    expect(qualifierList(parseQuery(on))).toEqual(["kind:plugin"]);
    expect(removeQualifier(on, "kind:plugin")).toBe("review");
  });

  it("highlights kind: only for a real kind", () => {
    expect(tokenizeForDisplay("kind:rule").filter((r) => r.kind === "key").map((r) => r.text)).toEqual(["kind:"]);
    expect(tokenizeForDisplay("kind:widget")[0]?.kind).toBe("text");
  });

  it("toggles a stack", () => {
    expect(toggleQualifier("team:data", "stack", "Python")).toBe("team:data stack:python");
  });

  it("lists qualifiers without sort or text, and removes one at a time", () => {
    const input = 'team:platform stack:aws tag:"code review" is:verified sort:name drift';
    expect(qualifierList(parseQuery(input))).toEqual(["team:platform", "stack:aws", 'tag:"code review"', "is:verified"]);
    expect(removeQualifier(input, "stack:aws")).toBe('team:platform tag:"code review" is:verified sort:name drift');
    expect(removeQualifier(input, 'tag:"code review"')).toBe("team:platform stack:aws is:verified sort:name drift");
  });

  it("sets deprecated mode and sort, dropping the default sort", () => {
    expect(withDeprecated("x", "exclude")).toBe("-is:deprecated x");
    expect(withSort("x", "name")).toBe("sort:name x");
    expect(withSort("sort:name x", "updated")).toBe("x");
  });
});

describe("toSkillQuery", () => {
  it("maps qualifiers onto the API params", () => {
    const q = toSkillQuery(parseQuery('team:security stack:node tool:codex -is:deprecated sort:downloads "code review"'));
    expect(q).toEqual({
      q: "code review",
      kind: [],
      team: ["security"],
      stack: ["node"],
      area: [],
      tool: ["codex"],
      tag: [],
      visibility: [],
      health: undefined,
      verified: undefined,
      sort: "downloads",
      deprecated: "exclude",
    });
  });

  it("sends health, verified and the trending sort", () => {
    const q = toSkillQuery(parseQuery("is:verified is:active sort:trending"));
    expect(q.health).toBe("active");
    expect(q.verified).toBe(true);
    expect(q.sort).toBe("trending");
  });

  it("asks the API for everything when is:deprecated, then filters client-side", () => {
    const parsed = parseQuery("is:deprecated");
    expect(toSkillQuery(parsed).deprecated).toBe("include");
    expect(matchesClientSide(parsed, { deprecated: null })).toBe(false);
    expect(matchesClientSide(parsed, { deprecated: "old" })).toBe(true);
  });
});

describe("fromLegacyParams", () => {
  it("folds the old param shape into one query", () => {
    const p = new URLSearchParams("team=platform&tool=codex&visibility=private&sort=name&deprecated=exclude&q=review");
    expect(fromLegacyParams(p)).toBe("team:platform tool:codex is:private -is:deprecated sort:name review");
  });
  it("folds Home's links (?sort=trending, ?stack=) into the query", () => {
    expect(fromLegacyParams(new URLSearchParams("sort=trending"))).toBe("sort:trending");
    expect(fromLegacyParams(new URLSearchParams("stack=terraform&verified=1&health=stale"))).toBe("stack:terraform is:verified is:stale");
  });
  it("returns null when there is nothing legacy to fold", () => {
    expect(fromLegacyParams(new URLSearchParams("q=team:x"))).toBeNull();
  });
});

describe("tokenizeForDisplay", () => {
  it("preserves every character so the overlay lines up with the caret", () => {
    const input = '  team:platform  foo:bar -is:deprecated tag:"a b" ';
    const runs = tokenizeForDisplay(input);
    expect(runs.map((r) => r.text).join("")).toBe(input);
    expect(runs.filter((r) => r.kind === "key").map((r) => r.text)).toEqual(["team:", "is:", "tag:"]);
    expect(runs.find((r) => r.text === "foo:bar")?.kind).toBe("text");
  });
});
