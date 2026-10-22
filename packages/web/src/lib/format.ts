const nf = new Intl.NumberFormat("en-US");
export const formatNumber = (n: number) => nf.format(n);

export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
export function relativeTime(iso: string, now = Date.now()): string {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  if (abs < 86400 * 365) return rtf.format(Math.round(diff / (86400 * 30)), "month");
  return rtf.format(Math.round(diff / (86400 * 365)), "year");
}

const dtf = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const dttf = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
export const formatDate = (iso: string) => dtf.format(new Date(iso));
export const formatDateTime = (iso: string) => dttf.format(new Date(iso));

export const shortSha = (sha: string, n = 7) => sha.slice(0, n);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "")).toUpperCase() || "?";
}

export const plural = (n: number, one: string, many = `${one}s`) => `${formatNumber(n)} ${n === 1 ? one : many}`;
