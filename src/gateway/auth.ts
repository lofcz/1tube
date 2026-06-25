/**
 * JWT authentication for the gateway.
 *
 * Validates HMAC-SHA256 JWTs using the same secret as Supabase,
 * producing tokens fully compatible with Supabase RLS policies.
 *
 * The JWT secret is read lazily on first use so that env defaults applied
 * by the server bootstrap (e.g. dev mode) take effect even though this
 * module is imported transitively before bootstrap runs.
 *
 * Verified payloads are cached in a bounded LRU keyed by the raw token
 * string. Cache hits skip the SubtleCrypto verify (~50–200µs each on a
 * realistic workload) and the JSON.parse, which is the single biggest
 * single-process throughput win on the hot path.
 *
 *   - Cache is invalidated implicitly when JWT_SECRET rotates
 *     (see `getSecret()`), so a stale entry can never validate against
 *     a new key.
 *   - Each entry stores the token's `exp` so we never serve a payload
 *     past its TTL.
 *   - The map is bounded; oldest insertions are evicted first
 *     (insertion-order LRU; bumped on each hit).
 */

import type { AuthContext, JWTPayload } from "../registry.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let _cachedKey: CryptoKey | null = null;
let _cachedSecret: string | null = null;
let _warnedNoSecret = false;

const VERIFY_CACHE_DEFAULT_MAX = 5_000;
let _verifyCacheMax = VERIFY_CACHE_DEFAULT_MAX;

interface VerifiedEntry {
  payload: JWTPayload;
  expiresAtMs: number;
}

const verifyCache = new Map<string, VerifiedEntry>();
let _verifyCacheHits = 0;
let _verifyCacheMisses = 0;

function getSecret(): string {
  const current = Deno.env.get("JWT_SECRET") || "";
  if (current !== _cachedSecret) {
    _cachedSecret = current;
    _cachedKey = null;
    // Any cached verifications were authorised against the previous key;
    // drop them so a rotated secret cannot accidentally accept old tokens.
    verifyCache.clear();
    if (!current && !_warnedNoSecret) {
      console.warn(
        "[1tube] JWT_SECRET not set — authenticated endpoints will reject all requests",
      );
      _warnedNoSecret = true;
    }
  }
  return current;
}

async function getKey(): Promise<CryptoKey | null> {
  const secret = getSecret();
  if (!secret) return null;
  if (_cachedKey) return _cachedKey;
  _cachedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return _cachedKey;
}

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

function cacheGet(token: string, nowMs: number): JWTPayload | null {
  const hit = verifyCache.get(token);
  if (!hit) return null;
  if (hit.expiresAtMs <= nowMs) {
    verifyCache.delete(token);
    return null;
  }
  // LRU bump: re-insert so this entry becomes the most recently used.
  verifyCache.delete(token);
  verifyCache.set(token, hit);
  _verifyCacheHits++;
  return hit.payload;
}

function cacheSet(token: string, payload: JWTPayload): void {
  // Evict insertion-oldest while we're over capacity. Loop because the cap
  // can be lowered at runtime via `_setVerifyCacheMaxForTests()`.
  while (verifyCache.size >= _verifyCacheMax) {
    const oldest = verifyCache.keys().next().value;
    if (oldest === undefined) break;
    verifyCache.delete(oldest);
  }
  verifyCache.set(token, {
    payload,
    expiresAtMs: payload.exp * 1000,
  });
}

async function verifyToken(token: string): Promise<JWTPayload | null> {
  // Resolve the secret BEFORE consulting the cache. getSecret() detects
  // rotation and clears stale entries; if we read the cache first, a token
  // signed with the previous key would be returned to the caller before the
  // rotation took effect.
  const secret = getSecret();
  if (!secret) return null;

  const nowMs = Date.now();
  const cached = cacheGet(token, nowMs);
  if (cached) return cached;

  _verifyCacheMisses++;
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const key = await getKey();
    if (!key) return null;
    const sigBytes = base64UrlDecode(signatureB64);

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
    if (!isValid) return null;

    const payload = JSON.parse(
      decoder.decode(base64UrlDecode(payloadB64)),
    ) as JWTPayload;

    // `exp` is a NumericDate (seconds since epoch). Per RFC 7519 the token
    // MUST NOT be accepted past `exp`; we treat the second the token expires
    // as "past" so a 1-second TTL token can't be replayed within the same
    // wall-clock second.
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) {
      return null;
    }

    cacheSet(token, payload);
    return payload;
  } catch {
    return null;
  }
}

/**
 * Validate the Authorization header and return an AuthContext, or null if invalid.
 *
 * Two accepted token forms:
 *
 * 1. **HMAC-SHA256 JWT** signed with `JWT_SECRET`. This is the primary auth
 *    mechanism — used by user session tokens and (in hosted Supabase) by
 *    service role calls, since hosted service role keys are themselves JWTs.
 *
 * 2. **Service role key passthrough.** When `SUPABASE_SERVICE_ROLE_KEY` is set
 *    and the bearer token matches it exactly, the request is treated as a
 *    service-role call. This lets local-dev deployments use opaque key formats
 *    (e.g. `sb_secret_*`) for inter-function calls without minting JWTs.
 *
 *    The synthesised payload has `role: "service_role"` and an empty `sub`,
 *    matching the shape produced by hosted Supabase. Authorization specs that
 *    want service-only access should check for `payload.role === "service_role"`
 *    (e.g. via `require: ["service_role"]`).
 */
export async function validateRequest(
  req: Request,
): Promise<AuthContext | null> {
  const token = parseBearer(req.headers.get("Authorization"));
  if (!token) return null;

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (serviceKey && token === serviceKey) {
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      userId: "",
      email: "",
      payload: {
        sub: "",
        email: "",
        role: "service_role",
        iss: "supabase",
        aud: "service_role",
        iat: nowSec,
        // Synthetic exp matching JWTPayload shape; the token has no real
        // expiry of its own — rotation is governed by env reload.
        exp: nowSec + 60 * 60,
      },
      rawToken: token,
    };
  }

  const payload = await verifyToken(token);
  if (!payload) return null;

  return {
    userId: payload.sub,
    email: payload.email,
    payload,
    rawToken: token,
  };
}

// ---------------------------------------------------------------------------
// Diagnostics & test hooks
// ---------------------------------------------------------------------------

export interface JwtVerifyCacheStats {
  size: number;
  capacity: number;
  hits: number;
  misses: number;
}

export function getVerifyCacheStats(): JwtVerifyCacheStats {
  return {
    size: verifyCache.size,
    capacity: _verifyCacheMax,
    hits: _verifyCacheHits,
    misses: _verifyCacheMisses,
  };
}

/** Test-only: clear the cache + counters and reset key/secret memoisation. */
export function _resetAuthForTests(): void {
  verifyCache.clear();
  _verifyCacheHits = 0;
  _verifyCacheMisses = 0;
  _cachedKey = null;
  _cachedSecret = null;
  _warnedNoSecret = false;
  _verifyCacheMax = VERIFY_CACHE_DEFAULT_MAX;
}

/** Test-only: shrink the cache so eviction is observable in unit tests. */
export function _setVerifyCacheMaxForTests(max: number): void {
  _verifyCacheMax = Math.max(1, Math.floor(max));
  while (verifyCache.size > _verifyCacheMax) {
    const oldest = verifyCache.keys().next().value;
    if (oldest === undefined) break;
    verifyCache.delete(oldest);
  }
}
