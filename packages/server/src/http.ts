// Error type, error responses and small input validators shared by every route.
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "invalid"
  | "unauthenticated"
  | "forbidden"
  | "csrf"
  | "not_found"
  | "conflict"
  | "too_large"
  | "invalid_skill"
  | "upstream"
  | "internal";

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  invalid: 400,
  unauthenticated: 401,
  forbidden: 403,
  csrf: 403,
  not_found: 404,
  conflict: 409,
  too_large: 413,
  invalid_skill: 422,
  upstream: 502,
  internal: 500,
};

export class HttpError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
  get status(): ContentfulStatusCode {
    return STATUS[this.code];
  }
}

export const invalid = (msg: string, details?: unknown) => new HttpError("invalid", msg, details);
export const notFound = (what = "not found") => new HttpError("not_found", what);
export const forbidden = (msg = "forbidden", details?: unknown) => new HttpError("forbidden", msg, details);
export const conflict = (msg: string) => new HttpError("conflict", msg);

export function errorResponse(c: Context, e: HttpError): Response {
  const body: { error: { code: string; message: string; details?: unknown } } = {
    error: { code: e.code, message: e.message },
  };
  if (e.details !== undefined) body.error.details = e.details;
  return c.json(body, e.status);
}

/** Parse a JSON body; any parse failure or non-object is a 400. */
export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw invalid("request body must be JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid("request body must be a JSON object");
  return data as Record<string, unknown>;
}

/** Like jsonBody, but an empty body reads as {} (for routes whose every field is optional). */
export async function optionalJsonBody(c: Context): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === "") return {};
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw invalid("request body must be JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid("request body must be a JSON object");
  return data as Record<string, unknown>;
}

/** Parse a JSON body that must be an array. */
export async function jsonArrayBody(c: Context): Promise<unknown[]> {
  let data: unknown;
  try {
    data = await c.req.json();
  } catch {
    throw invalid("request body must be JSON");
  }
  if (!Array.isArray(data)) throw invalid("request body must be a JSON array");
  return data;
}

export function optString(o: Record<string, unknown>, key: string, max = 1000): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw invalid(`${key} must be a string`);
  if (v.length > max) throw invalid(`${key} is longer than ${max} characters`);
  return v;
}

export function reqString(o: Record<string, unknown>, key: string, max = 1000): string {
  const v = optString(o, key, max);
  if (v === undefined || v.trim() === "") throw invalid(`${key} is required`);
  return v;
}

export function optStringArray(o: Record<string, unknown>, key: string, re: RegExp): string[] | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 50) throw invalid(`${key} must be an array of at most 50 strings`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") throw invalid(`${key} must contain strings`);
    const s = x.trim().toLowerCase();
    if (!re.test(s)) throw invalid(`${key}: invalid value "${x}"`);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

export const HANDLE_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
export const MAX_HANDLE = 39;

export function checkHandle(h: string): string {
  if (h.length > MAX_HANDLE || !HANDLE_RE.test(h)) throw invalid(`invalid handle "${h}"`);
  return h;
}
