/**
 * CORS handling for the gateway.
 *
 * Allowed domains come from `1TUBE_CORS_ORIGIN` (comma-separated allowlist,
 * `*`, or wildcard subdomains such as `*.example.com`). Schemes in config
 * values are ignored (`https://app.example.com` normalizes to
 * `app.example.com`); matching is domain-based, not protocol-based. When
 * unset, defaults to `*` only in dev mode (`1TUBE_DEV=1`); in prod the
 * absence of the env var is reported and CORS is disabled (no
 * `Access-Control-*` headers are emitted, browsers will refuse cross-origin
 * requests).
 *
 * Everything else about the CORS response is configurable too, with the
 * historical values as defaults (so an existing deployment that sets none
 * of these behaves exactly as before):
 *   - `1TUBE_CORS_ALLOW_HEADERS`  — replaces the default `Access-Control-
 *     Allow-Headers` allowlist.
 *   - `1TUBE_CORS_ALLOW_METHODS`  — replaces the default methods list.
 *   - `1TUBE_CORS_EXPOSE_HEADERS` — ADDED to (never replaces) the internal
 *     `x-1tube-*` set, so operators can expose extra response headers
 *     without breaking the warming/stale overlay.
 *   - `1TUBE_CORS_MAX_AGE`        — seconds for `Access-Control-Max-Age`
 *     (preflight cache). Unset = header omitted (unchanged default).
 *   - `1TUBE_CORS_ALLOW_CREDENTIALS` — force credentials on/off. Unset =
 *     the historical behaviour (on for an explicit allowlist, off for `*`).
 */

import type { Context, Next } from "npm:hono@4";

const DEFAULT_ALLOWED_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-application-name, user-agent";
const DEFAULT_ALLOWED_METHODS = "POST, GET, OPTIONS, PUT, PATCH, DELETE";
// Headers browser JS must be able to read on cross-origin responses.
// `x-1tube-warming` drives the "backend is warming up" overlay;
// `x-1tube-stale` marks a response served by a pre-edit worker while
// its HMR respawn is still in flight; `retry-after` lets clients
// honour the gateway's suggested backoff. These are always exposed —
// operator config only ADDS to them.
const INTERNAL_EXPOSED_HEADERS = "x-1tube-warming, x-1tube-stale, retry-after";

interface CorsConfig {
  /** "*" means allow any. Empty array means CORS disabled. */
  allowAny: boolean;
  allowList: string[];
  wildcardList: string[];
  allowHeaders: string;
  allowMethods: string;
  exposeHeaders: string;
  /** Seconds for Access-Control-Max-Age, or null to omit the header. */
  maxAge: string | null;
  /** Explicit credentials override; null = derive from allowAny. */
  allowCredentials: boolean | null;
}

let _config: CorsConfig | null = null;

/** Merge comma-lists, dedupe case-insensitively, keep first-seen order. */
function mergeHeaderList(base: string, extra: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (
    const part of `${base},${extra}`.split(",").map((s) => s.trim()).filter(
      Boolean,
    )
  ) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(", ");
}

function readBoolEnv(name: string): boolean | null {
  const v = Deno.env.get(name);
  if (v === undefined) return null;
  const t = v.trim().toLowerCase();
  if (t === "1" || t === "true") return true;
  if (t === "0" || t === "false") return false;
  return null;
}

/** Headers/methods/etc. are independent of the origin allowlist branch. */
function loadResponseShape(): Pick<
  CorsConfig,
  "allowHeaders" | "allowMethods" | "exposeHeaders" | "maxAge" | "allowCredentials"
> {
  const allowHeaders =
    (Deno.env.get("1TUBE_CORS_ALLOW_HEADERS") || DEFAULT_ALLOWED_HEADERS).trim();
  const allowMethods =
    (Deno.env.get("1TUBE_CORS_ALLOW_METHODS") || DEFAULT_ALLOWED_METHODS).trim();
  const exposeHeaders = mergeHeaderList(
    INTERNAL_EXPOSED_HEADERS,
    (Deno.env.get("1TUBE_CORS_EXPOSE_HEADERS") || "").trim(),
  );
  const maxAgeRaw = (Deno.env.get("1TUBE_CORS_MAX_AGE") || "").trim();
  const maxAgeNum = parseInt(maxAgeRaw, 10);
  const maxAge = maxAgeRaw !== "" && Number.isFinite(maxAgeNum) && maxAgeNum >= 0
    ? String(maxAgeNum)
    : null;
  return {
    allowHeaders,
    allowMethods,
    exposeHeaders,
    maxAge,
    allowCredentials: readBoolEnv("1TUBE_CORS_ALLOW_CREDENTIALS"),
  };
}

function loadConfig(): CorsConfig {
  if (_config) return _config;
  const raw = (Deno.env.get("1TUBE_CORS_ORIGIN") || "").trim();
  const isDev = Deno.env.get("1TUBE_DEV") === "1";
  const shape = loadResponseShape();

  if (!raw) {
    if (isDev) {
      _config = { allowAny: true, allowList: [], wildcardList: [], ...shape };
    } else {
      console.warn(
        "[1tube] 1TUBE_CORS_ORIGIN not set — CORS disabled. Set it to '*' or a " +
          "comma-separated domain allowlist (e.g. app.example.com,*.example.com).",
      );
      _config = { allowAny: false, allowList: [], wildcardList: [], ...shape };
    }
    return _config;
  }

  const allowList: string[] = [];
  const wildcardList: string[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (entry === "*") {
      _config = { allowAny: true, allowList: [], wildcardList: [], ...shape };
      return _config;
    }
    const domain = normalizeDomainPattern(entry);
    if (!domain) continue;
    if (domain.startsWith("*.")) wildcardList.push(domain.slice(1));
    else allowList.push(domain);
  }

  _config = {
    allowAny: false,
    allowList,
    wildcardList,
    ...shape,
  };
  return _config;
}

function normalizeDomainPattern(entry: string): string | null {
  let value = entry.trim().toLowerCase();
  if (!value) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  value = value.split("/")[0] ?? "";
  value = value.split("@").pop() ?? "";
  value = value.replace(/\.$/, "");
  if (!value) return null;

  // CORS config is domain-based: ignore optional ports in both
  // user-provided values and request origins.
  if (value.startsWith("[") && value.includes("]")) {
    return value.slice(1, value.indexOf("]"));
  }
  const colon = value.indexOf(":");
  return colon >= 0 ? value.slice(0, colon) : value;
}

function originDomain(reqOrigin: string): string | null {
  try {
    return new URL(reqOrigin).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return normalizeDomainPattern(reqOrigin);
  }
}

function wildcardMatches(suffix: string, hostname: string): boolean {
  return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

function pickAllowedOrigin(reqOrigin: string | null): string | null {
  const cfg = loadConfig();
  if (cfg.allowAny) return reqOrigin || "*";
  if (!reqOrigin) return null;
  const hostname = originDomain(reqOrigin);
  if (!hostname) return null;
  if (cfg.allowList.includes(hostname)) return reqOrigin;
  return cfg.wildcardList.some((suffix) => wildcardMatches(suffix, hostname)) ? reqOrigin : null;
}

function buildCorsHeaders(reqOrigin: string | null): Record<string, string> | null {
  const allowed = pickAllowedOrigin(reqOrigin);
  if (!allowed) return null;
  const cfg = loadConfig();

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": cfg.allowHeaders,
    "Access-Control-Allow-Methods": cfg.allowMethods,
    "Access-Control-Expose-Headers": cfg.exposeHeaders,
  };
  if (allowed !== "*") {
    headers["Vary"] = "Origin";
  }
  if (cfg.maxAge !== null) {
    headers["Access-Control-Max-Age"] = cfg.maxAge;
  }
  // Default (override unset): credentials on for an explicit allowlist,
  // off in `*` mode. An explicit override wins — but never claim
  // credentials alongside a literal `*` origin, which browsers reject.
  const wantCredentials = cfg.allowCredentials ?? !cfg.allowAny;
  if (wantCredentials && allowed !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

export async function corsMiddleware(c: Context, next: Next) {
  const reqOrigin = c.req.header("Origin") || null;
  const headers = buildCorsHeaders(reqOrigin);

  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: headers ?? {} });
  }

  await next();

  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      c.res.headers.set(key, value);
    }
  }
}
