/**
 * Tests for src/gateway/logging.ts.
 *
 * - Confirms metricsMap is bounded (5_000 entries) by exercising the eviction
 *   path through `loggingMiddleware`.
 * - Confirms that no Authorization header, no body, and no query string ever
 *   appear in the log line.
 * - Confirms `safeFnName` clamps & sanitises function names.
 */

import { assertEquals, assert, assertFalse } from "@std/assert";
import { Hono } from "hono";
import {
  _configureLogBufferForTests,
  _resetLogBufferForTests,
} from "../src/log-buffer.ts";

let suffix = 0;
async function freshLogging(): Promise<typeof import("../src/gateway/logging.ts")> {
  suffix++;
  return await import(`../src/gateway/logging.ts?test=${suffix}-${crypto.randomUUID()}`);
}

interface CapturedLog {
  level: "log" | "error";
  text: string;
}

const decoder = new TextDecoder();

/**
 * Capture log lines by replacing the buffered writer's stdout/stderr sinks.
 * Each `writeSync(p)` call is decoded into one logical line (the buffer
 * already includes a trailing `\n`). With `syncMode: true`, every write
 * flushes immediately so tests don't have to wait for an interval.
 */
function captureConsole(): { lines: CapturedLog[]; restore: () => void } {
  const lines: CapturedLog[] = [];
  const stdout = {
    writeSync(p: Uint8Array): number {
      const text = decoder.decode(p).replace(/\n+$/, "");
      for (const line of text.split("\n")) lines.push({ level: "log", text: line });
      return p.length;
    },
  };
  const stderr = {
    writeSync(p: Uint8Array): number {
      const text = decoder.decode(p).replace(/\n+$/, "");
      for (const line of text.split("\n")) lines.push({ level: "error", text: line });
      return p.length;
    },
  };
  _configureLogBufferForTests({ syncMode: true, flushIntervalMs: 0, stdout, stderr });
  return {
    lines,
    restore() {
      _resetLogBufferForTests();
    },
  };
}

Deno.test("logging: success request emits a single info line, no auth/body/query", async () => {
  const { loggingMiddleware } = await freshLogging();
  const app = new Hono();
  app.use("/functions/v1/*", loggingMiddleware);
  app.all("/functions/v1/:name{.+}", (c) => c.json({ ok: true }));

  const cap = captureConsole();
  try {
    const res = await app.fetch(
      new Request("http://localhost/functions/v1/foo?token=SECRET-QUERY-VALUE", {
        method: "POST",
        headers: { Authorization: "Bearer SUPER-SECRET-TOKEN" },
        body: JSON.stringify({ password: "SUPER-SECRET-BODY" }),
      }),
    );
    assertEquals(res.status, 200);
  } finally {
    cap.restore();
  }

  const all = cap.lines.map((l) => l.text).join("\n");
  assertFalse(all.includes("SUPER-SECRET-TOKEN"), "auth must not be logged");
  assertFalse(all.includes("SUPER-SECRET-BODY"), "body must not be logged");
  assertFalse(all.includes("SECRET-QUERY-VALUE"), "query must not be logged");
  assertFalse(all.includes("Bearer"), "auth scheme must not be logged");
  assert(all.includes("/functions/v1/foo"), "path must be logged");
  assert(all.includes("200"), "status must be logged");
});

Deno.test("logging: error responses go to console.error and bump the error counter", async () => {
  const mod = await freshLogging();
  const { loggingMiddleware, getCollectedMetrics } = mod;
  const app = new Hono();
  app.use("/functions/v1/*", loggingMiddleware);
  app.all("/functions/v1/:name{.+}", (c) => c.json({ err: true }, 500));

  const cap = captureConsole();
  try {
    await app.fetch(new Request("http://localhost/functions/v1/boom", { method: "POST" }));
  } finally {
    cap.restore();
  }
  const metrics = getCollectedMetrics();
  assertEquals(metrics.total_errors, 1);
  assertEquals(metrics.total_requests, 1);
  assert(cap.lines.some((l) => l.level === "error"));
});

Deno.test("logging: safeFnName strips control chars and shell metacharacters", async () => {
  const { safeFnName } = await freshLogging();

  assertEquals(safeFnName("hello"), "hello");
  assertEquals(safeFnName("a/b.c-d_e"), "a/b.c-d_e");

  // Newlines, ESC, semicolons, spaces — log-injection vectors.
  const sanitised = safeFnName("\u001bhi\n;rm -rf /;there");
  assertFalse(sanitised.includes("\n"));
  assertFalse(sanitised.includes("\u001b"));
  assertFalse(sanitised.includes(";"));
  assertFalse(sanitised.includes(" "));
  // Same length as the input — replacement is 1:1.
  assertEquals(sanitised.length, "\u001bhi\n;rm -rf /;there".length);
});

Deno.test("logging: safeFnName clamps to 80 chars + ellipsis on overflow", async () => {
  const { safeFnName } = await freshLogging();
  const long = "a".repeat(200);
  const out = safeFnName(long);
  // 80 chars + 1 single-char ellipsis "…" = 81 chars total.
  assertEquals(out.length, 81);
  assert(out.endsWith("…"));
  // Names at exactly 80 are passed through unchanged.
  const exact = "b".repeat(80);
  assertEquals(safeFnName(exact), exact);
});

Deno.test("logging: metricsMap evicts oldest entries past capacity", async () => {
  const mod = await freshLogging();
  const { loggingMiddleware, getCollectedMetrics } = mod;
  const app = new Hono();
  app.use("/functions/v1/*", loggingMiddleware);
  app.all("/functions/v1/:name{.+}", (c) => c.text("ok"));

  // Capacity is 5000. Drive 5050 distinct fn names through; map should stay
  // capped. (This test is the slow one — ~half a second locally — but it
  // validates the bound that protects us from cardinality DoS.)
  const cap = captureConsole();
  try {
    for (let i = 0; i < 5050; i++) {
      await app.fetch(new Request(`http://localhost/functions/v1/fn${i}`));
    }
  } finally {
    cap.restore();
  }
  const metrics = getCollectedMetrics();
  assertEquals(metrics.metric_capacity, 5000);
  assertEquals(metrics.metric_entries, 5000);
  // Oldest names should have been evicted; newest survive.
  assertFalse("fn0" in metrics.functions);
  assertFalse("fn49" in metrics.functions);
  assert("fn5049" in metrics.functions);
});
