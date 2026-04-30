import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createDenoHmrSnapshot } from "../src/deno-hmr-snapshot.ts";
import { discoverAndLoad } from "../src/discovery.ts";
import { FunctionRegistry, type PublicHandler } from "../src/registry.ts";

async function writeFile(path: string, text: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true });
  await Deno.writeTextFile(path, text);
}

function installRegistry(): FunctionRegistry {
  const registry = new FunctionRegistry();
  (globalThis as { __edgeFunctionRegistry?: FunctionRegistry })
    .__edgeFunctionRegistry = registry;
  return registry;
}

async function invokePublic(
  registry: FunctionRegistry,
  name: string,
): Promise<string> {
  const fn = registry.get(name);
  assert(fn, `expected ${name} to be registered`);
  const response = await (fn.handler as PublicHandler)(
    new Request("http://localhost/"),
  );
  return await response.text();
}

Deno.test("deno-hmr-snapshot: local dependency edits load through a fresh module graph", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-deno-hmr-local-" });
  try {
    const functionsDir = join(tmp, "functions");
    const cacheDir = join(tmp, "cache");
    const fnName = `fn-${crypto.randomUUID().slice(0, 8)}`;
    const fnDir = join(functionsDir, fnName);

    await writeFile(
      join(fnDir, "index.ts"),
      `
import { value } from "./dep.ts";
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(() => new Response(value), { public: true });
`,
    );
    await writeFile(join(fnDir, "dep.ts"), `export const value = "before";\n`);

    const registry = installRegistry();
    await discoverAndLoad(functionsDir, registry);
    assertEquals(await invokePublic(registry, fnName), "before");

    await writeFile(join(fnDir, "dep.ts"), `export const value = "after";\n`);
    const snapshot = await createDenoHmrSnapshot({
      functionsDir,
      changed: new Set([fnName]),
      generation: 1,
      cacheDir,
    });
    await discoverAndLoad(functionsDir, registry, {
      only: new Set([fnName]),
      importRoot: snapshot.functionsDir,
      cacheBust: "gen-1",
    });

    assertEquals(await invokePublic(registry, fnName), "after");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deno-hmr-snapshot: shared dependency edits refresh every function on full reload", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-deno-hmr-shared-" });
  try {
    const functionsDir = join(tmp, "functions");
    const cacheDir = join(tmp, "cache");
    const names = [
      `a-${crypto.randomUUID().slice(0, 8)}`,
      `b-${crypto.randomUUID().slice(0, 8)}`,
    ];

    await writeFile(
      join(functionsDir, "_shared", "value.ts"),
      `export const value = "before";\n`,
    );
    for (const name of names) {
      await writeFile(
        join(functionsDir, name, "index.ts"),
        `
import { value } from "../_shared/value.ts";
const name = ${JSON.stringify(name)};
const reg = (globalThis as any).__edgeFunctionRegistry;
reg.register(() => new Response(name + ":" + value), { public: true });
`,
      );
    }

    const registry = installRegistry();
    await discoverAndLoad(functionsDir, registry);
    assertEquals(await invokePublic(registry, names[0]), `${names[0]}:before`);
    assertEquals(await invokePublic(registry, names[1]), `${names[1]}:before`);

    await writeFile(
      join(functionsDir, "_shared", "value.ts"),
      `export const value = "after";\n`,
    );
    const snapshot = await createDenoHmrSnapshot({
      functionsDir,
      changed: "all",
      generation: 1,
      cacheDir,
    });

    registry.clear();
    await discoverAndLoad(functionsDir, registry, {
      importRoot: snapshot.functionsDir,
      cacheBust: "gen-1",
    });

    assertEquals(await invokePublic(registry, names[0]), `${names[0]}:after`);
    assertEquals(await invokePublic(registry, names[1]), `${names[1]}:after`);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("deno-hmr-snapshot: incremental snapshots include shared dirs and prune old generations", async () => {
  const tmp = await Deno.makeTempDir({ prefix: "1tube-deno-hmr-prune-" });
  try {
    const functionsDir = join(tmp, "functions");
    const cacheDir = join(tmp, "cache");

    await writeFile(
      join(functionsDir, "_shared", "handler.ts"),
      `export const shared = true;\n`,
    );
    await writeFile(
      join(functionsDir, "alpha", "index.ts"),
      `export const alpha = true;\n`,
    );
    await writeFile(
      join(functionsDir, "beta", "index.ts"),
      `export const beta = true;\n`,
    );

    const first = await createDenoHmrSnapshot({
      functionsDir,
      changed: new Set(["alpha"]),
      generation: 1,
      cacheDir,
      keepGenerations: 2,
    });
    assertEquals(first.copiedDirs, ["_shared", "alpha"]);

    await createDenoHmrSnapshot({
      functionsDir,
      changed: new Set(["beta"]),
      generation: 2,
      cacheDir,
      keepGenerations: 2,
    });
    await createDenoHmrSnapshot({
      functionsDir,
      changed: "all",
      generation: 3,
      cacheDir,
      keepGenerations: 2,
    });

    await assertRejectsNotFound(join(cacheDir, "gen-1"));
    await Deno.stat(join(cacheDir, "gen-2"));
    await Deno.stat(join(cacheDir, "gen-3"));
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

async function assertRejectsNotFound(path: string): Promise<void> {
  try {
    await Deno.stat(path);
  } catch (err) {
    assert(err instanceof Deno.errors.NotFound);
    return;
  }
  throw new Error(`expected ${path} to be pruned`);
}
