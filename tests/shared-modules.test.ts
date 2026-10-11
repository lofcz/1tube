/**
 * Shared-module integration tests for the Bun backend.
 *
 * A shared module (Supabase's `_shared/profile-cache.ts` convention) has
 * process-wide side effects that must run ONCE, not once per function. The
 * shared runtime evaluates it in one dedicated `Bun.ModuleGraph`; the compat
 * plugin rewrites each function's import of it to a stub that re-exports
 * the singleton. These tests pin the semantics:
 *
 *   1. The top-level side effect runs once total, however many functions
 *      import the module.
 *   2. Every function gets the very same live objects (no RPC, no copies).
 *   3. Editing the shared module re-evaluates it once, its exported
 *      `dispose()` hook runs, and HMR reloads exactly its dependents, which
 *      re-bind to the fresh exports (including a changed export list).
 *   4. Without a shared runtime, each function evaluates the module itself
 *      (the canary that the test boundary is real).
 */

import { afterEach, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, assertEquals, assertRejects } from "./_assert.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createFunctionHost, type FunctionHost, type ReloadSummary } from "../src/backends/bun/function-host.ts";
import {
  createSharedRuntime,
  discoverSharedModules,
  type SharedRuntime,
} from "../src/backends/bun/shared-runtime.ts";
import { createHotReloader, type FsEventStream } from "../src/backends/bun/hot-reloader.ts";
import { configureCompat } from "../src/compat/plugin.ts";

setDefaultTimeout(20_000);

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve(cleanups.pop()!()).catch(() => {});
  // The compat plugin is process-global: never leak our provider.
  configureCompat({ shared: null });
});

interface Project {
  dir: string;
  evalLog: string;
  disposeLog: string;
  sharedPath: string;
}

const sharedSource = (version: string, extraExports = "") => (evalLog: string, disposeLog: string) => `
// Top-level side effect: count evaluations from outside.
Deno.writeTextFileSync(${JSON.stringify(evalLog)}, "x", { append: true });

export const token = crypto.randomUUID();
export const version = ${JSON.stringify(version)};
const cache = new Map([["u1", { userId: "u1", role: "teacher" }]]);
let hits = 0;

export async function getCachedProfile(userId) {
  hits++;
  return cache.get(userId) ?? null;
}
export function setProfile(userId, profile) {
  cache.set(userId, profile);
}
export function hitCount() {
  return hits;
}
export function dispose() {
  Deno.writeTextFileSync(${JSON.stringify(disposeLog)}, ${JSON.stringify(version)} + ";", { append: true });
}
${extraExports}
`;

/** N functions, each importing `_shared/profile-cache.ts`. */
async function makeProject(numFns: number): Promise<Project> {
  // Canonicalize like the gateway: shared-module matching is by exact path.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-shared-test-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const evalLog = join(dir, ".shared-evals.log");
  const disposeLog = join(dir, ".shared-dispose.log");
  await writeFile(evalLog, "");
  await writeFile(disposeLog, "");
  const sharedPath = join(dir, "_shared", "profile-cache.ts");
  await write(sharedPath, sharedSource("v1")(evalLog, disposeLog));

  for (let i = 0; i < numFns; i++) {
    const name = `fn${i}`;
    await write(
      join(dir, name, "index.ts"),
      `import * as shared from "../_shared/profile-cache.ts";
import { getCachedProfile, setProfile, hitCount, token, version } from "../_shared/profile-cache.ts";

(globalThis as any).__edgeFunctionRegistry.register(async (req: Request) => {
  const url = new URL(req.url);
  if (url.searchParams.has("set")) setProfile("u1", { userId: "u1", role: url.searchParams.get("set") });
  const profile = await getCachedProfile("u1");
  return Response.json({
    from: "${name}",
    profile,
    token,
    version,
    hits: hitCount(),
    extra: typeof (shared as any).extra === "function" ? (shared as any).extra() : null,
  });
}, { public: true });
`,
    );
  }
  return { dir, evalLog, disposeLog, sharedPath };
}

async function startShared(dir: string): Promise<SharedRuntime> {
  const specs = await discoverSharedModules(dir);
  const runtime = await createSharedRuntime(specs);
  configureCompat({ shared: runtime, functionRoots: [dir] });
  cleanups.push(() => runtime.stop());
  return runtime;
}

function startHost(dir: string, sharedRuntime?: SharedRuntime, onReloaded?: (s: ReloadSummary) => void) {
  const registry = new FunctionRegistry();
  const host = createFunctionHost({
    functionsDir: dir,
    registry,
    supervisor: new FunctionSupervisor(),
    reloadDrainMs: 0,
    ...(sharedRuntime ? { sharedRuntime } : {}),
    onReloaded,
  });
  cleanups.push(() => host.stop());
  return { registry, host };
}

async function call(
  registry: FunctionRegistry,
  name: string,
  query = "",
): Promise<Record<string, unknown>> {
  const handle = registry.workerHandle(name);
  assert(handle, `missing handle for ${name}`);
  const resp = await handle.dispatch(
    new Request(`http://localhost/${query}`),
    null,
    new AbortController().signal,
  );
  assertEquals(resp.status, 200);
  return await resp.json();
}

test("shared modules: discovery finds the profile-cache convention", async () => {
  const proj = await makeProject(1);
  const shared = await discoverSharedModules(proj.dir);
  assertEquals(shared.length, 1);
  assertEquals(shared[0].id, "profile-cache");
  assertEquals(shared[0].sourcePath, proj.sharedPath);
});

test("shared modules: top-level side effect runs ONCE across many function graphs", async () => {
  const proj = await makeProject(5);
  const runtime = await startShared(proj.dir);
  assertEquals(runtime.list().map((r) => r.id), ["profile-cache"]);
  assert(runtime.bySourcePath(proj.sharedPath)?.exportNames.includes("getCachedProfile"));
  assertEquals(await readFile(proj.evalLog, "utf8"), "x");

  const { registry, host } = startHost(proj.dir, runtime);
  const { loaded, errors } = await host.start();
  assertEquals(errors, []);
  assertEquals(loaded.length, 5);

  const tokens = new Set<unknown>();
  for (const name of loaded) {
    const body = await call(registry, name);
    assertEquals(body.from, name);
    assertEquals(body.profile, { userId: "u1", role: "teacher" });
    tokens.add(body.token);
  }
  // Same singleton everywhere, still evaluated exactly once.
  assertEquals(tokens.size, 1);
  assertEquals(await readFile(proj.evalLog, "utf8"), "x");
});

test("shared modules: functions see the same live state", async () => {
  const proj = await makeProject(2);
  const runtime = await startShared(proj.dir);
  const { registry, host } = startHost(proj.dir, runtime);
  assertEquals((await host.start()).errors, []);

  // fn0 mutates the shared cache; fn1 observes it — and the hit counter
  // (module-private state of the singleton) counts calls from both.
  await call(registry, "fn0", "?set=admin");
  const seen = await call(registry, "fn1");
  assertEquals(seen.profile, { userId: "u1", role: "admin" });
  assertEquals(seen.hits, 2);
});

test("shared modules: hot reload re-evaluates once, disposes the old instance, and re-binds dependents", async () => {
  const proj = await makeProject(2);
  // A function that does NOT import the shared module must not reload.
  await write(
    join(proj.dir, "loner", "index.ts"),
    `(globalThis as any).__edgeFunctionRegistry.register(() => new Response("loner"), { public: true });\n`,
  );
  const runtime = await startShared(proj.dir);
  const summaries: ReloadSummary[] = [];
  const { registry, host } = startHost(proj.dir, runtime, (s) => summaries.push(s));
  assertEquals((await host.start()).errors, []);
  const before = await call(registry, "fn0");
  assertEquals(before.version, "v1");
  const lonerHandle = registry.workerHandle("loner");

  // Drive the real reloader with a fake watcher.
  let emit: (paths: string[]) => void = () => {};
  const stream: FsEventStream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        yield await new Promise<{ paths: string[] }>((r) => (emit = (paths) => r({ paths })));
      }
    },
    close() {},
  };
  const reloader = createHotReloader({
    host,
    functionsDir: proj.dir,
    debounceMs: 10,
    leadingMs: 5,
    watch: () => stream,
    sharedRuntime: runtime,
    log: () => {},
  });
  await reloader.start();
  cleanups.push(() => reloader.stop());
  await new Promise((r) => setTimeout(r, 10));

  // Edit: new version AND a new export the stub must pick up.
  await writeFile(
    proj.sharedPath,
    sharedSource("v2", `export function extra() { return "new export"; }`)(proj.evalLog, proj.disposeLog),
  );
  emit([proj.sharedPath]);
  const deadline = performance.now() + 5000;
  while (summaries.length === 0 && performance.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assertEquals(summaries.length, 1);
  assertEquals(summaries[0].reloaded, ["fn0", "fn1"]);
  assertEquals(summaries[0].errors, []);

  assertEquals(await readFile(proj.evalLog, "utf8"), "xx", "one re-evaluation per edit");
  assertEquals(await readFile(proj.disposeLog, "utf8"), "v1;", "old instance's dispose() ran");
  const a = await call(registry, "fn0");
  const b = await call(registry, "fn1");
  assertEquals(a.version, "v2");
  assertEquals(a.extra, "new export");
  assertEquals(a.token, b.token);
  assert(a.token !== before.token, "dependents re-bound to the fresh instance");
  assertEquals(registry.workerHandle("loner"), lonerHandle);

  await runtime.stop();
  assertEquals(await readFile(proj.disposeLog, "utf8"), "v1;v2;");
});

test("shared modules: a failing shared edit keeps the previous instance live", async () => {
  const proj = await makeProject(1);
  const runtime = await startShared(proj.dir);
  const { registry, host } = startHost(proj.dir, runtime);
  assertEquals((await host.start()).errors, []);
  const before = await call(registry, "fn0");

  await writeFile(
    proj.sharedPath,
    `export async function getCachedProfile() {}\nthrow new Error("shared boom");\n`,
  );
  await assertRejects(() => runtime.reload(), "shared boom");
  // Nothing was torn down: the registry still serves the old generation.
  assertEquals(await readFile(proj.disposeLog, "utf8"), "");
  assertEquals(runtime.list().map((r) => r.id), ["profile-cache"]);
  const reloaded = await host.reload(new Set(["fn0"]), "after failed shared edit");
  assertEquals(reloaded.errors, []);
  assertEquals((await call(registry, "fn0")).token, before.token);
});

test("shared modules: shared modules import each other directly (one graph)", async () => {
  const proj = await makeProject(1);
  // A second shared module that imports the first: inside the shared
  // graph the import is NOT redirected to a stub.
  const helperPath = join(proj.dir, "_shared", "helper.ts");
  await write(
    helperPath,
    `import { token } from "./profile-cache.ts";\nexport function helperToken() { return token; }\n`,
  );
  const specs = await discoverSharedModules(proj.dir, [helperPath]);
  assertEquals(specs.map((s) => s.id).sort(), ["helper", "profile-cache"]);
  const runtime = await createSharedRuntime(specs);
  configureCompat({ shared: runtime, functionRoots: [proj.dir] });
  cleanups.push(() => runtime.stop());
  await write(
    join(proj.dir, "both", "index.ts"),
    `import { helperToken } from "../_shared/helper.ts";
import { token } from "../_shared/profile-cache.ts";
(globalThis as any).__edgeFunctionRegistry.register(() => Response.json({ same: helperToken() === token }), { public: true });
`,
  );
  const { registry, host } = startHost(proj.dir, runtime);
  assertEquals((await host.start()).errors, []);
  assertEquals(await call(registry, "both"), { same: true });
  assertEquals(await readFile(proj.evalLog, "utf8"), "x");
});

test("shared modules: dynamic import() of a non-shared sibling works next to the stub", async () => {
  const proj = await makeProject(0);
  await write(join(proj.dir, "fn", "model.ts"), `export const CHEAP_MODEL = "tiny";\n`);
  await write(
    join(proj.dir, "fn", "index.ts"),
    `import { getCachedProfile } from "../_shared/profile-cache.ts";
(globalThis as any).__edgeFunctionRegistry.register(async () => {
  const { CHEAP_MODEL } = await import("./model.ts");
  const shared = await import("../_shared/profile-cache.ts");
  return Response.json({ model: CHEAP_MODEL, profile: await getCachedProfile("u1"), dynToken: typeof shared.token });
}, { public: true });
`,
  );
  const runtime = await startShared(proj.dir);
  const { registry, host } = startHost(proj.dir, runtime);
  assertEquals((await host.start()).errors, []);
  assertEquals(await call(registry, "fn"), {
    model: "tiny",
    profile: { userId: "u1", role: "teacher" },
    dynToken: "string",
  });
  assertEquals(await readFile(proj.evalLog, "utf8"), "x");
});

test("shared modules: without a shared runtime each function evaluates the module itself", async () => {
  const proj = await makeProject(2);
  configureCompat({ shared: null, functionRoots: [proj.dir] });
  const { registry, host } = startHost(proj.dir);
  const { loaded, errors } = await host.start();
  assertEquals(errors, []);
  assertEquals(loaded.length, 2);
  assertEquals(
    await readFile(proj.evalLog, "utf8"),
    "xx",
    "without a shared runtime each graph evaluates the module; expected 2 markers from 2 fns",
  );
  const a = await call(registry, "fn0");
  const b = await call(registry, "fn1");
  assert(a.token !== b.token);
});
