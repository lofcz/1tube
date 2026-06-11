/**
 * Deferred boot tests for the Deno worker host.
 *
 * Covers the smart-HMR boot path:
 *   - `startDeferred()` returns before any Worker is ready, with every
 *     function registered as a candidate (so the gateway won't 404 it)
 *   - boot states walk queued → loading → ready
 *   - `prioritize()` jumps a queued function past slower ones
 *   - `whenReady()` resolves/timeouts as the gateway's grace-wait expects
 *   - reload-during-boot doesn't corrupt state (per-name serialization)
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createDenoWorkerHost } from "../src/backends/deno/worker-host.ts";

async function writeFn(
  dir: string,
  name: string,
  body: string,
  opts: { delayMs?: number } = {},
): Promise<void> {
  const fnDir = join(dir, name);
  await Deno.mkdir(fnDir, { recursive: true });
  const delay = opts.delayMs
    ? `await new Promise((r) => setTimeout(r, ${opts.delayMs}));\n`
    : "";
  await Deno.writeTextFile(
    join(fnDir, "index.ts"),
    `${delay}const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(() => new Response(${JSON.stringify(body)}), { public: true });
`,
  );
}

Deno.test("deferred boot: returns immediately, functions become ready in background", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-defer-" });
  try {
    await writeFn(tmp, "alpha", "alpha-resp");
    await writeFn(tmp, "beta", "beta-resp");

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
    });
    try {
      const { discovered, done } = await host.startDeferred();
      assertEquals(discovered.sort(), ["alpha", "beta"]);

      // Known to the gateway immediately — candidates registered.
      assert(registry.has("alpha"), "alpha should be known before ready");
      assert(registry.has("beta"), "beta should be known before ready");

      // States are queued/loading at this point, never undefined.
      for (const name of ["alpha", "beta"]) {
        const s = host.bootState(name);
        assert(
          s === "queued" || s === "loading" || s === "ready",
          `unexpected state for ${name}: ${s}`,
        );
      }

      const { loaded, errors } = await done;
      assertEquals(errors, []);
      assertEquals(loaded.sort(), ["alpha", "beta"]);
      assertEquals(host.bootState("alpha"), "ready");
      assertEquals(host.bootState("beta"), "ready");

      const status = host.bootStatus();
      assertEquals(status.total, 2);
      assertEquals(status.ready, ["alpha", "beta"]);
      assertEquals(status.queued, []);
      assertEquals(status.loading, []);
      assertEquals(status.failed, []);

      // And the function actually dispatches.
      const handle = registry.workerHandle("alpha");
      assert(handle, "expected worker handle for alpha");
      const resp = await handle.dispatch(
        new Request("http://localhost/"),
        null,
        new AbortController().signal,
      );
      assertEquals(await resp.text(), "alpha-resp");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deferred boot: prioritize() jumps a queued function past slow ones", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-defer-prio-" });
  try {
    // Alphabetical queue order: aa, bb, zz. With concurrency 1 the lane
    // grinds through aa (slow) then bb (slow); zz would normally go last.
    await writeFn(tmp, "aa", "aa", { delayMs: 800 });
    await writeFn(tmp, "bb", "bb", { delayMs: 800 });
    await writeFn(tmp, "zz", "zz");

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
      concurrency: 1,
    });
    try {
      const { done } = await host.startDeferred();

      // Simulate "a request arrived for zz".
      host.prioritize("zz");
      const outcome = await host.whenReady("zz", 30_000);
      assertEquals(outcome, "ready");

      // zz finished while the slow lane was still busy — bb (queued
      // behind aa) must not have completed yet.
      assert(
        host.bootState("bb") !== "ready",
        "bb should still be warming when prioritized zz is ready",
      );

      const { loaded, errors } = await done;
      assertEquals(errors, []);
      assertEquals(loaded.sort(), ["aa", "bb", "zz"]);
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deferred boot: initialRecency warms recently used functions first", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-defer-mru-" });
  try {
    // Alphabetical order would be aa, mm, zz. The recency seed says the
    // developer was hitting zz, then mm — aa goes last.
    await writeFn(tmp, "aa", "aa");
    await writeFn(tmp, "mm", "mm");
    await writeFn(tmp, "zz", "zz");

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const spawnOrder: string[] = [];
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
      concurrency: 1,
      initialRecency: new Map([["zz", 3000], ["mm", 2000]]),
    });
    try {
      const { done } = await host.startDeferred({
        onSpawnStart: (p) => spawnOrder.push(p.name),
      });
      const { errors } = await done;
      assertEquals(errors, []);
      assertEquals(spawnOrder, ["zz", "mm", "aa"]);
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deferred boot: whenReady() times out for a function stuck in the queue", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-defer-timeout-" });
  try {
    await writeFn(tmp, "aa", "aa", { delayMs: 1500 });
    await writeFn(tmp, "bb", "bb");

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
      concurrency: 1,
    });
    try {
      const { done } = await host.startDeferred();
      // bb sits behind the slow aa; a short grace window must time out
      // (this is the gateway's warming-503 path).
      const outcome = await host.whenReady("bb", 50);
      assertEquals(outcome, "timeout");
      assertEquals(host.whenReady("nope") instanceof Promise, true);
      assertEquals(await host.whenReady("nope"), "unknown");
      await done;
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deferred boot: a failing function settles as failed with its error", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-defer-fail-" });
  try {
    const fnDir = join(tmp, "broken");
    await Deno.mkdir(fnDir, { recursive: true });
    await Deno.writeTextFile(
      join(fnDir, "index.ts"),
      `throw new Error("boom at import time");\n`,
    );
    await writeFn(tmp, "fine", "ok");

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
    });
    try {
      const { done } = await host.startDeferred();
      const { loaded, errors } = await done;
      assertEquals(loaded, ["fine"]);
      assertEquals(errors.length, 1);
      assertEquals(errors[0].name, "broken");

      assertEquals(host.bootState("broken"), "failed");
      assertEquals(await host.whenReady("broken"), "failed");
      const status = host.bootStatus();
      assertEquals(status.failed.length, 1);
      assertEquals(status.failed[0].name, "broken");
      assert(status.failed[0].error.length > 0);
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deferred boot: reload during boot claims queued functions without double-spawn", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-defer-reload-" });
  try {
    await writeFn(tmp, "aa", "aa", { delayMs: 600 });
    await writeFn(tmp, "target", "v1");

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
      concurrency: 1,
    });
    try {
      const { done } = await host.startDeferred();

      // While aa hogs the only lane, edit target and reload it — the
      // reload must claim it out of the queue (state flips to loading)
      // and the boot lane must skip it.
      await writeFn(tmp, "target", "v2");
      const summary = await host.reload(new Set(["target"]), "test-edit");
      assertEquals(summary.errors, []);
      assert(
        summary.reloaded.includes("target") || summary.added.includes("target"),
        "target should have been spawned by the reload",
      );
      assertEquals(host.bootState("target"), "ready");

      const handle = registry.workerHandle("target");
      assert(handle);
      const resp = await handle.dispatch(
        new Request("http://localhost/"),
        null,
        new AbortController().signal,
      );
      assertEquals(await resp.text(), "v2");

      const { errors } = await done;
      assertEquals(errors, []);
      // The boot queue must not have respawned v1 over the reload's v2.
      const after = await registry.workerHandle("target")!.dispatch(
        new Request("http://localhost/"),
        null,
        new AbortController().signal,
      );
      assertEquals(await after.text(), "v2");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
