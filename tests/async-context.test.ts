/**
 * Verifies the AsyncLocalStorage wiring that per-function / per-request
 * attribution relies on.
 *
 *   1. The gateway's `currentRequestStorage` survives `await`, `setTimeout`
 *      hops, and concurrent dispatches don't bleed into each other.
 *   2. A store entered on the host side propagates INTO `Bun.ModuleGraph`
 *      code run via `graph.run()` — timers and promise chains included —
 *      which is what the function host's console attribution builds on.
 *   3. Orphan rejections / uncaught errors from function code are attributed
 *      through the graph's `onError` (by closure), not through the process
 *      handlers: Bun's process-level `unhandledRejection` handler runs
 *      without the originating async context, so it cannot attribute.
 */

import { afterEach, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "./_assert.ts";
import { currentRequestStorage, FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createFunctionHost, type FunctionConsoleEvent } from "../src/backends/bun/function-host.ts";

function dispatch<T>(fnName: string, fn: () => T | Promise<T>): Promise<T> {
  // Mirrors the wrap in src/server.ts: every handler runs inside a
  // `currentRequestStorage.run({ functionName }, ...)` scope.
  return Promise.resolve(currentRequestStorage.run({ functionName: fnName }, fn));
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

test("async-context: store visible synchronously inside the handler", async () => {
  await dispatch("alpha", () => {
    assertEquals(currentRequestStorage.getStore()?.functionName, "alpha");
  });
});

test("async-context: store survives an await boundary", async () => {
  await dispatch("beta", async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    assertEquals(currentRequestStorage.getStore()?.functionName, "beta");
  });
});

test("async-context: setTimeout callback inherits the store", async () => {
  await new Promise<void>((resolve, reject) => {
    dispatch("gamma", () => {
      setTimeout(() => {
        try {
          assertEquals(currentRequestStorage.getStore()?.functionName, "gamma");
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 5);
    });
  });
});

test("async-context: concurrent dispatches keep their own store (no bleed)", async () => {
  const seenA: (string | undefined)[] = [];
  const seenB: (string | undefined)[] = [];
  const a = dispatch("fn-a", async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      seenA.push(currentRequestStorage.getStore()?.functionName);
    }
  });
  const b = dispatch("fn-b", async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      seenB.push(currentRequestStorage.getStore()?.functionName);
    }
  });
  await Promise.all([a, b]);
  assertEquals(new Set(seenA), new Set(["fn-a"]));
  assertEquals(new Set(seenB), new Set(["fn-b"]));
});

test("async-context: a host-side store propagates into module-graph code", async () => {
  const dir = await mkdtemp(join(tmpdir(), "1tube-als-graph-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const modPath = join(dir, "mod.ts");
  await writeFile(
    modPath,
    `export async function probe(read: () => string | undefined) {
  const seen = [read()];
  await Promise.resolve();
  seen.push(read());
  await new Promise((r) => setTimeout(r, 2));
  seen.push(read());
  await new Promise<void>((r) => queueMicrotask(() => { seen.push(read()); r(); }));
  return seen;
}
`,
  );
  const als = new AsyncLocalStorage<string>();
  const graph = new Bun.ModuleGraph({ globals: {} });
  cleanups.push(() => graph.dispose());
  const mod = await graph.import(modPath) as {
    probe: (read: () => string | undefined) => Promise<Array<string | undefined>>;
  };
  const read = () => als.getStore();
  const [a, b] = await Promise.all([
    als.run("inv-a", () => graph.run(() => mod.probe(read))),
    als.run("inv-b", () => graph.run(() => mod.probe(read))),
  ]);
  assertEquals(a, ["inv-a", "inv-a", "inv-a", "inv-a"]);
  assertEquals(b, ["inv-b", "inv-b", "inv-b", "inv-b"]);
});

test("async-context: orphan rejections from function code are attributed to the function", async () => {
  const dir = await mkdtemp(join(tmpdir(), "1tube-als-reject-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "delta"), { recursive: true });
  await writeFile(
    join(dir, "delta", "index.ts"),
    `(globalThis as any).__edgeFunctionRegistry.register(() => {
  // Fire and forget — no .catch, no await.
  void Promise.resolve().then(() => { throw new Error("rejection-from-delta"); });
  return new Response("ok");
}, { public: true });
`,
  );
  const processSeen: unknown[] = [];
  const onProcess = (reason: unknown) => processSeen.push(reason);
  process.on("unhandledRejection", onProcess);
  cleanups.push(() => {
    process.off("unhandledRejection", onProcess);
  });

  const events: FunctionConsoleEvent[] = [];
  const supervisor = new FunctionSupervisor();
  const registry = new FunctionRegistry();
  const host = createFunctionHost({
    functionsDir: dir,
    registry,
    supervisor,
    onConsole: (e) => events.push(e),
  });
  cleanups.push(() => host.stop());
  assertEquals((await host.start()).errors, []);

  const resp = await registry.workerHandle("delta")!.dispatch(
    new Request("http://localhost/"),
    null,
    new AbortController().signal,
    "inv-delta",
  );
  assertEquals(await resp.text(), "ok");

  const deadline = performance.now() + 1000;
  let hit: FunctionConsoleEvent | undefined;
  while (!hit && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    hit = events.find((e) => e.message.includes("rejection-from-delta"));
  }
  assert(hit, "the rejection should surface through the graph's onError");
  assertEquals(hit.functionName, "delta");
  assertEquals(hit.level, "error");
  assertEquals(supervisor.stats("delta").errors, 1);
  // It never reaches the gateway's process-level handler.
  assertEquals(processSeen, []);
});
