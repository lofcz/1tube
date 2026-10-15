/**
 * `import()` of a CommonJS package inside a code-split bundle. esbuild emits
 * such a package as a chunk with only `export default require_x()`, so
 * `const { Agent } = await import("undici")` was `undefined` in Vercel
 * bundles (minified: "m is not a constructor") while Bun and Node expose the
 * named export. The bundle must expose named exports the way Node does.
 */

import { afterEach, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, assertEquals } from "./_assert.ts";
import { bundleAllChunked } from "../src/bundler/core.ts";
import { VERCEL_PROFILE } from "../src/backends/vercel/bundle-profile.ts";

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function pkg(root: string, name: string, files: Record<string, string>): Promise<void> {
  await write(
    join(root, "node_modules", name, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
  );
  for (const [file, text] of Object.entries(files)) {
    await write(join(root, "node_modules", name, file), text);
  }
}

test("bundler: dynamic import() of CommonJS keeps named exports in chunked bundles", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-cjs-dynamic-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));

  await pkg(dir, "cjs-fixture", {
    "index.js": [
      "class Thing { constructor() { this.ok = true; } }",
      "module.exports.Thing = Thing;",
      'module.exports["dash-name"] = "dash";',
      "module.exports.static = 1;",
    ].join("\n"),
  });
  await pkg(dir, "cjs-reexport", {
    "index.js": 'module.exports = require("./impl");\n',
    "impl.js": 'exports.fromImpl = "impl";\n',
  });
  await pkg(dir, "cjs-esmodule", {
    "index.js": [
      'Object.defineProperty(exports, "__esModule", { value: true });',
      'exports.default = "inner-default";',
      'exports.named = "named";',
    ].join("\n"),
  });
  await pkg(dir, "esm-fixture", { "index.js": 'export const esmNamed = "esm";\n' });
  await pkg(dir, "cjs-static", { "index.js": 'exports.staticNamed = "static";\n' });

  await write(
    join(dir, "functions", "probe", "index.ts"),
    `import { staticNamed } from "cjs-static";
(globalThis as any).__cjsDynamicProbe = (async () => {
  const fixture: any = await import("cjs-fixture");
  const reexport: any = await import("cjs-reexport");
  const esModule: any = await import("cjs-esmodule");
  const esm: any = await import("esm-fixture");
  return {
    thing: new fixture.Thing().ok,
    dash: fixture["dash-name"],
    defaultIsExports: fixture.default.Thing === fixture.Thing,
    fromImpl: reexport.fromImpl,
    esModuleDefault: esModule.default.default,
    esModuleNamed: esModule.named,
    esmNamed: esm.esmNamed,
    staticNamed,
  };
})();
`,
  );

  const result = await bundleAllChunked({
    inputs: [{ name: "probe", entrypoint: join(dir, "functions", "probe", "index.ts") }],
    outDir: join(dir, "out"),
    profile: VERCEL_PROFILE,
    sourcemap: false,
  });
  assertEquals(result.functions.length, 1);

  // Importing a Vercel entry runs its banner, which installs Deno/EdgeRuntime
  // shims; put the realm back afterwards.
  const g = globalThis as { Deno?: unknown; EdgeRuntime?: unknown; __cjsDynamicProbe?: unknown };
  const before = { Deno: g.Deno, EdgeRuntime: g.EdgeRuntime, hadDeno: "Deno" in g, hadEdge: "EdgeRuntime" in g };
  cleanups.push(() => {
    if (before.hadDeno) g.Deno = before.Deno;
    else delete g.Deno;
    if (before.hadEdge) g.EdgeRuntime = before.EdgeRuntime;
    else delete g.EdgeRuntime;
    delete g.__cjsDynamicProbe;
  });

  await import(pathToFileURL(result.functions[0].bundlePath).href);
  const probe = await (g.__cjsDynamicProbe as Promise<Record<string, unknown>>);
  assert(probe, "function did not run");
  assertEquals(probe, {
    thing: true,
    dash: "dash",
    defaultIsExports: true,
    fromImpl: "impl",
    // Like Node: `default` is module.exports even when `__esModule` is set.
    esModuleDefault: "inner-default",
    esModuleNamed: "named",
    esmNamed: "esm",
    staticNamed: "static",
  });
});
