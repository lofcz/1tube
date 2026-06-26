/**
 * Tests for src/cli/dep-pin.ts — the pure npm-specifier reconciliation core
 * the serve launcher uses to pin unconstrained imports to installed versions.
 */

import { assert, assertEquals } from "@std/assert";
import { parseNpmSpecifier, reconcileImports } from "../src/cli/dep-pin.ts";

Deno.test("parseNpmSpecifier: unconstrained bare + subpath", () => {
  assertEquals(parseNpmSpecifier("npm:1tube/edge"), {
    name: "1tube",
    version: undefined,
    subpath: "/edge",
  });
  assertEquals(parseNpmSpecifier("npm:1tube"), {
    name: "1tube",
    version: undefined,
    subpath: "",
  });
});

Deno.test("parseNpmSpecifier: constrained bare + range", () => {
  assertEquals(parseNpmSpecifier("npm:zod@4.4.3"), {
    name: "zod",
    version: "4.4.3",
    subpath: "",
  });
  assertEquals(parseNpmSpecifier("npm:ai@7"), {
    name: "ai",
    version: "7",
    subpath: "",
  });
});

Deno.test("parseNpmSpecifier: scoped, constrained + subpath", () => {
  assertEquals(parseNpmSpecifier("npm:@supabase/server@^1/core"), {
    name: "@supabase/server",
    version: "^1",
    subpath: "/core",
  });
});

Deno.test("parseNpmSpecifier: scoped, unconstrained + subpath", () => {
  assertEquals(parseNpmSpecifier("npm:@supabase/server/core"), {
    name: "@supabase/server",
    version: undefined,
    subpath: "/core",
  });
});

Deno.test("parseNpmSpecifier: non-npm specifiers return null", () => {
  assertEquals(parseNpmSpecifier("jsr:@std/assert"), null);
  assertEquals(parseNpmSpecifier("https://esm.sh/x"), null);
  assertEquals(parseNpmSpecifier("./local.ts"), null);
});

Deno.test("reconcileImports: pins only unconstrained npm specifiers", () => {
  const installed: Record<string, string> = {
    "1tube": "0.1.46",
    "@supabase/server": "1.2.0",
  };
  const resolve = (p: string) => installed[p];

  const result = reconcileImports(
    {
      "1tube/edge": "npm:1tube/edge",
      "1tube/edge-caller": "npm:1tube/edge-caller",
      "zod": "npm:zod@4.4.3", // already pinned — untouched
      "@supabase/server": "npm:@supabase/server@^1", // ranged — untouched
      "@supabase/server/core": "npm:@supabase/server/core", // unconstrained
      "jose": "jsr:@std/jose", // non-npm — untouched
    },
    resolve,
  );

  assert(result.changed);
  assertEquals(result.imports["1tube/edge"], "npm:1tube@0.1.46/edge");
  assertEquals(result.imports["1tube/edge-caller"], "npm:1tube@0.1.46/edge-caller");
  assertEquals(result.imports["zod"], "npm:zod@4.4.3");
  assertEquals(result.imports["@supabase/server"], "npm:@supabase/server@^1");
  assertEquals(
    result.imports["@supabase/server/core"],
    "npm:@supabase/server@1.2.0/core",
  );
  assertEquals(result.imports["jose"], "jsr:@std/jose");

  // Distinct packages, first-seen order, deduped (1tube appears twice).
  assertEquals(result.pins, [
    { name: "1tube", version: "0.1.46" },
    { name: "@supabase/server", version: "1.2.0" },
  ]);
});

Deno.test("reconcileImports: leaves unresolved packages unpinned", () => {
  const result = reconcileImports(
    { "ghost/edge": "npm:ghost/edge" },
    () => undefined,
  );
  assertEquals(result.changed, false);
  assertEquals(result.imports["ghost/edge"], "npm:ghost/edge");
  assertEquals(result.pins, []);
});

Deno.test("reconcileImports: no-op when everything already pinned", () => {
  const result = reconcileImports(
    { "zod": "npm:zod@4.4.3", "ai": "npm:ai@7" },
    () => "9.9.9",
  );
  assertEquals(result.changed, false);
  assertEquals(result.pins, []);
});
