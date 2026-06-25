/**
 * Tests for the workerd hot reloader.
 *
 * Two layers, both exercised here without ever touching the real
 * `Deno.watchFs` or spawning a workerd process:
 *
 *   1. {@link createReloadDebouncer} — pure debounce + classify
 *      buffer. Tests drive a fake clock so flush timing is exact.
 *
 *   2. {@link createWorkerdHotReloader} — wires a watcher iterable
 *      to the debouncer + a backend stub. We construct an in-memory
 *      `FsEventStream` and a stub backend whose `reload()` we can
 *      assert on (call count, change set, error injection).
 *
 * The real-fs end-to-end save-edit-rerequest assertion lives in
 * `tests/workerd-e2e.test.ts` (M4 section) because it needs to spawn
 * a workerd binary; that's the one place the full pipeline is
 * exercised.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import {
  classifyChangedPath,
  createReloadDebouncer,
  createWorkerdHotReloader,
  type FsEventStream,
} from "../src/backends/workerd/hot-reloader.ts";
import type {
  WorkerdBackend,
  WorkerdReloadResult,
} from "../src/backends/workerd/backend.ts";
import type { FunctionManifest } from "../src/manifest.ts";
import { defaultManifest } from "../src/manifest.ts";

// ---------------------------------------------------------------------------
// classifyChangedPath
// ---------------------------------------------------------------------------

Deno.test("classifyChangedPath: returns the function dir name for a real edit", () => {
  const root = join("/abs", "playground");
  // Test against both forward + back slashes so the helper works on
  // Windows. Path.relative() on Windows will produce backslashes;
  // the regex split inside the helper handles both.
  assertEquals(
    classifyChangedPath(root, join(root, "hello", "index.ts")),
    "hello",
  );
  assertEquals(
    classifyChangedPath(root, join(root, "echo", "1tube.json")),
    "echo",
  );
});

Deno.test("classifyChangedPath: underscored / shared dirs map to null (full reload)", () => {
  const root = join("/abs", "playground");
  // Anything starting with `_` is treated as cross-cutting code.
  assertEquals(
    classifyChangedPath(root, join(root, "_shared", "handler.ts")),
    null,
  );
  assertEquals(
    classifyChangedPath(root, join(root, "_internal", "x.ts")),
    null,
  );
  // `*_shared` suffix also full-reload.
  assertEquals(
    classifyChangedPath(root, join(root, "auth_shared", "x.ts")),
    null,
  );
});

Deno.test("classifyChangedPath: outside-tree paths map to null", () => {
  const root = join("/abs", "playground");
  assertEquals(classifyChangedPath(root, join("/abs", "other", "x.ts")), null);
  // The dir itself isn't a change to a specific function.
  assertEquals(classifyChangedPath(root, root), null);
});

// ---------------------------------------------------------------------------
// createReloadDebouncer — fake-clock unit tests
// ---------------------------------------------------------------------------

/**
 * Tiny fake clock. Returns ids and lets the test trigger the
 * registered callback at will. The debouncer never schedules
 * anything other than a single-shot timer per active window, so we
 * can keep this trivial.
 */
function fakeClock() {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    set: (cb: () => void, _ms: number) => {
      const id = next++;
      timers.set(id, cb);
      return id;
    },
    clear: (id: number) => {
      timers.delete(id);
    },
    fire: (id: number) => {
      const cb = timers.get(id);
      if (!cb) throw new Error(`fakeClock: no timer ${id}`);
      timers.delete(id);
      cb();
    },
    fireAll: () => {
      // Snapshot first — flushFn can schedule a follow-up.
      const ids = [...timers.keys()];
      for (const id of ids) {
        const cb = timers.get(id);
        if (cb) {
          timers.delete(id);
          cb();
        }
      }
    },
    pending: () => timers.size,
  };
}

Deno.test("debouncer: coalesces multiple pushes into a single flush", async () => {
  const root = "/p";
  const calls: { sharedChange: boolean; functions: string[] }[] = [];
  const clock = fakeClock();
  const d = createReloadDebouncer({
    functionsDir: root,
    debounceMs: 200,
    setTimer: clock.set,
    clearTimer: clock.clear,
    flushFn: async (c) => {
      calls.push(c);
    },
  });

  // Three rapid saves to the same function should merge into one
  // flush carrying just that function name.
  d.push([join(root, "hello", "index.ts")]);
  d.push([join(root, "hello", "index.ts")]);
  d.push([join(root, "hello", "1tube.json")]);
  assertEquals(calls.length, 0, "should not have flushed yet");
  assertEquals(clock.pending(), 1, "exactly one timer should be active");

  clock.fireAll();
  await Promise.resolve(); // let the async flushFn settle
  assertEquals(calls, [{ sharedChange: false, functions: ["hello"] }]);
});

Deno.test("debouncer: distinct function dirs surface as a sorted list", async () => {
  const root = "/p";
  const calls: { sharedChange: boolean; functions: string[] }[] = [];
  const clock = fakeClock();
  const d = createReloadDebouncer({
    functionsDir: root,
    debounceMs: 200,
    setTimer: clock.set,
    clearTimer: clock.clear,
    flushFn: async (c) => {
      calls.push(c);
    },
  });

  d.push([
    join(root, "echo", "index.ts"),
    join(root, "boom", "index.ts"),
    join(root, "alpha", "1tube.json"),
  ]);
  clock.fireAll();
  await Promise.resolve();
  // Sorted so logs are deterministic.
  assertEquals(calls, [{
    sharedChange: false,
    functions: ["alpha", "boom", "echo"],
  }]);
});

Deno.test("debouncer: shared change promotes to full reload (sharedChange=true, functions=[])", async () => {
  const root = "/p";
  const calls: { sharedChange: boolean; functions: string[] }[] = [];
  const clock = fakeClock();
  const d = createReloadDebouncer({
    functionsDir: root,
    debounceMs: 200,
    setTimer: clock.set,
    clearTimer: clock.clear,
    flushFn: async (c) => {
      calls.push(c);
    },
  });

  // A change to _shared/handler.ts plus a per-function change must
  // collapse to "shared" — we can't tell which functions actually
  // depend on the shared file without a dep graph. Reload all.
  d.push([
    join(root, "hello", "index.ts"),
    join(root, "_shared", "handler.ts"),
  ]);
  clock.fireAll();
  await Promise.resolve();
  assertEquals(calls, [{ sharedChange: true, functions: [] }]);
});

Deno.test("debouncer: pushes during flush schedule a follow-up flush", async () => {
  const root = "/p";
  const calls: { sharedChange: boolean; functions: string[] }[] = [];
  const clock = fakeClock();
  // Hold the first flush until the test releases it; new pushes
  // arriving in this window should produce a SECOND flush after
  // the first resolves.
  let release: () => void = () => {};
  const inFlight = new Promise<void>((r) => {
    release = r;
  });

  const d = createReloadDebouncer({
    functionsDir: root,
    debounceMs: 200,
    setTimer: clock.set,
    clearTimer: clock.clear,
    flushFn: async (c) => {
      calls.push(c);
      if (calls.length === 1) await inFlight;
    },
  });

  d.push([join(root, "hello", "index.ts")]);
  clock.fireAll();
  // The flush is now suspended on `inFlight`. New event arrives.
  d.push([join(root, "echo", "index.ts")]);
  // No new timer should be set yet — push() sees flushing=true is
  // still false because we haven't checked? Actually push() doesn't
  // know about flushing; it always (re)schedules a timer. Verify
  // the second flush fires on a separate timer.
  assert(clock.pending() >= 1, "follow-up timer must be queued");

  // Release the suspended flush.
  release();
  await Promise.resolve();
  await Promise.resolve();
  // Now fire the next timer (the follow-up the inner finally{} set up).
  clock.fireAll();
  await Promise.resolve();
  await Promise.resolve();

  // Order matters: hello first, echo second. The second flush only
  // contains `echo` because `hello` was already drained.
  assertEquals(calls.length, 2);
  assertEquals(calls[0], { sharedChange: false, functions: ["hello"] });
  assertEquals(calls[1], { sharedChange: false, functions: ["echo"] });
});

Deno.test("debouncer: cancel() drops the pending flush", async () => {
  const root = "/p";
  const calls: unknown[] = [];
  const clock = fakeClock();
  const d = createReloadDebouncer({
    functionsDir: root,
    debounceMs: 200,
    setTimer: clock.set,
    clearTimer: clock.clear,
    flushFn: async (c) => {
      calls.push(c);
    },
  });

  d.push([join(root, "hello", "index.ts")]);
  d.cancel();
  // Cancelling clears the timer; firing all yields nothing.
  clock.fireAll();
  await Promise.resolve();
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// createWorkerdHotReloader — watcher loop integration
// ---------------------------------------------------------------------------

/**
 * A backend stub that records reload calls. We don't need a real
 * workerd or even a real backend interface implementation for these
 * tests — the reloader only ever calls `reload()` and reads
 * `manifests`.
 */
function stubBackend(opts?: {
  failNTimes?: number;
  manifests?: ReadonlyMap<string, FunctionManifest>;
}): WorkerdBackend & {
  readonly calls: ({ all: boolean; names: string[] })[];
} {
  const calls: ({ all: boolean; names: string[] })[] = [];
  let failsRemaining = opts?.failNTimes ?? 0;
  const manifests = opts?.manifests ?? new Map<string, FunctionManifest>();
  let gen = 0;
  const stub = {
    functionNames: [...manifests.keys()],
    workerdVersion: "stub",
    manifests,
    async start() {/* */},
    async stop() {/* */},
    async dispatch() {
      return new Response();
    },
    reload(
      changed?: ReadonlySet<string> | "all",
    ): Promise<WorkerdReloadResult> {
      const all = changed === "all" || changed === undefined;
      calls.push({
        all,
        names: all ? [] : [...(changed as ReadonlySet<string>)].sort(),
      });
      if (failsRemaining > 0) {
        failsRemaining--;
        return Promise.reject(new Error("synthetic bundle failure"));
      }
      gen++;
      return Promise.resolve({
        durationMs: 1,
        added: [],
        removed: [],
        rebundled: all
          ? [...manifests.keys()]
          : [...(changed as ReadonlySet<string>)],
        generation: gen,
      });
    },
    get calls() {
      return calls;
    },
  };
  return stub as unknown as WorkerdBackend & {
    readonly calls: ({ all: boolean; names: string[] })[];
  };
}

/**
 * In-memory FsEventStream that emits events from a queue and yields
 * to the caller via `await reader`. `close()` ends the iteration.
 */
function fakeStream(): FsEventStream & {
  emit(paths: string[]): void;
  close(): void;
} {
  const queue: { paths: readonly string[] }[] = [];
  const waiters: ((v: IteratorResult<{ paths: readonly string[] }>) => void)[] =
    [];
  let closed = false;

  return {
    emit(paths: string[]) {
      const event = { paths };
      const w = waiters.shift();
      if (w) w({ value: event, done: false });
      else queue.push(event);
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        const w = waiters.shift()!;
        w({ value: undefined as never, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<{ paths: readonly string[] }>> => {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined as never, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

Deno.test("hot reloader: routes a single fs event to backend.reload", async () => {
  const root = "/p";
  const stream = fakeStream();
  const backend = stubBackend({
    manifests: new Map([["hello", defaultManifest()]]),
  });
  const clock = fakeClock();

  const r = createWorkerdHotReloader({
    functionsDir: root,
    backend,
    debounceMs: 50,
    watch: () => stream,
    setTimer: clock.set,
    clearTimer: clock.clear,
    log: () => {},
  });
  await r.start();

  stream.emit([join(root, "hello", "index.ts")]);
  // Allow the consume-loop to deliver the event into the debouncer.
  await new Promise((res) => setTimeout(res, 0));
  clock.fireAll();
  await new Promise((res) => setTimeout(res, 0));

  assertEquals(backend.calls, [{ all: false, names: ["hello"] }]);
  await r.stop();
});

Deno.test("hot reloader: shared change reloads everything", async () => {
  const root = "/p";
  const stream = fakeStream();
  const backend = stubBackend();
  const clock = fakeClock();

  const r = createWorkerdHotReloader({
    functionsDir: root,
    backend,
    debounceMs: 50,
    watch: () => stream,
    setTimer: clock.set,
    clearTimer: clock.clear,
    log: () => {},
  });
  await r.start();

  stream.emit([join(root, "_shared", "handler.ts")]);
  await new Promise((res) => setTimeout(res, 0));
  clock.fireAll();
  await new Promise((res) => setTimeout(res, 0));

  assertEquals(backend.calls, [{ all: true, names: [] }]);
  await r.stop();
});

Deno.test("hot reloader: reload failure does not stop the watcher; next event still flushes", async () => {
  const root = "/p";
  const stream = fakeStream();
  const backend = stubBackend({ failNTimes: 1 });
  const clock = fakeClock();
  const logs: string[] = [];

  const r = createWorkerdHotReloader({
    functionsDir: root,
    backend,
    debounceMs: 50,
    watch: () => stream,
    setTimer: clock.set,
    clearTimer: clock.clear,
    log: (l) => {
      logs.push(l);
    },
  });
  await r.start();

  // First save → fails. Reloader must log the failure and stay alive.
  stream.emit([join(root, "hello", "index.ts")]);
  await new Promise((res) => setTimeout(res, 0));
  clock.fireAll();
  // Drain microtasks until the failed flush settles.
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  assert(
    logs.some((l) => l.includes("HMR reload FAILED")),
    `expected failure log; got: ${logs.join("\n")}`,
  );
  assertEquals(backend.calls.length, 1);

  // Second save → succeeds. Proves the watcher loop survived.
  stream.emit([join(root, "echo", "index.ts")]);
  await new Promise((res) => setTimeout(res, 0));
  clock.fireAll();
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  assertEquals(backend.calls.length, 2);
  assertEquals(backend.calls[1], { all: false, names: ["echo"] });
  assert(
    logs.some((l) => l.includes("HMR reload ok")),
    `expected success log on retry; got: ${logs.join("\n")}`,
  );
  await r.stop();
});

Deno.test("hot reloader: onManifestsUpdated fires after a successful reload", async () => {
  const root = "/p";
  const stream = fakeStream();
  const m = defaultManifest();
  m.timeoutMs = 1234;
  const backend = stubBackend({ manifests: new Map([["hello", m]]) });
  const clock = fakeClock();

  const updates: ReadonlyMap<string, FunctionManifest>[] = [];
  const r = createWorkerdHotReloader({
    functionsDir: root,
    backend,
    debounceMs: 50,
    watch: () => stream,
    setTimer: clock.set,
    clearTimer: clock.clear,
    log: () => {},
    onManifestsUpdated: (m) => {
      updates.push(m);
    },
  });
  await r.start();

  stream.emit([join(root, "hello", "index.ts")]);
  await new Promise((res) => setTimeout(res, 0));
  clock.fireAll();
  for (let i = 0; i < 5; i++) await new Promise((res) => setTimeout(res, 0));

  assertEquals(updates.length, 1);
  assertEquals(updates[0].get("hello")?.timeoutMs, 1234);
  await r.stop();
});

Deno.test("hot reloader: stop() cancels pending flushes and ignores subsequent events", async () => {
  const root = "/p";
  const stream = fakeStream();
  const backend = stubBackend();
  const clock = fakeClock();

  const r = createWorkerdHotReloader({
    functionsDir: root,
    backend,
    debounceMs: 50,
    watch: () => stream,
    setTimer: clock.set,
    clearTimer: clock.clear,
    log: () => {},
  });
  await r.start();

  stream.emit([join(root, "hello", "index.ts")]);
  await new Promise((res) => setTimeout(res, 0));
  // Stop BEFORE the timer fires; this must clear the pending flush.
  await r.stop();
  // Emitting after stop() is a no-op — the iterator is closed.
  // Firing any leftover timer must also not call reload().
  clock.fireAll();
  await new Promise((res) => setTimeout(res, 0));

  assertEquals(backend.calls, []);
});
