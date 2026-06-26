/**
 * Tests for the smart-HMR fast path:
 *   - leading-edge debounce (first save flushes after leadingMs, not the
 *     full trailing window)
 *   - content-hash no-op detection (identical re-saves don't respawn)
 *   - MRU-first reload ordering (recently dispatched functions respawn
 *     before idle ones)
 *   - prioritize() works for pending HMR respawns, not just deferred boot
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { pathToFileURL } from "node:url";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createDenoWorkerHost } from "../src/backends/deno/worker-host.ts";
import {
  createDenoHotReloader,
  createDenoReloadDebouncer,
  type FsEventStream,
} from "../src/backends/deno/hot-reloader.ts";
import { createDepGraph } from "../src/backends/deno/dep-graph.ts";
import type {
  DenoWorkerHost,
  ReloadSummary,
} from "../src/backends/deno/worker-host.ts";

// Re-run the suite against the colocated host with `1TUBE_FORCE_COLOCATE=1`.
// The debounce + content-hash + fake-host cases are mode-agnostic and must
// pass under both. The MRU-ordering / prioritize-mid-reload cases assert a
// per-function respawn *queue* (`bootState(...) === "queued"`); colocated
// re-imports the touched set serially in a single isolate with no such queue,
// so those two are skipped (not deleted) under the flag.
const FORCE_COLO = Deno.env.get("1TUBE_FORCE_COLOCATE") === "1";

// ---------------------------------------------------------------------
// Leading-edge debounce
// ---------------------------------------------------------------------

Deno.test("debouncer: leading mode arms once with leadingMs and doesn't push the flush out", async () => {
  const armed: number[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const setTimer = (cb: () => void, ms: number): number => {
    armed.push(ms);
    const id = nextId++;
    timers.set(id, cb);
    return id;
  };
  const clearTimer = (id: number) => {
    timers.delete(id);
  };
  const flushes: string[][] = [];
  const d = createDenoReloadDebouncer({
    debounceMs: 200,
    leadingMs: 40,
    setTimer,
    clearTimer,
    flushFn: (paths) => {
      flushes.push([...paths].sort());
    },
  });

  d.push(["/a.ts"]);
  d.push(["/b.ts"]); // same burst — must NOT re-arm or extend
  assertEquals(armed, [40], "exactly one timer, armed with leadingMs");

  // Fire the leading flush and let the async flushFn settle.
  const cbs = [...timers.values()];
  timers.clear();
  for (const cb of cbs) cb();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(flushes, [["/a.ts", "/b.ts"]]);

  // A fresh burst after idle arms with leadingMs again.
  d.push(["/c.ts"]);
  assertEquals(armed, [40, 40]);
});

Deno.test("debouncer: leading mode re-arms stragglers with the trailing debounce", async () => {
  const armed: number[] = [];
  const timers = new Map<number, () => void>();
  let nextId = 1;
  const setTimer = (cb: () => void, ms: number): number => {
    armed.push(ms);
    const id = nextId++;
    timers.set(id, cb);
    return id;
  };
  const clearTimer = (id: number) => {
    timers.delete(id);
  };
  const flushes: string[][] = [];
  let blockFlush: (() => void) | null = null;
  const d = createDenoReloadDebouncer({
    debounceMs: 200,
    leadingMs: 40,
    setTimer,
    clearTimer,
    flushFn: (paths) => {
      flushes.push([...paths].sort());
      return new Promise<void>((r) => {
        blockFlush = r;
      });
    },
  });

  d.push(["/a.ts"]);
  // Fire the leading timer — flush starts and blocks.
  const fire = () => {
    const cbs = [...timers.values()];
    timers.clear();
    for (const cb of cbs) cb();
  };
  fire();
  assertEquals(flushes.length, 1);

  // A straggler lands mid-flush: no timer may be armed while flushing.
  d.push(["/late.ts"]);
  assertEquals(armed, [40], "no timer while a flush is in progress");

  // Unblock; the finally must re-arm with the TRAILING window.
  blockFlush!();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(armed, [40, 200]);
  fire();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(flushes.length, 2);
  assertEquals(flushes[1], ["/late.ts"]);
  blockFlush!();
});

// ---------------------------------------------------------------------
// Content-hash no-op detection
// ---------------------------------------------------------------------

function makeFakeStream(): FsEventStream & { emit(paths: string[]): void } {
  const queue: Array<{ paths: string[] }> = [];
  let resolveNext:
    | ((r: IteratorResult<{ paths: string[] }>) => void)
    | null = null;
  let closed = false;
  const iter = {
    next(): Promise<IteratorResult<{ paths: string[] }>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined, done: true });
      }
      return new Promise((r) => {
        resolveNext = r;
      });
    },
  };
  return {
    [Symbol.asyncIterator]() {
      return iter;
    },
    emit(paths: string[]) {
      const event = { paths };
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    close() {
      closed = true;
      resolveNext?.({ value: undefined, done: true });
      resolveNext = null;
    },
  };
}

function fakeHost(): {
  host: DenoWorkerHost;
  reloads: Array<ReadonlySet<string> | "all">;
} {
  const reloads: Array<ReadonlySet<string> | "all"> = [];
  const host: DenoWorkerHost = {
    start: () => Promise.resolve({ loaded: [], errors: [] }),
    startDeferred: () =>
      Promise.resolve({
        discovered: [],
        done: Promise.resolve({ loaded: [], errors: [] }),
      }),
    bootState: () => undefined,
    bootStatus: () => ({
      total: 0,
      ready: [],
      loading: [],
      queued: [],
      failed: [],
    }),
    prioritize: () => {},
    whenReady: () => Promise.resolve("unknown" as const),
    reload(names) {
      reloads.push(names);
      const summary: ReloadSummary = {
        reason: "test",
        reloaded: names === "all" ? [] : [...names].sort(),
        added: [],
        removed: [],
        errors: [],
        durationMs: 0,
      };
      return Promise.resolve(summary);
    },
    stop: () => Promise.resolve(),
    list: () => [],
    depGraph: createDepGraph(),
  };
  return { host, reloads };
}

Deno.test("hot-reloader: identical re-save is a no-op, real change reloads", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-noop-save-" });
  try {
    const idx = join(tmp, "alpha", "index.ts");
    await Deno.mkdir(join(tmp, "alpha"), { recursive: true });
    await Deno.writeTextFile(idx, `export default 1;\n`);
    await fakeHost().host.depGraph.refresh("alpha", pathToFileURL(idx).href);

    const { host, reloads } = fakeHost();
    await host.depGraph.refresh("alpha", pathToFileURL(idx).href);
    const stream = makeFakeStream();
    const reloader = createDenoHotReloader({
      host,
      functionsDir: tmp,
      debounceMs: 5,
      leadingMs: 5,
      watch: () => stream,
      log: () => {},
    });
    await reloader.start();
    try {
      const flushSettle = () => new Promise((r) => setTimeout(r, 100));

      // First sighting: no baseline digest → reload happens.
      stream.emit([idx]);
      await flushSettle();
      assertEquals(reloads.length, 1);

      // Identical re-save (same bytes): must be dropped before reload.
      stream.emit([idx]);
      await flushSettle();
      assertEquals(reloads.length, 1, "no-op save must not respawn");

      // Real edit: reloads again.
      await Deno.writeTextFile(idx, `export default 2;\n`);
      stream.emit([idx]);
      await flushSettle();
      assertEquals(reloads.length, 2);
    } finally {
      await reloader.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

// ---------------------------------------------------------------------
// MRU ordering + prioritize() during reload
// ---------------------------------------------------------------------

async function writeSlowFn(
  dir: string,
  name: string,
  body: string,
  delayMs: number,
): Promise<void> {
  const fnDir = join(dir, name);
  await Deno.mkdir(fnDir, { recursive: true });
  const delay = delayMs > 0
    ? `await new Promise((r) => setTimeout(r, ${delayMs}));\n`
    : "";
  await Deno.writeTextFile(
    join(fnDir, "index.ts"),
    `${delay}const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(() => new Response(${JSON.stringify(body)}), { public: true });
`,
  );
}

async function pollUntil(
  cond: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("pollUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test({
  name: "reload: most-recently-dispatched function respawns first",
  // MRU respawn ordering is an isolate-per-function lane concept (the test
  // polls for a "queued" boot state). Colocated re-imports the touched set
  // serially in one isolate; there is no per-function respawn queue.
  ignore: FORCE_COLO,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "1tube-mru-" });
    try {
      // Alphabetical order would be aa, bb, zz. We dispatch to zz, so MRU
      // ordering must respawn zz FIRST despite sorting last by name.
      await writeSlowFn(tmp, "aa", "aa", 400);
      await writeSlowFn(tmp, "bb", "bb", 400);
      await writeSlowFn(tmp, "zz", "zz", 400);

      const registry = new FunctionRegistry();
      const supervisor = new FunctionSupervisor();
      const host = createDenoWorkerHost({
        functionsDir: tmp,
        registry,
        supervisor,
        concurrency: 1,
      });
      await host.start();
      try {
        // Make zz the most recently used function.
        const resp = await registry.workerHandle("zz")!.dispatch(
          new Request("http://localhost/"),
          null,
          new AbortController().signal,
        );
        assertEquals(await resp.text(), "zz");

        const reloadDone = host.reload(new Set(["aa", "bb", "zz"]), "test-mru");
        // Wait until the reload has re-queued the targets (bb can only be
        // "queued" once the reload enqueued it — boot left it "ready").
        await pollUntil(() => host.bootState("bb") === "queued");
        // With one lane, zz (MRU) is picked first; when it's ready, the
        // alphabetically-earlier functions must still be waiting.
        const outcome = await host.whenReady("zz", 30_000);
        assertEquals(outcome, "ready");
        assert(
          host.bootState("aa") !== "ready" || host.bootState("bb") !== "ready",
          "zz must not respawn last despite its name sorting last",
        );

        const summary = await reloadDone;
        assertEquals(summary.errors, []);
        assertEquals(summary.reloaded, ["aa", "bb", "zz"]);
      } finally {
        await host.stop();
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "reload: prioritize() pulls a queued respawn forward mid-reload",
  // prioritize() reorders a per-function respawn lane (polls for "queued").
  // Colocated has no such lane, so this case is isolate-per-function only.
  ignore: FORCE_COLO,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "1tube-prio-reload-" });
    try {
      await writeSlowFn(tmp, "aa", "aa", 600);
      await writeSlowFn(tmp, "bb", "bb", 600);
      await writeSlowFn(tmp, "mm", "mm", 0);

      const registry = new FunctionRegistry();
      const supervisor = new FunctionSupervisor();
      const host = createDenoWorkerHost({
        functionsDir: tmp,
        registry,
        supervisor,
        concurrency: 1,
      });
      await host.start();
      try {
        const reloadDone = host.reload(
          new Set(["aa", "bb", "mm"]),
          "test-prioritize",
        );
        // Wait for the reload to enqueue, then simulate "a request hit mm"
        // while the single lane is stuck on the slow aa.
        await pollUntil(() => host.bootState("mm") === "queued");
        host.prioritize("mm");
        const outcome = await host.whenReady("mm", 30_000);
        assertEquals(outcome, "ready");
        assert(
          host.bootState("bb") !== "ready",
          "bb (queued behind the slow lane) must still be pending when prioritized mm is ready",
        );

        const summary = await reloadDone;
        assertEquals(summary.errors, []);
        assertEquals(summary.reloaded, ["aa", "bb", "mm"]);
      } finally {
        await host.stop();
      }
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
