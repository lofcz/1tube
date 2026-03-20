/**
 * In-memory token bucket rate limiter.
 * Keyed by user ID (authenticated) or IP (public endpoints).
 */

import type { Context, Next } from "npm:hono@4";

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

function getOrCreateBucket(key: string, rpm: number): Bucket {
  const now = Date.now();
  let bucket = buckets.get(key);

  if (!bucket) {
    if (buckets.size >= DEFAULT_CONFIG.maxBuckets) {
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

  return `ip:${c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown"}`;
}

export function createRateLimiter(config: Partial<RateLimitConfig> = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  return async (c: Context, next: Next) => {
    const fnName = c.req.param("name");
    const rpm = (fnName && cfg.overrides[fnName]) || cfg.defaultRpm;
    const key = `${resolveKey(c)}:${fnName || "global"}`;
    const bucket = getOrCreateBucket(key, rpm);

    if (bucket.tokens <= 0) {
      return c.json(
        { error: "Rate limit exceeded", retryAfterSeconds: Math.ceil(60 / rpm) },
        429,
      );
    }

    bucket.tokens--;
    await next();
  };
}
