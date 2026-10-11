/**
 * Deferred boot tests for the Bun function host.
 *
 * Covers the smart-HMR boot path:
 *   - `startDeferred()` returns before any function is ready, with every
 *     function registered as a candidate (so the gateway won't 404 it)
 *   - boot states walk queued → loading → ready
 *   - `prioritize()` jumps a queued function past slower ones
 *   - `whenReady()` resolves/timeouts as the gateway's grace-wait expects
 *   - reload-during-boot doesn't corrupt state (per-name serialization)
 */

import { afterEach, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "./_assert.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createFunctionHost, type FunctionHostOptions } from "../src/backends/bun/function-host.ts";

setDefaultTimeout(30_000);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!().catch(() => {});
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeFn(
  dir: string,
  name: string,
  body: string,
  opts: { delayMs?: number; source?: string } = {},
): Promise<void> {
  const fnDir = join(dir, name);
  await mkdir(fnDir, { recursive: true });
  const delay = opts.delayMs ? `await new Promise((r) => setTimeout(r, ${opts.delayMs}));\n` : "";
  await writeFile(
    join(fnDir, "index.ts"),
    opts.source ??
      `${delay}const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(() => new Response(${JSON.stringify(body)}), { public: true });
`,
  );
}

function makeHost(dir: string, extra: Partial<FunctionHostOptions> = {}) {
  const registry = new FunctionRegistry();
  const host = createFunctionHost({
    functionsDir: dir,
    registry,
    supervisor: new FunctionSupervisor(),
    ...extra,
  });
  cleanups.push(() => host.stop());
  return { registry, host };
}

async function text(registry: FunctionRegistry, name: string): Promise<string> {
  const handle = registry.workerHandle(name);
  assert(handle, `expected a handle for ${name}`);
  const resp = await handle.dispatch(new Request("http://localhost/"), null, new AbortController().signal);
  return await resp.text();
}

test("deferred boot: returns immediately, functions become ready in background", async () => {
  const tmp = await tempDir("1tube-defer-");
  await writeFn(tmp, "alpha", "alpha-resp");
  await writeFn(tmp, "beta", "beta-resp");
  await mkdir(join(tmp, "_shared"), { recursive: true });
  await mkdir(join(tmp, "no-entry"), { recursive: true });

  const { registry, host } = makeHost(tmp);
  const phases = new Set<string>();
  const { discovered, done } = await host.startDeferred({
    onScanProgress: (p) => phases.add(p.phase),
  });
  assertEquals(discovered.sort(), ["alpha", "beta"]);

  // Known to the gateway immediately — candidates registered.
  assert(registry.has("alpha"), "alpha should be known before ready");
  assert(registry.has("beta"), "beta should be known before ready");
  assertEquals(registry.has("no-entry"), false);

  for (const name of ["alpha", "beta"]) {
    const s = host.bootState(name);
    assert(s === "queued" || s === "loading" || s === "ready", `unexpected state for ${name}: ${s}`);
  }

  const { loaded, errors } = await done;
  assertEquals(errors, []);
  assertEquals(loaded.sort(), ["alpha", "beta"]);
  assertEquals(host.bootState("alpha"), "ready");
  assertEquals(host.bootState("beta"), "ready");
  assert(phases.has("scan") && phases.has("graph"), `phases: ${[...phases]}`);

  assertEquals(host.bootStatus(), {
    total: 2,
    ready: ["alpha", "beta"],
    loading: [],
    queued: [],
    failed: [],
  });
  assertEquals(await text(registry, "alpha"), "alpha-resp");
});

test("deferred boot: prioritize() jumps a queued function past slow ones", async () => {
  const tmp = await tempDir("1tube-defer-prio-");
  // Alphabetical queue order: aa, bb, zz. With concurrency 1 the lane
  // grinds through aa (slow) then bb (slow); zz would normally go last.
  await writeFn(tmp, "aa", "aa", { delayMs: 800 });
  await writeFn(tmp, "bb", "bb", { delayMs: 800 });
  await writeFn(tmp, "zz", "zz");

  const { host } = makeHost(tmp, { concurrency: 1 });
  const { done } = await host.startDeferred();

  // Simulate "a request arrived for zz".
  host.prioritize("zz");
  host.prioritize("zz"); // idempotent
  host.prioritize("unknown"); // no-op
  assertEquals(await host.whenReady("zz", 30_000), "ready");
  // zz finished while the slow lane was still busy.
  assert(host.bootState("bb") !== "ready", "bb should still be warming when prioritized zz is ready");

  const { loaded, errors } = await done;
  assertEquals(errors, []);
  assertEquals(loaded.sort(), ["aa", "bb", "zz"]);
});

test("deferred boot: initialRecency warms recently used functions first", async () => {
  const tmp = await tempDir("1tube-defer-mru-");
  // Alphabetical order would be aa, mm, zz. The recency seed says the
  // developer was hitting zz, then mm — aa goes last.
  await writeFn(tmp, "aa", "aa");
  await writeFn(tmp, "mm", "mm");
  await writeFn(tmp, "zz", "zz");

  const spawnOrder: string[] = [];
  const { host } = makeHost(tmp, {
    concurrency: 1,
    initialRecency: new Map([["zz", 3000], ["mm", 2000]]),
  });
  const { done } = await host.startDeferred({ onSpawnStart: (p) => spawnOrder.push(p.name) });
  assertEquals((await done).errors, []);
  assertEquals(spawnOrder, ["zz", "mm", "aa"]);
});

test("deferred boot: whenReady() times out for a function stuck in the queue", async () => {
  const tmp = await tempDir("1tube-defer-timeout-");
  await writeFn(tmp, "aa", "aa", { delayMs: 1500 });
  await writeFn(tmp, "bb", "bb");

  const { host } = makeHost(tmp, { concurrency: 1 });
  const { done } = await host.startDeferred();
  // bb sits behind the slow aa; a short grace window must time out (this
  // is the gateway's warming-503 path).
  assertEquals(await host.whenReady("bb", 50), "timeout");
  assertEquals(await host.whenReady("nope"), "unknown");
  await done;
  assertEquals(await host.whenReady("bb", 50), "ready");
});

test("deferred boot: a failing function settles as failed with its error", async () => {
  const tmp = await tempDir("1tube-defer-fail-");
  await writeFn(tmp, "broken", "", { source: `throw new Error("boom at import time");\n` });
  await writeFn(tmp, "fine", "ok");

  const { registry, host } = makeHost(tmp);
  const { done } = await host.startDeferred();
  const { loaded, errors } = await done;
  assertEquals(loaded, ["fine"]);
  assertEquals(errors.length, 1);
  assertEquals(errors[0].name, "broken");
  assert(errors[0].error.includes("boom at import time"));

  assertEquals(host.bootState("broken"), "failed");
  assertEquals(await host.whenReady("broken"), "failed");
  const status = host.bootStatus();
  assertEquals(status.failed.length, 1);
  assertEquals(status.failed[0].name, "broken");
  // Still a known candidate (the gateway answers with the boot error).
  assert(registry.has("broken"));
  assertEquals(registry.workerHandle("broken"), undefined);

  // Fixing the file and reloading recovers it.
  await writeFn(tmp, "broken", "fixed");
  const summary = await host.reload(new Set(["broken"]), "fix");
  assertEquals(summary.errors, []);
  assertEquals(host.bootState("broken"), "ready");
  assertEquals(await text(registry, "broken"), "fixed");
});

test("deferred boot: reload during boot claims queued functions without double-spawn", async () => {
  const tmp = await tempDir("1tube-defer-reload-");
  await writeFn(tmp, "aa", "aa", { delayMs: 600 });
  await writeFn(tmp, "target", "v1");

  const { registry, host } = makeHost(tmp, { concurrency: 1 });
  const spawned: string[] = [];
  const { done } = await host.startDeferred({ onSpawnStart: (p) => spawned.push(p.name) });

  // While aa hogs the only lane, edit target and reload it — the reload
  // must claim it out of the queue and the boot lane must skip it.
  await writeFn(tmp, "target", "v2");
  const summary = await host.reload(new Set(["target"]), "test-edit");
  assertEquals(summary.errors, []);
  assert(
    summary.reloaded.includes("target") || summary.added.includes("target"),
    "target should have been spawned by the reload",
  );
  assertEquals(host.bootState("target"), "ready");
  assertEquals(await text(registry, "target"), "v2");

  const { errors } = await done;
  assertEquals(errors, []);
  // The boot queue must not have respawned v1 over the reload's v2.
  assertEquals(await text(registry, "target"), "v2");
  assertEquals(spawned.filter((n) => n === "target"), []);
});

test("deferred boot: a candidate's manifest refreshes when it boots", async () => {
  const tmp = await tempDir("1tube-defer-manifest-");
  await writeFn(tmp, "limited", "", {
    source: `(globalThis as any).__edgeFunctionRegistry.register(() => new Response("ok"), {
  public: true,
  rpm: 7,
});
`,
  });
  const { registry, host } = makeHost(tmp);
  const { done } = await host.startDeferred();
  await done;
  // The serve() rate-limit override is folded into what the gateway sees.
  assertEquals(registry.manifestFor("limited")?.rpm, 7);
});
