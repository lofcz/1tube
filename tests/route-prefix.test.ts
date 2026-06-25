/**
 * Tests for src/gateway/route-prefix.ts � the configurable function route
 * prefix.
 *
 * The prefix is process-global module state, so every test restores the
 * default in a `finally` to avoid leaking a custom prefix into the
 * logging / rate-limit suites that share the same process.
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import {
  DEFAULT_ROUTE_PREFIX,
  getRoutePrefix,
  normalizeRoutePrefix,
  routeDispatchPattern,
  routeRemainder,
  routeWildcard,
  setRoutePrefix,
  stripRoutePrefixFromPathname,
} from "../src/gateway/route-prefix.ts";

function withPrefix(p: string, fn: () => void | Promise<void>) {
  return async () => {
    setRoutePrefix(p);
    try {
      await fn();
    } finally {
      setRoutePrefix(DEFAULT_ROUTE_PREFIX);
    }
  };
}

Deno.test("normalizeRoutePrefix: defaults, slashes, trimming", () => {
  assertEquals(normalizeRoutePrefix(undefined), "/functions/v1");
  assertEquals(normalizeRoutePrefix(""), "/functions/v1");
  assertEquals(normalizeRoutePrefix("   "), "/functions/v1");
  // bare root can't be mounted without swallowing /health etc.
  assertEquals(normalizeRoutePrefix("/"), "/functions/v1");
  // leading slash added, trailing slash stripped
  assertEquals(normalizeRoutePrefix("api"), "/api");
  assertEquals(normalizeRoutePrefix("/api/"), "/api");
  assertEquals(normalizeRoutePrefix("api/v2/"), "/api/v2");
  // duplicate slashes collapsed
  assertEquals(normalizeRoutePrefix("//edge///v2//"), "/edge/v2");
});

Deno.test(
  "routeRemainder + stripRoutePrefixFromPathname: default prefix",
  withPrefix("/functions/v1", () => {
    assertEquals(getRoutePrefix(), "/functions/v1");
    assertEquals(routeRemainder("/functions/v1/hello"), "hello");
    assertEquals(routeRemainder("/functions/v1/hello/world"), "hello/world");
    assertEquals(routeRemainder("/functions/v1"), "");
    assertEquals(routeRemainder("/something/else"), "");
    assertEquals(stripRoutePrefixFromPathname("/functions/v1/hello"), "/hello");
    assertEquals(stripRoutePrefixFromPathname("/functions/v1"), "");
    assertEquals(stripRoutePrefixFromPathname("/other"), "/other");
  }),
);

Deno.test(
  "routeRemainder + stripRoutePrefixFromPathname: custom prefix",
  withPrefix("/api/v2", () => {
    assertEquals(routeWildcard(), "/api/v2/*");
    assertEquals(routeDispatchPattern(), "/api/v2/:name{.+}");
    assertEquals(routeRemainder("/api/v2/hello/world"), "hello/world");
    assertEquals(stripRoutePrefixFromPathname("/api/v2/hello"), "/hello");
    // the old prefix is now just a normal (unmatched) path
    assertEquals(routeRemainder("/functions/v1/hello"), "");
  }),
);

Deno.test(
  "integration: a custom prefix routes dispatch and strips the path",
  withPrefix("/api", async () => {
    const app = new Hono();
    app.all(routeDispatchPattern(), (c) => {
      const name = (c.req.param("name") ?? "").split("/", 1)[0];
      const seen = stripRoutePrefixFromPathname(new URL(c.req.url).pathname);
      return c.json({ name, seen });
    });

    const hit = await app.fetch(
      new Request("http://localhost/api/hello/world"),
    );
    assertEquals(hit.status, 200);
    assertEquals(await hit.json(), { name: "hello", seen: "/hello/world" });

    // The historical prefix no longer matches under a custom prefix.
    const miss = await app.fetch(
      new Request("http://localhost/functions/v1/hello"),
    );
    assertEquals(miss.status, 404);
  }),
);

Deno.test("setRoutePrefix normalizes its input and is observable globally", () => {
  try {
    assertEquals(setRoutePrefix("edge/v3/"), "/edge/v3");
    assertEquals(getRoutePrefix(), "/edge/v3");
    assertEquals(routeWildcard(), "/edge/v3/*");
  } finally {
    setRoutePrefix(DEFAULT_ROUTE_PREFIX);
  }
});
