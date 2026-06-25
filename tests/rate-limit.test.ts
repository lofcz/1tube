/**
 * Tests for src/gateway/rate-limit.ts.
 *
 * Buckets are stored in module-level state, so each test re-imports the
 * module under a unique URL fragment to start with empty buckets.
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { resetTubeEnv } from "./_helpers.ts";

let suffix = 0;
async function freshLimiter(): Promise<
  typeof import("../src/gateway/rate-limit.ts")
> {
  suffix++;
  return await import(
    `../src/gateway/rate-limit.ts?test=${suffix}-${crypto.randomUUID()}`
  );
}

function buildApp(
  mw: import("hono").MiddlewareHandler,
  tagger?: (
    c: import("hono").Context,
    n: import("hono").Next,
  ) => Promise<void> | void,
) {
  const app = new Hono();
  if (tagger) app.use("/functions/v1/*", tagger as never);
  app.use("/functions/v1/*", mw);
  app.all("/functions/v1/:name{.+}", (c) => c.text("ok"));
  return app;
}

Deno.test("rate-limit: blocks once tokens are exhausted (anon, default rpm)", async () => {
  resetTubeEnv();
  const { createRateLimiter } = await freshLimiter();
  const limiter = createRateLimiter({
    defaultRpm: 3,
    overrides: {},
    maxBuckets: 100,
  });
  const app = buildApp(limiter);

  for (let i = 0; i < 3; i++) {
    const res = await app.fetch(
      new Request("http://localhost/functions/v1/foo"),
    );
    assertEquals(res.status, 200, `request ${i + 1} should pass`);
  }
  const blocked = await app.fetch(
    new Request("http://localhost/functions/v1/foo"),
  );
  assertEquals(blocked.status, 429);
  const body = await blocked.json();
  assertEquals(typeof body.retryAfterSeconds, "number");
});

Deno.test("rate-limit: per-user keying uses the userId set by upstream auth", async () => {
  resetTubeEnv();
  const { createRateLimiter } = await freshLimiter();
  const limiter = createRateLimiter({
    defaultRpm: 2,
    overrides: {},
    maxBuckets: 100,
  });

  let currentUser = "alice";
  const app = buildApp(limiter, (c, n) => {
    c.set("userId" as never, currentUser as never);
    return n();
  });

  // Burn alice's bucket.
  await app.fetch(new Request("http://localhost/functions/v1/foo"));
  await app.fetch(new Request("http://localhost/functions/v1/foo"));
  const aliceBlocked = await app.fetch(
    new Request("http://localhost/functions/v1/foo"),
  );
  assertEquals(aliceBlocked.status, 429);

  // Bob has his own fresh bucket.
  currentUser = "bob";
  const bobOk = await app.fetch(
    new Request("http://localhost/functions/v1/foo"),
  );
  assertEquals(bobOk.status, 200);
});

Deno.test("rate-limit: ignores X-Forwarded-For when no trusted proxies are configured", async () => {
  resetTubeEnv();
  const { createRateLimiter } = await freshLimiter();
  const limiter = createRateLimiter({
    defaultRpm: 1,
    overrides: {},
    maxBuckets: 100,
  });
  const app = buildApp(limiter);

  // Two requests claiming different XFF source IPs — both must hit the same
  // bucket because XFF is not trusted by default.
  const a = await app.fetch(
    new Request("http://localhost/functions/v1/foo", {
      headers: { "x-forwarded-for": "1.1.1.1" },
    }),
  );
  assertEquals(a.status, 200);
  const b = await app.fetch(
    new Request("http://localhost/functions/v1/foo", {
      headers: { "x-forwarded-for": "2.2.2.2" },
    }),
  );
  assertEquals(b.status, 429);
});

Deno.test("rate-limit: per-function rpm override applies independently of default", async () => {
  resetTubeEnv();
  const { createRateLimiter } = await freshLimiter();
  const limiter = createRateLimiter({
    defaultRpm: 100,
    overrides: { hot: 1 },
    maxBuckets: 100,
  });
  const app = buildApp(limiter);

  const ok = await app.fetch(new Request("http://localhost/functions/v1/hot"));
  assertEquals(ok.status, 200);
  const blocked = await app.fetch(
    new Request("http://localhost/functions/v1/hot"),
  );
  assertEquals(blocked.status, 429);

  // Other functions still pass freely.
  const cool = await app.fetch(
    new Request("http://localhost/functions/v1/cool"),
  );
  assertEquals(cool.status, 200);
});

Deno.test("rate-limit: bucket eviction keeps the map within maxBuckets", async () => {
  resetTubeEnv();
  const { createRateLimiter } = await freshLimiter();
  const limiter = createRateLimiter({
    defaultRpm: 1,
    overrides: {},
    maxBuckets: 3,
  });
  const app = buildApp(limiter);

  // Each fn name produces a distinct bucket key (anon-keyed).
  for (const name of ["a", "b", "c", "d", "e"]) {
    const res = await app.fetch(
      new Request(`http://localhost/functions/v1/${name}`),
    );
    assertEquals(res.status, 200, `request to ${name} should pass`);
  }

  // After eviction, the oldest entry ("a") should have been dropped — so a
  // second hit on "a" gets a fresh bucket and passes again, while "e" (most
  // recent) is now at zero and 429s.
  const aAgain = await app.fetch(
    new Request("http://localhost/functions/v1/a"),
  );
  assertEquals(aAgain.status, 200);
  const eBlocked = await app.fetch(
    new Request("http://localhost/functions/v1/e"),
  );
  assertEquals(eBlocked.status, 429);
});

Deno.test("rate-limit: manifest.rpm overrides static config when registry is supplied", async () => {
  resetTubeEnv();
  const { createRateLimiter } = await freshLimiter();
  const { FunctionRegistry } = await import("../src/registry.ts");
  const { defaultManifest } = await import("../src/manifest.ts");

  const registry = new FunctionRegistry();
  const m = defaultManifest();
  m.rpm = 1;
  registry.attachManifest("foo", m);
  registry.runWithCurrentFunction("foo", () => {
    registry.register(() => new Response("ok"), { public: true });
  });

  const limiter = createRateLimiter({
    defaultRpm: 100,
    overrides: { foo: 50 }, // manifest must win over both default and override
    maxBuckets: 100,
    registry,
  });
  const app = buildApp(limiter);

  const ok = await app.fetch(new Request("http://localhost/functions/v1/foo"));
  assertEquals(ok.status, 200);
  const blocked = await app.fetch(
    new Request("http://localhost/functions/v1/foo"),
  );
  assertEquals(blocked.status, 429);
});
