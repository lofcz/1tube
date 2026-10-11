/**
 * Tests for src/gateway/cors.ts.
 *
 * The CORS module caches its config the first time it's called per process,
 * so each test re-imports the module under a unique URL fragment to force a
 * fresh ESM instance. (We can't reset internal closure state otherwise.)
 */

import { test } from "bun:test";
import { assertEquals } from "./_assert.ts";
import { Hono } from "hono";
import { resetTubeEnv } from "./_helpers.ts";

let suffix = 0;
async function freshCors(): Promise<typeof import("../src/gateway/cors.ts")> {
  suffix++;
  // Cache-bust the module so closure state (the once-loaded config) resets.
  return await import(
    `../src/gateway/cors.ts?test=${suffix}-${crypto.randomUUID()}`
  );
}

function appWith(
  mw: (c: import("hono").Context, n: import("hono").Next) => unknown,
) {
  const app = new Hono();
  app.use("/*", mw as never);
  app.get("/*", (c) => c.text("ok"));
  return app;
}

test("cors: dev mode without 1TUBE_CORS_ORIGIN allows any origin", async () => {
  resetTubeEnv();
  process.env["1TUBE_DEV"] = "1";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://example.com" },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "https://example.com",
  );
});

test("cors: production with no allowlist emits no CORS headers", async () => {
  resetTubeEnv();
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://example.com" },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("access-control-allow-origin"), null);
});

test("cors: production allowlist accepts a listed origin", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com,admin.example.com";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const ok = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://admin.example.com" },
    }),
  );
  assertEquals(
    ok.headers.get("access-control-allow-origin"),
    "https://admin.example.com",
  );
  assertEquals(ok.headers.get("vary"), "Origin");
  assertEquals(ok.headers.get("access-control-allow-credentials"), "true");
});

test("cors: production allowlist rejects an unlisted origin", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const blocked = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://evil.example.com" },
    }),
  );
  assertEquals(blocked.headers.get("access-control-allow-origin"), null);
});

test("cors: production allowlist accepts wildcard subdomains", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "https://app.example.com,*.schools.example";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const ok = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://tenant.schools.example" },
    }),
  );
  assertEquals(
    ok.headers.get("access-control-allow-origin"),
    "https://tenant.schools.example",
  );
  assertEquals(ok.headers.get("access-control-allow-credentials"), "true");

  const apex = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://schools.example" },
    }),
  );
  assertEquals(apex.headers.get("access-control-allow-origin"), null);

  const anyScheme = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "http://tenant.schools.example" },
    }),
  );
  assertEquals(
    anyScheme.headers.get("access-control-allow-origin"),
    "http://tenant.schools.example",
  );
});

test("cors: '*' inside comma list allows any origin", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com,*";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const res = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://anywhere.example" },
    }),
  );
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "https://anywhere.example",
  );
});

test("cors: explicit '*' allows any origin in production", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "*";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const res = await app.fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://anywhere.example" },
    }),
  );
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "https://anywhere.example",
  );
  // With wildcard mode we don't claim credentials support.
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});

test("cors: OPTIONS preflight short-circuits to 204", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);

  const res = await app.fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(res.status, 204);
  assertEquals(
    res.headers.get("access-control-allow-methods")?.includes("POST"),
    true,
  );
  assertEquals(
    res.headers.get("access-control-allow-headers")?.includes("authorization"),
    true,
  );
});

test("cors: OPTIONS from a disallowed origin returns 204 with no allow-origin header", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
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

test("cors: default expose-headers carries the internal x-1tube set", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
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
  assertEquals(expose.includes("x-deployment-id"), true);
});

test("cors: default allow-headers admits the Vercel Skew Protection pin", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Headers": "x-deployment-id",
      },
    }),
  );
  assertEquals(res.status, 204);
  const allow = (res.headers.get("access-control-allow-headers") ?? "")
    .toLowerCase();
  assertEquals(allow.includes("x-deployment-id"), true);
  // The historical defaults are still there.
  assertEquals(allow.includes("authorization"), true);
  assertEquals(allow.includes("apikey"), true);
});

test("cors: 1TUBE_CORS_ALLOW_HEADERS / _METHODS override the defaults", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
  process.env["1TUBE_CORS_ALLOW_HEADERS"] = "authorization, x-tenant-id";
  process.env["1TUBE_CORS_ALLOW_METHODS"] = "GET, POST";
  const { corsMiddleware } = await freshCors();
  const app = appWith(corsMiddleware);
  const res = await app.fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(
    res.headers.get("access-control-allow-headers"),
    "authorization, x-tenant-id",
  );
  assertEquals(res.headers.get("access-control-allow-methods"), "GET, POST");
});

test("cors: 1TUBE_CORS_EXPOSE_HEADERS adds to (never drops) the internal set", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
  process.env["1TUBE_CORS_EXPOSE_HEADERS"] = "x-total-count, x-1tube-warming";
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

test("cors: Access-Control-Max-Age is omitted by default, emitted when configured", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
  const off = await freshCors();
  const resOff = await appWith(off.corsMiddleware).fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(resOff.headers.get("access-control-max-age"), null);

  process.env["1TUBE_CORS_MAX_AGE"] = "600";
  const on = await freshCors();
  const resOn = await appWith(on.corsMiddleware).fetch(
    new Request("http://localhost/x", {
      method: "OPTIONS",
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(resOn.headers.get("access-control-max-age"), "600");
});

test("cors: 1TUBE_CORS_ALLOW_CREDENTIALS=false suppresses credentials for an allowlist", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "app.example.com";
  process.env["1TUBE_CORS_ALLOW_CREDENTIALS"] = "false";
  const { corsMiddleware } = await freshCors();
  const res = await appWith(corsMiddleware).fetch(
    new Request("http://localhost/x", {
      headers: { Origin: "https://app.example.com" },
    }),
  );
  assertEquals(
    res.headers.get("access-control-allow-origin"),
    "https://app.example.com",
  );
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});

test("cors: credentials are never claimed alongside a literal '*' origin", async () => {
  resetTubeEnv();
  process.env["1TUBE_CORS_ORIGIN"] = "*";
  // Force-on, but with no request Origin the resolved value is literal "*".
  process.env["1TUBE_CORS_ALLOW_CREDENTIALS"] = "true";
  const { corsMiddleware } = await freshCors();
  const res = await appWith(corsMiddleware).fetch(
    new Request("http://localhost/x"),
  );
  assertEquals(res.headers.get("access-control-allow-origin"), "*");
  assertEquals(res.headers.get("access-control-allow-credentials"), null);
});
