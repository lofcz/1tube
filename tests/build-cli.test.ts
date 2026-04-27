/**
 * Tests for the `1tube build` CLI command and the prebuilt artifact
 * loader on the workerd backend.
 *
 * These are real integration tests — they invoke esbuild against the
 * playground fixtures, write a `dist/` artifact, then verify the
 * artifact's shape, integrity verification, and (in `prebuilt mode`)
 * boot behaviour. Mocking esbuild would defeat the point: the contract
 * is "what `1tube build` writes is what `--prebuilt` reads".
 *
 * No workerd subprocess is launched in this file — that lives in
 * `workerd-e2e.test.ts`. We stop short of `start()` for the prebuilt
 * tests (manifest verification + boot pipeline up to capnp generation)
 * because we don't want every CI runner to need workerd installed for
 * a build-CLI unit test.
 */

import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join, resolve as resolvePath } from "node:path";
import { build, runBuild } from "../src/cli/build.ts";
import {
  PREBUILT_SCHEMA,
  parsePrebuiltManifest,
  type PrebuiltManifest,
} from "../src/backends/workerd/prebuilt.ts";

const PROJECT_ROOT = resolvePath(
  new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
);
const PLAYGROUND = join(PROJECT_ROOT, "playground");
const DENO_JSON = join(PROJECT_ROOT, "deno.json");

const TEST_OPTS = { sanitizeResources: false, sanitizeOps: false } as const;

async function tmpOutDir(label: string): Promise<string> {
  return await Deno.makeTempDir({ prefix: `1tube-build-${label}-` });
}

Deno.test("build() produces a manifest.json with hashed bundle entries", TEST_OPTS, async () => {
  const out = await tmpOutDir("happy");
  const result = await build({
    functionsDir: PLAYGROUND,
    outDir: out,
    configPath: DENO_JSON,
    only: ["hello", "echo"],
    sourcemap: false,
  });

  assertEquals(result.manifest.schema, PREBUILT_SCHEMA);
  assertEquals(result.manifest.functions.length, 2);
  const names = result.manifest.functions.map((f) => f.name).sort();
  assertEquals(names, ["echo", "hello"]);

  // Re-load from disk to make sure what's written matches what we got
  // back in-memory.
  const onDisk = JSON.parse(
    await Deno.readTextFile(join(out, "manifest.json")),
  );
  const parsed = parsePrebuiltManifest(onDisk);
  assertEquals(parsed.functions.length, 2);

  // Each entry's recorded sha256 matches the actual file bytes.
  for (const fn of parsed.functions) {
    const bytes = await Deno.readFile(join(out, fn.bundleFile));
    assertEquals(bytes.length, fn.bundleBytes);
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    let hex = "";
    for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, "0");
    assertEquals(hex, fn.bundleSha256);
  }

  // README + .gitignore land alongside the bundles.
  await Deno.stat(join(out, "README.txt"));
  await Deno.stat(join(out, ".gitignore"));
});

Deno.test("build() bakes envAllowlist + compatibility settings into the manifest", TEST_OPTS, async () => {
  const out = await tmpOutDir("compat");
  await build({
    functionsDir: PLAYGROUND,
    outDir: out,
    configPath: DENO_JSON,
    only: ["hello"],
    sourcemap: false,
    compatibilityDate: "2026-01-01",
    compatibilityFlags: ["nodejs_compat", "nodejs_als"],
    envAllowlist: ["MY_VAR", "OTHER"],
  });
  const m: PrebuiltManifest = parsePrebuiltManifest(
    JSON.parse(await Deno.readTextFile(join(out, "manifest.json"))),
  );
  assertEquals(m.compatibilityDate, "2026-01-01");
  assertEquals(m.compatibilityFlags, ["nodejs_compat", "nodejs_als"]);
  assertEquals(m.envAllowlist, ["MY_VAR", "OTHER"]);
});

Deno.test("build() packages default shared profile module metadata", TEST_OPTS, async () => {
  const root = await Deno.makeTempDir({ prefix: "1tube-build-shared-src-" });
  const out = await tmpOutDir("shared");
  try {
    await Deno.mkdir(join(root, "_shared"), { recursive: true });
    await Deno.mkdir(join(root, "needs-profile"), { recursive: true });
    await Deno.writeTextFile(
      join(root, "_shared", "profile-cache.ts"),
      `const bootId = crypto.randomUUID();
export async function getCachedProfile(userId: string) {
  return { userId, bootId };
}
export function invalidateProfile(_userId: string) {}
`,
    );
    await Deno.writeTextFile(
      join(root, "_shared", "handler.ts"),
      `export function serve(handler: (req: Request) => Response | Promise<Response>) {
  (globalThis as { __edgeFunctionRegistry: { register: (h: unknown, m: unknown) => void } })
    .__edgeFunctionRegistry.register(handler, { public: true });
}
`,
    );
    await Deno.writeTextFile(
      join(root, "needs-profile", "index.ts"),
      `import { serve } from "../_shared/handler.ts";
import { getCachedProfile } from "../_shared/profile-cache.ts";
serve(async () => Response.json(await getCachedProfile("u1")));
`,
    );

    await build({
      functionsDir: root,
      outDir: out,
      only: ["needs-profile"],
      sourcemap: false,
    });
    const m = parsePrebuiltManifest(JSON.parse(await Deno.readTextFile(join(out, "manifest.json"))));
    assertEquals(m.sharedModules.length, 1);
    assertEquals(m.sharedModules[0].id, "profile-cache");
    assertEquals(m.sharedModules[0].exportNames, ["getCachedProfile", "invalidateProfile"]);
    await Deno.stat(join(out, m.sharedModules[0].bundleFile));
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
    await Deno.remove(out, { recursive: true }).catch(() => {});
  }
});

Deno.test("build() throws on unknown function name in --only", TEST_OPTS, async () => {
  const out = await tmpOutDir("only-miss");
  await assertRejects(
    () =>
      build({
        functionsDir: PLAYGROUND,
        outDir: out,
        configPath: DENO_JSON,
        only: ["does-not-exist"],
        sourcemap: false,
      }),
    Error,
    "no functions matched",
  );
});

Deno.test("parsePrebuiltManifest rejects newer schema versions", () => {
  const fakeFutureManifest = {
    schema: PREBUILT_SCHEMA + 1,
    builtBy: "1tube@future",
    builtAt: new Date().toISOString(),
    envAllowlist: [],
    functions: [],
  };
  let threw: Error | null = null;
  try {
    parsePrebuiltManifest(fakeFutureManifest);
  } catch (err) {
    threw = err as Error;
  }
  assert(threw, "expected newer schema to throw");
  assertStringIncludes(threw!.message, "not supported");
});

Deno.test("parsePrebuiltManifest tolerates partial per-function manifest objects", () => {
  // FunctionManifest is fed through the forgiving parseManifest path,
  // so missing fields degrade to defaults rather than throwing. This
  // is what lets a slightly older manifest schema still load.
  const m = parsePrebuiltManifest({
    schema: PREBUILT_SCHEMA,
    builtBy: "1tube@test",
    builtAt: "2026-01-01T00:00:00Z",
    envAllowlist: [],
    functions: [
      {
        name: "x",
        bundleFile: "x.js",
        bundleBytes: 10,
        bundleSha256: "deadbeef",
        manifest: { /* deliberately empty */ },
      },
    ],
  });
  assertEquals(m.functions[0].name, "x");
  assertEquals(m.functions[0].manifest.permissions.env, []);
  assertEquals(m.functions[0].manifest.fromFile, true);
});

Deno.test("runBuild CLI happy path returns 0 and writes artifact", TEST_OPTS, async () => {
  const out = await tmpOutDir("cli");
  const code = await runBuild([
    "--functions",
    PLAYGROUND,
    "--out",
    out,
    "--only",
    "hello",
    "--sourcemap",
    "none",
  ]);
  assertEquals(code, 0);
  const manifest = parsePrebuiltManifest(
    JSON.parse(await Deno.readTextFile(join(out, "manifest.json"))),
  );
  assertEquals(manifest.functions.length, 1);
  assertEquals(manifest.functions[0].name, "hello");
});

Deno.test("runBuild CLI returns 2 on unknown flag", TEST_OPTS, async () => {
  const code = await runBuild(["--made-up-flag", "foo"]);
  assertEquals(code, 2);
});
