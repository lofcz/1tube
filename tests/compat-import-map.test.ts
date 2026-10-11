/**
 * Deno import-map support (`imports` + `scopes` from deno.json[c]).
 *
 * Bun has no notion of deno.json, so the compat plugin's source rewriter and
 * the HMR dep-graph both resolve aliases through `compat/import-map.ts`.
 */

import { afterEach, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertEquals } from "./_assert.ts";
import {
  findDenoConfig,
  type ImportMap,
  importMapKeys,
  readImportMap,
  resolveImportMap,
  stripJsonc,
} from "../src/compat/import-map.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "1tube-import-map-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

const BASE = "/project/supabase/functions/deno.json";
const ref = (p: string) => pathToFileURL(p).href;

test("import-map: stripJsonc removes comments and trailing commas, not string contents", () => {
  const text = `{
  // line comment
  "imports": {
    "a": "https://x.dev/a//b.ts", /* block */
    "b": "it's // not a comment",
    "c": "/* nor this */",
  },
  "scopes": {},
}`;
  assertEquals(JSON.parse(stripJsonc(text)), {
    imports: {
      a: "https://x.dev/a//b.ts",
      b: "it's // not a comment",
      c: "/* nor this */",
    },
    scopes: {},
  });
  assertEquals(JSON.parse(stripJsonc(`{"q": "say \\"hi\\" // x"}`)), { q: `say "hi" // x` });
});

test("import-map: exact matches win over prefixes; longest prefix wins", () => {
  const map: ImportMap = {
    imports: {
      "lodash": "npm:lodash@4",
      "lodash/": "npm:lodash@4/",
      "@shared/": "./_shared/",
      "@shared/deep/": "./_deep/",
      "@app/util": "./_shared/util.ts",
      "std/": "https://deno.land/std@0.224.0/",
    },
    base: BASE,
  };
  const from = ref("/project/supabase/functions/fn/index.ts");
  assertEquals(resolveImportMap("lodash", from, map), "npm:lodash@4");
  assertEquals(resolveImportMap("lodash/fp", from, map), "npm:lodash@4/fp");
  assertEquals(
    resolveImportMap("@shared/cors.ts", from, map),
    "file:///project/supabase/functions/_shared/cors.ts",
  );
  assertEquals(
    resolveImportMap("@shared/deep/x.ts", from, map),
    "file:///project/supabase/functions/_deep/x.ts",
  );
  assertEquals(
    resolveImportMap("@app/util", from, map),
    "file:///project/supabase/functions/_shared/util.ts",
  );
  assertEquals(
    resolveImportMap("std/http/server.ts", from, map),
    "https://deno.land/std@0.224.0/http/server.ts",
  );
  // A non-slash key never matches as a prefix.
  assertEquals(resolveImportMap("@app/util/x", from, map), null);
  assertEquals(resolveImportMap("unknown", from, map), null);
  assertEquals(resolveImportMap("lodash", from, undefined), null);
});

test("import-map: the most specific matching scope is consulted first", () => {
  const map: ImportMap = {
    imports: { "@lib": "./_vendor/global.ts", "only-global": "npm:g@1" },
    scopes: {
      "./fn/": { "@lib": "./_vendor/fn.ts" },
      "./fn/nested/": { "@lib": "./_vendor/nested.ts" },
      "https://esm.sh/": { "@lib": "npm:lib@1" },
    },
    base: BASE,
  };
  const root = "/project/supabase/functions";
  assertEquals(resolveImportMap("@lib", ref(`${root}/other/index.ts`), map), `file://${root}/_vendor/global.ts`);
  assertEquals(resolveImportMap("@lib", ref(`${root}/fn/index.ts`), map), `file://${root}/_vendor/fn.ts`);
  assertEquals(resolveImportMap("@lib", ref(`${root}/fn/nested/a.ts`), map), `file://${root}/_vendor/nested.ts`);
  assertEquals(resolveImportMap("@lib", "https://esm.sh/x.js", map), "npm:lib@1");
  // A scope without the key falls back to the top-level imports.
  assertEquals(resolveImportMap("only-global", ref(`${root}/fn/index.ts`), map), "npm:g@1");
});

test("import-map: URL-ish targets pass through; relative ones resolve against the config file", () => {
  const map: ImportMap = {
    imports: {
      "a": "jsr:@std/path@^1",
      "b": "file:///abs/b.ts",
      "c": "../outside/c.ts",
      "d": "/rooted/d.ts",
      "e": "node:path",
    },
    base: BASE,
  };
  const from = ref("/project/supabase/functions/fn/index.ts");
  assertEquals(resolveImportMap("a", from, map), "jsr:@std/path@^1");
  assertEquals(resolveImportMap("b", from, map), "file:///abs/b.ts");
  assertEquals(resolveImportMap("c", from, map), "file:///project/supabase/outside/c.ts");
  assertEquals(resolveImportMap("d", from, map), "file:///rooted/d.ts");
  assertEquals(resolveImportMap("e", from, map), "node:path");
});

test("import-map: importMapKeys lists every key once", () => {
  assertEquals(importMapKeys(undefined), []);
  assertEquals(
    importMapKeys({
      imports: { a: "x", "b/": "y/" },
      scopes: { "./s/": { a: "z", c: "w" } },
      base: BASE,
    }).sort(),
    ["a", "b/", "c"],
  );
});

test("import-map: findDenoConfig prefers cwd, then the functions dir, json before jsonc", async () => {
  const dir = await tempDir();
  const fnDir = join(dir, "supabase", "functions");
  await mkdir(fnDir, { recursive: true });
  assertEquals(findDenoConfig(dir, fnDir), undefined);

  await writeFile(join(fnDir, "deno.jsonc"), "{}");
  assertEquals(findDenoConfig(dir, fnDir), join(fnDir, "deno.jsonc"));
  await writeFile(join(fnDir, "deno.json"), "{}");
  assertEquals(findDenoConfig(dir, fnDir), join(fnDir, "deno.json"));
  assertEquals(findDenoConfig(dir), undefined);

  await writeFile(join(dir, "deno.jsonc"), "{}");
  assertEquals(findDenoConfig(dir, fnDir), join(dir, "deno.jsonc"));
  await writeFile(join(dir, "deno.json"), "{}");
  assertEquals(findDenoConfig(dir, fnDir), join(dir, "deno.json"));
});

test("import-map: readImportMap handles jsonc, importMap pointers, and bad input", async () => {
  const dir = await tempDir();
  assertEquals(readImportMap(undefined), undefined);
  assertEquals(readImportMap(join(dir, "missing.json")), undefined);

  const jsonc = join(dir, "deno.jsonc");
  await writeFile(
    jsonc,
    `{
  // Supabase projects keep aliases here
  "imports": { "@shared/": "./_shared/", },
  "scopes": { "./fn/": { "x": "npm:x@1" } },
}`,
  );
  assertEquals(readImportMap(jsonc), {
    base: jsonc,
    imports: { "@shared/": "./_shared/" },
    scopes: { "./fn/": { x: "npm:x@1" } },
  });

  // `"importMap": "./import_map.json"` points at a standalone map whose
  // own location is the base for relative targets.
  await mkdir(join(dir, "maps"), { recursive: true });
  const pointer = join(dir, "deno.json");
  const standalone = join(dir, "maps", "import_map.json");
  await writeFile(pointer, JSON.stringify({ importMap: "./maps/import_map.json" }));
  await writeFile(standalone, JSON.stringify({ imports: { lib: "./lib.ts" } }));
  const viaPointer = readImportMap(pointer)!;
  assertEquals(viaPointer.base, standalone);
  assertEquals(
    resolveImportMap("lib", ref(join(dir, "fn", "index.ts")), viaPointer),
    pathToFileURL(join(dir, "maps", "lib.ts")).href,
  );

  // A config without imports/scopes is "no map", not an empty one.
  const empty = join(dir, "empty.json");
  await writeFile(empty, JSON.stringify({ compilerOptions: {} }));
  assertEquals(readImportMap(empty), undefined);

  // Invalid JSON warns and yields no map instead of throwing.
  const bad = join(dir, "bad.json");
  await writeFile(bad, "{ not json");
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...a: unknown[]) => warnings.push(a.join(" "));
  try {
    assertEquals(readImportMap(bad), undefined);
  } finally {
    console.warn = warn;
  }
  assertEquals(warnings.length, 1);
});
