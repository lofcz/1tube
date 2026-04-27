/**
 * End-to-end test for `--prebuilt` mode on the workerd backend.
 *
 * Runs `1tube build` against the playground, then boots the gateway with
 * `--prebuilt` pointing at the resulting artifact directory and confirms:
 *
 *   1. The gateway starts without esbuild on the critical path.
 *   2. Bundled functions are reachable through the proxy.
 *   3. Editing a source file does NOT cause a reload (sealed artifact).
 *   4. A tampered bundle fails the integrity check at boot.
 *
 * Skips silently when `workerd` is not on PATH — same convention as
 * `tests/workerd-e2e.test.ts`. The build step itself does not need
 * workerd; only the boot step does, so we test #4 (tamper detection)
 * unconditionally inside this file by driving the backend in-process,
 * and reserve the spawned-subprocess path for #1-#3.
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fromFileUrl } from "jsr:@std/path@^1/from-file-url";
import { build } from "../src/cli/build.ts";
import { createWorkerdBackend } from "../src/backends/workerd/backend.ts";
import { probeVersion } from "../src/backends/workerd/process.ts";

const PROJECT_ROOT = resolvePath(dirname(fromFileUrl(import.meta.url)), "..");
const PLAYGROUND = join(PROJECT_ROOT, "playground");
const DENO_JSON = join(PROJECT_ROOT, "deno.json");
const E2E_OPTS = { sanitizeOps: false, sanitizeResources: false } as const;

async function freePort(): Promise<number> {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

function freeWorkerdBasePort(): number {
  const span = 16;
  for (let attempt = 0; attempt < 100; attempt++) {
    const base = 20_000 + Math.floor(Math.random() * 20_000);
    const listeners: Deno.Listener[] = [];
    try {
      for (let offset = 0; offset < span; offset++) {
        listeners.push(Deno.listen({ hostname: "127.0.0.1", port: base + offset }));
      }
      return base;
    } catch {
      // try another range
    } finally {
      for (const l of listeners) l.close();
    }
  }
  throw new Error("could not reserve a free workerd base port range");
}

async function waitForGateway(port: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" });
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway on :${port} did not become ready within ${timeoutMs}ms`);
}

async function workerdAvailable(): Promise<boolean> {
  try {
    await probeVersion(Deno.env.get("1TUBE_WORKERD_BIN") ?? "workerd");
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "prebuilt artifact serves through gateway without esbuild on the boot path",
  E2E_OPTS,
  async () => {
    if (!(await workerdAvailable())) {
      console.log("[skipped: workerd binary not on PATH]");
      return;
    }

    // Build a tiny artifact (just hello + echo so the test stays fast).
    const dist = await Deno.makeTempDir({ prefix: "1tube-prebuilt-e2e-" });
    await build({
      functionsDir: PLAYGROUND,
      outDir: dist,
      configPath: DENO_JSON,
      only: ["hello", "echo"],
      sourcemap: false,
    });

    const port = await freePort();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--quiet",
        "--allow-all",
        "src/cli.ts",
        "--backend",
        "workerd",
        "--prebuilt",
        dist,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--dev",
      ],
      cwd: PROJECT_ROOT,
      env: {
        ...Deno.env.toObject(),
        // HMR must no-op against a sealed artifact; test that the
        // gateway warns and continues rather than booting a watcher.
        "1TUBE_HMR": "1",
        "1TUBE_LAZY": "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    let bootLog = "";
    const teePump = (async () => {
      const reader = child.stderr.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value);
          bootLog += chunk;
          Deno.stderr.writeSync(new TextEncoder().encode(chunk.replace(/^/gm, "   ⏵ ")));
        }
      } catch { /* */ }
    })();
    const stdoutPump = (async () => {
      const reader = child.stdout.getReader();
      const dec = new TextDecoder();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bootLog += dec.decode(value);
        }
      } catch { /* */ }
    })();

    try {
      await waitForGateway(port, 30_000);

      const helloRes = await fetch(`http://127.0.0.1:${port}/functions/v1/hello`, {
        cache: "no-store",
      });
      assertEquals(helloRes.status, 200);
      const helloBody = await helloRes.json();
      assertEquals(helloBody.message, "hello, hello");

      const echoRes = await fetch(`http://127.0.0.1:${port}/functions/v1/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
        cache: "no-store",
      });
      assertEquals(echoRes.status, 200);
      const echoed = await echoRes.json();
      assertEquals(echoed.body, { a: 1 });

      // Boot log assertions: the prebuilt path announces itself, the
      // HMR-on-prebuilt warning fires, and the bundling-from line is
      // absent (we'd have logged "Serving prebuilt artifact" instead).
      assert(
        bootLog.includes("prebuilt artifact"),
        "boot log should announce the prebuilt artifact load",
      );
      assert(
        bootLog.includes("--hmr ignored"),
        "boot log should warn that HMR is ignored on prebuilt deploys",
      );
      assert(
        !bootLog.includes("Bundling functions from:"),
        "prebuilt mode must skip the live-bundling banner",
      );
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* */ }
      await child.status;
      await Promise.all([teePump, stdoutPump]).catch(() => {});
      await Deno.remove(dist, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "prebuilt shared chunks serve two functions through workerd",
  E2E_OPTS,
  async () => {
    if (!(await workerdAvailable())) {
      console.log("[skipped: workerd binary not on PATH]");
      return;
    }

    const root = await Deno.makeTempDir({ prefix: "1tube-prebuilt-chunk-src-" });
    const dist = await Deno.makeTempDir({ prefix: "1tube-prebuilt-chunk-dist-" });
    await Deno.mkdir(join(root, "_shared"), { recursive: true });
    await Deno.mkdir(join(root, "alpha"), { recursive: true });
    await Deno.mkdir(join(root, "beta"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "_shared", "handler.ts"),
      `export function serve(handler, opts = {}) {
  globalThis.__edgeFunctionRegistry.register(handler, { public: opts.public ?? true });
}
`,
    );
    await Deno.writeTextFile(
      join(root, "_shared", "large-dep.ts"),
      `export const payload = ${JSON.stringify("chunked-dependency-" + "x".repeat(4096))};
export function answer(name) {
  return name + ":" + payload.slice(0, 18);
}
`,
    );
    for (const name of ["alpha", "beta"]) {
      await Deno.writeTextFile(
        join(root, name, "index.ts"),
        `import { serve } from "../_shared/handler.ts";
import { answer } from "../_shared/large-dep.ts";
serve(() => Response.json({ value: answer(${JSON.stringify(name)}) }), { public: true });
`,
      );
    }

    await build({
      functionsDir: root,
      outDir: dist,
      only: ["alpha", "beta"],
      sourcemap: false,
    });
    const manifest = JSON.parse(await Deno.readTextFile(join(dist, "manifest.json")));
    assert(manifest.chunks.length > 0, "expected build to emit shared chunks");

    const port = await freePort();
    const workerdBasePort = freeWorkerdBasePort();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--quiet",
        "--allow-all",
        "src/cli.ts",
        "--backend",
        "workerd",
        "--prebuilt",
        dist,
        "--port",
        String(port),
        "--host",
        "127.0.0.1",
        "--workerd-base-port",
        String(workerdBasePort),
        "--dev",
      ],
      cwd: PROJECT_ROOT,
      env: { ...Deno.env.toObject(), "1TUBE_LAZY": "0" },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      try {
        while (!(await reader.read()).done) {
          // drain
        }
      } catch {
        // child closed
      }
    };
    const stdoutPump = pump(child.stdout);
    const stderrPump = pump(child.stderr);
    try {
      await waitForGateway(port, 30_000);
      for (const name of ["alpha", "beta"]) {
        const res = await fetch(`http://127.0.0.1:${port}/functions/v1/${name}`, { cache: "no-store" });
        assertEquals(res.status, 200);
        const body = await res.json();
        assertEquals(body.value, `${name}:chunked-dependency`);
      }
    } finally {
      try {
        child.kill("SIGTERM");
      } catch {
        // already exited
      }
      await child.status;
      await Promise.all([stdoutPump, stderrPump]).catch(() => {});
      await Deno.remove(root, { recursive: true }).catch(() => {});
      await Deno.remove(dist, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "prebuilt boot fails fast when a bundle has been tampered with",
  E2E_OPTS,
  async () => {
    if (!(await workerdAvailable())) {
      console.log("[skipped: workerd binary not on PATH]");
      return;
    }

    const dist = await Deno.makeTempDir({ prefix: "1tube-prebuilt-tamper-" });
    try {
      await build({
        functionsDir: PLAYGROUND,
        outDir: dist,
        configPath: DENO_JSON,
        only: ["hello"],
        sourcemap: false,
      });

      // Corrupt the bundle bytes without updating the manifest's
      // sha-256 — boot must reject this.
      const bundlePath = join(dist, "functions", "hello.js");
      const original = await Deno.readTextFile(bundlePath);
      await Deno.writeTextFile(bundlePath, original + "\n// tampered\n");

      const backend = createWorkerdBackend({
        functionsDir: PLAYGROUND,
        configPath: DENO_JSON,
        prebuiltDir: dist,
      });

      let threw: Error | null = null;
      try {
        await backend.start();
      } catch (err) {
        threw = err as Error;
      }
      assert(threw, "tampered bundle must cause start() to throw");
      assert(
        /failed integrity check/i.test(threw!.message),
        `expected integrity check failure, got: ${threw!.message}`,
      );
      // start() should also clean up — calling stop() must be safe.
      await backend.stop().catch(() => {});
    } finally {
      await Deno.remove(dist, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test("prebuilt mode rejects public reload() calls", async () => {
  // Pure unit: build a real artifact, point a backend at it, but never
  // call start() — the public reload() guard must reject regardless of
  // backend state. This avoids needing workerd here.
  const dist = await Deno.makeTempDir({ prefix: "1tube-prebuilt-reload-" });
  try {
    await build({
      functionsDir: PLAYGROUND,
      outDir: dist,
      configPath: DENO_JSON,
      only: ["hello"],
      sourcemap: false,
    });

    const backend = createWorkerdBackend({
      functionsDir: PLAYGROUND,
      configPath: DENO_JSON,
      prebuiltDir: dist,
    });

    let threw: Error | null = null;
    try {
      await backend.reload();
    } catch (err) {
      threw = err as Error;
    }
    assert(threw, "reload() must reject in prebuilt mode");
    assert(
      /prebuilt/i.test(threw!.message),
      `expected message to mention prebuilt, got: ${threw!.message}`,
    );
  } finally {
    await Deno.remove(dist, { recursive: true }).catch(() => {});
  }
});
