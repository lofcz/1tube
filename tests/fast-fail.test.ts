/**
 * Fast-fail middleware: unknown function names return 404 BEFORE running
 * auth, body-limit, and rate-limit. This both saves CPU and prevents
 * scanner traffic from exhausting the rate-limit table.
 *
 * The middleware is co-located with server.ts. Since server.ts has top-level
 * Deno.serve() side effects, we re-implement the same wiring against a fresh
 * Hono instance + a real FunctionRegistry — the middleware itself is a few
 * lines of pure logic, easy to reproduce verbatim.
 */

import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { FunctionRegistry } from "../src/registry.ts";
import { defaultManifest } from "../src/manifest.ts";
import { createRateLimiter } from "../src/gateway/rate-limit.ts";
import { resetTubeEnv } from "./_helpers.ts";

function buildApp(registry: FunctionRegistry) {
  const app = new Hono();
  let authProbeCalls = 0;
  let rateLimitCalls = 0;
  let dispatchCalls = 0;

  // Mirror server.ts middleware order: fast-fail FIRST.
  app.use("/functions/v1/*", async (c, next) => {
    const path = c.req.path;
    const prefix = "/functions/v1/";
    if (path.length > prefix.length) {
      const after = path.slice(prefix.length);
      const slash = after.indexOf("/");
      const name = slash === -1 ? after : after.slice(0, slash);
      if (name && !registry.has(name)) {
        return c.json({ error: `Function "${name}" not found` }, 404);
      }
    }
    await next();
  });

  app.use("/functions/v1/*", async (_c, next) => {
    authProbeCalls++;
    await next();
  });

  const rl = createRateLimiter({
    registry,
    defaultRpm: 10,
    maxBuckets: 100,
  });
  app.use("/functions/v1/*", async (c, next) => {
    rateLimitCalls++;
    return await rl(c, next);
  });

  app.all("/functions/v1/:name{.+}", (c) => {
    dispatchCalls++;
    return c.json({ ok: true });
  });

  return {
    app,
    counts: () => ({
      authProbe: authProbeCalls,
      rateLimit: rateLimitCalls,
      dispatch: dispatchCalls,
    }),
  };
}

function reqFor(name: string): Request {
  return new Request(`http://x/functions/v1/${name}`);
}

Deno.test("fast-fail: unknown name returns 404 without running auth/rate-limit/dispatch", async () => {
  resetTubeEnv();
  const reg = new FunctionRegistry();
  const { app, counts } = buildApp(reg);

  const res = await app.fetch(reqFor("ghost"));
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, 'Function "ghost" not found');

  const c = counts();
  assertEquals(c.authProbe, 0, "auth probe must be skipped");
  assertEquals(c.rateLimit, 0, "rate-limit must be skipped");
  assertEquals(c.dispatch, 0, "dispatch must be skipped");
});

Deno.test("fast-fail: known candidate (lazy, not loaded) is allowed through", async () => {
  resetTubeEnv();
  const reg = new FunctionRegistry();
  reg.registerCandidate({
    name: "lazy-fn",
    moduleUrl: "data:text/javascript,/* never imported */",
    manifest: defaultManifest(),
  });

  const { app, counts } = buildApp(reg);
  const res = await app.fetch(reqFor("lazy-fn"));
  // Real dispatch runs because we registered the dispatch route directly;
  // returns 200 from our stub. The point is fast-fail did NOT short-circuit.
  assertEquals(res.status, 200);
  const c = counts();
  assertEquals(c.authProbe, 1);
  assertEquals(c.rateLimit, 1);
  assertEquals(c.dispatch, 1);
});

Deno.test("fast-fail: scanner hammering does not pollute the rate-limit table", async () => {
  resetTubeEnv();
  const reg = new FunctionRegistry();
  // No registered fns → every name is unknown.
  const { app, counts } = buildApp(reg);

  // Send 50 requests to 50 unique unknown names.
  for (let i = 0; i < 50; i++) {
    const res = await app.fetch(reqFor(`scanner-${i}`));
    assertEquals(res.status, 404);
  }

  const c = counts();
  assertEquals(c.authProbe, 0);
  assertEquals(c.rateLimit, 0, "no buckets created for any of the 50 unknowns");
  assertEquals(c.dispatch, 0);
});

Deno.test("fast-fail: requests to /functions/v1/ (no name) fall through (no early 404)", async () => {
  resetTubeEnv();
  const reg = new FunctionRegistry();
  const { app, counts } = buildApp(reg);

  // Trailing slash with empty segment — middleware should not 404 here; the
  // route below will not match either, so we expect 404 from Hono itself.
  const res = await app.fetch(new Request("http://x/functions/v1/"));
  assertEquals(res.status, 404);
  const c = counts();
  // The middleware ran (mounted on `/functions/v1/*`) but didn't early-404.
  // No dispatch since there's no name segment to match.
  assertEquals(c.dispatch, 0);
});

Deno.test("fast-fail: name with trailing path is parsed correctly (only first segment)", async () => {
  resetTubeEnv();
  const reg = new FunctionRegistry();
  reg.registerCandidate({
    name: "myfn",
    moduleUrl: "data:text/javascript,/* never imported */",
    manifest: defaultManifest(),
  });

  const { app, counts } = buildApp(reg);
  const res = await app.fetch(
    new Request("http://x/functions/v1/myfn/some/sub/path"),
  );
  // Known fn → middleware allows through.
  assertEquals(res.status, 200);
  assertEquals(counts().dispatch, 1);

  const res2 = await app.fetch(
    new Request("http://x/functions/v1/notmyfn/sub"),
  );
  assertEquals(res2.status, 404);
  const body = await res2.json();
  assert((body.error as string).includes("notmyfn"));
});
