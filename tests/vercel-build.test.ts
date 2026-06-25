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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
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
  "buildVercel derives maxDuration from a declared serve({ timeoutMs }) and overrides the manifest",
  TEST_OPTS,
  async () => {
    // Faithful to `_shared/handler.ts`: register against the gateway registry
    // when present (the capture path), else fall back to Deno.serve (the
    // bundled-runtime path). No bare imports, so it bundles + imports offline.
    const serveLike = (timeoutMs: number) =>
      `const reg = (globalThis as any).__edgeFunctionRegistry;
const handler = () => new Response("ok");
if (reg) reg.register(handler, { public: true, timeoutMs: ${timeoutMs} });
else Deno.serve(handler);
`;
    const dir = await Deno.makeTempDir({ prefix: "1tube-vercel-declared-" });
    const out = await tmpOutDir("declared");
    try {
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ imports: {} }),
      );
      // declared-only: serve() timeout, no manifest -> 45s.
      await Deno.mkdir(join(dir, "declared-only"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "declared-only", "index.ts"),
        serveLike(45_000),
      );
      // override: serve() timeout (30s) wins over a 1tube.json timeout (300s).
      await Deno.mkdir(join(dir, "override"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "override", "index.ts"),
        serveLike(30_000),
      );
      await Deno.writeTextFile(
        join(dir, "override", "1tube.json"),
        JSON.stringify({ timeoutMs: 300_000 }),
      );

      const result = await buildVercel({
        functionsDir: dir,
        outDir: out,
        configPath: join(dir, "deno.json"),
        only: ["declared-only", "override"],
        sourcemap: false,
        defaultMaxDuration: 123,
      });

      const declaredOnly = result.functions.find((f) =>
        f.name === "declared-only"
      )!;
      const override = result.functions.find((f) => f.name === "override")!;
      assertEquals(declaredOnly.maxDuration, 45);
      assertEquals(override.maxDuration, 30);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
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

      // The sub-path rewrite uses the custom prefix too.
      const config = await readJson(join(out, "config.json"));
      const routes = config.routes as Array<Record<string, unknown>>;
      assert(
        routes.some((r) =>
          r.src === "^/api/edge/hello/.*$" && r.dest === "/api/edge/hello"
        ),
        "expected a custom-prefix sub-path route",
      );
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel writes per-function sub-path rewrite routes into config.json",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("routes");
    try {
      const result = await buildVercel({
        functionsDir: PLAYGROUND,
        outDir: out,
        configPath: DENO_JSON,
        only: ["hello", "echo"],
        sourcemap: false,
      });

      assertEquals(result.subpathRoutes, 2);
      const config = await readJson(join(out, "config.json"));
      assertEquals(config.version, 3);
      const routes = config.routes as Array<Record<string, unknown>>;

      const hello = routes.find((r) => r.dest === "/functions/v1/hello");
      assertEquals(hello?.src, "^/functions/v1/hello/.*$");
      const echo = routes.find((r) => r.dest === "/functions/v1/echo");
      assertEquals(echo?.src, "^/functions/v1/echo/.*$");

      // The exact path is left to Vercel's filesystem routing — no route claims
      // it — so the change is purely additive for sub-paths.
      assert(
        !routes.some((r) =>
          typeof r.src === "string" && r.src === "^/functions/v1/hello$"
        ),
        "exact path must not be rewritten",
      );
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel merges sub-path routes before the filesystem handle and preserves existing routes",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("merge");
    try {
      // Seed a Build Output API config like `vercel build` emits: a continue
      // header route, the filesystem marker, then a SPA fallback rewrite.
      await Deno.mkdir(out, { recursive: true });
      const seeded = {
        version: 3,
        routes: [
          {
            src: "^/assets/(.*)$",
            headers: { "cache-control": "max-age=1" },
            continue: true,
          },
          { handle: "filesystem" },
          { src: "^/((?!functions/).*)$", dest: "/index.html" },
        ],
      };
      await Deno.writeTextFile(
        join(out, "config.json"),
        JSON.stringify(seeded),
      );

      const result = await buildVercel({
        functionsDir: PLAYGROUND,
        outDir: out,
        configPath: DENO_JSON,
        only: ["hello", "echo"],
        sourcemap: false,
      });
      assertEquals(result.subpathRoutes, 2);

      const config = await readJson(join(out, "config.json"));
      const routes = config.routes as Array<Record<string, unknown>>;
      const headerIdx = routes.findIndex((r) => r.src === "^/assets/(.*)$");
      const handleIdx = routes.findIndex((r) => r.handle === "filesystem");
      const helloIdx = routes.findIndex((r) =>
        r.dest === "/functions/v1/hello"
      );
      const echoIdx = routes.findIndex((r) => r.dest === "/functions/v1/echo");

      // Our routes land in the main phase: after the header route, before the
      // filesystem marker.
      assert(headerIdx >= 0 && handleIdx > headerIdx);
      assert(helloIdx > headerIdx && helloIdx < handleIdx);
      assert(echoIdx > headerIdx && echoIdx < handleIdx);
      // The pre-existing SPA fallback survives after the filesystem marker.
      assert(
        routes.some((r) => r.dest === "/index.html"),
        "SPA fallback must be preserved",
      );
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel sub-path route merge is idempotent across re-runs",
  TEST_OPTS,
  async () => {
    const out = await tmpOutDir("idem");
    try {
      const opts = {
        functionsDir: PLAYGROUND,
        outDir: out,
        configPath: DENO_JSON,
        only: ["hello", "echo"],
        sourcemap: false,
      } as const;
      await buildVercel(opts);
      await buildVercel(opts);

      const config = await readJson(join(out, "config.json"));
      const routes = config.routes as Array<Record<string, unknown>>;
      const hello = routes.filter((r) => r.dest === "/functions/v1/hello");
      const echo = routes.filter((r) => r.dest === "/functions/v1/echo");
      assertEquals(hello.length, 1);
      assertEquals(echo.length, 1);
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
  "buildVercel externalises an unresolvable optional dependency instead of failing",
  TEST_OPTS,
  async () => {
    // Regression guard for the optional-dependency resolver: libraries
    // routinely require()/import() a native or peer package behind a
    // try/catch and degrade when it's absent (ws→bufferutil, debug→
    // supports-color, …). Those are uninstalled optionalDependencies the Deno
    // loader can't resolve, which used to abort the whole bundle unless the
    // exact package was on a hand-curated allowlist. The Vercel profile now
    // probes resolution and externalises ON FAILURE, so the build survives any
    // such package — not just a fixed three — and reports what it externalised.
    //
    // The fixture imports a bare specifier with no import-map entry, which the
    // Deno loader rejects at RESOLVE time (offline, deterministic — exactly the
    // phase the `Could not find package …` optional-dep failure happens in).
    // A failure at LOAD time instead — e.g. an import-map alias pointing at a
    // missing file — is a real error and is intentionally NOT swallowed.
    const dir = await Deno.makeTempDir({ prefix: "1tube-vercel-optdep-" });
    const out = await tmpOutDir("optdep");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ imports: {} }),
      );
      await Deno.mkdir(join(dir, "opt"), { recursive: true });
      await Deno.writeTextFile(
        join(dir, "opt", "index.ts"),
        `let optional = null;
try {
  optional = await import("phantom-optional-dep");
} catch {
  // optionalDependency absent — degrade gracefully.
}
Deno.serve(() => Response.json({ ok: true, hadOptional: optional !== null }));
`,
      );

      const result = await buildVercel({
        functionsDir: dir,
        outDir: out,
        configPath: join(dir, "deno.json"),
        only: ["opt"],
        sourcemap: false,
      });

      assertEquals(result.functions.map((f) => f.name), ["opt"]);
      const warned = warnings.join("\n");
      assertStringIncludes(warned, "phantom-optional-dep");
      assertStringIncludes(warned, "externalised");
    } finally {
      console.warn = originalWarn;
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "buildVercel output survives a CJS dependency that require()s at module init",
  TEST_OPTS,
  async () => {
    // Regression guard for the Node createRequire shim. CJS deps that
    // `require()` during module initialisation (e.g. google-auth-library →
    // `require("node:child_process")`) compile to esbuild's `__require` helper,
    // which esbuild hoists into a SHARED CHUNK. esbuild's `banner` never
    // reaches chunks, so without the profile's `outputPreamble` that chunk has
    // no `require` in scope and throws "Dynamic require of … is not supported"
    // at runtime. The fixture below forces exactly that code path with a local
    // CommonJS module (offline, deterministic — `node:os` is a builtin).
    const dir = await Deno.makeTempDir({ prefix: "1tube-vercel-dynreq-" });
    const out = await tmpOutDir("dynreq");
    const origServe = (globalThis as { Deno: { serve: unknown } }).Deno.serve;
    const hadEdge = "EdgeRuntime" in globalThis;
    const origEdge = (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
    try {
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ imports: {} }),
      );
      await Deno.mkdir(join(dir, "dynreq"), { recursive: true });
      // CommonJS: esbuild wraps this in __commonJS and rewrites the require()
      // call to __require(...), evaluated lazily when the module is first used.
      await Deno.writeTextFile(
        join(dir, "dynreq", "dep.cjs"),
        `const os = require("node:os");
module.exports = { platform: typeof os.platform === "function" ? os.platform() : "unknown" };
`,
      );
      await Deno.writeTextFile(
        join(dir, "dynreq", "index.ts"),
        `import dep from "./dep.cjs";
Deno.serve(() => Response.json({ ok: true, platform: dep.platform }));
`,
      );

      const result = await buildVercel({
        functionsDir: dir,
        outDir: out,
        configPath: join(dir, "deno.json"),
        only: ["dynreq"],
        sourcemap: false,
      });
      const fn = result.functions[0];

      // Importing the emitted module runs the __commonJS wrapper, which invokes
      // __require("node:os"). Before the fix this threw "Dynamic require…".
      const entryAbs = join(fn.funcDir, fn.handler);
      const mod = await import(pathToFileURL(entryAbs).href);
      assertEquals(typeof mod.default, "function");
    } finally {
      (globalThis as { Deno: { serve: unknown } }).Deno.serve = origServe;
      if (hadEdge) {
        (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime = origEdge;
      } else {
        delete (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
      }
      await Deno.remove(dir, { recursive: true }).catch(() => {});
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
    const code = await runBuild([
      "--target",
      "vercel",
      "--made-up-flag",
      "foo",
    ]);
    assertEquals(code, 2);
  },
);

Deno.test("build rejects an unknown --target", TEST_OPTS, async () => {
  const code = await runBuild(["--target", "bogus"]);
  assertEquals(code, 2);
});
