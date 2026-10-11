/**
 * Shared-dependency mode for LOCAL shared code (`_shared/**`): evaluated
 * once in the shared graph like packages, with `serve()` calls made by a
 * shared handler attributed to the function being imported, and HMR of
 * shared code moving only its importers to a fresh generation.
 */

import { afterEach, describe, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, assertEquals } from "./_assert.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createFunctionHost, sharedCodeHooks } from "../src/backends/bun/function-host.ts";
import { configureCompat } from "../src/compat/plugin.ts";
import { createSharedDependencies, type SharedDependencies } from "../src/compat/shared-deps.ts";

const cleanups: Array<() => Promise<unknown> | unknown> = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  configureCompat({ sharedDeps: null, functionsDir: undefined });
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/**
 * A Supabase-style project: `_shared/handler.ts` captures the registry at
 * evaluation time (like real projects do) and exposes `serve()`.
 */
async function project(files: Record<string, string>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-shared-code-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await write(
    join(dir, "_shared", "handler.ts"),
    `const registry = (globalThis as any).__edgeFunctionRegistry;
export function serve(handler: (req: Request) => Response | Promise<Response>) {
  registry.register(handler, { public: true });
}
export function background(p: Promise<unknown>) {
  (globalThis as any).EdgeRuntime?.waitUntil?.(p);
}
`,
  );
  await write(
    join(dir, "_shared", "state.ts"),
    `export const evaluatedAt = crypto.randomUUID();\nlet calls = 0;\nexport const hit = () => ++calls;\nexport const VERSION = 1;\n`,
  );
  for (const [rel, text] of Object.entries(files)) await write(join(dir, rel), text);
  return dir;
}

const usesState = (tag: string) =>
  `import { serve } from "../_shared/handler.ts";
import { evaluatedAt, hit, VERSION } from "../_shared/state.ts";
let own = 0;
serve(() => Response.json({ tag: ${JSON.stringify(tag)}, evaluatedAt, calls: hit(), own: ++own, VERSION }));
`;

async function boot(dir: string, sharedDeps: SharedDependencies | null) {
  configureCompat({ sharedDeps, functionRoots: [dir] });
  const registry = new FunctionRegistry();
  const host = createFunctionHost({
    functionsDir: dir,
    registry,
    supervisor: new FunctionSupervisor(),
    reloadDrainMs: 0,
  });
  cleanups.push(() => host.stop());
  const result = await host.start();
  const json = async (name: string) => {
    const handle = registry.workerHandle(name);
    assert(handle, `no handle for ${name}; errors: ${JSON.stringify(result.errors)}`);
    const resp = await handle.dispatch(new Request("http://localhost/"), null, new AbortController().signal);
    return await resp.json();
  };
  return { host, registry, json, ...result };
}

function sharing(): SharedDependencies {
  const deps = createSharedDependencies({
    globals: { __edgeFunctionRegistry: sharedCodeHooks },
    onServe: (h) => sharedCodeHooks.serve(h),
    onWaitUntil: (p) => sharedCodeHooks.waitUntil(p),
  });
  cleanups.push(() => deps.dispose());
  return deps;
}

describe("shared code (share-deps)", () => {
  test("_shared modules evaluate once; serve() through a shared handler attributes per function", async () => {
    const dir = await project({ "a/index.ts": usesState("a"), "b/index.ts": usesState("b") });
    const b = await boot(dir, sharing());
    assertEquals(b.errors, []);
    assertEquals(b.loaded.sort(), ["a", "b"]);
    const ra = await b.json("a");
    const rb = await b.json("b");
    // Each name reached its own handler...
    assertEquals([ra.tag, rb.tag], ["a", "b"]);
    // ...while the shared module is one instance with one state.
    assertEquals(ra.evaluatedAt, rb.evaluatedAt);
    assertEquals([ra.calls, rb.calls], [1, 2]);
    // Function-own module state stays per function.
    assertEquals([ra.own, rb.own], [1, 1]);
  });

  test("isolated mode evaluates _shared per function", async () => {
    const dir = await project({ "a/index.ts": usesState("a"), "b/index.ts": usesState("b") });
    const b = await boot(dir, null);
    assertEquals(b.errors, []);
    const ra = await b.json("a");
    const rb = await b.json("b");
    assert(ra.evaluatedAt !== rb.evaluatedAt, "separate instances");
    assertEquals([ra.calls, rb.calls], [1, 1]);
  });

  test("a shared-code edit + bump moves only reloaded functions to a fresh generation", async () => {
    const dir = await project({
      "a/index.ts": usesState("a"),
      "b/index.ts": usesState("b"),
      "c/index.ts": `import { serve } from "../_shared/handler.ts";\nlet n = 0;\nserve(() => Response.json({ n: ++n }));\n`,
    });
    const deps = sharing();
    const b = await boot(dir, deps);
    const before = await b.json("a");
    await b.json("c");
    const gen = deps.generation;

    await write(join(dir, "_shared", "state.ts"), (await Bun.file(join(dir, "_shared", "state.ts")).text()).replace("VERSION = 1", "VERSION = 2"));
    deps.bump();
    assert(deps.generation > gen, "generation advanced");
    const summary = await b.host.reload(new Set(["a", "b"]), "shared edit");
    assertEquals(summary.errors, []);

    const after = await b.json("a");
    assertEquals(after.VERSION, 2);
    assert(after.evaluatedAt !== before.evaluatedAt, "re-evaluated in the new generation");
    assertEquals(after.calls, 1);
    // c was not reloaded: it keeps running on the previous generation.
    assertEquals((await b.json("c")).n, 2);
  });

  test("EdgeRuntime.waitUntil from shared code is tracked for the calling function", async () => {
    const dir = await project({
      "w/index.ts": `import { serve, background } from "../_shared/handler.ts";
let done = false;
serve(() => {
  background(new Promise((r) => setTimeout(r, 150)).then(() => { done = true; }));
  return Response.json({ done });
});
export {};
`,
    });
    const b = await boot(dir, sharing());
    assertEquals(b.errors, []);
    assertEquals((await b.json("w")).done, false);
    // Superseding the graph must wait for the shared-code background task.
    const handle = b.registry.workerHandle("w")!;
    const t0 = performance.now();
    await handle.terminate({ drainMs: 2000 });
    assert(performance.now() - t0 >= 100, "drain waited for waitUntil work");
  });
});
