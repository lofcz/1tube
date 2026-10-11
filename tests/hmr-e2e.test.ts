/**
 * End-to-end HMR validation for the Bun backend.
 *
 * The other test files exercise the pieces in isolation: dep-graph against
 * synthetic fixtures, function-host with manual `reload()` calls,
 * hot-reloader with a fake watcher / fake host. This file wires *all of
 * them* together against a real fs watcher and a real temp project, then
 * drives the edits a developer actually makes:
 *
 *   1. Edit a function's own `index.ts`               → that one function
 *   2. Edit a sidecar file of one function            → only that function
 *   3. Edit a shared module imported by two functions → both functions
 *   4. Edit a transitive dep (dep of a dep)           → the importing fn
 *   5. Add a new function dir at runtime              → dispatchable
 *   6. Delete a function dir at runtime               → removed
 *   7. Edit a file outside any graph (e.g. README)    → no reload at all
 *   8. Rapid successive saves                         → converge on the last
 *
 * Locality is checked with a per-module-evaluation id (`load`): every graph
 * evaluates the function's modules afresh, so `load` changes iff the
 * function was re-imported. The last block boots a real gateway process and
 * checks import-map / shared-module behaviour through HTTP.
 */

import { afterEach, describe, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, assertEquals } from "./_assert.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import {
  createFunctionHost,
  type FunctionHost,
  type ReloadSummary,
} from "../src/backends/bun/function-host.ts";
import { createHotReloader, type HotReloader } from "../src/backends/bun/hot-reloader.ts";
import { devGatewayEnv, signJwt } from "./_helpers.ts";

const SERVER = join(import.meta.dir, "..", "src", "server.ts");

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A function whose response carries a per-module-evaluation id (`load`),
 * so a test can tell whether it was re-imported, plus `value`.
 */
function fnSource(valueExpr: string, importLines: string[] = []): string {
  return `${importLines.join("\n")}
const LOAD = crypto.randomUUID();
(globalThis as any).__edgeFunctionRegistry.register(
  () => Response.json({ load: LOAD, value: ${valueExpr} }),
  { public: true },
);
`;
}

interface Harness {
  dir: string;
  registry: FunctionRegistry;
  host: FunctionHost;
  reloader: HotReloader;
  summaries: ReloadSummary[];
  /** Resolves once a reload that touches any of `expected` lands. */
  waitForReloadOf(expected: ReadonlySet<string>, timeoutMs?: number): Promise<ReloadSummary>;
  /** Resolves with the first reload summary (from now on) matching `pred`. */
  waitForSummary(pred: (s: ReloadSummary) => boolean, timeoutMs?: number): Promise<ReloadSummary>;
  /** Resolves after `quietMs` ms during which no reload occurred. */
  waitForQuiet(quietMs: number): Promise<void>;
}

const harnesses: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!().catch(() => {});
});

async function makeHarness(setup: (root: string) => Promise<void>): Promise<Harness> {
  // Canonicalize like the gateway does (server.ts realpaths the functions
  // dir): watcher paths and dep-graph paths must agree.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-hmr-e2e-")));
  await setup(dir);

  const registry = new FunctionRegistry();
  const supervisor = new FunctionSupervisor();
  const summaries: ReloadSummary[] = [];
  let lastSummaryAt = performance.now();
  const host = createFunctionHost({
    functionsDir: dir,
    registry,
    supervisor,
    reloadDrainMs: 50,
    onReloaded: (s) => {
      summaries.push(s);
      lastSummaryAt = performance.now();
    },
  });
  const boot = await host.start();
  assertEquals(boot.errors, [], `boot errors: ${JSON.stringify(boot.errors)}`);

  // Short windows keep each scenario fast without losing coalescing.
  const reloader = createHotReloader({
    host,
    functionsDir: dir,
    debounceMs: 50,
    leadingMs: 20,
    log: () => {},
  });
  await reloader.start();
  harnesses.push(async () => {
    await reloader.stop();
    await host.stop();
    await rm(dir, { recursive: true, force: true });
  });

  let cursor = 0;
  async function waitForSummary(pred: (s: ReloadSummary) => boolean, timeoutMs = 4000) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      while (cursor < summaries.length) {
        const s = summaries[cursor++];
        if (pred(s)) return s;
      }
      await sleep(20);
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for a reload; saw: ${
        summaries.map((s) =>
          `[reloaded=${s.reloaded.join("|")}; added=${s.added.join("|")}; removed=${
            s.removed.join("|")
          }; errors=${s.errors.map((e) => e.name).join("|")}]`
        ).join(", ")
      }`,
    );
  }
  return {
    dir,
    registry,
    host,
    reloader,
    summaries,
    waitForSummary,
    waitForReloadOf(expected, timeoutMs) {
      return waitForSummary((s) => {
        const touched = new Set([...s.reloaded, ...s.added, ...s.removed]);
        return [...expected].some((want) => touched.has(want));
      }, timeoutMs);
    },
    async waitForQuiet(quietMs) {
      const start = performance.now();
      while (performance.now() - Math.max(lastSummaryAt, start) < quietMs) await sleep(20);
    },
  };
}

async function get(
  registry: FunctionRegistry,
  name: string,
): Promise<{ load: string; value: unknown }> {
  const handle = registry.workerHandle(name);
  if (!handle) throw new Error(`no handle for ${name}`);
  const r = await handle.dispatch(new Request("http://x/"), null, new AbortController().signal);
  return await r.json();
}

// ---------------------------------------------------------------------------
// In-process: real watcher + real host
// ---------------------------------------------------------------------------

describe("hmr-e2e: watcher + host", () => {
  test("editing a function's own index.ts reloads only that function", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "alpha", "index.ts"), fnSource(`"v1-alpha"`));
      await write(join(root, "beta", "index.ts"), fnSource(`"v1-beta"`));
    });
    const betaBefore = await get(h.registry, "beta");
    const betaHandle = h.registry.workerHandle("beta");
    assertEquals((await get(h.registry, "alpha")).value, "v1-alpha");

    await write(join(h.dir, "alpha", "index.ts"), fnSource(`"v2-alpha"`));
    const summary = await h.waitForReloadOf(new Set(["alpha"]));
    assertEquals(summary.reloaded, ["alpha"]);

    assertEquals((await get(h.registry, "alpha")).value, "v2-alpha");
    // beta was not re-imported: same handle, same module evaluation.
    assertEquals(h.registry.workerHandle("beta"), betaHandle);
    assertEquals(await get(h.registry, "beta"), betaBefore);
  });

  test("editing a sidecar file reloads only its function, and the edit is visible", async () => {
    const h = await makeHarness(async (root) => {
      for (const n of ["alpha", "beta"]) {
        await write(join(root, n, "dep.ts"), `export const dep = "${n}1";\n`);
        await write(join(root, n, "index.ts"), fnSource("dep", [`import { dep } from "./dep.ts";`]));
      }
    });
    const aBefore = await get(h.registry, "alpha");
    const bBefore = await get(h.registry, "beta");

    await write(join(h.dir, "alpha", "dep.ts"), `export const dep = "alpha2";\n`);
    const summary = await h.waitForReloadOf(new Set(["alpha"]));
    assertEquals(summary.reloaded, ["alpha"]);

    const aAfter = await get(h.registry, "alpha");
    assertEquals(aAfter.value, "alpha2");
    assert(aAfter.load !== aBefore.load, "alpha must have re-imported");
    assertEquals(await get(h.registry, "beta"), bBefore, "beta must NOT re-import");
  });

  test("editing a shared module reloads only its importers", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "_shared", "greet.ts"), `export const greet = "hi-v1";\n`);
      await write(join(root, "_shared", "other.ts"), `export const other = "other-v1";\n`);
      for (const n of ["alpha", "beta"]) {
        await write(join(root, n, "index.ts"), fnSource("greet", [`import { greet } from "../_shared/greet.ts";`]));
      }
      // gamma uses a *different* shared file, so it must NOT reload.
      await write(join(root, "gamma", "index.ts"), fnSource("other", [`import { other } from "../_shared/other.ts";`]));
    });
    const gammaBefore = await get(h.registry, "gamma");

    await write(join(h.dir, "_shared", "greet.ts"), `export const greet = "hi-v2";\n`);
    const summary = await h.waitForReloadOf(new Set(["alpha", "beta"]));
    assertEquals(summary.reloaded, ["alpha", "beta"]);

    assertEquals((await get(h.registry, "alpha")).value, "hi-v2");
    assertEquals((await get(h.registry, "beta")).value, "hi-v2");
    assertEquals(await get(h.registry, "gamma"), gammaBefore);
  });

  test("editing a transitive dep (dep of a dep) propagates", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "_shared", "leaf.ts"), `export const leaf = "leaf-v1";\n`);
      await write(join(root, "_shared", "mid.ts"), `export { leaf as value } from "./leaf.ts";\n`);
      await write(join(root, "fn", "index.ts"), fnSource("value", [`import { value } from "../_shared/mid.ts";`]));
    });
    assertEquals((await get(h.registry, "fn")).value, "leaf-v1");
    await write(join(h.dir, "_shared", "leaf.ts"), `export const leaf = "leaf-v2";\n`);
    await h.waitForReloadOf(new Set(["fn"]));
    assertEquals((await get(h.registry, "fn")).value, "leaf-v2");
  });

  test("adding a new dependency import updates the graph for future edits", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "fn", "index.ts"), fnSource(`"without-dep"`));
      await write(join(root, "_shared", "late.ts"), `export const late = "late-v1";\n`);
    });
    assertEquals((await get(h.registry, "fn")).value, "without-dep");

    await write(join(h.dir, "fn", "index.ts"), fnSource("late", [`import { late } from "../_shared/late.ts";`]));
    await h.waitForReloadOf(new Set(["fn"]));
    assertEquals((await get(h.registry, "fn")).value, "late-v1");

    // Only the newly introduced dependency changes: the graph must know it.
    await write(join(h.dir, "_shared", "late.ts"), `export const late = "late-v2";\n`);
    await h.waitForReloadOf(new Set(["fn"]));
    assertEquals((await get(h.registry, "fn")).value, "late-v2");
  });

  test("rapid successive saves converge on the last version", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "alpha", "dep.ts"), `export const dep = "v0";\n`);
      await write(join(root, "alpha", "index.ts"), fnSource("dep", [`import { dep } from "./dep.ts";`]));
      await write(join(root, "beta", "index.ts"), fnSource(`"beta"`));
    });
    const bBefore = await get(h.registry, "beta");
    for (let i = 1; i <= 6; i++) {
      await write(join(h.dir, "alpha", "dep.ts"), `export const dep = "v${i}";\n`);
      await sleep(i % 2 === 0 ? 5 : 60); // some inside, some across a flush
    }
    const deadline = performance.now() + 5000;
    while ((await get(h.registry, "alpha")).value !== "v6" && performance.now() < deadline) {
      await sleep(25);
    }
    await h.waitForQuiet(300);
    assertEquals((await get(h.registry, "alpha")).value, "v6");
    assertEquals(h.summaries.flatMap((s) => s.errors), []);
    assert(h.summaries.every((s) => !s.reloaded.includes("beta")));
    assertEquals(await get(h.registry, "beta"), bBefore);
  });

  test("editing an unimported sidecar file does not reload its function", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "fn", "index.ts"), fnSource(`"fn-v1"`));
      await write(join(root, "fn", "notes.txt"), "not imported v1\n");
    });
    const before = h.registry.workerHandle("fn");
    await write(join(h.dir, "fn", "notes.txt"), "not imported v2\n");
    await h.waitForQuiet(400);
    assertEquals(h.registry.workerHandle("fn"), before);
    assertEquals(h.summaries.length, 0);
  });

  test("adding a new function dir at runtime makes it dispatchable", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "alpha", "index.ts"), fnSource(`"alpha"`));
    });
    const alphaBefore = await get(h.registry, "alpha");
    assertEquals(h.registry.workerHandle("brand-new"), undefined);

    await write(join(h.dir, "brand-new", "dep.ts"), `export const d = "brand-new-ok";\n`);
    await write(join(h.dir, "brand-new", "index.ts"), fnSource("d", [`import { d } from "./dep.ts";`]));
    const summary = await h.waitForReloadOf(new Set(["brand-new"]));
    assertEquals(summary.added, ["brand-new"]);
    assertEquals((await get(h.registry, "brand-new")).value, "brand-new-ok");
    assertEquals(await get(h.registry, "alpha"), alphaBefore);

    // The new function's sidecar is tracked from now on.
    await write(join(h.dir, "brand-new", "dep.ts"), `export const d = "brand-new-v2";\n`);
    await h.waitForReloadOf(new Set(["brand-new"]));
    assertEquals((await get(h.registry, "brand-new")).value, "brand-new-v2");
  });

  test("deleting a function dir removes it from the registry", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "doomed", "index.ts"), fnSource(`"doomed"`));
      await write(join(root, "alive", "index.ts"), fnSource(`"alive"`));
    });
    const aliveBefore = await get(h.registry, "alive");
    await rm(join(h.dir, "doomed"), { recursive: true });
    const summary = await h.waitForReloadOf(new Set(["doomed"]));
    assertEquals(summary.removed, ["doomed"]);
    assertEquals(h.registry.workerHandle("doomed"), undefined);
    assertEquals(h.registry.has("doomed"), false);
    assertEquals(await get(h.registry, "alive"), aliveBefore);
  });

  test("editing a file outside any function graph does NOT trigger a reload", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "alpha", "index.ts"), fnSource(`"alpha"`));
      await write(join(root, "README.md"), `# notes\n`);
      await write(join(root, "_shared", "untracked.ts"), `export const x = 1;\n`);
    });
    const before = h.registry.workerHandle("alpha");
    await write(join(h.dir, "README.md"), `# notes v2\n`);
    await write(join(h.dir, "_shared", "untracked.ts"), `export const x = 2;\n`);
    await h.waitForQuiet(400);
    assertEquals(h.registry.workerHandle("alpha"), before);
    assertEquals(h.summaries.length, 0);
  });

  test("a malformed edit keeps the old graph serving; a valid edit recovers", async () => {
    const h = await makeHarness(async (root) => {
      await write(join(root, "fn", "index.ts"), fnSource(`"v1"`));
    });
    assertEquals((await get(h.registry, "fn")).value, "v1");

    await write(
      join(h.dir, "fn", "index.ts"),
      `(globalThis as any).__edgeFunctionRegistry.register(() => new Response("broken"`,
    );
    // A failed reload has no "reloaded" entry; it reports the error.
    await h.waitForSummary((s) => s.errors.some((e) => e.name === "fn"));
    assertEquals(h.host.bootState("fn"), "failed");
    // The previous graph still answers while the file is broken.
    assertEquals((await get(h.registry, "fn")).value, "v1");

    await write(join(h.dir, "fn", "index.ts"), fnSource(`"v2-recovered"`));
    await h.waitForReloadOf(new Set(["fn"]));
    assertEquals(h.host.bootState("fn"), "ready");
    assertEquals((await get(h.registry, "fn")).value, "v2-recovered");
  });
});

// ---------------------------------------------------------------------------
// Host-level locality (no watcher): what a reload touches
// ---------------------------------------------------------------------------

describe("hmr-e2e: reload locality", () => {
  test("reloading one function never re-imports the others, regardless of project size", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-hmr-scale-")));
    const wide = Array.from({ length: 8 }, (_, i) => `fn${i}`);
    await write(join(dir, "_shared", "util.ts"), `export const shared = "S1";\n`);
    for (const n of wide) {
      await write(join(dir, n, "dep.ts"), `export const dep = "${n}1";\n`);
      await write(
        join(dir, n, "index.ts"),
        fnSource("dep + '/' + shared", [
          `import { shared } from "../_shared/util.ts";`,
          `import { dep } from "./dep.ts";`,
        ]),
      );
    }
    const registry = new FunctionRegistry();
    const host = createFunctionHost({
      functionsDir: dir,
      registry,
      supervisor: new FunctionSupervisor(),
      reloadDrainMs: 0,
    });
    harnesses.push(async () => {
      await host.stop();
      await rm(dir, { recursive: true, force: true });
    });
    assertEquals((await host.start()).errors, []);
    const before = new Map<string, string>();
    for (const n of wide) before.set(n, (await get(registry, n)).load);

    await write(join(dir, "fn3", "dep.ts"), `export const dep = "edited";\n`);
    const summary = await host.reload(new Set(["fn3"]), "scale");
    assertEquals(summary.reloaded, ["fn3"]);
    const fn3 = await get(registry, "fn3");
    assertEquals(fn3.value, "edited/S1");
    assert(fn3.load !== before.get("fn3"));
    for (const n of wide) {
      if (n === "fn3") continue;
      assertEquals((await get(registry, n)).load, before.get(n), `${n} must NOT have been re-imported`);
    }

    // Concurrent reloads of different functions don't corrupt routing.
    await write(join(dir, "fn1", "dep.ts"), `export const dep = "A!";\n`);
    await write(join(dir, "fn2", "dep.ts"), `export const dep = "B!";\n`);
    const [s1, s2] = await Promise.all([
      host.reload(new Set(["fn1"]), "concurrent a"),
      host.reload(new Set(["fn2"]), "concurrent b"),
    ]);
    assertEquals([...s1.errors, ...s2.errors], []);
    assertEquals((await get(registry, "fn1")).value, "A!/S1");
    assertEquals((await get(registry, "fn2")).value, "B!/S1");
    assertEquals((await get(registry, "fn0")).value, "fn01/S1");

    // Racing reloads of the SAME function serialize; the last writer wins.
    await write(join(dir, "fn4", "dep.ts"), `export const dep = "first";\n`);
    const r1 = host.reload(new Set(["fn4"]), "race 1");
    await write(join(dir, "fn4", "dep.ts"), `export const dep = "second";\n`);
    const r2 = host.reload(new Set(["fn4"]), "race 2");
    await Promise.all([r1, r2]);
    assertEquals((await get(registry, "fn4")).value, "second/S1");
  });
});

// ---------------------------------------------------------------------------
// Real gateway process
// ---------------------------------------------------------------------------

function freePort(): number {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

// Same value the --dev defaults block in src/server.ts seeds.
const DEV_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
let devToken: Promise<string> | null = null;

async function waitForHttpText(url: string, expected: string, timeoutMs = 10000): Promise<void> {
  // `Deno.serve` handlers are authenticated (Supabase's verify_jwt default).
  devToken ??= signJwt(DEV_JWT_SECRET);
  const headers = { authorization: `Bearer ${await devToken}` };
  const deadline = performance.now() + timeoutMs;
  let last = "";
  while (performance.now() < deadline) {
    try {
      const res = await fetch(url, { headers });
      last = `${res.status} ${await res.text()}`;
      if (res.ok && last.endsWith(` ${expected}`)) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${url} to return ${expected}; last=${last}`);
}

/** Boot `src/server.ts --dev --hmr` on a temp project; returns its base URL. */
async function spawnGateway(
  root: string,
  functionsDir: string,
  extraArgs: string[] = [],
): Promise<{ base: string; stop: () => Promise<string> }> {
  const port = freePort();
  const proc = Bun.spawn(
    [
      process.execPath,
      SERVER,
      "--dev",
      "--hmr",
      "--functions",
      functionsDir,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      ...extraArgs,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        ...devGatewayEnv({
          "1TUBE_DEPS_DIR": join(root, ".1tube", "deps"),
          // HMR correctness, not rate limiting: keep the pollers from 429ing.
          "1TUBE_DISABLE_RATE_LIMIT": "1",
          "1TUBE_INVOCATION_LOGS": "0",
        }),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const out = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    .then(([o, e]) => o + e);
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      proc.kill("SIGTERM");
      const exited = await Promise.race([proc.exited.then(() => true), sleep(5000).then(() => false)]);
      if (!exited) proc.kill("SIGKILL");
    }
    return await out;
  };
  harnesses.push(async () => {
    await stop();
  });
  return { base: `http://127.0.0.1:${port}/functions/v1`, stop };
}

async function gatewayProject(prefix: string): Promise<{ root: string; functionsDir: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  harnesses.push(() => rm(root, { recursive: true, force: true }));
  return { root, functionsDir: join(root, "supabase", "functions") };
}

const plainFn = (expr: string, imports: string[] = []) =>
  `${imports.join("\n")}\nDeno.serve(() => new Response(${expr}));\n`;

describe("hmr-e2e: gateway process", () => {
  for (const mode of ["--share-deps", "--isolate-deps"]) {
    test(`deno.json import-map library update reloads consumers (${mode})`, async () => {
      const { root, functionsDir } = await gatewayProject("1tube-hmr-config-");
      await write(
        join(functionsDir, "deno.json"),
        JSON.stringify({ imports: { "@fake/lib": "./_vendor/fake-lib.ts" } }),
      );
      await write(join(functionsDir, "_vendor", "fake-lib.ts"), `export const version = "lib-v1";\n`);
      await write(join(functionsDir, "uses-lib", "index.ts"), plainFn("version", [`import { version } from "@fake/lib";`]));
      await write(join(functionsDir, "plain", "index.ts"), plainFn(`"plain"`));

      const gw = await spawnGateway(root, functionsDir, [mode]);
      try {
        await waitForHttpText(`${gw.base}/uses-lib`, "lib-v1", 30000);
        await waitForHttpText(`${gw.base}/plain`, "plain", 5000);

        await write(join(functionsDir, "_vendor", "fake-lib.ts"), `export const version = "lib-v2";\n`);
        await waitForHttpText(`${gw.base}/uses-lib`, "lib-v2", 10000);
        await waitForHttpText(`${gw.base}/plain`, "plain", 5000);
      } catch (err) {
        throw new Error(`${(err as Error).message}\n--- gateway output ---\n${await gw.stop()}`);
      }
    }, 60_000);
  }

  test("scoped import-map library update reloads consumers", async () => {
    const { root, functionsDir } = await gatewayProject("1tube-hmr-scoped-");
    await write(
      join(functionsDir, "deno.json"),
      JSON.stringify({ scopes: { "./uses-scoped/": { "@scoped/lib": "./_vendor/scoped-lib.ts" } } }),
    );
    await write(join(functionsDir, "_vendor", "scoped-lib.ts"), `export const version = "scoped-v1";\n`);
    await write(join(functionsDir, "uses-scoped", "index.ts"), plainFn("version", [`import { version } from "@scoped/lib";`]));

    const gw = await spawnGateway(root, functionsDir);
    try {
      await waitForHttpText(`${gw.base}/uses-scoped`, "scoped-v1", 30000);
      await write(join(functionsDir, "_vendor", "scoped-lib.ts"), `export const version = "scoped-v2";\n`);
      await waitForHttpText(`${gw.base}/uses-scoped`, "scoped-v2", 10000);
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- gateway output ---\n${await gw.stop()}`);
    }
  }, 60_000);

  test("shared profile-cache imported via an import-map alias runs once and hot-reloads", async () => {
    const { root, functionsDir } = await gatewayProject("1tube-hmr-shared-alias-");
    const evalLog = join(root, "profile-cache-evals.log");
    await write(evalLog, "");
    await write(
      join(functionsDir, "deno.json"),
      JSON.stringify({ imports: { "@shared/profile-cache": "./_shared/profile-cache.ts" } }),
    );
    const sharedSrc = (v: string) => `const logPath = ${JSON.stringify(evalLog)};
Deno.writeTextFileSync(logPath, "x", { append: true });
export async function getCachedProfile(userId) {
  return { userId, v: ${JSON.stringify(v)} };
}
`;
    await write(join(functionsDir, "_shared", "profile-cache.ts"), sharedSrc("v1"));
    for (const name of ["one", "two"]) {
      await write(
        join(functionsDir, name, "index.ts"),
        `import { getCachedProfile } from "@shared/profile-cache";
Deno.serve(async () => Response.json(await getCachedProfile("${name}")));
`,
      );
    }

    const gw = await spawnGateway(root, functionsDir);
    try {
      await waitForHttpText(`${gw.base}/one`, `{"userId":"one","v":"v1"}`, 30000);
      await waitForHttpText(`${gw.base}/two`, `{"userId":"two","v":"v1"}`, 5000);
      assertEquals(
        await readFile(evalLog, "utf8"),
        "x",
        "profile-cache side effect should run once in the gateway, not once per function",
      );

      await write(join(functionsDir, "_shared", "profile-cache.ts"), sharedSrc("v2"));
      await waitForHttpText(`${gw.base}/one`, `{"userId":"one","v":"v2"}`, 10000);
      await waitForHttpText(`${gw.base}/two`, `{"userId":"two","v":"v2"}`, 5000);
      assertEquals(await readFile(evalLog, "utf8"), "xx", "one re-evaluation per shared edit");
    } catch (err) {
      throw new Error(`${(err as Error).message}\n--- gateway output ---\n${await gw.stop()}`);
    }
  }, 60_000);
});
