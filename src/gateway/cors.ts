/**
 * CORS handling for the gateway.
 *
 * Allowed origins come from `1TUBE_CORS_ORIGIN` (comma-separated allowlist or
 * `*`). When unset, defaults to `*` only in dev mode (`1TUBE_DEV=1`); in prod
 * the absence of the env var is reported and CORS is disabled (no
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
}

let _config: CorsConfig | null = null;

function loadConfig(): CorsConfig {
  if (_config) return _config;
  const raw = (Deno.env.get("1TUBE_CORS_ORIGIN") || "").trim();
  const isDev = Deno.env.get("1TUBE_DEV") === "1";

  if (!raw) {
    if (isDev) {
      _config = { allowAny: true, allowList: [] };
    } else {
      console.warn(
        "[1tube] 1TUBE_CORS_ORIGIN not set — CORS disabled. Set it to '*' or a " +
          "comma-separated allowlist (e.g. https://app.example.com,https://admin.example.com).",
      );
      _config = { allowAny: false, allowList: [] };
    }
    return _config;
  }

  if (raw === "*") {
    _config = { allowAny: true, allowList: [] };
    return _config;
  }

  _config = {
    allowAny: false,
    allowList: raw.split(",").map((s) => s.trim()).filter(Boolean),
  };
  return _config;
}

function pickAllowedOrigin(reqOrigin: string | null): string | null {
  const cfg = loadConfig();
  if (cfg.allowAny) return reqOrigin || "*";
  if (!reqOrigin) return null;
  return cfg.allowList.includes(reqOrigin) ? reqOrigin : null;
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
