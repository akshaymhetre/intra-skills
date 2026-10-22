// Frontmatter query: the catalog's search language.
//
//   kind:plugin team:platform stack:terraform tool:codex tag:"code review" is:private is:verified is:stale -is:deprecated sort:trending review
//
// - Qualifier keys are the SKILL.md frontmatter keys (singular or plural: `stack:` and `stacks:` both work).
// - `kind:` is the package kind (skill, plugin, rule); any other value stays free text.
// - `is:` reads registry facts, not frontmatter: private / org, verified, stale / active, deprecated.
// - Repeating a key ORs its values; different keys AND together (standard faceted search, docs/API.md).
// - Values with spaces are quoted. Anything not recognised (unknown key, empty value, bad `is:`) stays free text.
// - The URL carries the canonical form (`?q=team:platform tool:codex review`), produced by `serializeQuery`.

import type { SkillQuery } from "../api";

export type FacetKey = "kind" | "team" | "stack" | "area" | "tool" | "tag";
export const KIND_VALUES = ["skill", "plugin", "rule"] as const;
export type SortKey = "updated" | "trending" | "downloads" | "name";
export type HealthValue = "active" | "stale";
export type VisibilityValue = "org" | "private";
/** include: everything, exclude: `-is:deprecated`, only: `is:deprecated`. */
export type DeprecatedMode = "include" | "exclude" | "only";

export interface FrontmatterQuery {
  /** Package kinds: skill, plugin, rule. */
  kind: string[];
  team: string[];
  stack: string[];
  area: string[];
  tool: string[];
  tag: string[];
  visibility: VisibilityValue[];
  deprecated: DeprecatedMode;
  /** `is:verified`: only skills an admin reviewed. */
  verified: boolean;
  /** `is:stale` / `is:active`: the registry's health fact. The last one typed wins. */
  health: HealthValue | null;
  sort: SortKey | null;
  /** Free-text terms in the order typed. A quoted phrase is one term, stored without its quotes. */
  text: string[];
}

export const FACET_KEYS: readonly FacetKey[] = ["kind", "team", "stack", "area", "tool", "tag"];
export const SORT_KEYS: readonly SortKey[] = ["updated", "trending", "downloads", "name"];

const KEY_ALIASES: Record<string, FacetKey> = {
  kind: "kind",
  kinds: "kind",
  team: "team",
  teams: "team",
  stack: "stack",
  stacks: "stack",
  area: "area",
  areas: "area",
  tool: "tool",
  tools: "tool",
  tag: "tag",
  tags: "tag",
};

export function emptyQuery(): FrontmatterQuery {
  return { kind: [], team: [], stack: [], area: [], tool: [], tag: [], visibility: [], deprecated: "include", verified: false, health: null, sort: null, text: [] };
}

// One token: optional "-", then key:"quoted", key:value, "quoted phrase", or a bare word.
const TOKEN = /(-?)([A-Za-z]+):"([^"]*)"?|(-?)([A-Za-z]+):([^\s"]+)|"([^"]*)"?|(\S+)/g;

const push = <T,>(list: T[], v: T) => {
  if (!list.includes(v)) list.push(v);
};

export function parseQuery(input: string): FrontmatterQuery {
  const q = emptyQuery();
  for (const m of input.matchAll(TOKEN)) {
    const raw = m[0];
    const quotedKey = m[2] !== undefined;
    const neg = (quotedKey ? m[1] : m[4]) === "-";
    const key = (quotedKey ? m[2] : m[5])?.toLowerCase();
    const value = (quotedKey ? m[3] : m[6])?.trim().toLowerCase();

    if (key !== undefined && value !== undefined) {
      if (handleQualifier(q, key, value, neg)) continue;
      q.text.push(raw);
      continue;
    }
    if (m[7] !== undefined) {
      const phrase = m[7].trim();
      if (phrase) q.text.push(phrase);
      continue;
    }
    if (m[8] !== undefined) q.text.push(m[8]);
  }
  return q;
}

/** Applies a recognised qualifier to `q` and returns true; returns false when it must stay free text. */
function handleQualifier(q: FrontmatterQuery, key: string, value: string, neg: boolean): boolean {
  if (!value) return false;
  const facet = KEY_ALIASES[key];
  if (facet && !neg) {
    if (facet === "kind" && !(KIND_VALUES as readonly string[]).includes(value)) return false;
    push(q[facet], value);
    return true;
  }
  if (key === "is" || key === "visibility") {
    if (value === "deprecated" && key === "is") {
      q.deprecated = neg ? "exclude" : "only";
      return true;
    }
    if (neg) return false;
    if (key === "is" && value === "verified") {
      q.verified = true;
      return true;
    }
    if (key === "is" && (value === "stale" || value === "active")) {
      q.health = value;
      return true;
    }
    if (value === "private") {
      push(q.visibility, "private");
      return true;
    }
    if (value === "org" || value === "public") {
      push(q.visibility, "org");
      return true;
    }
    return false;
  }
  if (key === "sort" && !neg && (SORT_KEYS as string[]).includes(value)) {
    q.sort = value as SortKey;
    return true;
  }
  return false;
}

function quoteValue(v: string): string {
  return /[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v;
}

function quoteText(t: string): string {
  // Raw tokens that already carry their quotes (an unknown `key:"a b"`) are emitted as they were typed.
  if (t.includes('"')) return t;
  return /\s/.test(t) ? `"${t}"` : t;
}

/** Canonical text form: qualifiers in a fixed order, then free text in the order typed. */
export function serializeQuery(q: FrontmatterQuery): string {
  const parts: string[] = [];
  for (const k of FACET_KEYS) for (const v of q[k]) parts.push(`${k}:${quoteValue(v)}`);
  for (const v of q.visibility) parts.push(`is:${v}`);
  if (q.verified) parts.push("is:verified");
  if (q.health) parts.push(`is:${q.health}`);
  if (q.deprecated === "only") parts.push("is:deprecated");
  if (q.deprecated === "exclude") parts.push("-is:deprecated");
  if (q.sort) parts.push(`sort:${q.sort}`);
  for (const t of q.text) parts.push(quoteText(t));
  return parts.join(" ");
}

/** Round-trips any input through the parser into its canonical form. */
export function normalizeQuery(input: string): string {
  return serializeQuery(parseQuery(input));
}

export function hasQualifiers(q: FrontmatterQuery): boolean {
  return (
    FACET_KEYS.some((k) => q[k].length > 0) || q.visibility.length > 0 || q.deprecated !== "include" || q.verified || q.health !== null
  );
}

export function isEmptyQuery(q: FrontmatterQuery): boolean {
  return !hasQualifiers(q) && q.text.length === 0;
}

/** Adds the qualifier when absent, removes it when present. Returns the new canonical query text. */
export function toggleQualifier(input: string, key: FacetKey | "is", value: string): string {
  const q = parseQuery(input);
  const v = value.toLowerCase();
  if (key === "is") {
    if (v === "deprecated") q.deprecated = q.deprecated === "only" ? "include" : "only";
    else if (v === "verified") q.verified = !q.verified;
    else if (v === "stale" || v === "active") q.health = q.health === v ? null : v;
    else if (v === "org" || v === "private") {
      q.visibility = q.visibility.includes(v) ? q.visibility.filter((x) => x !== v) : [...q.visibility, v];
    }
  } else {
    q[key] = q[key].includes(v) ? q[key].filter((x) => x !== v) : [...q[key], v];
  }
  return serializeQuery(q);
}

export function withDeprecated(input: string, mode: DeprecatedMode): string {
  return serializeQuery({ ...parseQuery(input), deprecated: mode });
}

export function withSort(input: string, sort: SortKey | null): string {
  return serializeQuery({ ...parseQuery(input), sort: sort === "updated" ? null : sort });
}

/** The free-text part as the API's `q` (a substring match), with phrase quotes dropped. */
export function freeText(q: FrontmatterQuery): string {
  return q.text.map((t) => t.replace(/"/g, "")).join(" ").trim();
}

/** Maps a parsed query to GET /api/skills params. `is:deprecated` (only) is applied client-side by `matchesClientSide`. */
export function toSkillQuery(q: FrontmatterQuery): SkillQuery {
  const text = freeText(q);
  return {
    q: text || undefined,
    kind: q.kind,
    team: q.team,
    stack: q.stack,
    area: q.area,
    tool: q.tool,
    tag: q.tag,
    visibility: q.visibility,
    health: q.health ?? undefined,
    verified: q.verified || undefined,
    sort: q.sort ?? "updated",
    deprecated: q.deprecated === "exclude" ? "exclude" : "include",
  };
}

/** The one rule the API cannot express: `is:deprecated` keeps only deprecated skills. */
export function matchesClientSide(q: FrontmatterQuery, s: { deprecated: string | null }): boolean {
  return q.deprecated !== "only" || !!s.deprecated;
}

/** Folds the pre-query URL shape (`?team=a&tool=b&q=x`) into one query string, so old links keep working. */
export function fromLegacyParams(p: URLSearchParams): string | null {
  if (!LEGACY_PARAM_KEYS.some((k) => p.has(k))) return null;
  const q = parseQuery(p.get("q") ?? "");
  for (const k of FACET_KEYS) for (const v of p.getAll(k)) push(q[k], v.toLowerCase());
  for (const v of p.getAll("visibility")) if (v === "org" || v === "private") push(q.visibility, v);
  const sort = p.get("sort");
  if (sort && (SORT_KEYS as string[]).includes(sort) && sort !== "updated") q.sort = sort as SortKey;
  if (p.get("deprecated") === "exclude") q.deprecated = "exclude";
  const health = p.get("health");
  if (health === "active" || health === "stale") q.health = health;
  if (p.get("verified") === "1" || p.get("verified") === "true") q.verified = true;
  return serializeQuery(q);
}

export interface QueryToken {
  text: string;
  kind: "key" | "value" | "neg" | "text" | "space";
}

/**
 * Splits the raw input into styled runs for the highlighted query field, preserving every character
 * (spaces included) so the overlay lines up with the caret in the real input.
 */
export function tokenizeForDisplay(input: string): QueryToken[] {
  const out: QueryToken[] = [];
  let last = 0;
  for (const m of input.matchAll(TOKEN)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ text: input.slice(last, start), kind: "space" });
    const raw = m[0];
    const quotedKey = m[2] !== undefined;
    const key = quotedKey ? m[2] : m[5];
    const value = quotedKey ? m[3] : m[6];
    const neg = (quotedKey ? m[1] : m[4]) === "-";
    const probe = emptyQuery();
    if (key !== undefined && value !== undefined && handleQualifier(probe, key.toLowerCase(), value.trim().toLowerCase(), neg)) {
      if (neg) out.push({ text: "-", kind: "neg" });
      out.push({ text: `${key}:`, kind: "key" });
      out.push({ text: raw.slice((neg ? 1 : 0) + key.length + 1), kind: "value" });
    } else {
      out.push({ text: raw, kind: "text" });
    }
    last = start + raw.length;
  }
  if (last < input.length) out.push({ text: input.slice(last), kind: "space" });
  return out;
}

/** Every qualifier in canonical order as its own string (`stack:terraform`, `is:verified`), for removable chips. */
export function qualifierList(q: FrontmatterQuery): string[] {
  return serializeQuery({ ...q, text: [], sort: null }).match(/-?[a-z]+:(?:"[^"]*"|\S+)/g) ?? [];
}

/** Removes one qualifier (as `qualifierList` printed it) and returns the new canonical query. */
export function removeQualifier(input: string, qualifier: string): string {
  const q = parseQuery(input);
  const kept = qualifierList(q).filter((x) => x !== qualifier);
  return serializeQuery({ ...parseQuery(kept.join(" ")), text: q.text, sort: q.sort });
}

/** The legacy URL keys `fromLegacyParams` folds into `q`, so a caller can delete them afterwards. */
export const LEGACY_PARAM_KEYS = ["team", "stack", "area", "tool", "tag", "visibility", "health", "verified", "sort", "deprecated"] as const;
