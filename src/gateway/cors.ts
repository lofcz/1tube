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
 */

import type { Context, Next } from "npm:hono@4";

const ALLOWED_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-application-name, user-agent";
const ALLOWED_METHODS = "POST, GET, OPTIONS, PUT, PATCH, DELETE";

interface CorsConfig {
  /** "*" means allow any. Empty array means CORS disabled. */
  allowAny: boolean;
  allowList: string[];
  wildcardList: string[];
}

let _config: CorsConfig | null = null;

function loadConfig(): CorsConfig {
  if (_config) return _config;
  const raw = (Deno.env.get("1TUBE_CORS_ORIGIN") || "").trim();
  const isDev = Deno.env.get("1TUBE_DEV") === "1";

  if (!raw) {
    if (isDev) {
      _config = { allowAny: true, allowList: [], wildcardList: [] };
    } else {
      console.warn(
        "[1tube] 1TUBE_CORS_ORIGIN not set — CORS disabled. Set it to '*' or a " +
          "comma-separated domain allowlist (e.g. app.example.com,*.example.com).",
      );
      _config = { allowAny: false, allowList: [], wildcardList: [] };
    }
    return _config;
  }

  const allowList: string[] = [];
  const wildcardList: string[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (entry === "*") {
      _config = { allowAny: true, allowList: [], wildcardList: [] };
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
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
  };
  if (allowed !== "*") {
    headers["Vary"] = "Origin";
  }
  if (!cfg.allowAny) {
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
