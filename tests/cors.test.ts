/**
 * Tests for src/gateway/cors.ts.
 *
 * The CORS module caches its config the first time it's called per process,
 * so each test re-imports the module under a unique URL fragment to force a
 * fresh ESM instance. (We can't reset internal closure state otherwise.)
 */

import { assertEquals } from "@std/assert";
import { Hono } from "hono";
import { resetTubeEnv } from "./_helpers.ts";

let suffix = 0;
async function freshCors(): Promise<typeof import("../src/gateway/cors.ts")> {
  suffix++;
  // Cache-bust the module so closure state (the once-loaded config) resets.
  return await import(`../src/gateway/cors.ts?test=${suffix}-${crypto.randomUUID()}`);
}

function appWith(mw: (c: import("hono").Context, n: import("hono").Next) => unknown) {
  const app = new Hono();
  app.use("/*", mw as never);
  app.get("/*", (c) => c.text("ok"));
  return app;
}

Deno.test("cors: dev mode without 1TUBE_CORS_ORIGIN allows any origin", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_DEV", "1");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://example.com" } }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), "https://example.com");
});

Deno.test("cors: production with no allowlist emits no CORS headers", async () => {
  resetTubeEnv();
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://example.com" } }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), null);
});

Deno.test("cors: production allowlist accepts a listed origin", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com,admin.example.com");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const ok = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://admin.example.com" } }),
  );
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://admin.example.com");
  assertEquals(ok.headers.get("vary"), "Origin");
  assertEquals(ok.headers.get("access-control-allow-credentials"), "true");
});

Deno.test("cors: production allowlist rejects an unlisted origin", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const blocked = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://evil.example.com" } }),
  );
  assertEquals(blocked.headers.get("access-control-allow-origin"), null);
});

Deno.test("cors: production allowlist accepts wildcard subdomains", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "https://app.example.com,*.schools.example");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const ok = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://tenant.schools.example" } }),
  );
  assertEquals(ok.headers.get("access-control-allow-origin"), "https://tenant.schools.example");
  assertEquals(ok.headers.get("access-control-allow-credentials"), "true");

  const apex = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://schools.example" } }),
  );
  assertEquals(apex.headers.get("access-control-allow-origin"), null);

  const anyScheme = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "http://tenant.schools.example" } }),
  );
  assertEquals(anyScheme.headers.get("access-control-allow-origin"), "http://tenant.schools.example");
});

Deno.test("cors: '*' inside comma list allows any origin", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com,*");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const res = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://anywhere.example" } }),
  );
  assertEquals(res.headers.get("access-control-allow-origin"), "https://anywhere.example");
});

Deno.test("cors: explicit '*' allows any origin in production", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "*");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const res = await app.fetch(
    new Request("http://localhost/x", { headers: { Origin: "https://anywhere.example" } }),
  );
  assertEquals(res.headers.get("access-control-allow-origin"), "https://anywhere.example");
  // With wildcard mode we don't claim credentials support.
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});

Deno.test("cors: OPTIONS preflight short-circuits to 204", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const res = await app.fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-methods")?.includes("POST"), true);
  assertEquals(res.headers.get("access-control-allow-headers")?.includes("authorization"), true);
});

Deno.test("cors: OPTIONS from a disallowed origin returns 204 with no allow-origin header", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const res = await app.fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com" },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(res.headers.get("access-control-allow-origin"), null);
});

// ---------------------------------------------------------------------------
// De-hardcoded CORS response shape (headers/methods/expose/max-age/creds)
// ---------------------------------------------------------------------------

Deno.test("cors: default expose-headers carries the internal x-1tube set", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://app.example.com" },
    }),
  );
  const expose = res.headers.get("access-control-expose-headers") ?? "";
  assertEquals(expose.includes("x-1tube-warming"), true);
  assertEquals(expose.includes("x-1tube-stale"), true);
  assertEquals(expose.includes("retry-after"), true);
});

Deno.test("cors: 1TUBE_CORS_ALLOW_HEADERS / _METHODS override the defaults", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  Deno.env.set("1TUBE_CORS_ALLOW_HEADERS", "authorization, x-tenant-id");
  Deno.env.set("1TUBE_CORS_ALLOW_METHODS", "GET, POST");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(res.headers.get("access-control-allow-headers"), "authorization, x-tenant-id");
  assertEquals(res.headers.get("access-control-allow-methods"), "GET, POST");
});

Deno.test("cors: 1TUBE_CORS_EXPOSE_HEADERS adds to (never drops) the internal set", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  Deno.env.set("1TUBE_CORS_EXPOSE_HEADERS", "x-total-count, x-1tube-warming");
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://app.example.com" },
    }),
  );
  const expose = res.headers.get("access-control-expose-headers") ?? "";
  // Internal headers survive; the operator extra is appended; no dupes.
  assertEquals(expose.includes("x-1tube-stale"), true);
  assertEquals(expose.includes("x-total-count"), true);
  assertEquals((expose.match(/x-1tube-warming/g) ?? []).length, 1);
});

Deno.test("cors: Access-Control-Max-Age is omitted by default, emitted when configured", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  const off = await freshCors();
  const resOff = await appWith(off.corsMiddleware).fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(resOff.headers.get("access-control-max-age"), null);

  Deno.env.set("1TUBE_CORS_MAX_AGE", "600");
  const on = await freshCors();
  const resOn = await appWith(on.corsMiddleware).fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(resOn.headers.get("access-control-max-age"), "600");
});

Deno.test("cors: 1TUBE_CORS_ALLOW_CREDENTIALS=false suppresses credentials for an allowlist", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "app.example.com");
  Deno.env.set("1TUBE_CORS_ALLOW_CREDENTIALS", "false");
  const { corsMiddleware } = await freshCors();
  const res = await appWith(corsMiddleware).fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(res.headers.get("access-control-allow-origin"), "https://app.example.com");
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});

Deno.test("cors: credentials are never claimed alongside a literal '*' origin", async () => {
  resetTubeEnv();
  Deno.env.set("1TUBE_CORS_ORIGIN", "*");
  // Force-on, but with no request Origin the resolved value is literal "*".
  Deno.env.set("1TUBE_CORS_ALLOW_CREDENTIALS", "true");
  const { corsMiddleware } = await freshCors();
  const res = await appWith(corsMiddleware).fetch(
    new Request("http://localhost/x"),
  );
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});
