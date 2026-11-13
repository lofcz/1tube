# Rate limits outside the gateway

`serve({ rateLimit })` is enforced by the 1tube gateway's in-process token bucket. The
Vercel target does not run the gateway: each function is a standalone Node function and the
host's `serve()` takes its standalone path, so a declaration alone limits nothing there.

Standalone runtimes enforce declarations with `createRateLimitGuard` from `1tube/edge` and a
store that every instance shares:

```ts
import { createRateLimitGuard, type RateLimitStore } from "1tube/edge";

const store: RateLimitStore = {
  // Fixed window: count (key, window); deny at `limit` without incrementing past it.
  async consume(key, limit, windowMs) {
    const row = await db.rpc("consume_rate_limit", { key, limit, window_ms: windowMs });
    return { allowed: row.allowed, remaining: row.remaining, resetAt: Date.parse(row.reset_at) };
  },
};

const guard = createRateLimitGuard({
  store,
  hashKey: (key) => hmac(secret, key), // keep raw IPs out of the store
});

// In the standalone request path, after authentication:
const limited = await guard({
  functionName: config.name,
  rateLimit: config.rateLimit,
  identity: auth?.userId,
  ip: trustedClientIp(req), // never the raw X-Forwarded-For
  exempt: auth?.isServiceRole,
});
if (limited) return limited;
```

Semantics match the gateway: `false` or `0` exempts, a number or `{ rpm, by }` limits per
minute, `by` is `"identity"` (user, else IP), `"ip"` or `"global"`. Differences:

- Fixed one-minute windows instead of a token bucket, so a caller can burst up to twice the
  limit across a window boundary.
- Functions without a numeric declaration are not limited unless `defaultRpm` is set. The
  gateway applies its default to every function; turning that on for a production runtime that
  never enforced it can throttle legitimate shared-IP traffic (schools behind one NAT).
- Requests without a trusted IP are not limited rather than sharing one bucket.
- Store errors fail open and go to `onStoreError` (default `console.error`).

`createMemoryRateLimitStore()` is for local development and single-process servers only.
