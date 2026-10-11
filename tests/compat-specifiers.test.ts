/**
 * Parsing of the Deno-style specifiers Supabase Edge Functions use
 * (`npm:`, `jsr:`, `https:`). The compat plugin, the dependency pre-scan and
 * the dep-graph all go through these parsers, so their shapes must agree.
 */

import { test } from "bun:test";
import { assertEquals } from "./_assert.ts";
import {
  isRemoteSpecifier,
  packageKey,
  parseJsrSpecifier,
  parseNpmSpecifier,
  parsePackageSpecifier,
} from "../src/compat/specifiers.ts";

test("specifiers: npm: plain, ranged, scoped and with subpaths", () => {
  assertEquals(parseNpmSpecifier("npm:zod"), { name: "zod", range: "latest", subpath: "", registry: "npm" });
  assertEquals(parseNpmSpecifier("npm:zod@^3.23"), { name: "zod", range: "^3.23", subpath: "", registry: "npm" });
  assertEquals(parseNpmSpecifier("npm:zod@3.23.8/v4"), {
    name: "zod",
    range: "3.23.8",
    subpath: "/v4",
    registry: "npm",
  });
  assertEquals(parseNpmSpecifier("npm:zod/v4"), { name: "zod", range: "latest", subpath: "/v4", registry: "npm" });
  assertEquals(parseNpmSpecifier("npm:@supabase/supabase-js@2"), {
    name: "@supabase/supabase-js",
    range: "2",
    subpath: "",
    registry: "npm",
  });
  assertEquals(parseNpmSpecifier("npm:@ai-sdk/openai@^1.0.0/internal/x.js"), {
    name: "@ai-sdk/openai",
    range: "^1.0.0",
    subpath: "/internal/x.js",
    registry: "npm",
  });
  assertEquals(parseNpmSpecifier("npm:@scope/pkg/sub"), {
    name: "@scope/pkg",
    range: "latest",
    subpath: "/sub",
    registry: "npm",
  });
});

test("specifiers: npm: edge forms", () => {
  // Bun hands a namespace plugin the remainder without the scheme.
  assertEquals(parseNpmSpecifier("hono@4/jsx"), { name: "hono", range: "4", subpath: "/jsx", registry: "npm" });
  // Deno also accepts `npm:/pkg`.
  assertEquals(parseNpmSpecifier("npm:/zod@3"), { name: "zod", range: "3", subpath: "", registry: "npm" });
  // An empty range and a trailing slash normalize.
  assertEquals(parseNpmSpecifier("npm:zod@"), { name: "zod", range: "latest", subpath: "", registry: "npm" });
  assertEquals(parseNpmSpecifier("npm:zod@3/"), { name: "zod", range: "3", subpath: "", registry: "npm" });
  // Complex ranges survive intact (up to the subpath slash).
  assertEquals(parseNpmSpecifier("npm:zod@>=3.20 <4")?.range, ">=3.20 <4");
  // Not plausible package references.
  assertEquals(parseNpmSpecifier("npm:"), null);
  assertEquals(parseNpmSpecifier("npm:@scope"), null);
  assertEquals(parseNpmSpecifier("npm:@/x"), null);
  assertEquals(parseNpmSpecifier("npm:@scope/"), null);
});

test("specifiers: jsr: maps to the npm.jsr.io compat package", () => {
  assertEquals(parseJsrSpecifier("jsr:@std/path@^1"), {
    name: "@jsr/std__path",
    range: "^1",
    subpath: "",
    registry: "jsr",
  });
  assertEquals(parseJsrSpecifier("jsr:@std/path@1.0.8/posix"), {
    name: "@jsr/std__path",
    range: "1.0.8",
    subpath: "/posix",
    registry: "jsr",
  });
  assertEquals(parseJsrSpecifier("jsr:@supabase/functions-js"), {
    name: "@jsr/supabase__functions-js",
    range: "latest",
    subpath: "",
    registry: "jsr",
  });
  assertEquals(parseJsrSpecifier("@std/assert@1")?.name, "@jsr/std__assert");
  assertEquals(parseJsrSpecifier("jsr:/@std/assert@1")?.name, "@jsr/std__assert");
  // JSR packages are always scoped.
  assertEquals(parseJsrSpecifier("jsr:path@1"), null);
  assertEquals(parseJsrSpecifier("jsr:@std"), null);
});

test("specifiers: parsePackageSpecifier only accepts scheme-prefixed forms", () => {
  assertEquals(parsePackageSpecifier("npm:zod@3")?.registry, "npm");
  assertEquals(parsePackageSpecifier("jsr:@std/path")?.registry, "jsr");
  assertEquals(parsePackageSpecifier("zod"), null);
  assertEquals(parsePackageSpecifier("./local.ts"), null);
  assertEquals(parsePackageSpecifier("https://esm.sh/zod"), null);
  assertEquals(parsePackageSpecifier("node:fs"), null);
});

test("specifiers: remote detection and package keys", () => {
  assertEquals(isRemoteSpecifier("https://deno.land/std/http/server.ts"), true);
  assertEquals(isRemoteSpecifier("http://localhost:8000/mod.ts"), true);
  assertEquals(isRemoteSpecifier("npm:zod"), false);
  assertEquals(isRemoteSpecifier("file:///tmp/x.ts"), false);
  assertEquals(isRemoteSpecifier("httpx"), false);

  // The key is the unit of installation: subpaths share one install.
  const a = parseNpmSpecifier("npm:zod@^3/v4")!;
  const b = parseNpmSpecifier("npm:zod@^3")!;
  assertEquals(packageKey(a), "zod@^3");
  assertEquals(packageKey(a), packageKey(b));
  assertEquals(packageKey(parseJsrSpecifier("jsr:@std/path@^1")!), "@jsr/std__path@^1");
});
