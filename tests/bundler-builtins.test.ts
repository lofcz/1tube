/**
 * Bundling vs. Bun's builtin list: Bun reports `ws` / `undici` as builtins
 * (it ships its own), but bundles run on Node/workerd where they are plain
 * npm packages. Regression: the node-builtins resolver and Vercel's
 * optional-dependency resolver used to answer each other's `build.resolve`
 * probes for `ws`, bouncing it forever and never finishing the build.
 */

import { afterEach, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assert, assertEquals } from "./_assert.ts";
import { bundleAllChunked } from "../src/bundler/core.ts";
import { VERCEL_PROFILE } from "../src/backends/vercel/bundle-profile.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

test("bundler: `ws` is bundled for Node targets and the probe resolvers terminate", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-builtins-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  // A `ws` lookalike: optionally requires a native helper behind try/catch,
  // exactly the shape the optional-dependency resolver exists for.
  await write(
    join(dir, "node_modules", "ws", "package.json"),
    JSON.stringify({ name: "ws", version: "8.0.0", main: "index.js" }),
  );
  await write(
    join(dir, "node_modules", "ws", "index.js"),
    `let fast = null;\ntry { fast = require("bufferutil"); } catch {}\nmodule.exports = { WS_MARKER: "fake-ws", fast };\n`,
  );
  await write(
    join(dir, "functions", "sock", "index.ts"),
    `import ws from "ws";\nimport { createHash } from "node:crypto";\nexport const marker = (ws as any).WS_MARKER + typeof createHash;\n`,
  );

  const out = join(dir, "out");
  const result = await Promise.race([
    bundleAllChunked({
      inputs: [{ name: "sock", entrypoint: join(dir, "functions", "sock", "index.ts") }],
      outDir: out,
      profile: VERCEL_PROFILE,
      sourcemap: false,
    }),
    Bun.sleep(30_000).then(() => "TIMEOUT" as const),
  ]);
  assert(result !== "TIMEOUT", "bundle did not finish (probe recursion?)");
  assertEquals(result.functions.length, 1);

  const js: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (p.endsWith(".js")) js.push(await readFile(p, "utf8"));
    }
  };
  await walk(out);
  const code = js.join("\n");
  assert(code.includes("fake-ws"), "ws was bundled, not treated as a builtin");
  assert(!/from\s*["']node:ws["']/.test(code), "ws must not become node:ws");
  assert(/["']node:crypto["']/.test(code), "real builtins stay external");
});

test("Vercel bundles npm subpaths under builtin names and runs them in Node", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "1tube-builtin-subpaths-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  // readable-stream uses require('process/') to request the npm polyfill.
  // A builtin head alone must not turn that into the invalid node:process/.
  for (const name of ["process", "assert"]) {
    await write(join(dir, "node_modules", name, "package.json"),
      JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
    await write(join(dir, "node_modules", name, "index.js"),
      `module.exports = { marker: "npm-${name}" };`);
  }
  await write(join(dir, "node_modules", "process", "browser.js"),
    'module.exports = { marker: "npm-process-browser" };');
  const { build } = await import("esbuild");
  const outfile = join(dir, "bundle.mjs");
  await build({
    stdin: { resolveDir: dir, contents: `
      const polyfill = require('process/');
      const browser = require('process/browser');
      const npmAssert = require('assert/');
      const nativeProcess = require('process');
      const { ReadableStream } = require('stream/web');
      const { readFile } = require('fs/promises');
      console.log(JSON.stringify([polyfill.marker, browser.marker, npmAssert.marker,
        typeof nativeProcess.nextTick, typeof ReadableStream, typeof readFile]));
    ` },
    outfile, bundle: true, format: "esm", platform: VERCEL_PROFILE.platform,
    conditions: [...VERCEL_PROFILE.conditions], mainFields: [...VERCEL_PROFILE.mainFields],
    plugins: [...(VERCEL_PROFILE.resolverPlugins ?? [])],
    banner: { js: VERCEL_PROFILE.outputPreamble! },
  });
  const run = Bun.spawn(["node", outfile], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited,
  ]);
  assertEquals(exitCode, 0, stderr);
  assertEquals(JSON.parse(stdout), ["npm-process", "npm-process-browser", "npm-assert", "function", "function", "function"]);
});
