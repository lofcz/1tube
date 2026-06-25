/**
 * Lazy-load: candidates registered at boot, imported on first dispatch,
 * concurrent first-requests dedupe on a single import.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { join } from "@std/path";
import { FunctionRegistry } from "../src/registry.ts";
import { discoverAndLoad } from "../src/discovery.ts";

async function makeFnDir(
  root: string,
  name: string,
  body: string,
  manifest?: Record<string, unknown>,
) {
  const dir = join(root, name);
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, "index.ts"), body);
  if (manifest) {
    await Deno.writeTextFile(
      join(dir, "1tube.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
}

const HANDLER_BODY = (tag: string) => `
const reg = (globalThis as any).__edgeFunctionRegistry;
(globalThis as any).__loadCounts = (globalThis as any).__loadCounts || {};
(globalThis as any).__loadCounts[${JSON.stringify(tag)}] =
  ((globalThis as any).__loadCounts[${JSON.stringify(tag)}] || 0) + 1;
reg.register(() => new Response("hello-${tag}"), { public: true });
`;

function setupRegistry(): FunctionRegistry {
  // Reset load counts and install a fresh registry on globalThis so the
  // function modules can find it during dynamic import.
  (globalThis as any).__loadCounts = {};
  const reg = new FunctionRegistry();
  (globalThis as any).__edgeFunctionRegistry = reg;
  return reg;
}

Deno.test("lazy-load: discovery in lazy mode registers candidates without importing", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeFnDir(tmp, "fn-a", HANDLER_BODY("a"));
    await makeFnDir(tmp, "fn-b", HANDLER_BODY("b"));

    const reg = setupRegistry();
    const result = await discoverAndLoad(tmp, reg, { lazy: true });

    assertEquals(result.loaded.length, 0, "nothing should be eagerly loaded");
    assertEquals(result.deferred.sort(), ["fn-a", "fn-b"]);
    assertEquals(reg.size, 0, "no handlers registered yet");
    assert(reg.has("fn-a"));
    assert(reg.has("fn-b"));
    assertEquals(reg.knownNames(), ["fn-a", "fn-b"]);
    assertEquals(reg.pendingCount, 2);

    const counts = (globalThis as any).__loadCounts as Record<string, number>;
    assertEquals(
      counts["a"],
      undefined,
      "fn-a module must not have been imported",
    );
    assertEquals(
      counts["b"],
      undefined,
      "fn-b module must not have been imported",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("lazy-load: warm:true manifests still load eagerly", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await makeFnDir(tmp, "warm-fn", HANDLER_BODY("warm"), { warm: true });
    await makeFnDir(tmp, "cold-fn", HANDLER_BODY("cold"));

    const reg = setupRegistry();
    const result = await discoverAndLoad(tmp, reg, { lazy: true });

    assertEquals(result.loaded, ["warm-fn"]);
    assertEquals(result.deferred, ["cold-fn"]);
    assertEquals(reg.size, 1);
    assert(reg.get("warm-fn"));
    assertEquals(reg.get("cold-fn"), undefined);

    const counts = (globalThis as any).__loadCounts as Record<string, number>;
    assertEquals(counts["warm"], 1);
    assertEquals(counts["cold"], undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("lazy-load: getOrLoad imports on first call, hit on second", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    // Use a unique name per test run so Deno's module cache doesn't return a
    // stale module from a previous test.
    const name = `lazy-once-${crypto.randomUUID().slice(0, 8)}`;
    await makeFnDir(tmp, name, HANDLER_BODY("once"));

    const reg = setupRegistry();
    await discoverAndLoad(tmp, reg, { lazy: true });

    assertEquals(reg.get(name), undefined, "no handler before first dispatch");
    const fn = await reg.getOrLoad(name);
    assert(fn, "first getOrLoad triggers import");
    assert(reg.get(name), "handler is now cached");

    const fn2 = await reg.getOrLoad(name);
    assertEquals(fn2, fn, "second getOrLoad returns the same handler");

    const counts = (globalThis as any).__loadCounts as Record<string, number>;
    assertEquals(counts["once"], 1, "module top-level ran exactly once");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("lazy-load: concurrent first-dispatch dedupes on a single import", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const name = `lazy-dedupe-${crypto.randomUUID().slice(0, 8)}`;
    await makeFnDir(tmp, name, HANDLER_BODY("dedupe"));

    const reg = setupRegistry();
    await discoverAndLoad(tmp, reg, { lazy: true });

    const results = await Promise.all([
      reg.getOrLoad(name),
      reg.getOrLoad(name),
      reg.getOrLoad(name),
      reg.getOrLoad(name),
      reg.getOrLoad(name),
    ]);

    for (const r of results) assert(r);
    // All concurrent waiters should resolve to the same handler entry.
    for (let i = 1; i < results.length; i++) {
      assertEquals(results[i], results[0]);
    }

    const counts = (globalThis as any).__loadCounts as Record<string, number>;
    assertEquals(
      counts["dedupe"],
      1,
      "module imported exactly once despite 5 racers",
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("lazy-load: getOrLoad on unknown name returns undefined", async () => {
  const reg = setupRegistry();
  const r = await reg.getOrLoad("does-not-exist");
  assertEquals(r, undefined);
});

Deno.test("lazy-load: failed import drops the candidate", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const name = `lazy-fail-${crypto.randomUUID().slice(0, 8)}`;
    await makeFnDir(
      tmp,
      name,
      `throw new Error("boom from " + ${JSON.stringify(name)});`,
    );

    const reg = setupRegistry();
    await discoverAndLoad(tmp, reg, { lazy: true });
    assert(reg.has(name));

    let threw = false;
    try {
      await reg.getOrLoad(name);
    } catch (err) {
      threw = true;
      assert(err instanceof Error);
      assert(err.message.includes("boom"));
    }
    assert(threw, "failed import must surface the error");
    assertEquals(reg.has(name), false, "candidate dropped after failure");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("lazy-load: registry.has() covers candidates AND loaded handlers", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const eager = `eager-${crypto.randomUUID().slice(0, 8)}`;
    const lazy = `lazy-${crypto.randomUUID().slice(0, 8)}`;
    await makeFnDir(tmp, eager, HANDLER_BODY(eager), { warm: true });
    await makeFnDir(tmp, lazy, HANDLER_BODY(lazy));

    const reg = setupRegistry();
    await discoverAndLoad(tmp, reg, { lazy: true });

    assert(reg.has(eager), "warm fn (loaded handler) is .has()");
    assert(reg.has(lazy), "lazy fn (candidate only) is .has()");
    assertEquals(reg.has("nope"), false);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("lazy-load: manifestFor() reads manifest of unloaded candidates", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const name = `manifest-${crypto.randomUUID().slice(0, 8)}`;
    await makeFnDir(tmp, name, HANDLER_BODY(name), {
      rpm: 999,
      timeoutMs: 1234,
    });

    const reg = setupRegistry();
    await discoverAndLoad(tmp, reg, { lazy: true });

    const m = reg.manifestFor(name);
    assert(m);
    assertEquals(m.rpm, 999);
    assertEquals(m.timeoutMs, 1234);
    // Sanity: handler still NOT loaded.
    assertEquals(reg.get(name), undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("lazy-load: eager (non-lazy) discovery is unchanged — handlers loaded immediately", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const name = `eager-classic-${crypto.randomUUID().slice(0, 8)}`;
    await makeFnDir(tmp, name, HANDLER_BODY("classic"));

    const reg = setupRegistry();
    const result = await discoverAndLoad(tmp, reg, {/* lazy omitted */});

    assertEquals(result.deferred, []);
    assertEquals(result.loaded, [name]);
    assert(reg.get(name), "handler loaded eagerly");
    assertNotEquals((globalThis as any).__loadCounts["classic"], undefined);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
