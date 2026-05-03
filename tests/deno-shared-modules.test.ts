/**
 * Shared-module integration tests for the Deno backend.
 *
 * Validates the workerd-equivalent behavior we just added:
 *
 *   1. A shared module's top-level side effect runs ONCE total in the
 *      gateway, regardless of how many functions import it.
 *   2. The auto-generated stub re-exports each function name and
 *      round-trips into the gateway via the worker-host's postMessage
 *      RPC — return values land back at the caller intact.
 *   3. Editing a shared module re-runs its initialization in the
 *      gateway (cache-bust import), so a side-effect counter sees the
 *      bump on next call.
 *
 * Why these tests exist: the Deno backend used to evaluate every
 * imported module once per Worker. With 53 functions sharing
 * `_shared/profile-cache.ts`, that meant 53 websocket subscriptions
 * at boot. The fix is the source-rewriter + shared-runtime pair;
 * these tests are the canary that catches anyone re-introducing
 * per-Worker evaluation of shared code.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createDenoWorkerHost } from "../src/backends/deno/worker-host.ts";
import {
  createDenoSharedRuntime,
  discoverSharedModules,
} from "../src/backends/deno/shared-runtime.ts";
import { createRewriteCache } from "../src/backends/deno/source-rewriter.ts";

async function write(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

interface Project {
  dir: string;
  cleanup: () => Promise<void>;
}

/**
 * Build a temp project with N functions, each importing the same
 * `_shared/profile-cache.ts`. Returns the dir + a cleanup hook.
 *
 * The shared module writes a one-line "I was evaluated" record to
 * `<dir>/.shared-evals.log` at top level. Each function's handler
 * returns the result of `getCachedProfile("u1")` so the test can
 * confirm the RPC actually reaches the gateway.
 */
async function makeProject(numFns: number): Promise<Project> {
  const dir = await Deno.makeTempDir({ prefix: "1tube-shared-test-" });
  const evalLog = join(dir, ".shared-evals.log");
  // Best-effort: ensure the file exists so the shared module can
  // append. Avoids races where two cache-bust imports try to create
  // the file at the same time.
  await Deno.writeTextFile(evalLog, "");

  await write(
    join(dir, "_shared", "profile-cache.ts"),
    `// Top-level side effect: append a marker to a side-channel file
// so the test can count gateway-side evaluations from outside.
const evalLog = ${JSON.stringify(evalLog)};
await Deno.writeTextFile(evalLog, Deno.readTextFileSync(evalLog) + "x");

const cache = new Map([
  ["u1", { userId: "u1", role: "teacher" }],
]);

export async function getCachedProfile(userId) {
  return cache.get(userId) ?? null;
}

export async function pingShared() {
  return "pong";
}
`,
  );

  for (let i = 0; i < numFns; i++) {
    const name = `fn${i}`;
    await write(
      join(dir, name, "index.ts"),
      `import { getCachedProfile } from "../_shared/profile-cache.ts";

const reg = (globalThis).__edgeFunctionRegistry;
reg.register(
  async () => {
    const profile = await getCachedProfile("u1");
    return new Response(JSON.stringify({ from: "${name}", profile }), {
      headers: { "content-type": "application/json" },
    });
  },
  { public: true },
);
`,
    );
  }

  return {
    dir,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

Deno.test(
  "shared modules: top-level side effect runs ONCE across many Workers",
  async () => {
    const proj = await makeProject(5);
    try {
      const evalLog = join(proj.dir, ".shared-evals.log");
      const shared = await discoverSharedModules(proj.dir);
      assertEquals(shared.length, 1);
      assertEquals(shared[0].id, "profile-cache");

      const sharedRuntime = await createDenoSharedRuntime(shared);
      const cacheDir = await Deno.makeTempDir({ prefix: "1tube-rewrite-" });
      const rewriteCache = createRewriteCache({ cacheDir, sharedRuntime });

      const registry = new FunctionRegistry();
      const supervisor = new FunctionSupervisor();
      const host = createDenoWorkerHost({
        functionsDir: proj.dir,
        registry,
        supervisor,
        sharedRuntime,
        rewriteCache,
      });
      try {
        const { loaded, errors } = await host.start();
        assertEquals(errors, []);
        assertEquals(loaded.length, 5);

        // Side-effect ran exactly once: the gateway dynamically
        // imported the shared module on createDenoSharedRuntime, and
        // the 5 Workers got stub copies (no re-evaluation).
        const log = await Deno.readTextFile(evalLog);
        assertEquals(
          log.length,
          1,
          `expected one evaluation marker, got ${log.length}: ${JSON.stringify(log)}`,
        );

        // RPC actually reaches the gateway: dispatch every fn and
        // verify the profile returned by the shared cache.
        const abort = new AbortController();
        for (const name of loaded) {
          const handle = registry.workerHandle(name);
          assert(handle, `missing worker handle for ${name}`);
          const resp = await handle.dispatch(
            new Request("http://localhost/"),
            null,
            abort.signal,
          );
          assertEquals(resp.status, 200);
          const body = await resp.json() as {
            from: string;
            profile: { userId: string; role: string } | null;
          };
          assertEquals(body.from, name);
          assertEquals(body.profile, { userId: "u1", role: "teacher" });
        }

        // Still only one evaluation after 5 RPC round-trips.
        const log2 = await Deno.readTextFile(evalLog);
        assertEquals(log2.length, 1);
      } finally {
        await host.stop();
        await sharedRuntime.stop();
        await rewriteCache.stop();
      }
    } finally {
      await proj.cleanup();
    }
  },
);

Deno.test(
  "shared modules: reloading a shared module re-runs the gateway evaluation",
  async () => {
    const proj = await makeProject(1);
    try {
      const evalLog = join(proj.dir, ".shared-evals.log");
      const shared = await discoverSharedModules(proj.dir);
      const sharedRuntime = await createDenoSharedRuntime(shared);
      const cacheDir = await Deno.makeTempDir({ prefix: "1tube-rewrite-" });
      const rewriteCache = createRewriteCache({ cacheDir, sharedRuntime });

      const registry = new FunctionRegistry();
      const supervisor = new FunctionSupervisor();
      const host = createDenoWorkerHost({
        functionsDir: proj.dir,
        registry,
        supervisor,
        sharedRuntime,
        rewriteCache,
      });
      try {
        await host.start();
        assertEquals((await Deno.readTextFile(evalLog)).length, 1);

        // Edit the shared file and reload via the runtime API. We
        // bypass the watcher here — that path is exercised by the
        // hot-reloader test — and just call reload() directly.
        const sharedPath = shared[0].sourcePath;
        const src = await Deno.readTextFile(sharedPath);
        await Deno.writeTextFile(sharedPath, src + "\n// touched\n");
        const { record, exportListChanged } = await sharedRuntime.reload(
          sharedPath,
        );
        assertEquals(record.id, "profile-cache");
        assertEquals(
          exportListChanged,
          false,
          "edit didn't change exports — list shouldn't be reported as changed",
        );

        // Re-evaluation appended a second marker.
        assertEquals((await Deno.readTextFile(evalLog)).length, 2);

        // RPC after reload returns the fresh exports.
        const result = await sharedRuntime.call("profile-cache", "pingShared", []);
        assertEquals(result, "pong");
      } finally {
        await host.stop();
        await sharedRuntime.stop();
        await rewriteCache.stop();
      }
    } finally {
      await proj.cleanup();
    }
  },
);

Deno.test("shared modules: rewriter is a no-op when no shared modules are configured", async () => {
  const proj = await makeProject(2);
  try {
    // Empty shared runtime → the rewriter should leave entries alone
    // and the Workers should evaluate the shared file themselves
    // (i.e. the side-effect counter should rise — proving the test
    // boundary is correct).
    const sharedRuntime = await createDenoSharedRuntime([]);
    const cacheDir = await Deno.makeTempDir({ prefix: "1tube-rewrite-" });
    const rewriteCache = createRewriteCache({ cacheDir, sharedRuntime });

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: proj.dir,
      registry,
      supervisor,
      sharedRuntime,
      rewriteCache,
    });
    try {
      const { loaded, errors } = await host.start();
      assertEquals(errors, []);
      assertEquals(loaded.length, 2);

      const evalLog = join(proj.dir, ".shared-evals.log");
      const log = await Deno.readTextFile(evalLog);
      assertEquals(
        log.length,
        2,
        "without shared-runtime registration each Worker evaluates the module itself; expected 2 markers from 2 fns",
      );

      assertEquals(rewriteCache.inspect().rewrites.length, 0);
      assertEquals(rewriteCache.inspect().stubs.length, 0);
    } finally {
      await host.stop();
      await sharedRuntime.stop();
      await rewriteCache.stop();
    }
  } finally {
    await proj.cleanup();
  }
});
