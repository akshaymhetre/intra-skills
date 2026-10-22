// Minimal semver: x.y.z with optional -prerelease. Ranges: exact, ^x.y.z, ~x.y.z, latest / *.
// Browser-safe.

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseVersion(v: string): SemVer | null {
  const m = VERSION_RE.exec(v.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split(".") : [],
  };
}

export function isValidVersion(v: string): boolean {
  return parseVersion(v) !== null;
}

/** Negative when a < b, 0 when equal, positive when a > b. Throws on invalid input. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`invalid version: ${!pa ? a : b}`);
  for (const k of ["major", "minor", "patch"] as const) if (pa[k] !== pb[k]) return pa[k] - pb[k];
  if (!pa.pre.length && !pb.pre.length) return 0;
  if (!pa.pre.length) return 1;
  if (!pb.pre.length) return -1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y);
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export function bumpVersion(v: string, kind: "major" | "minor" | "patch"): string {
  const p = parseVersion(v);
  if (!p) throw new Error(`invalid version: ${v}`);
  if (kind === "major") return `${p.major + 1}.0.0`;
  if (kind === "minor") return `${p.major}.${p.minor + 1}.0`;
  return p.pre.length ? `${p.major}.${p.minor}.${p.patch}` : `${p.major}.${p.minor}.${p.patch + 1}`;
}

export function isValidRange(range: string): boolean {
  const r = range.trim();
  if (r === "" || r === "latest" || r === "*") return true;
  const body = r.startsWith("^") || r.startsWith("~") ? r.slice(1) : r;
  return isValidVersion(body);
}

/** Does `version` satisfy `range`? Prereleases only match an exact range. */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const r = range.trim();
  if (r === "" || r === "latest" || r === "*") return v.pre.length === 0;
  if (!r.startsWith("^") && !r.startsWith("~")) return compareVersions(version, r) === 0;
  const base = parseVersion(r.slice(1));
  if (!base) return false;
  if (v.pre.length) return false;
  if (compareVersions(version, r.slice(1)) < 0) return false;
  if (r.startsWith("~")) return v.major === base.major && v.minor === base.minor;
  if (base.major > 0) return v.major === base.major;
  if (base.minor > 0) return v.major === 0 && v.minor === base.minor;
  return v.major === 0 && v.minor === 0 && v.patch === base.patch;
}

/** Highest version in `versions` satisfying `range`, or null. */
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: string | null = null;
  for (const v of versions) {
    if (!satisfies(v, range)) continue;
    if (best === null || compareVersions(v, best) > 0) best = v;
  }
  return best;
}
