/**
 * Tests for the standalone rate-limit guard and memory store in src/edge.ts.
 *
 * Standalone runtimes (the Vercel target) never mount the gateway limiter, so
 * `serve({ rateLimit })` must be enforced by `createRateLimitGuard` there.
 */

import { test } from "bun:test";
import { assert, assertEquals } from "./_assert.ts";
import {
  createMemoryRateLimitStore,
  createRateLimitGuard,
  type RateLimitStore,
} from "../src/edge.ts";

function clock(start = 1_700_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => (at += ms) };
}

test("memory store counts per fixed window and resets on the next one", async () => {
  const time = clock(60_000 * 1000);
  const store = createMemoryRateLimitStore({ now: time.now });
  assertEquals((await store.consume("k", 2, 60_000)).remaining, 1);
  assertEquals((await store.consume("k", 2, 60_000)).allowed, true);
  const denied = await store.consume("k", 2, 60_000);
  assertEquals(denied.allowed, false);
  assertEquals(denied.resetAt, 60_000 * 1001);
  time.advance(60_000);
  assertEquals((await store.consume("k", 2, 60_000)).allowed, true);
});

test("memory store evicts the oldest key at capacity", async () => {
  const store = createMemoryRateLimitStore({ maxKeys: 2 });
  await store.consume("a", 1, 60_000);
  await store.consume("b", 1, 60_000);
  await store.consume("c", 1, 60_000);
  assertEquals((await store.consume("a", 1, 60_000)).allowed, true);
});

test("guard enforces a numeric declaration with a 429 and Retry-After", async () => {
  const guard = createRateLimitGuard({ store: createMemoryRateLimitStore() });
  const check = { functionName: "fn", rateLimit: 2, ip: "1.2.3.4" } as const;
  assertEquals(await guard(check), null);
  assertEquals(await guard(check), null);
  const res = await guard(check);
  assert(res);
  assertEquals(res.status, 429);
  const retry = Number(res.headers.get("Retry-After"));
  assert(retry >= 1 && retry <= 60);
  const body = await res.json();
  assertEquals(body.error, "Rate limit exceeded");
});

test("guard ignores undeclared, true, false and zero unless a default is set", async () => {
  const guard = createRateLimitGuard({ store: createMemoryRateLimitStore() });
  for (const rateLimit of [undefined, true, false, 0, { by: "ip" as const }]) {
    for (let i = 0; i < 5; i++) {
      assertEquals(await guard({ functionName: "fn", rateLimit, ip: "1.1.1.1" }), null);
    }
  }
  const withDefault = createRateLimitGuard({
    store: createMemoryRateLimitStore(),
    defaultRpm: 1,
  });
  assertEquals(await withDefault({ functionName: "fn", rateLimit: true, ip: "1.1.1.1" }), null);
  assert(await withDefault({ functionName: "fn", rateLimit: true, ip: "1.1.1.1" }));
  // `false` stays exempt even with a default.
  for (let i = 0; i < 3; i++) {
    assertEquals(await withDefault({ functionName: "f2", rateLimit: false, ip: "1.1.1.1" }), null);
  }
});

test("identity keys by user, falling back to IP; ip and global strategies", async () => {
  const guard = createRateLimitGuard({ store: createMemoryRateLimitStore() });
  // Two users behind one IP get separate buckets.
  assertEquals(await guard({ functionName: "fn", rateLimit: 1, identity: "u1", ip: "9.9.9.9" }), null);
  assertEquals(await guard({ functionName: "fn", rateLimit: 1, identity: "u2", ip: "9.9.9.9" }), null);
  assert(await guard({ functionName: "fn", rateLimit: 1, identity: "u1", ip: "8.8.8.8" }));
  // "ip" ignores identity.
  const ip = { rpm: 1, by: "ip" as const };
  assertEquals(await guard({ functionName: "g", rateLimit: ip, identity: "u1", ip: "7.7.7.7" }), null);
  assert(await guard({ functionName: "g", rateLimit: ip, identity: "u2", ip: "7.7.7.7" }));
  // "global" shares one bucket.
  const global = { rpm: 1, by: "global" as const };
  assertEquals(await guard({ functionName: "h", rateLimit: global, ip: "1.1.1.1" }), null);
  assert(await guard({ functionName: "h", rateLimit: global, ip: "2.2.2.2" }));
  // Buckets are per function.
  assertEquals(await guard({ functionName: "other", rateLimit: 1, identity: "u1" }), null);
});

test("guard skips exempt callers and requests without a trusted IP", async () => {
  const guard = createRateLimitGuard({ store: createMemoryRateLimitStore() });
  for (let i = 0; i < 3; i++) {
    assertEquals(await guard({ functionName: "fn", rateLimit: 1, ip: "1.1.1.1", exempt: true }), null);
    assertEquals(await guard({ functionName: "fn", rateLimit: 1, ip: null }), null);
  }
});

test("guard hashes keys before they reach the store", async () => {
  const seen: string[] = [];
  const store: RateLimitStore = {
    consume(key) {
      seen.push(key);
      return Promise.resolve({ allowed: true, remaining: 1, resetAt: Date.now() + 1 });
    },
  };
  const guard = createRateLimitGuard({ store, hashKey: (key) => `h(${key.length})` });
  await guard({ functionName: "fn", rateLimit: 5, ip: "10.0.0.1" });
  assertEquals(seen, ["h(14)"]);
});

test("store failures fail open and are reported", async () => {
  const errors: string[] = [];
  const guard = createRateLimitGuard({
    store: { consume: () => Promise.reject(new Error("db down")) },
    onStoreError: (error, fn) => errors.push(`${fn}:${(error as Error).message}`),
  });
  assertEquals(await guard({ functionName: "fn", rateLimit: 1, ip: "1.1.1.1" }), null);
  assertEquals(errors, ["fn:db down"]);
});
