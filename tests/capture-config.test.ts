/**
 * Tests for build-time capture of declared `serve({ timeoutMs })` options
 * (`src/backends/vercel/capture-config.ts`).
 *
 * The capture installs a stub `globalThis.__edgeFunctionRegistry` — the same
 * contract `_shared/handler.ts` registers against — imports each entrypoint
 * once, and records what it registered. These tests use hermetic temp fixtures
 * that only touch globals (no bare imports) so they run offline.
 */

import { assert, assertEquals } from "@std/assert";
import { join } from "node:path";
import type { BundleInput } from "../src/bundler/core.ts";
import { captureDeclaredServeConfigs } from "../src/backends/vercel/capture-config.ts";

const TEST_OPTS = { sanitizeResources: false, sanitizeOps: false } as const;

async function writeFixture(
  dir: string,
  name: string,
  body: string,
): Promise<BundleInput> {
  const entrypoint = join(dir, `${name}.ts`);
  await Deno.writeTextFile(entrypoint, body);
  return { name, entrypoint };
}

Deno.test(
  "captureDeclaredServeConfigs reads a registry-declared timeoutMs",
  TEST_OPTS,
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "1tube-capture-" });
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
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "captureDeclaredServeConfigs does not bind a port for raw Deno.serve and restores it",
  TEST_OPTS,
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "1tube-capture-raw-" });
    const origServe = Deno.serve;
    try {
      // If Deno.serve were NOT neutralised this would bind a real listener and
      // leak a resource; the fixture also declares no timeout, so it must be
      // absent from the result.
      const input = await writeFixture(
        dir,
        "raw",
        `Deno.serve(() => new Response("ok"));\n`,
      );
      const map = await captureDeclaredServeConfigs([input]);
      assert(!map.has("raw"));
      // Deno.serve must be the original reference again after the sweep.
      assertEquals(Deno.serve, origServe);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "captureDeclaredServeConfigs skips an entry that throws at import and warns",
  TEST_OPTS,
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "1tube-capture-throw-" });
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
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "captureDeclaredServeConfigs returns empty for no inputs",
  TEST_OPTS,
  async () => {
    const map = await captureDeclaredServeConfigs([]);
    assertEquals(map.size, 0);
  },
);
