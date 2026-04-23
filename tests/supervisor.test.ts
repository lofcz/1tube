/**
 * Tests for src/supervisor.ts.
 */

import { assertEquals, assert, assertFalse } from "@std/assert";
import { FunctionSupervisor } from "../src/supervisor.ts";
import { defaultManifest } from "../src/manifest.ts";

function withRecycle(opts: Partial<{
  errorRate: number;
  errorWindow: number;
  cooldownMs: number;
  maxRequests: number;
}>) {
  const m = defaultManifest();
  Object.assign(m.recycle, opts);
  return m;
}

Deno.test("supervisor: trips breaker once errorRate is exceeded over the window", () => {
  const sup = new FunctionSupervisor();
  sup.setManifest("fn", withRecycle({ errorRate: 0.5, errorWindow: 4, cooldownMs: 1000 }));

  // 4 records: 1 ok, then 3 errors → ratio 0.75 ≥ 0.5 → trip
  let tripped = false;
  sup.record("fn", false);
  sup.record("fn", true);
  sup.record("fn", true);
  const last = sup.record("fn", true);
  tripped = tripped || last.breakerJustTripped;
  assert(tripped, "breaker should have tripped");

  const decision = sup.admit("fn", Date.now());
  assertFalse(decision.ok);
  assertEquals(decision.status, 503);
  assert((decision.retryAfter ?? 0) > 0);
});

Deno.test("supervisor: breaker re-closes after cooldown elapses", () => {
  const sup = new FunctionSupervisor();
  sup.setManifest("fn", withRecycle({ errorRate: 0.5, errorWindow: 2, cooldownMs: 50 }));

  sup.record("fn", true);
  const trip = sup.record("fn", true);
  assert(trip.breakerJustTripped);

  // Just after tripping, request is denied.
  const denied = sup.admit("fn", Date.now());
  assertFalse(denied.ok);

  // Past the cooldown, the breaker half-opens and lets traffic through.
  const future = Date.now() + 1000;
  const allowed = sup.admit("fn", future);
  assert(allowed.ok);
});

Deno.test("supervisor: maxRequests recommendation fires exactly once", () => {
  const sup = new FunctionSupervisor();
  sup.setManifest("fn", withRecycle({ maxRequests: 3, errorRate: 0 }));

  const a = sup.record("fn", false);
  const b = sup.record("fn", false);
  const c = sup.record("fn", false);
  const d = sup.record("fn", false);
  assertFalse(a.recycleJustRecommended);
  assertFalse(b.recycleJustRecommended);
  assert(c.recycleJustRecommended);
  assertFalse(d.recycleJustRecommended);
  assertEquals(sup.stats("fn").recycleRecommended, true);
});

Deno.test("supervisor: stats tracks invocations, errors and ratio", () => {
  const sup = new FunctionSupervisor();
  sup.setManifest("fn", withRecycle({ errorRate: 0.99, errorWindow: 10 }));

  sup.record("fn", false);
  sup.record("fn", true);
  sup.record("fn", false);

  const stats = sup.stats("fn");
  assertEquals(stats.invocations, 3);
  assertEquals(stats.errors, 1);
  // 1/3 == 0.333…
  assert(Math.abs(stats.errorRate - 1 / 3) < 1e-9);
  assertEquals(stats.breakerOpen, false);
});

Deno.test("supervisor: forget() drops state and manifest", () => {
  const sup = new FunctionSupervisor();
  sup.setManifest("fn", defaultManifest());
  sup.record("fn", true);
  sup.forget("fn");

  // After forget, fresh stats: zero invocations.
  const stats = sup.stats("fn");
  assertEquals(stats.invocations, 0);
});

Deno.test("supervisor: admit always allows when no manifest is registered", () => {
  const sup = new FunctionSupervisor();
  const decision = sup.admit("unknown");
  assert(decision.ok);
});

Deno.test("supervisor: never trips breaker before window is full", () => {
  const sup = new FunctionSupervisor();
  sup.setManifest("fn", withRecycle({ errorRate: 0.1, errorWindow: 10 }));

  // 9 errors but window not yet full — must not trip.
  for (let i = 0; i < 9; i++) {
    const r = sup.record("fn", true);
    assertFalse(r.breakerJustTripped, `tripped early at ${i}`);
  }
  // 10th error fills the window → trips.
  const r = sup.record("fn", true);
  assert(r.breakerJustTripped);
});

Deno.test("supervisor: allStats() reports every known function", () => {
  const sup = new FunctionSupervisor();
  sup.setManifest("a", defaultManifest());
  sup.setManifest("b", defaultManifest());
  sup.record("a", false);
  sup.record("b", true);
  const all = sup.allStats();
  assertEquals(Object.keys(all).sort(), ["a", "b"]);
  assertEquals(all.a.errors, 0);
  assertEquals(all.b.errors, 1);
});
