/**
 * Test utilities shared across tests/.
 */

import type { Context, Next } from "hono";

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array | string): string {
  const arr =
    typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export interface SignOptions {
  sub?: string;
  email?: string;
  /** Seconds from now; default +1 hour. */
  expIn?: number;
  role?: string;
  iss?: string;
  aud?: string;
}

/**
 * Sign an HS256 JWT with the given secret. Mirrors the payload shape that
 * src/gateway/auth.ts validates.
 */
export async function signJwt(
  secret: string,
  opts: SignOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: opts.sub ?? "user-123",
    email: opts.email ?? "user@example.com",
    iat: now,
    exp: now + (opts.expIn ?? 3600),
    role: opts.role ?? "authenticated",
    iss: opts.iss ?? "test",
    aud: opts.aud ?? "authenticated",
  };
  const headerB64 = b64url(JSON.stringify(header));
  const payloadB64 = b64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput));
  const sigB64 = b64url(new Uint8Array(sigBuf));

  return `${signingInput}.${sigB64}`;
}

/** Reset every `1TUBE_*` env var so each test starts from a clean slate. */
export function resetTubeEnv(): void {
  const keys = [
    "1TUBE_DEV",
    "1TUBE_HMR",
    "1TUBE_HOST",
    "1TUBE_CORS_ORIGIN",
    "1TUBE_CORS_ALLOW_HEADERS",
    "1TUBE_CORS_ALLOW_METHODS",
    "1TUBE_CORS_EXPOSE_HEADERS",
    "1TUBE_CORS_MAX_AGE",
    "1TUBE_CORS_ALLOW_CREDENTIALS",
    "1TUBE_ROUTE_PREFIX",
    "1TUBE_TRUSTED_PROXIES",
    "1TUBE_BODY_LIMIT_MB",
    "1TUBE_BODY_READ_MS",
    "1TUBE_SHUTDOWN_GRACE_MS",
    "1TUBE_ENFORCE_MANIFEST",
    "1TUBE_ALLOW_ALL",
    "1TUBE_LAZY",
    "1TUBE_LOG_BUFFER_MS",
    "1TUBE_LOG_BUFFER_LINES",
    "INTERNAL_KEY",
    "JWT_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SUPABASE_URL",
  ];
  for (const k of keys) Deno.env.delete(k);
}

/**
 * Run a Hono middleware against a synthetic request and return the response
 * the middleware ultimately produced. If the middleware calls `next()`, the
 * provided `inner` handler runs; if `inner` is omitted, a 200 OK is returned.
 */
export async function runMw(
  mw: (c: Context, next: Next) => Promise<Response | void> | Response | void,
  req: Request,
  inner?: (c: Context) => Promise<Response> | Response,
  routeParams: Record<string, string> = {},
): Promise<Response> {
  // Lazy import to avoid forcing every test file to depend on hono symbols.
  const { Hono } = await import("hono");
  const app = new Hono();
  // Mount on `/*` so middleware always matches.
  app.use("/*", mw as never);
  app.all("/*", (c) => {
    if (inner) return inner(c);
    return c.body(null, 200);
  });
  // Provide a deterministic param for tests that need it.
  if (Object.keys(routeParams).length > 0) {
    // Hono doesn't expose param injection; tests that need params should
    // craft requests against the real path.
  }
  return await app.fetch(req);
}
