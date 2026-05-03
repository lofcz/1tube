/**
 * Tests for the per-function dependency graph used by Deno-backend HMR.
 *
 * The graph is the source of truth for "which functions does this fs change
 * actually affect?" — replacing the pre-existing first-dir-of-relative-path
 * heuristic that promoted any change under `_shared/` to a full reload.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { pathToFileURL } from "node:url";
import { createDepGraph } from "../src/backends/deno/dep-graph.ts";

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

function urlOf(path: string): string {
  return pathToFileURL(path).href;
}

Deno.test("dep-graph: relative import is tracked, sibling function is not affected", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-dep-graph-rel-" });
  try {
    const fooDir = join(tmp, "foo");
    const barDir = join(tmp, "bar");
    const sharedDir = join(tmp, "_shared");

    await writeFile(
      join(sharedDir, "db.ts"),
      `export const db = "v1";\n`,
    );
    await writeFile(
      join(sharedDir, "other.ts"),
      `export const other = "x";\n`,
    );
    await writeFile(
      join(fooDir, "index.ts"),
      `import { db } from "../_shared/db.ts"; export default db;\n`,
    );
    await writeFile(
      join(barDir, "index.ts"),
      `import { other } from "../_shared/other.ts"; export default other;\n`,
    );

    const graph = createDepGraph();
    await graph.refresh("foo", urlOf(join(fooDir, "index.ts")));
    await graph.refresh("bar", urlOf(join(barDir, "index.ts")));

    const dbAffected = graph.affected([join(sharedDir, "db.ts")]);
    assertEquals([...dbAffected].sort(), ["foo"]);

    const otherAffected = graph.affected([join(sharedDir, "other.ts")]);
    assertEquals([...otherAffected].sort(), ["bar"]);

    // Function entry edits affect their own function only.
    const fooEntry = graph.affected([join(fooDir, "index.ts")]);
    assertEquals([...fooEntry], ["foo"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("dep-graph: import-map alias resolves to the right file", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-dep-graph-im-" });
  try {
    await writeFile(
      join(tmp, "_shared", "util.ts"),
      `export const util = 1;\n`,
    );
    const fnDir = join(tmp, "fn");
    await writeFile(
      join(fnDir, "index.ts"),
      `import { util } from "@app/util"; export default util;\n`,
    );

    const graph = createDepGraph({
      importMap: { "@app/util": "./_shared/util.ts" },
      importMapBase: join(tmp, "deno.json"),
    });
    await graph.refresh("fn", urlOf(join(fnDir, "index.ts")));

    const affected = graph.affected([join(tmp, "_shared", "util.ts")]);
    assertEquals([...affected], ["fn"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("dep-graph: shared file affecting two functions returns both", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-dep-graph-multi-" });
  try {
    await writeFile(
      join(tmp, "_shared", "common.ts"),
      `export const x = 1;\n`,
    );
    for (const name of ["a", "b"]) {
      await writeFile(
        join(tmp, name, "index.ts"),
        `import { x } from "../_shared/common.ts"; export default x;\n`,
      );
    }

    const graph = createDepGraph();
    await graph.refresh("a", urlOf(join(tmp, "a", "index.ts")));
    await graph.refresh("b", urlOf(join(tmp, "b", "index.ts")));

    const affected = graph.affected([join(tmp, "_shared", "common.ts")]);
    assertEquals([...affected].sort(), ["a", "b"]);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("dep-graph: forget() removes a function from the reverse index", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-dep-graph-forget-" });
  try {
    await writeFile(
      join(tmp, "_shared", "x.ts"),
      `export const x = 1;\n`,
    );
    await writeFile(
      join(tmp, "fn", "index.ts"),
      `import { x } from "../_shared/x.ts"; export default x;\n`,
    );

    const graph = createDepGraph();
    await graph.refresh("fn", urlOf(join(tmp, "fn", "index.ts")));
    assertEquals([...graph.affected([join(tmp, "_shared", "x.ts")])], ["fn"]);

    graph.forget("fn");
    assertEquals([...graph.affected([join(tmp, "_shared", "x.ts")])], []);
    assertEquals(graph.size, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("dep-graph: refresh on broken file degrades to entry-only graph", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-dep-graph-broken-" });
  try {
    const fnDir = join(tmp, "fn");
    await writeFile(
      join(fnDir, "index.ts"),
      `import { missing } from "./does-not-exist.ts"; export default missing;\n`,
    );

    const graph = createDepGraph();
    // Does not throw.
    await graph.refresh("fn", urlOf(join(fnDir, "index.ts")));
    // Entry change still re-affects the function so the next save can recover.
    const affected = graph.affected([join(fnDir, "index.ts")]);
    assert(affected.has("fn"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
