/**
 * Hot reloader for the Deno backend: debouncer + dep-graph affected-set.
 *
 * Tests use:
 *   - a fake `setTimer`/`clearTimer` for deterministic time control
 *   - a fake `FsEventStream` async iterator for fs events
 *   - a fake `DenoWorkerHost` that records reload calls instead of
 *     spinning real Workers
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { pathToFileURL } from "node:url";
import {
  createDepGraph,
  type DepGraph,
} from "../src/backends/deno/dep-graph.ts";
import {
  computeAffected,
  createDenoHotReloader,
  createDenoReloadDebouncer,
  type FsEventStream,
} from "../src/backends/deno/hot-reloader.ts";
import type {
  DenoWorkerHost,
  ReloadSummary,
} from "../src/backends/deno/worker-host.ts";

class FakeClock {
  private timers = new Map<number, () => void>();
  private next = 1;
  setTimer = (cb: () => void, _ms: number): number => {
    const id = this.next++;
    this.timers.set(id, cb);
    return id;
  };
  clearTimer = (id: number): void => {
    this.timers.delete(id);
  };
  fireAll(): void {
    const cbs = [...this.timers.values()];
    this.timers.clear();
    for (const cb of cbs) cb();
  }
}

Deno.test("debouncer: coalesces rapid pushes into a single flush", () => {
  const clock = new FakeClock();
  const calls: string[][] = [];
  const d = createDenoReloadDebouncer({
    debounceMs: 100,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    flushFn: async (paths) => {
      calls.push([...paths].sort());
    },
  });
  d.push(["/a.ts"]);
  d.push(["/b.ts"]);
  d.push(["/a.ts"]); // dedup
  clock.fireAll();
  assertEquals(calls.length, 1);
  assertEquals(calls[0], ["/a.ts", "/b.ts"]);
});

Deno.test("debouncer: drain returns pending without flushing", () => {
  const clock = new FakeClock();
  const calls: string[][] = [];
  const d = createDenoReloadDebouncer({
    debounceMs: 100,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    flushFn: async (paths) => {
      calls.push([...paths]);
    },
  });
  d.push(["/x.ts", "/y.ts"]);
  const drained = d.drain();
  assertEquals(drained.sort(), ["/x.ts", "/y.ts"]);
  clock.fireAll();
  assertEquals(calls.length, 0);
});

Deno.test("computeAffected: includes graph owners and new function dirs", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-affected-" });
  try {
    await Deno.mkdir(join(tmp, "_shared"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "_shared", "x.ts"),
      `export const x = 1;\n`,
    );
    await Deno.mkdir(join(tmp, "alpha"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "alpha", "index.ts"),
      `import { x } from "../_shared/x.ts"; export default x;\n`,
    );
    const graph = createDepGraph();
    await graph.refresh(
      "alpha",
      pathToFileURL(join(tmp, "alpha", "index.ts")).href,
    );

    // Existing function affected via dep-graph.
    let affected = computeAffected([join(tmp, "_shared", "x.ts")], graph);
    assertEquals([...affected].sort(), ["alpha"]);

    // New function dir not yet in graph: heuristic catches the entry path.
    affected = computeAffected([join(tmp, "beta", "index.ts")], graph);
    assertEquals([...affected].sort(), ["beta"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

interface FakeStream extends FsEventStream {
  emit(paths: string[]): void;
  close(): void;
}

function makeFakeStream(): FakeStream {
  const queue: Array<{ paths: string[] }> = [];
  let resolveNext: ((v: IteratorResult<{ paths: string[] }>) => void) | null =
    null;
  let closed = false;

  const iter: AsyncIterator<{ paths: string[] }> = {
    next() {
      if (closed) return Promise.resolve({ value: undefined, done: true });
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    return() {
      closed = true;
      resolveNext?.({ value: undefined, done: true });
      resolveNext = null;
      return Promise.resolve({ value: undefined, done: true });
    },
  };

  return {
    [Symbol.asyncIterator]() {
      return iter;
    },
    emit(paths) {
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

function fakeHost(graph: DepGraph): {
  host: DenoWorkerHost;
  reloads: Array<ReadonlySet<string> | "all">;
} {
  const reloads: Array<ReadonlySet<string> | "all"> = [];
  const host: DenoWorkerHost = {
    start() {
      return Promise.resolve({ loaded: [], errors: [] });
    },
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
    stop() {
      return Promise.resolve();
    },
    list() {
      return [];
    },
    depGraph: graph,
  };
  return { host, reloads };
}

Deno.test("hot-reloader: fs events trigger a precise reload via the dep-graph", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-hot-reloader-" });
  try {
    await Deno.mkdir(join(tmp, "_shared"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "_shared", "x.ts"),
      `export const x = 1;\n`,
    );
    await Deno.mkdir(join(tmp, "alpha"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "alpha", "index.ts"),
      `import { x } from "../_shared/x.ts"; export default x;\n`,
    );
    await Deno.mkdir(join(tmp, "beta"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "beta", "index.ts"),
      `export default 1;\n`,
    );

    const graph = createDepGraph();
    await graph.refresh(
      "alpha",
      pathToFileURL(join(tmp, "alpha", "index.ts")).href,
    );
    await graph.refresh(
      "beta",
      pathToFileURL(join(tmp, "beta", "index.ts")).href,
    );

    const { host, reloads } = fakeHost(graph);
    const stream = makeFakeStream();
    const clock = new FakeClock();

    const reloader = createDenoHotReloader({
      host,
      functionsDir: tmp,
      debounceMs: 10,
      watch: () => stream,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });
    await reloader.start();
    try {
      stream.emit([join(tmp, "_shared", "x.ts")]);
      // Allow the consume loop to deliver into the debouncer.
      await new Promise((r) => setTimeout(r, 0));
      clock.fireAll();
      // Let the flushFn promise resolve.
      await new Promise((r) => setTimeout(r, 10));

      assertEquals(reloads.length, 1);
      const set = reloads[0] as ReadonlySet<string>;
      assert(set instanceof Set);
      assertEquals([...set].sort(), ["alpha"]);
    } finally {
      await reloader.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("hot-reloader: relative functionsDir misses absolute directory event for a new function", async () => {
  const tmp = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "1tube-hot-relative-",
  });
  const rel = `./${tmp.split(/[\\/]/).pop()}`;
  try {
    await Deno.mkdir(join(tmp, "brand-new"), { recursive: true });
    await Deno.writeTextFile(
      join(tmp, "brand-new", "index.ts"),
      `export default 1;\n`,
    );

    const graph = createDepGraph();
    const { host, reloads } = fakeHost(graph);
    const stream = makeFakeStream();
    const clock = new FakeClock();

    const reloader = createDenoHotReloader({
      host,
      functionsDir: rel,
      debounceMs: 10,
      watch: () => stream,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: () => {},
    });
    await reloader.start();
    try {
      // Deno.watchFs emits absolute paths even when watched with a relative
      // path. Linux can report only this directory path for a brand-new
      // function directory, so the reloader must normalize before matching.
      stream.emit([join(tmp, "brand-new")]);
      await new Promise((r) => setTimeout(r, 0));
      clock.fireAll();
      await new Promise((r) => setTimeout(r, 10));

      assertEquals(reloads.length, 1);
      const set = reloads[0] as ReadonlySet<string>;
      assert(set instanceof Set);
      assertEquals([...set].sort(), ["brand-new"]);
    } finally {
      await reloader.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
