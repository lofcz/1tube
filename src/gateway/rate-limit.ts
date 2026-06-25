/**
 * In-memory token bucket rate limiter.
 * Keyed by user ID (set by the auth middleware) or remote IP.
 *
 * X-Forwarded-For is only honored when the immediate connection comes from a
 * trusted proxy (env `1TUBE_TRUSTED_PROXIES`, comma-separated CIDRs/IPs).
 * Otherwise the raw socket address is used so attackers cannot spoof XFF to
 * mint fresh buckets.
 */

import type { Context, Next } from "npm:hono@4";
import { getConnInfo } from "npm:hono@4/deno";
import type { FunctionRegistry } from "../registry.ts";
import { routeRemainder } from "./route-prefix.ts";

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimitConfig {
  /** Requests per minute (default). */
  defaultRpm: number;
  /** Per-function overrides. */
  overrides: Record<string, number>;
  /** Max buckets to track before evicting oldest. */
  maxBuckets: number;
  /**
   * Optional registry. When supplied, the limiter consults each function's
   * `manifest.rpm` (highest precedence) before falling back to `overrides`.
   */
  registry?: FunctionRegistry;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  defaultRpm: 120,
  overrides: {
    "ai-chat": 30,
    "pdf-generate": 10,
    "discussion-chat": 30,
    "questions-generate": 20,
  },
  maxBuckets: 10_000,
};

const buckets = new Map<string, Bucket>();
let _activeMaxBuckets = DEFAULT_CONFIG.maxBuckets;

let _trustedProxies: Set<string> | null = null;

function loadTrustedProxies(): Set<string> {
  if (_trustedProxies) return _trustedProxies;
  const raw = (Deno.env.get("1TUBE_TRUSTED_PROXIES") || "").trim();
  _trustedProxies = new Set(
    raw.split(",").map((s) => s.trim()).filter(Boolean),
  );
  return _trustedProxies;
}

function getOrCreateBucket(key: string, rpm: number): Bucket {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    if (buckets.size >= _activeMaxBuckets) {
      const oldest = buckets.keys().next().value!;
      buckets.delete(oldest);
    }
    bucket = { tokens: rpm, lastRefill: now };
    buckets.set(key, bucket);
    return bucket;
  }

  const elapsed = (now - bucket.lastRefill) / 60_000;
  const refill = Math.floor(elapsed * rpm);
  if (refill > 0) {
    bucket.tokens = Math.min(rpm, bucket.tokens + refill);
    bucket.lastRefill = now;
  }

  return bucket;
}

function resolveKey(c: Context): string {
  const userId = c.get("userId") as string | undefined;
  if (userId) return `user:${userId}`;

  const trusted = loadTrustedProxies();
  let socketAddr = "unknown";
  try {
    const info = getConnInfo(c);
    socketAddr = info.remote.address || "unknown";
  } catch {
    // Conn info not available (e.g. unit tests). Fall through to "unknown".
  }

  if (trusted.size > 0 && trusted.has(socketAddr)) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      // Use leftmost (original client) entry.
      const first = xff.split(",")[0].trim();
      if (first) return `ip:${first}`;
    }
    const realIp = c.req.header("x-real-ip");
    if (realIp) return `ip:${realIp.trim()}`;
  }

  return `ip:${socketAddr}`;
}

export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  // Operators running load tests against this gateway need a way to
  // disable rate limiting entirely without editing every per-function
  // `1tube.json`. The opt-in env var below short-circuits the limiter
  // to a no-op middleware for the lifetime of the process. This is
  // BENCHMARK / DEV ONLY — production deployments must keep limits
  // enabled or set per-function caps via manifests.
  const disabled = (Deno.env.get("1TUBE_DISABLE_RATE_LIMIT") || "").trim();
  if (disabled === "1" || disabled.toLowerCase() === "true") {
    console.log(
      `[1tube] rate limiter DISABLED via 1TUBE_DISABLE_RATE_LIMIT — load-test mode only, do not run in prod.`,
    );
    return async (_c: Context, next: Next) => {
      await next();
    };
  }
  // The bucket store is module-level (shared across limiter instances); the
  // most-recently-configured cap wins. In production there is exactly one
  // limiter, so this is correct; in tests, callers are expected to size
  // maxBuckets relative to the cardinality they exercise.
  _activeMaxBuckets = cfg.maxBuckets;

  return async (c: Context, next: Next) => {
    // Middleware is mounted on the function route wildcard, so
    // c.req.param() won't see the trailing segments. Parse the function
    // name out of the path ourselves — first segment after the
    // (configurable) prefix, before any nested route.
    const fnName = routeRemainder(c.req.path).split("/", 1)[0] || "";

    const manifestRpm = fnName
      ? cfg.registry?.manifestFor(fnName)?.rpm
      : undefined;
    const rpm = manifestRpm ??
      ((fnName && cfg.overrides[fnName]) || cfg.defaultRpm);
    const key = `${resolveKey(c)}:${fnName || "global"}`;
    const bucket = getOrCreateBucket(key, rpm);

    if (bucket.tokens <= 0) {
      return c.json(
        {
          error: "Rate limit exceeded",
          retryAfterSeconds: Math.ceil(60 / rpm),
        },
        429,
      );
    }

    bucket.tokens--;
    await next();
  };
}
