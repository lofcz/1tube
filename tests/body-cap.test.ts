/**
 * Tests for the body size cap installed in src/server.ts.
 *
 * We don't import the server (it would bind a port and run signal handlers),
 * so we replicate just the bodyLimit middleware against a Hono app.
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

function appWithLimit(maxBytes: number) {
  const app = new Hono();
  app.use(
    "/functions/v1/*",
    bodyLimit({
      maxSize: maxBytes,
      onError: (c) =>
        c.json({ error: "Request body too large", maxBytes }, 413),
    }),
  );
  app.post("/functions/v1/:name{.+}", async (c) => {
    const buf = await c.req.arrayBuffer();
    return c.json({ bytes: buf.byteLength });
  });
  return app;
}

Deno.test("body-cap: passes a request under the limit", async () => {
  const app = appWithLimit(1024);
  const res = await app.fetch(
    new Request("http://localhost/functions/v1/x", {
      method: "POST",
      body: "x".repeat(100),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).bytes, 100);
});

Deno.test("body-cap: rejects a request over the limit with 413", async () => {
  const app = appWithLimit(64);
  const res = await app.fetch(
    new Request("http://localhost/functions/v1/x", {
      method: "POST",
      body: "x".repeat(1024),
    }),
  );
  assertEquals(res.status, 413);
  const body = await res.json();
  assertEquals(body.error, "Request body too large");
  assertEquals(body.maxBytes, 64);
});

Deno.test("body-cap: rejects exactly-at-limit + 1 (boundary)", async () => {
  const app = appWithLimit(10);
  const res = await app.fetch(
    new Request("http://localhost/functions/v1/x", {
      method: "POST",
      body: "x".repeat(11),
    }),
  );
  assertEquals(res.status, 413);
});
