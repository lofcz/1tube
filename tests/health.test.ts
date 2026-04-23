/**
 * Tests for src/health.ts.
 *
 * Verifies that without an INTERNAL_KEY both endpoints stay closed, that
 * `Authorization: Bearer` is the only accepted credential, and that the
 * removed `?key=` query form is treated like any other unauthenticated call.
 */

import { assertEquals, assert } from "@std/assert";
import { Hono } from "hono";
import { FunctionRegistry } from "../src/registry.ts";
import {
  _setConstrainedMemoryReaderForTests,
  createHealthHandler,
  createMetricsHandler,
} from "../src/health.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { defaultManifest } from "../src/manifest.ts";
import { resetTubeEnv } from "./_helpers.ts";

const KEY = "internal-key-shhh";

function buildApp(internalKey?: string) {
  const registry = new FunctionRegistry();
  const supervisor = new FunctionSupervisor();

  registry.attachManifest("alpha", defaultManifest());
  registry.runWithCurrentFunction("alpha", () => {
    registry.register(() => new Response("ok"), { public: true });
  });
  supervisor.setManifest("alpha", defaultManifest());

  const app = new Hono();
  app.get("/health", createHealthHandler(registry, internalKey, supervisor));
  app.get("/metrics", createMetricsHandler(internalKey));
  return app;
}

Deno.test("health: without INTERNAL_KEY responds with minimal status only", async () => {
  resetTubeEnv();
  const app = buildApp();

  const res = await app.fetch(new Request("http://localhost/health"));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body, { status: "ok" });

  const m = await app.fetch(new Request("http://localhost/metrics"));
  assertEquals(m.status, 403);
});

Deno.test("health: with INTERNAL_KEY but no auth responds minimally; auth unlocks details", async () => {
  resetTubeEnv();
  const app = buildApp(KEY);

  const closed = await app.fetch(new Request("http://localhost/health"));
  assertEquals(closed.status, 200);
  assertEquals(await closed.json(), { status: "ok" });

  const open = await app.fetch(
    new Request("http://localhost/health", {
      headers: { Authorization: `Bearer ${KEY}` },
    }),
  );
  assertEquals(open.status, 200);
  const body = await open.json();
  assertEquals(body.function_count, 1);
  assertEquals(body.functionList, ["alpha"]);
  assert("supervisor" in body);
  assert("memory" in body);
});

Deno.test("health: rejects a wrong bearer", async () => {
  resetTubeEnv();
  const app = buildApp(KEY);
  const res = await app.fetch(
    new Request("http://localhost/health", {
      headers: { Authorization: "Bearer not-the-key" },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok" });
});

Deno.test("metrics: with header bearer returns Prometheus text", async () => {
  resetTubeEnv();
  const app = buildApp(KEY);
  const res = await app.fetch(
    new Request("http://localhost/metrics", {
      headers: { Authorization: `Bearer ${KEY}` },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("content-type"),
    "text/plain; version=0.0.4; charset=utf-8",
  );
  const text = await res.text();
  assert(text.includes("onetube_uptime_seconds"));
  assert(text.includes("onetube_requests_total"));
});

Deno.test("metrics: ?key= query auth is rejected (header-only)", async () => {
  resetTubeEnv();
  const app = buildApp(KEY);

  // Even with the *correct* secret in the query string, /metrics must 403.
  // Query strings leak into access logs, browser history, and proxy buffers,
  // so 1tube only accepts the secret in the Authorization header.
  const res = await app.fetch(
    new Request(`http://localhost/metrics?key=${KEY}`),
  );
  assertEquals(res.status, 403);

  // Same rule on /health: the query value is ignored entirely; the response
  // is the minimal unauthenticated `{status:"ok"}` shape.
  const h = await app.fetch(
    new Request(`http://localhost/health?key=${KEY}`),
  );
  assertEquals(h.status, 200);
  assertEquals(await h.json(), { status: "ok" });
});

Deno.test("health: memory.limit_mb is null when constrainedMemory is unavailable", async () => {
  resetTubeEnv();
  _setConstrainedMemoryReaderForTests(() => null);
  try {
    const app = buildApp(KEY);
    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    );
    const body = await res.json();
    assertEquals(body.memory.limit_mb, null);
    assertEquals(body.memory.headroom_pct, null);
    assert(typeof body.memory.rss_mb === "number");
  } finally {
    _setConstrainedMemoryReaderForTests(null);
  }
});

Deno.test("health: memory.limit_mb + headroom_pct surfaced when cgroup cap reported", async () => {
  resetTubeEnv();
  // Pretend the cgroup gave us a 512 MB cap.
  const fakeCapBytes = 512 * 1024 * 1024;
  _setConstrainedMemoryReaderForTests(() => fakeCapBytes);
  try {
    const app = buildApp(KEY);
    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    );
    const body = await res.json();
    assertEquals(body.memory.limit_mb, 512);
    assert(typeof body.memory.headroom_pct === "number");
    assert(
      body.memory.headroom_pct >= 0 && body.memory.headroom_pct <= 100,
      `headroom_pct out of range: ${body.memory.headroom_pct}`,
    );
  } finally {
    _setConstrainedMemoryReaderForTests(null);
  }
});

Deno.test("health: headroom_pct clamps to 0 when RSS exceeds the reported cap", async () => {
  resetTubeEnv();
  // 1-byte cap → RSS will dwarf it → headroom must clamp at 0, not go negative.
  _setConstrainedMemoryReaderForTests(() => 1);
  try {
    const app = buildApp(KEY);
    const res = await app.fetch(
      new Request("http://localhost/health", {
        headers: { Authorization: `Bearer ${KEY}` },
      }),
    );
    const body = await res.json();
    assertEquals(body.memory.headroom_pct, 0);
  } finally {
    _setConstrainedMemoryReaderForTests(null);
  }
});

Deno.test("metrics: missing Authorization header returns 403", async () => {
  resetTubeEnv();
  const app = buildApp(KEY);
  const res = await app.fetch(new Request(`http://localhost/metrics`));
  assertEquals(res.status, 403);
});
