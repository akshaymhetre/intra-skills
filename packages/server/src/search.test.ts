import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, simple } from "./test/harness.js";

let h: Harness;
let outsider: string;
beforeEach(async () => {
  h = new Harness();
  outsider = await h.user("bob");
  await h.team("platform");
  await h.team("web");
  const pubs: [string, Record<string, string>][] = [
    ["tf-plan", { team: "platform", areas: "infra", tags: "aws, terraform", tools: "claude, codex" }],
    ["k8s-debug", { team: "platform", areas: "infra, backend", tags: "kubernetes", tools: "claude" }],
    ["react-review", { team: "web", areas: "frontend", tags: "react, review", tools: "claude, cursor" }],
    ["sql-tune", { areas: "data, backend", tags: "postgres" }],
    ["hidden-ops", { team: "platform", areas: "infra", tags: "aws", visibility: "private" }],
  ];
  for (const [name, meta] of pubs)
    expect((await h.publish(h.adminToken, name, "1.0.0", simple(name, { meta }))).status).toBe(201);
});
afterEach(() => h.close());

type List = { skills: { name: string }[]; facets: Record<string, { value: string; count: number }[]>; total: number };

async function list(qs: string, token = outsider): Promise<List> {
  const r = await h.call("GET", `/api/skills${qs}`, { token });
  expect(r.status).toBe(200);
  return r.json as List;
}
const namesOf = (l: List) => l.skills.map((s) => s.name).sort();

describe("faceted search", () => {
  it("unfiltered: only readable skills, counts exclude the private one", async () => {
    const l = await list("?sort=name");
    expect(l.skills.map((s) => s.name)).toEqual(["k8s-debug", "react-review", "sql-tune", "tf-plan"]);
    expect(l.total).toBe(4);
    expect(l.facets.teams).toEqual([
      { value: "platform", count: 2 },
      { value: "web", count: 1 },
    ]);
    expect(l.facets.areas).toEqual([
      { value: "backend", count: 2 },
      { value: "infra", count: 2 },
      { value: "data", count: 1 },
      { value: "frontend", count: 1 },
    ]);
    expect(l.facets.tools).toEqual([
      { value: "claude", count: 4 },
      { value: "codex", count: 2 },
      { value: "cursor", count: 2 },
    ]);
    expect(l.facets.visibility).toEqual([{ value: "org", count: 4 }]);
    const admin = await list("", h.adminToken);
    expect(admin.total).toBe(5);
    expect(admin.facets.teams).toEqual([
      { value: "platform", count: 3 },
      { value: "web", count: 1 },
    ]);
  });

  it("filters by team, area, tool and tag; facet counts use the other filters", async () => {
    const byTeam = await list("?team=platform");
    expect(namesOf(byTeam)).toEqual(["k8s-debug", "tf-plan"]);
    // team facet ignores the team filter itself
    expect(byTeam.facets.teams).toEqual([
      { value: "platform", count: 2 },
      { value: "web", count: 1 },
    ]);
    // area facet is computed over the team-filtered set
    expect(byTeam.facets.areas).toEqual([
      { value: "infra", count: 2 },
      { value: "backend", count: 1 },
    ]);

    expect(namesOf(await list("?area=backend"))).toEqual(["k8s-debug", "sql-tune"]);
    expect(namesOf(await list("?area=backend&area=frontend"))).toEqual(["k8s-debug", "react-review", "sql-tune"]);
    expect(namesOf(await list("?area=backend&team=platform"))).toEqual(["k8s-debug"]);
    expect(namesOf(await list("?tool=cursor"))).toEqual(["react-review", "sql-tune"]);
    const tag = await list("?tag=aws");
    expect(namesOf(tag)).toEqual(["tf-plan"]);
    expect(tag.facets.tags.find((f) => f.value === "aws")).toEqual({ value: "aws", count: 1 });
    expect(namesOf(await list("?q=REVIEW"))).toEqual(["react-review"]);
    expect(namesOf(await list("?q=postgres"))).toEqual(["sql-tune"]);
    expect((await list("?visibility=private")).total).toBe(0);
  });

  it("deprecated exclude and sort by downloads", async () => {
    await h.call("PATCH", "/api/skills/sql-tune", { token: h.adminToken, body: { deprecated: "use pg-tune" } });
    expect(namesOf(await list("?deprecated=exclude"))).toEqual(["k8s-debug", "react-review", "tf-plan"]);
    expect((await list("")).total).toBe(4);
    await h.call("GET", "/api/skills/react-review/versions/1.0.0/bundle", { token: outsider });
    await h.call("GET", "/api/skills/react-review/versions/1.0.0/bundle", { token: outsider });
    await h.call("GET", "/api/skills/tf-plan/versions/1.0.0/bundle", { token: outsider });
    const byDl = await list("?sort=downloads");
    expect(byDl.skills.slice(0, 2).map((s) => s.name)).toEqual(["react-review", "tf-plan"]);
    expect((await h.call("GET", "/api/skills?sort=bogus", { token: outsider })).status).toBe(400);
  });

  it("default sort is updated desc", async () => {
    await new Promise((r) => setTimeout(r, 5));
    await h.publish(h.adminToken, "sql-tune", "1.1.0", simple("sql-tune"));
    const l = await list("");
    expect(l.skills[0]!.name).toBe("sql-tune");
  });
});
