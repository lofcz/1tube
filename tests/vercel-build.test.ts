/**
 * Tests for the `1tube vercel-build` CLI command and the Vercel Build Output
 * API artifacts it emits.
 *
 * Like `build-cli.test.ts`, these are real integration tests: they run esbuild
 * against the playground fixtures, write `.vercel/output` function dirs, then
 * verify the Build Output API shape (`.vc-config.json`, `package.json`, handler
 * files). One test also imports an emitted entry module under Deno and invokes
 * its exported Node handler with a mock req/res to prove the `Deno.serve`
 * capture + Node<->Web bridge works end-to-end.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { runBuild } from "../src/cli/build.ts";
import { buildVercel } from "../src/cli/vercel-build.ts";

const PROJECT_ROOT = resolvePath(
  new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
);
const PLAYGROUND = join(PROJECT_ROOT, "playground");
const DENO_JSON = join(PROJECT_ROOT, "deno.json");

const TEST_OPTS = { sanitizeResources: false, sanitizeOps: false } as const;

async function tmpOutDir(label: string): Promise<string> {
  return await Deno.makeTempDir({ prefix: `1tube-vercel-${label}-` });
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await Deno.readTextFile(path));
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test(
  "buildVercel emits Build Output API function dirs",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("boa");
    try {
      const result = await buildVercel({
        functionsDir: PLAYGROUND,
        outDir: out,
        configPath: DENO_JSON,
        only: ["hello", "echo"],
        sourcemap: false,
      });

      assertEquals(result.runtime, "nodejs24.x");
      assertEquals(result.pathPrefix, "functions/v1");
      assertEquals(result.functions.map((f) => f.name).sort(), [
        "echo",
        "hello",
      ]);

      for (const fn of result.functions) {
        const funcDir = join(
          out,
          "functions",
          "functions",
          "v1",
          `${fn.name}.func`,
        );
        assert(await exists(funcDir), `${funcDir} should exist`);

        const vc = await readJson(join(funcDir, ".vc-config.json"));
        assertEquals(vc.runtime, "nodejs24.x");
        assertEquals(vc.launcherType, "Nodejs");
        assertEquals(vc.supportsResponseStreaming, true);
        assertEquals(vc.handler, fn.handler);
        assert(typeof vc.maxDuration === "number" && vc.maxDuration >= 1);

        // The handler file referenced by .vc-config.json must exist.
        assert(
          await exists(join(funcDir, fn.handler)),
          `handler ${fn.handler} should exist in ${funcDir}`,
        );

        const pkg = await readJson(join(funcDir, "package.json"));
        assertEquals(pkg.type, "module");
      }
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel derives maxDuration from 1tube.json timeoutMs",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("maxdur");
    try {
      const result = await buildVercel({
        functionsDir: PLAYGROUND,
        // hello has timeoutMs 5000 (-> 5s); echo has no manifest (-> default).
        only: ["hello", "echo"],
        outDir: out,
        configPath: DENO_JSON,
        sourcemap: false,
        defaultMaxDuration: 123,
      });

      const hello = result.functions.find((f) => f.name === "hello")!;
      const echo = result.functions.find((f) => f.name === "echo")!;
      assertEquals(hello.maxDuration, 5);
      assertEquals(echo.maxDuration, 123);
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel honours a custom path prefix and runtime",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("prefix");
    try {
      const result = await buildVercel({
        functionsDir: PLAYGROUND,
        outDir: out,
        configPath: DENO_JSON,
        only: ["hello"],
        sourcemap: false,
        pathPrefix: "/api/edge/",
        runtime: "nodejs20.x",
      });
      assertEquals(result.pathPrefix, "api/edge");
      assertEquals(result.functions[0].route, "api/edge/hello");
      const funcDir = join(out, "functions", "api", "edge", "hello.func");
      assert(await exists(funcDir));
      const vc = await readJson(join(funcDir, ".vc-config.json"));
      assertEquals(vc.runtime, "nodejs20.x");
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel output runs as a Vercel Node handler (Deno.serve capture + req/res bridge)",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("exec");
    // The Vercel banner overrides globalThis.Deno.serve to capture the handler
    // and installs an EdgeRuntime shim. Snapshot + restore so other tests in
    // the same realm aren't affected.
    const origServe = (globalThis as { Deno: { serve: unknown } }).Deno.serve;
    const hadEdge = "EdgeRuntime" in globalThis;
    const origEdge = (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
    try {
      const result = await buildVercel({
        functionsDir: PLAYGROUND,
        outDir: out,
        configPath: DENO_JSON,
        only: ["hello"],
        sourcemap: false,
      });
      const fn = result.functions[0];
      const entryAbs = join(fn.funcDir, fn.handler);
      const mod = await import(pathToFileURL(entryAbs).href);
      const handler = mod.default as (
        req: unknown,
        res: unknown,
      ) => Promise<void>;
      assertEquals(typeof handler, "function");

      const chunks: Uint8Array[] = [];
      const resHeaders: Record<string, string | string[]> = {};
      let statusCode = 0;
      const res = {
        statusCode: 200,
        headersSent: false,
        setHeader(k: string, v: string | string[]) {
          resHeaders[k.toLowerCase()] = v;
        },
        write(chunk: Uint8Array | string) {
          chunks.push(
            typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk,
          );
          return true;
        },
        once(_event: string, _cb: () => void) {},
        end(chunk?: Uint8Array | string) {
          if (chunk !== undefined) this.write(chunk);
          statusCode = this.statusCode;
        },
      };
      const req = {
        method: "GET",
        url: "/",
        headers: { host: "localhost" },
      };

      await handler(req, res);

      assertEquals(statusCode, 200);
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const merged = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
      const body = JSON.parse(new TextDecoder().decode(merged));
      assertStringIncludes(String(body.message), "hello");
      assertStringIncludes(
        String(resHeaders["content-type"] ?? ""),
        "application/json",
      );
    } finally {
      (globalThis as { Deno: { serve: unknown } }).Deno.serve = origServe;
      if (hadEdge) {
        (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = origEdge;
      } else {
        delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
      }
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel throws on unknown function name in only",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("miss");
    try {
      await assertRejects(
        () =>
          buildVercel({
            functionsDir: PLAYGROUND,
            outDir: out,
            configPath: DENO_JSON,
            only: ["does-not-exist"],
            sourcemap: false,
          }),
        Error,
        "no functions matched",
      );
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "build --target vercel happy path returns 0 and writes artifacts",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("cli");
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    let code: number;
    try {
      code = await runBuild([
        "--target",
        "vercel",
        "--functions",
        PLAYGROUND,
        "--out",
        out,
        "--only",
        "hello",
        "--sourcemap",
        "none",
        "--config",
        DENO_JSON,
      ]);
    } finally {
      console.log = originalLog;
    }
    assertEquals(code, 0);
    const funcDir = join(out, "functions", "functions", "v1", "hello.func");
    assert(await exists(join(funcDir, ".vc-config.json")));
    assert(await exists(join(funcDir, "package.json")));
    const output = logs.join("\n");
    assertStringIncludes(output, "bundling 1 function(s) for Vercel Node");
    assertStringIncludes(output, "/functions/v1/hello");
    await Deno.remove(out, { recursive: true }).catch(() => {});
  },
);

Deno.test(
  "build --target vercel returns 2 on unknown flag",
  TEST_OPTS,
  async () => {
    const code = await runBuild(["--target", "vercel", "--made-up-flag", "foo"]);
    assertEquals(code, 2);
  },
);

Deno.test("build rejects an unknown --target", TEST_OPTS, async () => {
  const code = await runBuild(["--target", "bogus"]);
  assertEquals(code, 2);
});
