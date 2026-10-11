/**
 * Hot reloader for the Bun backend: debouncer + dep-graph affected-set.
 *
 * Tests use:
 *   - a fake `setTimer`/`clearTimer` for deterministic time control
 *   - a fake `FsEventStream` async iterator for fs events
 *   - a fake `FunctionHost` that records reload calls instead of building
 *     real module graphs
 */

import { afterEach, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, assertEquals } from "./_assert.ts";
import { createDepGraph, type DepGraph } from "../src/backends/bun/dep-graph.ts";
import {
  computeAffected,
  createHotReloader,
  createReloadDebouncer,
  type FsEventStream,
} from "../src/backends/bun/hot-reloader.ts";
import type { FunctionHost, ReloadSummary } from "../src/backends/bun/function-host.ts";
import type { SharedRuntime } from "../src/backends/bun/shared-runtime.ts";

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const dirs: string[] = [];
async function tempDir(prefix: string, parent = tmpdir()): Promise<string> {
  const dir = await realpath(await mkdtemp(join(parent, prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

class FakeClock {
  private timers = new Map<number, () => void>();
  private next = 1;
  get pending(): number {
    return this.timers.size;
  }
  setTimer = (cb: () => void, _ms: number): number => {
    const id = this.next++;
    this.timers.set(id, cb);
    return id;
  };
  clearTimer = (id: number): void => {
    this.timers.delete(id);
  };
  async fireAll(): Promise<void> {
    const cbs = [...this.timers.values()];
    this.timers.clear();
    for (const cb of cbs) await cb();
  }
}

async function waitForTimer(clock: FakeClock, label: string): Promise<void> {
  for (let i = 0; i < 40 && clock.pending === 0; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert(clock.pending > 0, `expected ${label} to arm a flush timer`);
}

test("debouncer: coalesces rapid pushes into a single flush", async () => {
  const clock = new FakeClock();
  const calls: string[][] = [];
  const d = createReloadDebouncer({
    debounceMs: 100,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    flushFn: (paths) => {
      calls.push([...paths].sort());
    },
  });
  d.push(["/a.ts"]);
  d.push(["/b.ts"]);
  d.push(["/a.ts"]); // dedup
  assertEquals(clock.pending, 1, "trailing mode keeps exactly one timer armed");
  await clock.fireAll();
  assertEquals(calls, [["/a.ts", "/b.ts"]]);
});

test("debouncer: drain returns pending without flushing; cancel disarms", async () => {
  const clock = new FakeClock();
  const calls: string[][] = [];
  const d = createReloadDebouncer({
    debounceMs: 100,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    flushFn: (paths) => {
      calls.push([...paths]);
    },
  });
  d.push(["/x.ts", "/y.ts"]);
  assertEquals(d.drain().sort(), ["/x.ts", "/y.ts"]);
  await clock.fireAll();
  assertEquals(calls.length, 0);

  d.push(["/z.ts"]);
  d.cancel();
  assertEquals(clock.pending, 0);
  assertEquals(d.isFlushing, false);
});

test("computeAffected: graph owners, entry/manifest heuristics, new function dirs", async () => {
  const tmp = await tempDir("1tube-affected-");
  await write(join(tmp, "_shared", "x.ts"), `export const x = 1;\n`);
  await write(
    join(tmp, "alpha", "index.ts"),
    `import { x } from "../_shared/x.ts"; export default x;\n`,
  );
  const graph = createDepGraph();
  await graph.refresh("alpha", pathToFileURL(join(tmp, "alpha", "index.ts")).href);

  // Existing function affected via dep-graph.
  assertEquals([...computeAffected([join(tmp, "_shared", "x.ts")], graph)], ["alpha"]);
  // New function not yet in the graph: the entry-path heuristic catches it.
  assertEquals([...computeAffected([join(tmp, "beta", "index.ts")], graph)], ["beta"]);
  // A manifest edit reloads its function.
  assertEquals([...computeAffected([join(tmp, "gamma", "1tube.json")], graph)], ["gamma"]);
  // `_shared` itself is never a function.
  assertEquals([...computeAffected([join(tmp, "_shared", "index.ts")], graph)], []);
  // Bare directory events count only when asked to.
  assertEquals(
    [...computeAffected([join(tmp, "delta")], graph, { functionsDir: tmp })],
    ["delta"],
  );
  assertEquals(
    [
      ...computeAffected([join(tmp, "delta")], graph, {
        functionsDir: tmp,
        includeDirectoryEvents: false,
      }),
    ],
    [],
  );
});

interface FakeStream extends FsEventStream {
  emit(paths: string[]): void;
  readonly closed: boolean;
}

function makeFakeStream(): FakeStream {
  const queue: Array<{ paths: string[] }> = [];
  let resolveNext: ((v: IteratorResult<{ paths: string[] }>) => void) | null = null;
  let closed = false;

  const iter: AsyncIterator<{ paths: string[] }> = {
    next() {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false });
      if (closed) return Promise.resolve({ value: undefined, done: true });
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
    get closed() {
      return closed;
    },
  };
}

function fakeHost(graph: DepGraph, loaded: string[] = []): {
  host: FunctionHost;
  reloads: Array<ReadonlySet<string> | "all">;
  order: string[];
} {
  const reloads: Array<ReadonlySet<string> | "all"> = [];
  const order: string[] = [];
  const host: FunctionHost = {
    start: () => Promise.resolve({ loaded: [], errors: [] }),
    startDeferred: () =>
      Promise.resolve({ discovered: [], done: Promise.resolve({ loaded: [], errors: [] }) }),
    bootState: () => undefined,
    bootStatus: () => ({ total: 0, ready: [], loading: [], queued: [], failed: [] }),
    prioritize() {},
    whenReady: () => Promise.resolve("unknown" as const),
    reload(names) {
      reloads.push(names);
      order.push("host.reload");
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
    list: () => [...loaded].sort(),
    depGraph: graph,
  };
  return { host, reloads, order };
}

async function threeFunctionProject(): Promise<{ tmp: string; graph: DepGraph }> {
  const tmp = await tempDir("1tube-hot-reloader-");
  await write(join(tmp, "_shared", "x.ts"), `export const x = 1;\n`);
  await write(join(tmp, "alpha", "index.ts"), `import { x } from "../_shared/x.ts"; export default x;\n`);
  await write(join(tmp, "beta", "index.ts"), `export default 1;\n`);
  const graph = createDepGraph();
  await graph.refresh("alpha", join(tmp, "alpha", "index.ts"));
  await graph.refresh("beta", join(tmp, "beta", "index.ts"));
  return { tmp, graph };
}

test("hot-reloader: fs events trigger a precise reload via the dep-graph", async () => {
  const { tmp, graph } = await threeFunctionProject();
  const { host, reloads } = fakeHost(graph, ["alpha", "beta"]);
  const stream = makeFakeStream();
  const clock = new FakeClock();
  const summaries: ReloadSummary[] = [];
  const reloader = createHotReloader({
    host,
    functionsDir: tmp,
    debounceMs: 10,
    watch: () => stream,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
    onReloaded: (s) => summaries.push(s),
  });
  await reloader.start();
  try {
    stream.emit([join(tmp, "_shared", "x.ts")]);
    await waitForTimer(clock, "dep-graph reload");
    await clock.fireAll();

    assertEquals(reloads.length, 1);
    const set = reloads[0] as ReadonlySet<string>;
    assert(set instanceof Set);
    assertEquals([...set], ["alpha"]);
    assertEquals(summaries.length, 1);
  } finally {
    await reloader.stop();
  }
  assert(stream.closed, "stop() closes the watcher");
});

test("hot-reloader: files outside every graph are ignored", async () => {
  const { tmp, graph } = await threeFunctionProject();
  await write(join(tmp, "README.md"), "# notes\n");
  await write(join(tmp, "_shared", "untracked.ts"), "export const u = 1;\n");
  const { host, reloads } = fakeHost(graph, ["alpha", "beta"]);
  const stream = makeFakeStream();
  const clock = new FakeClock();
  const reloader = createHotReloader({
    host,
    functionsDir: tmp,
    watch: () => stream,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
  });
  await reloader.start();
  try {
    stream.emit([join(tmp, "README.md"), join(tmp, "_shared", "untracked.ts")]);
    await waitForTimer(clock, "noise flush");
    await clock.fireAll();
    assertEquals(reloads.length, 0);
  } finally {
    await reloader.stop();
  }
});

test("hot-reloader: directory events add new functions and remove deleted ones", async () => {
  const { tmp, graph } = await threeFunctionProject();
  await write(join(tmp, "brand-new", "index.ts"), `export default 1;\n`);
  // "gone" was loaded but its directory no longer exists.
  const { host, reloads } = fakeHost(graph, ["alpha", "beta", "gone"]);
  const stream = makeFakeStream();
  const clock = new FakeClock();
  const reloader = createHotReloader({
    host,
    functionsDir: tmp,
    watch: () => stream,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
  });
  await reloader.start();
  try {
    // A directory event for an already-loaded, still-present function is noise.
    stream.emit([join(tmp, "brand-new"), join(tmp, "gone"), join(tmp, "beta")]);
    await waitForTimer(clock, "directory-event reload");
    await clock.fireAll();
    assertEquals(reloads.length, 1);
    assertEquals([...(reloads[0] as Set<string>)].sort(), ["brand-new", "gone"]);
  } finally {
    await reloader.stop();
  }
});

test("hot-reloader: relative functionsDir still matches absolute watcher paths", async () => {
  const tmp = await tempDir("1tube-hot-relative-", process.cwd());
  const rel = `./${relative(process.cwd(), tmp)}`;
  await write(join(tmp, "brand-new", "index.ts"), `export default 1;\n`);

  const { host, reloads } = fakeHost(createDepGraph());
  const stream = makeFakeStream();
  const clock = new FakeClock();
  let watched = "";
  const reloader = createHotReloader({
    host,
    functionsDir: rel,
    debounceMs: 10,
    watch: (dir) => {
      watched = dir;
      return stream;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => {},
  });
  await reloader.start();
  try {
    assertEquals(watched, tmp, "the watcher gets the resolved directory");
    // The watcher reports absolute paths; Linux can report only the
    // directory for a brand-new function.
    stream.emit([join(tmp, "brand-new")]);
    await waitForTimer(clock, "directory-event reload");
    await clock.fireAll();
    assertEquals(reloads.length, 1);
    assertEquals([...(reloads[0] as Set<string>)], ["brand-new"]);
  } finally {
    await reloader.stop();
  }
});

test("hot-reloader: a shared-module edit re-evaluates the shared runtime BEFORE reloading dependents", async () => {
  const { tmp, graph } = await threeFunctionProject();
  const sharedPath = join(tmp, "_shared", "x.ts");
  const { host, reloads, order } = fakeHost(graph, ["alpha", "beta"]);
  const shared = {
    sourcePaths: [sharedPath],
    reload() {
      order.push("shared.reload");
      return Promise.resolve([{ id: "x", sourcePath: sharedPath, exportNames: ["x"] }]);
    },
  } as unknown as SharedRuntime;
  const stream = makeFakeStream();
  const clock = new FakeClock();
  const lines: string[] = [];
  const reloader = createHotReloader({
    host,
    functionsDir: tmp,
    watch: () => stream,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (l) => lines.push(l),
    sharedRuntime: shared,
  });
  await reloader.start();
  try {
    stream.emit([sharedPath]);
    await waitForTimer(clock, "shared flush");
    await clock.fireAll();
    assertEquals(order, ["shared.reload", "host.reload"]);
    assertEquals([...(reloads[0] as Set<string>)], ["alpha"]);
    assert(lines.some((l) => l.includes("shared module(s) reloaded: x")));
  } finally {
    await reloader.stop();
  }
});

test("hot-reloader: a failing host reload is logged and the loop keeps going", async () => {
  const { tmp, graph } = await threeFunctionProject();
  const { host } = fakeHost(graph, ["alpha", "beta"]);
  let calls = 0;
  host.reload = () => {
    calls++;
    return Promise.reject(new Error("kaboom"));
  };
  const stream = makeFakeStream();
  const clock = new FakeClock();
  const lines: string[] = [];
  const reloader = createHotReloader({
    host,
    functionsDir: tmp,
    watch: () => stream,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: (l) => lines.push(l),
  });
  await reloader.start();
  try {
    stream.emit([join(tmp, "beta", "index.ts")]);
    await waitForTimer(clock, "first flush");
    await clock.fireAll();
    await write(join(tmp, "beta", "index.ts"), `export default 2;\n`);
    stream.emit([join(tmp, "beta", "index.ts")]);
    await waitForTimer(clock, "second flush");
    await clock.fireAll();
    assertEquals(calls, 2);
    assert(lines.some((l) => l.includes("HMR reload FAILED") && l.includes("kaboom")));
  } finally {
    await reloader.stop();
  }
});
