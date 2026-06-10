/**
 * Tests for the invocation log store (src/logs/*).
 *
 * Covers:
 *  - migration bootstrap on a fresh DB (and idempotent re-open)
 *  - batched writer semantics: threshold flush, drop policy, retention
 *  - FTS MATCH sanitization (user input can never reach the grammar)
 *  - query layer: filters, keyset pagination, full-text search, tail
 *  - loggingMiddleware: invocation rows + id header + error classification
 *  - workerd console marker round-trip
 *  - real Deno worker console capture with per-invocation attribution
 *    under concurrent dispatches
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { join } from "@std/path";
import { Hono } from "hono";
import { openLogDb, type LogDb } from "../src/logs/db.ts";
import { createLogWriter } from "../src/logs/writer.ts";
import { buildFtsMatch, createLogQuery } from "../src/logs/query.ts";
import { parseMarkedConsoleLine, WORKERD_LOG_MARKER } from "../src/logs/console-marker.ts";
import { uuidv7 } from "../src/logs/id.ts";
import {
  _configureLogBufferForTests,
  _resetLogBufferForTests,
} from "../src/log-buffer.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import {
  createDenoWorkerHost,
  type WorkerConsoleEvent,
} from "../src/backends/deno/worker-host.ts";

async function withTempDb(
  fn: (db: LogDb, dir: string) => Promise<void> | void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "1tube-logs-test-" });
  const db = await openLogDb(join(dir, "logs.db"));
  try {
    await fn(db, dir);
  } finally {
    db.close();
    await Deno.remove(dir, { recursive: true });
  }
}

function seedInvocation(
  db: LogDb,
  over: Partial<{
    id: string;
    tsMs: number;
    fn: string;
    method: string;
    status: number;
    errorKind: string | null;
  }> = {},
): string {
  const id = over.id ?? uuidv7();
  db.raw.prepare(
    `INSERT INTO invocations (id, ts_ms, function_name, method, path, status, duration_ms, backend, error_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'deno', ?)`,
  ).run(
    id,
    over.tsMs ?? Date.now(),
    over.fn ?? "hello",
    over.method ?? "POST",
    `/functions/v1/${over.fn ?? "hello"}`,
    over.status ?? 200,
    12,
    over.errorKind ?? null,
  );
  return id;
}

function seedLog(
  db: LogDb,
  invocationId: string | null,
  message: string,
  level = "log",
): void {
  db.raw.prepare(
    `INSERT INTO logs (invocation_id, ts_ms, level, function_name, source, message)
     VALUES (?, ?, ?, 'hello', 'function', ?)`,
  ).run(invocationId, Date.now(), level, message);
}

// ---------------------------------------------------------------------------
// Migrations / bootstrap
// ---------------------------------------------------------------------------

Deno.test("logs-db: fresh open creates schema + FTS and is idempotent", async () => {
  const dir = await Deno.makeTempDir({ prefix: "1tube-logs-boot-" });
  try {
    const path = join(dir, "nested", "deeper", "logs.db");
    const db = await openLogDb(path);
    const tables = db.raw.prepare(
      `SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert(names.includes("invocations"));
    assert(names.includes("logs"));
    assert(names.includes("logs_fts"));
    assert(names.includes("logs_fts_ai"));
    db.close();

    // Second open re-runs the migrator — must be a no-op, not a crash.
    const again = await openLogDb(path);
    seedInvocation(again, { id: "reopen" });
    assertEquals(
      (again.raw.prepare("SELECT COUNT(*) AS n FROM invocations").get() as { n: number }).n,
      1,
    );
    again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

Deno.test("logs-writer: sync mode writes straight through; FTS triggers index rows", async () => {
  await withTempDb((db) => {
    const writer = createLogWriter({ db, flushIntervalMs: 0 });
    const inv = uuidv7();
    writer.recordInvocation({
      id: inv,
      tsMs: Date.now(),
      functionName: "hello",
      method: "POST",
      path: "/functions/v1/hello",
      status: 200,
      durationMs: 5,
      backend: "deno",
    });
    writer.recordLog({
      invocationId: inv,
      tsMs: Date.now(),
      level: "log",
      functionName: "hello",
      source: "function",
      message: "payment captured for order 42",
    });
    writer.stop();

    const q = createLogQuery(db);
    const page = q.queryInvocations({ q: "payment" });
    assertEquals(page.items.length, 1);
    assertEquals(page.items[0].id, inv);
    assertEquals(page.items[0].logCount, 1);
  });
});

Deno.test("logs-writer: threshold triggers flush; queue overflow drops oldest", async () => {
  await withTempDb((db) => {
    const writer = createLogWriter({
      db,
      flushIntervalMs: 60_000, // interval never fires during the test
      flushThreshold: 10,
      maxQueue: 5,
    });
    // 7 rows with threshold 10 + maxQueue 5 → 2 dropped, 5 retained.
    for (let i = 0; i < 7; i++) {
      writer.recordLog({
        tsMs: Date.now(),
        level: "log",
        source: "gateway",
        message: `line ${i}`,
      });
    }
    assertEquals(writer.stats.dropped, 2);
    writer.flushNow();
    const n = (db.raw.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n;
    assertEquals(n, 5);
    // Oldest lines were the ones dropped.
    const first = db.raw.prepare("SELECT message FROM logs ORDER BY id LIMIT 1").get() as {
      message: string;
    };
    assertEquals(first.message, "line 2");
    writer.stop();
  });
});

Deno.test("logs-writer: prune enforces retention age and row caps", async () => {
  await withTempDb((db) => {
    const now = Date.now();
    const old = now - 30 * 24 * 60 * 60 * 1000;
    seedInvocation(db, { id: "old", tsMs: old });
    seedInvocation(db, { id: "new", tsMs: now });
    for (let i = 0; i < 10; i++) seedLog(db, "new", `recent ${i}`);
    db.raw.prepare(
      `INSERT INTO logs (invocation_id, ts_ms, level, function_name, source, message)
       VALUES ('old', ?, 'log', 'hello', 'function', 'ancient line')`,
    ).run(old);

    const writer = createLogWriter({
      db,
      flushIntervalMs: 0,
      retentionDays: 7,
      maxLogRows: 4,
      pruneIntervalMs: 0,
    });
    writer.prune();
    writer.stop();

    const invIds = (db.raw.prepare("SELECT id FROM invocations").all() as Array<{ id: string }>)
      .map((r) => r.id);
    assertEquals(invIds, ["new"]);
    const logCount = (db.raw.prepare("SELECT COUNT(*) AS n FROM logs").get() as { n: number }).n;
    assertEquals(logCount, 4);
    // FTS index follows deletes via triggers — searching pruned text finds nothing.
    const q = createLogQuery(db);
    assertEquals(q.searchLogs({ q: "ancient" }).items.length, 0);
    assertEquals(q.searchLogs({ q: "recent" }).items.length, 4);
  });
});

// ---------------------------------------------------------------------------
// FTS sanitization
// ---------------------------------------------------------------------------

Deno.test("logs-fts: buildFtsMatch quotes terms and neutralizes operators", () => {
  assertEquals(buildFtsMatch("hello world"), '"hello" "world"');
  assertEquals(buildFtsMatch("  spaced   out  "), '"spaced" "out"');
  assertEquals(buildFtsMatch("pre*"), '"pre"*');
  // Operators / grammar metacharacters end up inside quotes.
  assertEquals(buildFtsMatch("a OR b"), '"a" "OR" "b"');
  assertEquals(buildFtsMatch('say "hi"'), '"say" """hi"""');
  assertEquals(buildFtsMatch("NEAR(a,2)"), '"NEAR(a,2)"');
  assertEquals(buildFtsMatch("   "), null);
  assertEquals(buildFtsMatch('"'), null);
});

Deno.test("logs-fts: hostile search input never throws and matches literally", async () => {
  await withTempDb((db) => {
    const inv = seedInvocation(db);
    seedLog(db, inv, 'user said "DROP TABLE" loudly');
    const q = createLogQuery(db);
    // None of these may throw a SQL/FTS syntax error.
    for (const evil of ['" OR 1=1 --', "NOT (", "a AND", "col:val", "*", '"" ""']) {
      q.searchLogs({ q: evil });
      q.queryInvocations({ q: evil });
    }
    const hits = q.searchLogs({ q: "DROP TABLE" });
    assertEquals(hits.items.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Query layer
// ---------------------------------------------------------------------------

Deno.test("logs-query: filters + keyset pagination", async () => {
  await withTempDb((db) => {
    const base = Date.now();
    for (let i = 0; i < 30; i++) {
      seedInvocation(db, {
        id: `inv-${String(i).padStart(2, "0")}`,
        tsMs: base + i * 1000,
        fn: i % 2 === 0 ? "alpha" : "beta",
        status: i % 5 === 0 ? 500 : 200,
        errorKind: i % 5 === 0 ? "unhandled" : null,
      });
    }
    const q = createLogQuery(db);

    // Newest first.
    const page1 = q.queryInvocations({ limit: 10 });
    assertEquals(page1.items.length, 10);
    assertEquals(page1.items[0].id, "inv-29");
    assert(page1.nextCursor !== null);

    // Cursor never repeats and never skips.
    const page2 = q.queryInvocations({ limit: 10, cursor: page1.nextCursor! });
    assertEquals(page2.items[0].id, "inv-19");
    const ids = new Set([...page1.items, ...page2.items].map((i) => i.id));
    assertEquals(ids.size, 20);

    // Function + status-class filters.
    const alphas = q.queryInvocations({ functionName: "alpha", limit: 200 });
    assertEquals(alphas.items.length, 15);
    const errors = q.queryInvocations({ statusClass: 5, limit: 200 });
    assertEquals(errors.items.length, 6);
    const kind = q.queryInvocations({ errorKind: "unhandled", limit: 200 });
    assertEquals(kind.items.length, 6);
    const windowed = q.queryInvocations({
      fromMs: base + 25_000,
      toMs: base + 29_000,
      limit: 200,
    });
    assertEquals(windowed.items.length, 5);

    assertEquals(q.functionNames(), ["alpha", "beta"]);
  });
});

Deno.test("logs-query: getInvocation returns row + its console lines; tail is ascending", async () => {
  await withTempDb((db) => {
    const inv = seedInvocation(db, { id: "wanted" });
    seedLog(db, inv, "first line");
    seedLog(db, inv, "second line", "warn");
    seedLog(db, null, "unrelated boot line");

    const q = createLogQuery(db);
    const detail = q.getInvocation("wanted");
    assert(detail);
    assertEquals(detail.invocation.logCount, 2);
    assertEquals(detail.logs.map((l) => l.message), ["first line", "second line"]);
    assertEquals(detail.logs[1].level, "warn");
    assertEquals(q.getInvocation("missing"), null);

    const tail = q.logsSince(0);
    assertEquals(tail.length, 3);
    const more = q.logsSince(tail[1].id);
    assertEquals(more.map((l) => l.message), ["unrelated boot line"]);
  });
});

// ---------------------------------------------------------------------------
// loggingMiddleware → invocation rows
// ---------------------------------------------------------------------------

async function freshLogging(): Promise<typeof import("../src/gateway/logging.ts")> {
  return await import(`../src/gateway/logging.ts?test=${crypto.randomUUID()}`);
}

Deno.test("logging: middleware persists an invocation row and echoes the id header", async () => {
  const mod = await freshLogging();
  const rows: import("../src/logs/writer.ts").InvocationRow[] = [];
  mod.configureInvocationLogging({ sink: (r) => rows.push(r), backend: "deno" });

  const app = new Hono();
  app.use("/functions/v1/*", mod.loggingMiddleware);
  app.all("/functions/v1/:name{.+}", (c) => c.json({ ok: true }));

  _configureLogBufferForTests({ syncMode: true });
  try {
    const res = await app.fetch(
      new Request("http://localhost/functions/v1/hello?token=SECRET-QS", {
        method: "POST",
      }),
    );
    assertEquals(res.status, 200);
    const id = res.headers.get("x-1tube-invocation-id");
    assert(id, "invocation id header must be set");

    assertEquals(rows.length, 1);
    assertEquals(rows[0].id, id);
    assertEquals(rows[0].functionName, "hello");
    assertEquals(rows[0].method, "POST");
    assertEquals(rows[0].status, 200);
    assertEquals(rows[0].backend, "deno");
    assertEquals(rows[0].errorKind ?? null, null);
    // Query strings (token=…) must never be persisted.
    assertFalse(rows[0].path.includes("SECRET-QS"));
    assertEquals(rows[0].path, "/functions/v1/hello");
  } finally {
    _resetLogBufferForTests();
  }
});

Deno.test("logging: setInvocationError classification lands on the persisted row", async () => {
  const mod = await freshLogging();
  const rows: import("../src/logs/writer.ts").InvocationRow[] = [];
  mod.configureInvocationLogging({ sink: (r) => rows.push(r), backend: "workerd" });

  const app = new Hono();
  app.use("/functions/v1/*", mod.loggingMiddleware);
  app.all("/functions/v1/:name{.+}", (c) => {
    mod.setInvocationError(c, {
      kind: "timeout",
      message: "Function execution timed out after 150ms",
    });
    return c.json({ error: "Function execution timed out" }, 504);
  });

  _configureLogBufferForTests({ syncMode: true });
  try {
    const res = await app.fetch(
      new Request("http://localhost/functions/v1/slow", { method: "POST" }),
    );
    assertEquals(res.status, 504);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].status, 504);
    assertEquals(rows[0].errorKind, "timeout");
    assertEquals(rows[0].errorMessage, "Function execution timed out after 150ms");
    assertEquals(rows[0].backend, "workerd");
  } finally {
    _resetLogBufferForTests();
  }
});

// ---------------------------------------------------------------------------
// Workerd console marker
// ---------------------------------------------------------------------------

Deno.test("console-marker: round-trips a marked line; ignores ordinary output", () => {
  const payload = { id: "inv-1", level: "warn", msg: "rate limit\nnear", ts: 1234 };
  const line = WORKERD_LOG_MARKER + JSON.stringify(payload);
  const parsed = parseMarkedConsoleLine(line);
  assert(parsed);
  assertEquals(parsed.id, "inv-1");
  assertEquals(parsed.level, "warn");
  assertEquals(parsed.msg, "rate limit\nnear");
  assertEquals(parsed.ts, 1234);

  // Tolerates a prefix before the marker (workerd line decoration).
  const decorated = parseMarkedConsoleLine("some-prefix " + line);
  assert(decorated);
  assertEquals(decorated.msg, "rate limit\nnear");

  assertEquals(parseMarkedConsoleLine("[workerd] plain output"), null);
  assertEquals(parseMarkedConsoleLine(WORKERD_LOG_MARKER + "{not json"), null);
  // Unknown levels degrade to "log" instead of being dropped.
  const odd = parseMarkedConsoleLine(
    WORKERD_LOG_MARKER + JSON.stringify({ id: null, level: "silly", msg: "x", ts: 1 }),
  );
  assert(odd);
  assertEquals(odd.level, "log");
});

// ---------------------------------------------------------------------------
// Deno worker console capture (real Workers, concurrent attribution)
// ---------------------------------------------------------------------------

Deno.test("worker-console: lines attribute to the correct invocation under concurrency", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-worker-console-" });
  try {
    await Deno.mkdir(join(tmp, "echo"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "echo", "index.ts"),
      `
console.log("boot line");
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(async (req: Request) => {
  const tag = new URL(req.url).searchParams.get("tag");
  console.log("start", tag);
  await new Promise((r) => setTimeout(r, 30));
  console.warn("end", tag);
  return new Response(tag);
}, { public: true });
`,
    );

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const events: WorkerConsoleEvent[] = [];
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
      captureConsole: true,
      onConsole: (e) => events.push(e),
    });
    const { errors } = await host.start();
    try {
      assertEquals(errors, []);
      const handle = registry.workerHandle("echo")!;

      // Two interleaved dispatches with distinct invocation ids.
      const mk = (tag: string, inv: string) =>
        handle.dispatch(
          new Request(`http://localhost/?tag=${tag}`),
          null,
          new AbortController().signal,
          inv,
        );
      const [r1, r2] = await Promise.all([mk("one", "inv-one"), mk("two", "inv-two")]);
      assertEquals(await r1.text(), "one");
      assertEquals(await r2.text(), "two");

      // Give the postMessage channel a beat to drain.
      await new Promise((r) => setTimeout(r, 100));

      const bootLines = events.filter((e) => e.message.includes("boot line"));
      assertEquals(bootLines.length, 1);
      assertEquals(bootLines[0].invocationId, null);
      assertEquals(bootLines[0].functionName, "echo");

      for (const [tag, inv] of [["one", "inv-one"], ["two", "inv-two"]] as const) {
        const start = events.find((e) => e.message === `start ${tag}`);
        const end = events.find((e) => e.message === `end ${tag}`);
        assert(start, `missing start line for ${tag}`);
        assert(end, `missing end line for ${tag}`);
        // The interesting assertion: attribution survives the await
        // inside the handler even with both requests in flight.
        assertEquals(start.invocationId, inv);
        assertEquals(end.invocationId, inv);
        assertEquals(end.level, "warn");
      }
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
