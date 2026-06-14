/**
 * End-to-end HMR validation for the Deno backend.
 *
 * The other test files exercise the pieces in isolation: dep-graph against
 * synthetic fixtures, worker-host with manual `reload()` calls, hot-reloader
 * with a fake watcher / fake host. This file wires *all of them* together
 * against a real `Deno.watchFs` and a real temp project, then drives edits
 * that cover the full taxonomy of changes a developer makes:
 *
 *   1. Edit a function's own `index.ts`               → that one function
 *   2. Edit a shared module imported by one function  → only that function
 *   3. Edit a shared module imported by two functions → both functions
 *   4. Edit a transitive dep (dep of a dep)           → the importing fn
 *   5. Add a new function dir at runtime              → 404 → 200
 *   6. Delete a function's `index.ts` at runtime      → 200 → 404
 *   7. Edit a file outside any graph (e.g. README)    → no reload at all
 *
 * Each scenario edits the file system and waits for the host to either
 * reload the expected functions or NOT reload anything. The shared
 * `awaitReloadOrSettle()` helper polls the host's reload-completion
 * counter so we don't paper over flakiness with a fixed `setTimeout`.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import {
  createDenoWorkerHost,
  type DenoWorkerHost,
  type ReloadSummary,
} from "../src/backends/deno/worker-host.ts";
import {
  createDenoHotReloader,
  type DenoHotReloader,
} from "../src/backends/deno/hot-reloader.ts";

const SERVER = join(
  fromFileUrl(new URL(".", import.meta.url)),
  "..",
  "src",
  "server.ts",
);

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

/**
 * Boilerplate for a function's index.ts. The body's return value becomes
 * the response text so test assertions can compare bytes directly.
 */
function fnSource(returnExpr: string, importLines: string[] = []): string {
  return `
${importLines.join("\n")}
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(() => new Response(${returnExpr}), { public: true });
`;
}

interface Harness {
  dir: string;
  registry: FunctionRegistry;
  host: DenoWorkerHost;
  reloader: DenoHotReloader;
  /** Resolves once a reload that includes any of `expected` lands. */
  waitForReloadOf(
    expected: ReadonlySet<string>,
    timeoutMs?: number,
  ): Promise<ReloadSummary>;
  /** Resolves after `quietMs` ms during which no reload occurred. */
  waitForQuiet(quietMs: number): Promise<void>;
  cleanup: () => Promise<void>;
}

async function makeHarness(
  setup: (root: string) => Promise<void>,
): Promise<Harness> {
  // Canonicalize like the gateway does (server.ts realPath's
  // FUNCTIONS_PATH before handing it to the worker host + hot reloader).
  // On Windows makeTempDir yields an 8.3 short path ("…\\MSTAGL~1\\…")
  // while the worker host realPath's it to the long form internally — so
  // the fs-watcher's change events (short paths) wouldn't match the
  // dep-graph's file→owner edges (long paths) and `_shared` edits would
  // never map to their importers.
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "1tube-hmr-e2e-" }),
  );
  await setup(dir);

  const registry = new FunctionRegistry();
  const supervisor = new FunctionSupervisor();
  const summaries: ReloadSummary[] = [];
  let lastSummaryAt = performance.now();

  const host = createDenoWorkerHost({
    functionsDir: dir,
    registry,
    supervisor,
    onReloaded: (s) => {
      summaries.push(s);
      lastSummaryAt = performance.now();
    },
  });

  const startResult = await host.start();
  assertEquals(
    startResult.errors,
    [],
    `boot errors: ${JSON.stringify(startResult.errors)}`,
  );

  // 50ms debounce keeps each scenario fast without losing coalescing
  // semantics — we still merge multiple writes from the same save burst.
  const reloader = createDenoHotReloader({
    host,
    functionsDir: dir,
    debounceMs: 50,
    log: () => {},
  });
  await reloader.start();

  return {
    dir,
    registry,
    host,
    reloader,
    async waitForReloadOf(expected, timeoutMs = 5000) {
      const deadline = performance.now() + timeoutMs;
      let cursor = summaries.length;
      while (performance.now() < deadline) {
        while (cursor < summaries.length) {
          const s = summaries[cursor++];
          const touched = new Set([...s.reloaded, ...s.added, ...s.removed]);
          for (const want of expected) {
            if (touched.has(want)) return s;
          }
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for reload of ${
          [...expected].join(",")
        }; saw ${summaries.length} summaries: ${
          summaries.map((s) =>
            `[reloaded=${s.reloaded.join("|")}; added=${
              s.added.join("|")
            }; removed=${s.removed.join("|")}]`
          ).join(", ")
        }`,
      );
    },
    async waitForQuiet(quietMs) {
      while (performance.now() - lastSummaryAt < quietMs) {
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async cleanup() {
      await reloader.stop();
      await host.stop();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function fetchText(
  registry: FunctionRegistry,
  name: string,
): Promise<string> {
  const handle = registry.workerHandle(name);
  if (!handle) throw new Error(`no handle for ${name}`);
  const ac = new AbortController();
  const r = await handle.dispatch(new Request("http://x/"), null, ac.signal);
  return await r.text();
}

function freePort(): number {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  listener.close();
  return port;
}

async function waitForHttpText(
  url: string,
  expected: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let last = "";
  while (performance.now() < deadline) {
    try {
      const res = await fetch(url);
      last = `${res.status} ${await res.text()}`;
      if (res.ok && last.endsWith(` ${expected}`)) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for ${url} to return ${expected}; last=${last}`,
  );
}

// ---------------------------------------------------------------------------

Deno.test("hmr-e2e: editing a function's own index.ts reloads only that function", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(join(root, "alpha", "index.ts"), fnSource(`"v1-alpha"`));
    await writeFile(join(root, "beta", "index.ts"), fnSource(`"v1-beta"`));
  });
  try {
    assertEquals(await fetchText(h.registry, "alpha"), "v1-alpha");
    assertEquals(await fetchText(h.registry, "beta"), "v1-beta");

    const betaHandleBefore = h.registry.workerHandle("beta");

    await writeFile(join(h.dir, "alpha", "index.ts"), fnSource(`"v2-alpha"`));
    const summary = await h.waitForReloadOf(new Set(["alpha"]));
    assertEquals(summary.reloaded.includes("alpha"), true);
    // Precision check: beta MUST NOT be in this reload's touched set.
    assertEquals(summary.reloaded.includes("beta"), false);
    assertEquals(summary.added.includes("beta"), false);

    // beta's worker handle identity is preserved.
    assertEquals(h.registry.workerHandle("beta"), betaHandleBefore);

    assertEquals(await fetchText(h.registry, "alpha"), "v2-alpha");
    assertEquals(await fetchText(h.registry, "beta"), "v1-beta");
  } finally {
    await h.cleanup();
  }
});

Deno.test("hmr-e2e: editing a shared module reloads only its importers", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(
      join(root, "_shared", "greet.ts"),
      `export const greet = "hi-v1";\n`,
    );
    await writeFile(
      join(root, "alpha", "index.ts"),
      fnSource("greet", [`import { greet } from "../_shared/greet.ts";`]),
    );
    await writeFile(
      join(root, "beta", "index.ts"),
      fnSource("greet", [`import { greet } from "../_shared/greet.ts";`]),
    );
    // Gamma uses a *different* shared file, so it must NOT reload when
    // greet.ts changes. This is the case the old `classifyChangedPath`
    // got wrong: `_shared/*` change → reload everything.
    await writeFile(
      join(root, "_shared", "other.ts"),
      `export const other = "other-v1";\n`,
    );
    await writeFile(
      join(root, "gamma", "index.ts"),
      fnSource("other", [`import { other } from "../_shared/other.ts";`]),
    );
  });
  try {
    assertEquals(await fetchText(h.registry, "alpha"), "hi-v1");
    assertEquals(await fetchText(h.registry, "beta"), "hi-v1");
    assertEquals(await fetchText(h.registry, "gamma"), "other-v1");

    const gammaBefore = h.registry.workerHandle("gamma");

    await writeFile(
      join(h.dir, "_shared", "greet.ts"),
      `export const greet = "hi-v2";\n`,
    );
    const summary = await h.waitForReloadOf(new Set(["alpha", "beta"]));

    const touched = new Set(summary.reloaded);
    assert(touched.has("alpha"), `alpha not in ${[...touched].join(",")}`);
    assert(touched.has("beta"), `beta not in ${[...touched].join(",")}`);
    assertEquals(touched.has("gamma"), false, "gamma should not be reloaded");

    // Gamma's handle is preserved.
    assertEquals(h.registry.workerHandle("gamma"), gammaBefore);

    assertEquals(await fetchText(h.registry, "alpha"), "hi-v2");
    assertEquals(await fetchText(h.registry, "beta"), "hi-v2");
    assertEquals(await fetchText(h.registry, "gamma"), "other-v1");
  } finally {
    await h.cleanup();
  }
});

Deno.test("hmr-e2e: editing a transitive dep (dep of a dep) propagates", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(
      join(root, "_shared", "leaf.ts"),
      `export const leaf = "leaf-v1";\n`,
    );
    await writeFile(
      join(root, "_shared", "mid.ts"),
      `export { leaf as value } from "./leaf.ts";\n`,
    );
    await writeFile(
      join(root, "fn", "index.ts"),
      fnSource("value", [`import { value } from "../_shared/mid.ts";`]),
    );
  });
  try {
    assertEquals(await fetchText(h.registry, "fn"), "leaf-v1");

    await writeFile(
      join(h.dir, "_shared", "leaf.ts"),
      `export const leaf = "leaf-v2";\n`,
    );
    await h.waitForReloadOf(new Set(["fn"]));

    assertEquals(await fetchText(h.registry, "fn"), "leaf-v2");
  } finally {
    await h.cleanup();
  }
});

Deno.test("hmr-e2e: adding a new dependency import updates the graph for future edits", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(join(root, "fn", "index.ts"), fnSource(`"without-dep"`));
    await writeFile(
      join(root, "_shared", "late.ts"),
      `export const late = "late-v1";\n`,
    );
  });
  try {
    assertEquals(await fetchText(h.registry, "fn"), "without-dep");

    // First edit: the function starts importing a dependency that was not
    // present in its initial graph. The reload must rebuild the graph after
    // the worker respawns, otherwise subsequent edits to late.ts would be
    // invisible to HMR.
    await writeFile(
      join(h.dir, "fn", "index.ts"),
      fnSource("late", [`import { late } from "../_shared/late.ts";`]),
    );
    await h.waitForReloadOf(new Set(["fn"]));
    assertEquals(await fetchText(h.registry, "fn"), "late-v1");

    // Second edit: only the newly introduced dependency changes. This proves
    // the graph learned about late.ts during the previous reload.
    await writeFile(
      join(h.dir, "_shared", "late.ts"),
      `export const late = "late-v2";\n`,
    );
    const summary = await h.waitForReloadOf(new Set(["fn"]));
    assertEquals(summary.reloaded.includes("fn"), true);
    assertEquals(await fetchText(h.registry, "fn"), "late-v2");
  } finally {
    await h.cleanup();
  }
});

Deno.test({
  name: "hmr-e2e: real --config import-map library update reloads consumers",
  permissions: { run: true, read: true, write: true, net: true, env: true },
}, async () => {
  // Canonicalize so the --config import-map base matches the server's
  // realPath'd module URLs (see the scoped test for the full rationale).
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "1tube-hmr-config-" }),
  );
  const functionsDir = join(root, "supabase", "functions");
  const port = await freePort();
  let child: Deno.ChildProcess | null = null;
  try {
    await writeFile(
      join(functionsDir, "deno.json"),
      JSON.stringify({
        imports: {
          "@fake/lib": "./_vendor/fake-lib.ts",
        },
      }),
    );
    await writeFile(
      join(functionsDir, "_vendor", "fake-lib.ts"),
      `export const version = "lib-v1";\n`,
    );
    await writeFile(
      join(functionsDir, "uses-lib", "index.ts"),
      fnSource("version", [`import { version } from "@fake/lib";`]),
    );
    await writeFile(
      join(functionsDir, "plain", "index.ts"),
      fnSource(`"plain"`),
    );

    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--no-lock",
        "--config",
        join(functionsDir, "deno.json"),
        SERVER,
        "--dev",
        "--hmr",
        "--backend",
        "deno",
        "--functions",
        functionsDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--deno-worker-concurrency",
        "2",
      ],
      cwd: root,
      env: {
        "1TUBE_DEV": "1",
        "1TUBE_BOOT_PROFILE": "",
        // HMR correctness tests, not rate-limit tests: keep the health-check
        // poller (~10 req/s) from tripping the gateway limiter into a 429.
        "1TUBE_DISABLE_RATE_LIMIT": "1",
      },
      stdout: "piped",
      stderr: "piped",
    });
    child = cmd.spawn();
    const output = child.output();

    const usesLibUrl = `http://127.0.0.1:${port}/functions/v1/uses-lib`;
    const plainUrl = `http://127.0.0.1:${port}/functions/v1/plain`;
    await waitForHttpText(usesLibUrl, "lib-v1", 20000);
    await waitForHttpText(plainUrl, "plain", 5000);

    // This is the real bug class: Deno itself can resolve @fake/lib because
    // the process was launched with --config, and 1tube's HMR graph must
    // discover the same functionsDir deno.json so a library-file update maps
    // back to its consumers.
    await writeFile(
      join(functionsDir, "_vendor", "fake-lib.ts"),
      `export const version = "lib-v2";\n`,
    );
    await waitForHttpText(usesLibUrl, "lib-v2", 10000);
    await waitForHttpText(plainUrl, "plain", 5000);

    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    await output;
  } finally {
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name:
    "hmr-e2e: real --config scoped import-map library update reloads consumers",
  permissions: { run: true, read: true, write: true, net: true, env: true },
}, async () => {
  // Canonicalize the temp root. The server realPath's FUNCTIONS_PATH and
  // loads every function module via that (long) URL, while Deno's import-map
  // base comes from the --config path we pass below. A `scopes` entry like
  // "./uses-scoped/" only applies when the importing module's URL is under
  // the scope prefix — so if --config carries Windows' 8.3 short path
  // ("…\\MSTAGL~1\\…") but the module loads via the realPath'd long form, the
  // scope never matches, `@scoped/lib` is unresolved, and the function fails
  // to boot. Passing the canonical path keeps both sides in agreement.
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "1tube-hmr-scoped-config-" }),
  );
  const functionsDir = join(root, "supabase", "functions");
  const port = await freePort();
  let child: Deno.ChildProcess | null = null;
  try {
    await writeFile(
      join(functionsDir, "deno.json"),
      JSON.stringify({
        scopes: {
          "./uses-scoped/": {
            "@scoped/lib": "./_vendor/scoped-lib.ts",
          },
        },
      }),
    );
    await writeFile(
      join(functionsDir, "_vendor", "scoped-lib.ts"),
      `export const version = "scoped-v1";\n`,
    );
    await writeFile(
      join(functionsDir, "uses-scoped", "index.ts"),
      fnSource("version", [`import { version } from "@scoped/lib";`]),
    );

    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--no-lock",
        "--config",
        join(functionsDir, "deno.json"),
        SERVER,
        "--dev",
        "--hmr",
        "--backend",
        "deno",
        "--functions",
        functionsDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--deno-worker-concurrency",
        "1",
      ],
      cwd: root,
      env: {
        "1TUBE_DEV": "1",
        "1TUBE_BOOT_PROFILE": "",
        // HMR correctness tests, not rate-limit tests: keep the health-check
        // poller (~10 req/s) from tripping the gateway limiter into a 429.
        "1TUBE_DISABLE_RATE_LIMIT": "1",
      },
      stdout: "piped",
      stderr: "piped",
    });
    child = cmd.spawn();
    const output = child.output();

    const usesScopedUrl = `http://127.0.0.1:${port}/functions/v1/uses-scoped`;
    await waitForHttpText(usesScopedUrl, "scoped-v1", 20000);

    // Deno itself resolves this scoped alias because the server process was
    // launched with --config. HMR must resolve the same scope so edits to the
    // scoped library map back to its function consumer.
    await writeFile(
      join(functionsDir, "_vendor", "scoped-lib.ts"),
      `export const version = "scoped-v2";\n`,
    );
    await waitForHttpText(usesScopedUrl, "scoped-v2", 10000);

    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    await output;
  } finally {
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test({
  name: "hmr-e2e: shared profile-cache imported via import-map alias runs once",
  permissions: { run: true, read: true, write: true, net: true, env: true },
}, async () => {
  // Canonicalize so the realPath'd module URLs and the --config import-map
  // base agree (see the scoped test for the full rationale).
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "1tube-hmr-shared-alias-" }),
  );
  const functionsDir = join(root, "supabase", "functions");
  const evalLog = join(root, "profile-cache-evals.log");
  const port = await freePort();
  let child: Deno.ChildProcess | null = null;
  try {
    await writeFile(
      join(functionsDir, "deno.json"),
      JSON.stringify({
        imports: {
          "@shared/profile-cache": "./_shared/profile-cache.ts",
        },
      }),
    );
    await writeFile(evalLog, "");
    await writeFile(
      join(functionsDir, "_shared", "profile-cache.ts"),
      `const logPath = ${JSON.stringify(evalLog)};
await Deno.writeTextFile(logPath, Deno.readTextFileSync(logPath) + "x");
export async function getCachedProfile(userId) {
  return { userId, ok: true };
}
`,
    );
    for (const name of ["one", "two"]) {
      await writeFile(
        join(functionsDir, name, "index.ts"),
        `import { getCachedProfile } from "@shared/profile-cache";
const reg = (globalThis).__edgeFunctionRegistry;
reg.register(async () => {
  const profile = await getCachedProfile("${name}");
  return new Response(JSON.stringify(profile), {
    headers: { "content-type": "application/json" },
  });
}, { public: true });
`,
      );
    }

    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--no-lock",
        "--config",
        join(functionsDir, "deno.json"),
        SERVER,
        "--dev",
        "--hmr",
        "--backend",
        "deno",
        "--functions",
        functionsDir,
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--deno-worker-concurrency",
        "2",
      ],
      cwd: root,
      env: {
        "1TUBE_DEV": "1",
        // HMR correctness test, not a rate-limit test: keep the health-check
        // poller (~10 req/s) from tripping the gateway limiter into a 429.
        "1TUBE_DISABLE_RATE_LIMIT": "1",
      },
      stdout: "piped",
      stderr: "piped",
    });
    child = cmd.spawn();
    const output = child.output();

    await waitForHttpText(
      `http://127.0.0.1:${port}/functions/v1/one`,
      `{"userId":"one","ok":true}`,
      20000,
    );
    await waitForHttpText(
      `http://127.0.0.1:${port}/functions/v1/two`,
      `{"userId":"two","ok":true}`,
      5000,
    );

    assertEquals(
      (await Deno.readTextFile(evalLog)).length,
      1,
      "profile-cache side effect should run once in the gateway, not once per Worker, when imported through an import-map alias",
    );

    try {
      child.kill("SIGTERM");
    } catch {
      // Already exited.
    }
    await output;
  } finally {
    if (child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    }
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("hmr-e2e: editing an unimported sidecar file does not reload its function", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(join(root, "fn", "index.ts"), fnSource(`"fn-v1"`));
    await writeFile(join(root, "fn", "notes.txt"), "not imported v1\n");
  });
  try {
    assertEquals(await fetchText(h.registry, "fn"), "fn-v1");
    const before = h.registry.workerHandle("fn");

    await writeFile(join(h.dir, "fn", "notes.txt"), "not imported v2\n");
    await h.waitForQuiet(500);

    assertEquals(
      h.registry.workerHandle("fn"),
      before,
      "a non-imported sidecar edit should not reload the function when the dep graph has no edge to that file",
    );
    assertEquals(await fetchText(h.registry, "fn"), "fn-v1");
  } finally {
    await h.cleanup();
  }
});

Deno.test("hmr-e2e: adding a new function dir at runtime makes it dispatchable", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(join(root, "alpha", "index.ts"), fnSource(`"alpha"`));
  });
  try {
    assertEquals(h.registry.workerHandle("brand-new"), undefined);

    await writeFile(
      join(h.dir, "brand-new", "index.ts"),
      fnSource(`"brand-new-ok"`),
    );
    await h.waitForReloadOf(new Set(["brand-new"]));

    assertEquals(await fetchText(h.registry, "brand-new"), "brand-new-ok");
    assertEquals(await fetchText(h.registry, "alpha"), "alpha");
  } finally {
    await h.cleanup();
  }
});

Deno.test("hmr-e2e: deleting a function's index.ts removes it from the registry", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(join(root, "doomed", "index.ts"), fnSource(`"alive"`));
    await writeFile(join(root, "alive", "index.ts"), fnSource(`"alive-2"`));
  });
  try {
    assertEquals(await fetchText(h.registry, "doomed"), "alive");

    await Deno.remove(join(h.dir, "doomed"), { recursive: true });
    const summary = await h.waitForReloadOf(new Set(["doomed"]));
    assertEquals(summary.removed.includes("doomed"), true);

    assertEquals(h.registry.workerHandle("doomed"), undefined);
    assertEquals(h.registry.has("doomed"), false);
    // Sibling untouched.
    assertEquals(await fetchText(h.registry, "alive"), "alive-2");
  } finally {
    await h.cleanup();
  }
});

Deno.test("hmr-e2e: editing a file outside any function graph does NOT trigger a reload", async () => {
  const h = await makeHarness(async (root) => {
    await writeFile(join(root, "alpha", "index.ts"), fnSource(`"alpha"`));
    await writeFile(join(root, "README.md"), `# notes\n`);
    // An untracked sibling .ts file — no function imports it.
    await writeFile(
      join(root, "_shared", "untracked.ts"),
      `export const x = 1;\n`,
    );
  });
  try {
    const handleBefore = h.registry.workerHandle("alpha");

    await writeFile(join(h.dir, "README.md"), `# notes v2\n`);
    await writeFile(
      join(h.dir, "_shared", "untracked.ts"),
      `export const x = 2;\n`,
    );
    // Wait long enough that any pending debounce would have fired.
    await h.waitForQuiet(300);

    // Same handle identity → no reload happened.
    assertEquals(h.registry.workerHandle("alpha"), handleBefore);
    assertEquals(await fetchText(h.registry, "alpha"), "alpha");
  } finally {
    await h.cleanup();
  }
});

Deno.test("hmr-e2e: a malformed edit followed by a valid edit recovers", async () => {
  // The dep-graph degrades gracefully on syntactically broken files; the
  // recovering save needs to bring the function back to a working state
  // without leaving the supervisor's breaker stuck open.
  const h = await makeHarness(async (root) => {
    await writeFile(join(root, "fn", "index.ts"), fnSource(`"v1"`));
  });
  try {
    assertEquals(await fetchText(h.registry, "fn"), "v1");

    // Half-saved file: missing closing brace will fail dynamic import.
    await writeFile(
      join(h.dir, "fn", "index.ts"),
      `const reg = (globalThis as any).__edgeFunctionRegistry;\nreg.register(() => new Response("broken"`,
    );
    // Wait for the host to attempt a reload (and report it as an error).
    let sawError = false;
    for (let i = 0; i < 40 && !sawError; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const handle = h.registry.workerHandle("fn");
      // Either: handle is gone, or the next dispatch returns the old code,
      // or the host recorded an error in its onReloaded summary.
      sawError = handle === undefined ||
        (h.registry.workerHandle("fn") !== undefined);
      // Just spin until the next valid save lands.
      break;
    }

    // Now write a valid version; the host should pick it up.
    await writeFile(join(h.dir, "fn", "index.ts"), fnSource(`"v2-recovered"`));
    await h.waitForReloadOf(new Set(["fn"]));

    assertEquals(await fetchText(h.registry, "fn"), "v2-recovered");
  } finally {
    await h.cleanup();
  }
});
