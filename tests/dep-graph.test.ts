/**
 * Tests for the per-function dependency graph used by Bun-backend HMR and
 * dependency pre-install.
 *
 * The graph is the source of truth for "which functions does this fs change
 * actually affect?" and "which npm:/jsr: packages must be installed before
 * this function is imported?".
 */

import { afterEach, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, assertEquals } from "./_assert.ts";
import { createDepGraph } from "../src/backends/bun/dep-graph.ts";

async function write(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const dirs: string[] = [];
async function tempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

function urlOf(path: string): string {
  return pathToFileURL(path).href;
}

test("dep-graph: relative import is tracked, sibling function is not affected", async () => {
  const tmp = await tempDir("1tube-dep-graph-rel-");
  await write(join(tmp, "_shared", "db.ts"), `export const db = "v1";\n`);
  await write(join(tmp, "_shared", "other.ts"), `export const other = "x";\n`);
  await write(join(tmp, "foo", "index.ts"), `import { db } from "../_shared/db.ts"; export default db;\n`);
  await write(
    join(tmp, "bar", "index.ts"),
    `import { other } from "../_shared/other.ts"; export default other;\n`,
  );

  const graph = createDepGraph();
  // Both entry spellings are accepted.
  await graph.refresh("foo", urlOf(join(tmp, "foo", "index.ts")));
  await graph.refresh("bar", join(tmp, "bar", "index.ts"));

  assertEquals([...graph.affected([join(tmp, "_shared", "db.ts")])], ["foo"]);
  assertEquals([...graph.affected([join(tmp, "_shared", "other.ts")])], ["bar"]);
  // Changed paths may be file URLs too.
  assertEquals([...graph.affected([urlOf(join(tmp, "_shared", "db.ts"))])], ["foo"]);
  // Function entry edits affect their own function only.
  assertEquals([...graph.affected([join(tmp, "foo", "index.ts")])], ["foo"]);
  assertEquals(
    [...graph.filesFor("foo")].sort(),
    [join(tmp, "_shared", "db.ts"), join(tmp, "foo", "index.ts")].sort(),
  );
  assertEquals(graph.size, 4);
});

test("dep-graph: import-map alias resolves to the right file", async () => {
  const tmp = await tempDir("1tube-dep-graph-im-");
  await write(join(tmp, "_shared", "util.ts"), `export const util = 1;\n`);
  await write(join(tmp, "fn", "index.ts"), `import { util } from "@app/util"; export default util;\n`);

  const graph = createDepGraph({
    importMap: { imports: { "@app/util": "./_shared/util.ts" }, base: join(tmp, "deno.json") },
  });
  await graph.refresh("fn", urlOf(join(tmp, "fn", "index.ts")));
  assertEquals([...graph.affected([join(tmp, "_shared", "util.ts")])], ["fn"]);
});

test("dep-graph: scoped import-map entries only apply inside their scope", async () => {
  const tmp = await tempDir("1tube-dep-graph-scope-");
  await write(join(tmp, "_vendor", "scoped.ts"), `export const v = 1;\n`);
  await write(join(tmp, "_vendor", "global.ts"), `export const v = 2;\n`);
  for (const name of ["inside", "outside"]) {
    await write(join(tmp, name, "index.ts"), `import { v } from "@lib"; export default v;\n`);
  }
  const graph = createDepGraph({
    importMap: {
      imports: { "@lib": "./_vendor/global.ts" },
      scopes: { "./inside/": { "@lib": "./_vendor/scoped.ts" } },
      base: join(tmp, "deno.json"),
    },
  });
  await graph.refreshMany([
    { name: "inside", entry: join(tmp, "inside", "index.ts") },
    { name: "outside", entry: join(tmp, "outside", "index.ts") },
  ]);
  assertEquals([...graph.affected([join(tmp, "_vendor", "scoped.ts")])], ["inside"]);
  assertEquals([...graph.affected([join(tmp, "_vendor", "global.ts")])], ["outside"]);
});

test("dep-graph: shared file affecting two functions returns both; transitive deps propagate", async () => {
  const tmp = await tempDir("1tube-dep-graph-multi-");
  await write(join(tmp, "_shared", "leaf.ts"), `export const x = 1;\n`);
  await write(join(tmp, "_shared", "common.ts"), `export { x } from "./leaf.ts";\n`);
  for (const name of ["a", "b"]) {
    await write(join(tmp, name, "index.ts"), `import { x } from "../_shared/common.ts"; export default x;\n`);
  }
  const graph = createDepGraph();
  await graph.refresh("a", join(tmp, "a", "index.ts"));
  await graph.refresh("b", join(tmp, "b", "index.ts"));
  assertEquals([...graph.affected([join(tmp, "_shared", "common.ts")])].sort(), ["a", "b"]);
  assertEquals([...graph.affected([join(tmp, "_shared", "leaf.ts")])].sort(), ["a", "b"]);
});

test("dep-graph: forget() removes a function from the reverse index", async () => {
  const tmp = await tempDir("1tube-dep-graph-forget-");
  await write(join(tmp, "_shared", "x.ts"), `export const x = 1;\n`);
  await write(join(tmp, "fn", "index.ts"), `import { x } from "../_shared/x.ts"; export default x;\n`);

  const graph = createDepGraph();
  await graph.refresh("fn", join(tmp, "fn", "index.ts"));
  assertEquals([...graph.affected([join(tmp, "_shared", "x.ts")])], ["fn"]);

  graph.forget("fn");
  assertEquals([...graph.affected([join(tmp, "_shared", "x.ts")])], []);
  assertEquals(graph.size, 0);
  assertEquals(graph.filesFor("fn"), []);
  graph.forget("never-known"); // no-op
});

test("dep-graph: a missing import degrades gracefully and is tracked for when it appears", async () => {
  const tmp = await tempDir("1tube-dep-graph-broken-");
  await write(
    join(tmp, "fn", "index.ts"),
    `import { missing } from "./does-not-exist.ts"; export default missing;\n`,
  );
  const graph = createDepGraph();
  await graph.refresh("fn", join(tmp, "fn", "index.ts")); // does not throw
  assert(graph.affected([join(tmp, "fn", "index.ts")]).has("fn"));
  // Creating the file later is an edit to the function's graph.
  assert(graph.affected([join(tmp, "fn", "does-not-exist.ts")]).has("fn"));
});

test("dep-graph: a syntax error mid-edit keeps the entry and recovers on the next save", async () => {
  const tmp = await tempDir("1tube-dep-graph-syntax-");
  const entry = join(tmp, "fn", "index.ts");
  await write(join(tmp, "fn", "dep.ts"), `export const d = 1;\n`);
  await write(entry, `import { d } from "./dep.ts";\nexport default (d;\n`);
  const graph = createDepGraph();
  await graph.refresh("fn", entry);
  assert(graph.affected([entry]).has("fn"));

  await write(entry, `import { d } from "./dep.ts";\nexport default d;\n`);
  // Make sure the mtime moves even on coarse-grained filesystems.
  const later = new Date(Date.now() + 5000);
  await utimes(entry, later, later);
  await graph.refresh("fn", entry);
  assert(graph.affected([join(tmp, "fn", "dep.ts")]).has("fn"));
});

test("dep-graph: refresh picks up a newly added import and drops a removed one", async () => {
  const tmp = await tempDir("1tube-dep-graph-edit-");
  const entry = join(tmp, "fn", "index.ts");
  await write(join(tmp, "_shared", "old.ts"), `export const v = 1;\n`);
  await write(join(tmp, "_shared", "new.ts"), `export const v = 2;\n`);
  await write(entry, `import { v } from "../_shared/old.ts"; export default v;\n`);
  const graph = createDepGraph();
  await graph.refresh("fn", entry);
  assertEquals([...graph.affected([join(tmp, "_shared", "old.ts")])], ["fn"]);

  await write(entry, `import { v } from "../_shared/new.ts";\nexport default v;\n`);
  const later = new Date(Date.now() + 5000);
  await utimes(entry, later, later);
  await graph.refresh("fn", entry);
  assertEquals([...graph.affected([join(tmp, "_shared", "old.ts")])], []);
  assertEquals([...graph.affected([join(tmp, "_shared", "new.ts")])], ["fn"]);
});

test("dep-graph: npm:/jsr: requests and remote URLs are collected, not walked", async () => {
  const tmp = await tempDir("1tube-dep-graph-pkgs-");
  await write(
    join(tmp, "_shared", "ai.ts"),
    `import { z } from "npm:zod@^3.23/v4";\nexport * from "jsr:@std/path@^1";\nexport { z };\n`,
  );
  await write(
    join(tmp, "fn", "index.ts"),
    `import "../_shared/ai.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { h } from "@alias/h";
import * as path from "node:path";
import { Database } from "bun:sqlite";
const lazy = () => import("npm:@supabase/supabase-js@2");
export { serve, h, path, Database, lazy };
`,
  );
  const graph = createDepGraph({
    importMap: { imports: { "@alias/h": "npm:hono@^4/jsx" }, base: join(tmp, "deno.json") },
  });
  await graph.refresh("fn", join(tmp, "fn", "index.ts"));
  const pkgs = graph.packagesFor("fn").map((p) => `${p.registry}:${p.name}@${p.range}${p.subpath}`).sort();
  assertEquals(pkgs, [
    "jsr:@jsr/std__path@^1",
    "npm:@supabase/supabase-js@2",
    "npm:hono@^4/jsx",
    "npm:zod@^3.23/v4",
  ]);
  assertEquals(graph.remotesFor("fn"), ["https://deno.land/std@0.168.0/http/server.ts"]);
  // Only local files are in the graph.
  assertEquals(
    [...graph.filesFor("fn")].sort(),
    [join(tmp, "_shared", "ai.ts"), join(tmp, "fn", "index.ts")].sort(),
  );
});

test("dep-graph: node_modules packages are leaves", async () => {
  const tmp = await tempDir("1tube-dep-graph-nm-");
  await write(join(tmp, "node_modules", "fake-pkg", "package.json"), JSON.stringify({ name: "fake-pkg", main: "index.js" }));
  await write(join(tmp, "node_modules", "fake-pkg", "index.js"), `export const f = 1;\n`);
  await write(join(tmp, "fn", "index.ts"), `import { f } from "fake-pkg"; export default f;\n`);
  const graph = createDepGraph();
  await graph.refresh("fn", join(tmp, "fn", "index.ts"));
  assertEquals(graph.filesFor("fn"), [join(tmp, "fn", "index.ts")]);
  assertEquals(graph.packagesFor("fn"), []);
});

test("dep-graph: refreshMany matches repeated refresh for shared and aliased deps", async () => {
  const tmp = await tempDir("1tube-dep-graph-many-");
  await write(join(tmp, "_shared", "common.ts"), `export const common = 1;\n`);
  await write(join(tmp, "_shared", "only-a.ts"), `export const onlyA = 2;\n`);
  await write(
    join(tmp, "a", "index.ts"),
    `import { common } from "@shared/common.ts"; import { onlyA } from "@shared/only-a.ts"; export default common + onlyA;\n`,
  );
  await write(join(tmp, "b", "index.ts"), `import { common } from "@shared/common.ts"; export default common;\n`);

  const options = {
    importMap: { imports: { "@shared/": "./_shared/" }, base: join(tmp, "deno.json") },
  };
  const repeated = createDepGraph(options);
  await repeated.refresh("a", urlOf(join(tmp, "a", "index.ts")));
  await repeated.refresh("b", urlOf(join(tmp, "b", "index.ts")));

  const batched = createDepGraph(options);
  await batched.refreshMany([
    { name: "a", entry: urlOf(join(tmp, "a", "index.ts")) },
    { name: "b", entry: join(tmp, "b", "index.ts") },
  ]);

  const commonPath = join(tmp, "_shared", "common.ts");
  const onlyAPath = join(tmp, "_shared", "only-a.ts");
  assertEquals([...batched.affected([commonPath])].sort(), [...repeated.affected([commonPath])].sort());
  assertEquals([...batched.affected([commonPath])].sort(), ["a", "b"]);
  assertEquals([...batched.affected([onlyAPath])], [...repeated.affected([onlyAPath])]);
  assertEquals([...batched.affected([onlyAPath])], ["a"]);
  assertEquals([...batched.filesFor("a")].sort(), [...repeated.filesFor("a")].sort());
  assertEquals([...batched.filesFor("b")].sort(), [...repeated.filesFor("b")].sort());
});
