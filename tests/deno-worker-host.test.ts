/**
 * Worker-host integration test for the Deno backend.
 *
 * Spins up a real {@link createDenoWorkerHost} against a temp functions dir,
 * dispatches a request, edits a relative dep, triggers a precise reload, and
 * verifies the response actually reflects the new code — i.e. the Worker
 * teardown + respawn DID drop the relative dep from Deno's module cache.
 *
 * This is the test that proves the Worker model fixes the HMR problem the
 * 3f1b220 snapshot approach was working around.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { FunctionRegistry } from "../src/registry.ts";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { createDenoWorkerHost } from "../src/backends/deno/worker-host.ts";

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

const HANDLER_TEMPLATE = (entryBody: string) => entryBody;

Deno.test("worker-host: dispatches a request and returns the function's response", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-worker-host-" });
  try {
    const fnDir = join(tmp, "hello");
    await writeFile(
      join(fnDir, "index.ts"),
      `
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(
  () => new Response("hello, world", { headers: { "x-fn": "hello" } }),
  { public: true },
);
`,
    );

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
    });
    const { loaded, errors } = await host.start();
    try {
      assertEquals(errors, []);
      assertEquals(loaded, ["hello"]);

      const handle = registry.workerHandle("hello");
      assert(handle, "expected hello to register a worker handle");
      assertEquals(handle.isPublic, true);

      const abort = new AbortController();
      const resp = await handle.dispatch(
        new Request("http://localhost/"),
        null,
        abort.signal,
      );
      assertEquals(resp.status, 200);
      assertEquals(resp.headers.get("x-fn"), "hello");
      assertEquals(await resp.text(), "hello, world");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-host: edit to a relative dep is observable after reload", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-worker-host-hmr-" });
  try {
    const fnDir = join(tmp, "fn");
    await writeFile(join(fnDir, "dep.ts"), `export const value = "before";\n`);
    await writeFile(
      join(fnDir, "index.ts"),
      `
import { value } from "./dep.ts";
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(() => new Response(value), { public: true });
`,
    );

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
    });
    await host.start();

    try {
      const before = registry.workerHandle("fn")!;
      const abort1 = new AbortController();
      const r1 = await before.dispatch(
        new Request("http://localhost/"),
        null,
        abort1.signal,
      );
      assertEquals(await r1.text(), "before");

      // Edit the relative dep — the very thing the snapshot approach in
      // 3f1b220 was working around. Worker termination drops the cached
      // `./dep.ts` module, so the respawned worker imports the fresh
      // version.
      await writeFile(join(fnDir, "dep.ts"), `export const value = "after";\n`);

      const summary = await host.reload(new Set(["fn"]), "test");
      assertEquals(summary.errors, []);
      assertEquals(summary.reloaded, ["fn"]);

      const after = registry.workerHandle("fn")!;
      assert(after !== before, "expected a fresh handle after reload");

      const abort2 = new AbortController();
      const r2 = await after.dispatch(
        new Request("http://localhost/"),
        null,
        abort2.signal,
      );
      assertEquals(await r2.text(), "after");
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("worker-host: reload removes a function whose index.ts was deleted", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-worker-host-rm-" });
  try {
    const fnDir = join(tmp, "ghost");
    await writeFile(
      join(fnDir, "index.ts"),
      HANDLER_TEMPLATE(
        `(globalThis as any).__edgeFunctionRegistry.register(() => new Response("ok"), { public: true });`,
      ),
    );

    const registry = new FunctionRegistry();
    const supervisor = new FunctionSupervisor();
    const host = createDenoWorkerHost({
      functionsDir: tmp,
      registry,
      supervisor,
    });
    await host.start();

    try {
      assert(registry.workerHandle("ghost"));
      await Deno.remove(fnDir, { recursive: true });
      const summary = await host.reload(new Set(["ghost"]), "test-delete");
      assertEquals(summary.removed, ["ghost"]);
      assertEquals(registry.workerHandle("ghost"), undefined);
      assertEquals(registry.has("ghost"), false);
    } finally {
      await host.stop();
    }
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
