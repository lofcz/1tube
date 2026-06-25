/**
 * Tests for src/env-scope.ts.
 *
 * The env scope module patches Deno.env globally — once installed, it cannot
 * be cleanly torn down for the rest of the process. To keep tests isolated
 * we install once at the top, save the originals, and let each test wrap
 * runWithEnvScope around its own assertions.
 */

import { assert, assertEquals } from "@std/assert";
import { installEnvScope, runWithEnvScope } from "../src/env-scope.ts";

installEnvScope();

Deno.test("env-scope: outside a function context, all env reads pass through", () => {
  Deno.env.set("__SCOPE_TEST_OUTSIDE", "yes");
  try {
    assertEquals(Deno.env.get("__SCOPE_TEST_OUTSIDE"), "yes");
  } finally {
    Deno.env.delete("__SCOPE_TEST_OUTSIDE");
  }
});

Deno.test("env-scope: inside a function context, only allowlisted vars are visible", () => {
  Deno.env.set("__SCOPE_ALLOWED", "ok");
  Deno.env.set("__SCOPE_BLOCKED", "secret");
  try {
    runWithEnvScope(
      { functionName: "fn", allow: new Set(["__SCOPE_ALLOWED"]) },
      () => {
        assertEquals(Deno.env.get("__SCOPE_ALLOWED"), "ok");
        assertEquals(Deno.env.get("__SCOPE_BLOCKED"), undefined);
        assert(Deno.env.has("__SCOPE_ALLOWED"));
        assert(!Deno.env.has("__SCOPE_BLOCKED"));
      },
    );
  } finally {
    Deno.env.delete("__SCOPE_ALLOWED");
    Deno.env.delete("__SCOPE_BLOCKED");
  }
});

Deno.test("env-scope: toObject filters to allowlisted keys inside a context", () => {
  Deno.env.set("__SCOPE_A", "1");
  Deno.env.set("__SCOPE_B", "2");
  try {
    runWithEnvScope(
      { functionName: "fn", allow: new Set(["__SCOPE_A"]) },
      () => {
        const obj = Deno.env.toObject();
        assertEquals(obj.__SCOPE_A, "1");
        assertEquals(obj.__SCOPE_B, undefined);
      },
    );
  } finally {
    Deno.env.delete("__SCOPE_A");
    Deno.env.delete("__SCOPE_B");
  }
});

Deno.test("env-scope: env writes from inside a context throw PermissionDenied", () => {
  let threw = false;
  try {
    runWithEnvScope(
      { functionName: "fn", allow: new Set() },
      () => Deno.env.set("__SCOPE_NEW", "nope"),
    );
  } catch (err) {
    threw = err instanceof Deno.errors.PermissionDenied;
  }
  assert(
    threw,
    "Deno.env.set inside function context should throw PermissionDenied",
  );
  assertEquals(Deno.env.get("__SCOPE_NEW"), undefined);
});
