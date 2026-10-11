/**
 * Tests for build-time capture of declared `serve({ timeoutMs })` options
 * (`src/backends/vercel/capture-config.ts`).
 *
 * The capture installs a stub `globalThis.__edgeFunctionRegistry` — the same
 * contract `_shared/handler.ts` registers against — imports each entrypoint
 * once, and records what it registered. These tests use hermetic temp fixtures
 * that only touch globals (no bare imports) so they run offline.
 */

import { test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, assertEquals } from "./_assert.ts";
import type { BundleInput } from "../src/bundler/core.ts";
import { captureDeclaredServeConfigs } from "../src/backends/vercel/capture-config.ts";

async function writeFixture(
  dir: string,
  name: string,
  body: string,
): Promise<BundleInput> {
  const entrypoint = join(dir, `${name}.ts`);
  await writeFile(entrypoint, body);
  return { name, entrypoint };
}

test(
  "captureDeclaredServeConfigs reads a registry-declared timeoutMs",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "1tube-capture-"));
    try {
      const input = await writeFixture(
        dir,
        "declared",
        `(globalThis as any).__edgeFunctionRegistry?.register(
           () => new Response("ok"),
           { public: true, timeoutMs: 60000 },
         );\n`,
      );
      const map = await captureDeclaredServeConfigs([input]);
      assertEquals(map.get("declared"), { public: true, timeoutMs: 60000 });
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

test(
  "captureDeclaredServeConfigs does not bind a port for raw Deno.serve and restores the Deno global",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "1tube-capture-raw-"));
    // Bun has no `Deno` global; the sweep installs a temporary one (with a
    // neutralised `serve`) so raw `Deno.serve(...)` entrypoints still load.
    const globalAny = globalThis as Record<string, unknown>;
    const hadDeno = "Deno" in globalAny;
    const origDeno = globalAny.Deno;
    try {
      // If Deno.serve were NOT neutralised this would bind a real listener;
      // the fixture also declares no timeout, so it must be absent from the
      // result.
      const input = await writeFixture(
        dir,
        "raw",
        `Deno.serve(() => new Response("ok"));\n`,
      );
      const warnings: string[] = [];
      const map = await captureDeclaredServeConfigs(
        [input],
        (m) => warnings.push(m),
      );
      assert(!map.has("raw"));
      // The fixture must have loaded (the shim made `Deno.serve` callable).
      assertEquals(warnings, []);
      // The global must be exactly what it was before the sweep.
      assertEquals("Deno" in globalAny, hadDeno);
      assert(globalAny.Deno === origDeno);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

test(
  "captureDeclaredServeConfigs skips an entry that throws at import and warns",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "1tube-capture-throw-"));
    try {
      const ok = await writeFixture(
        dir,
        "ok",
        `(globalThis as any).__edgeFunctionRegistry?.register(
           () => new Response("ok"),
           { public: false, timeoutMs: 12000 },
         );\n`,
      );
      const boom = await writeFixture(
        dir,
        "boom",
        `throw new Error("boom at import");\n`,
      );

      const warnings: string[] = [];
      const map = await captureDeclaredServeConfigs(
        [boom, ok],
        (m) => warnings.push(m),
      );

      assert(!map.has("boom"));
      assertEquals(map.get("ok"), { public: false, timeoutMs: 12000 });
      assert(
        warnings.some((w) => w.includes("boom")),
        `expected a warning mentioning boom, got: ${warnings.join(" | ")}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

test(
  "captureDeclaredServeConfigs returns empty for no inputs",
  async () => {
    const map = await captureDeclaredServeConfigs([]);
    assertEquals(map.size, 0);
  },
);
