/**
 * Tests for the Prometheus extras surface added in M6 (workerd-backend
 * gauges + per-function circuit-breaker view). The base /metrics
 * format hasn't been covered by tests historically because the shape
 * was static; with `extras` the output is now operator-visible state
 * worth pinning so a refactor doesn't silently break a dashboard.
 *
 * Each test imports `getPrometheusMetrics` via the cached module —
 * we don't need the metrics map fresh, only the extras formatting.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { getPrometheusMetrics } from "../src/gateway/logging.ts";

Deno.test("getPrometheusMetrics: workerd block omitted when extras absent", () => {
  const out = getPrometheusMetrics();
  // Sanity: the static gauges still emit even without extras.
  assertStringIncludes(out, "onetube_uptime_seconds");
  // No workerd-prefixed metric should appear when no extras are passed.
  assertEquals(out.includes("onetube_workerd_"), false);
  // Same for breaker labels.
  assertEquals(out.includes("onetube_function_breaker_open"), false);
});

Deno.test("getPrometheusMetrics: workerd block emits all configured gauges", () => {
  const out = getPrometheusMetrics({
    workerd: {
      pid: 4242,
      generation: 3,
      recycles: 7,
      rss_bytes: 123_456,
      budget_bytes: 200_000,
      last_reload_duration_ms: 412.5,
      bundle_bytes: { hello: 1024, "fancy-fn": 999_999 },
    },
  });

  // up + pid: gauges that always emit.
  assertStringIncludes(out, "onetube_workerd_up 1");
  assertStringIncludes(out, "onetube_workerd_pid 4242");
  // generation/recycles are counters (Prometheus type metadata only;
  // value is the same number).
  assertStringIncludes(out, "onetube_workerd_generation 3");
  assertStringIncludes(out, "onetube_workerd_recycles_total 7");
  // RSS + budget gauges only emit when their value is non-null.
  assertStringIncludes(out, "onetube_workerd_rss_bytes 123456");
  assertStringIncludes(out, "onetube_workerd_budget_bytes 200000");
  // Last reload duration uses one decimal place — operators care about
  // ms precision when tracking HMR perf regressions.
  assertStringIncludes(out, "onetube_workerd_last_reload_duration_ms 412.5");
  // Per-function bundle bytes labelled by name. Must NOT html-encode
  // the dash; Prometheus accepts label-value characters as-is unless
  // they need escaping, and 'fancy-fn' is fine.
  assertStringIncludes(
    out,
    `onetube_workerd_bundle_bytes{function="hello"} 1024`,
  );
  assertStringIncludes(
    out,
    `onetube_workerd_bundle_bytes{function="fancy-fn"} 999999`,
  );
});

Deno.test("getPrometheusMetrics: workerd block omits null-valued gauges", () => {
  // pid: null is the "between processes" state (mid-recycle, post-
  // crash before reload). We still emit `up=0` and `pid=0` so dashboards
  // can detect the gap, but don't emit RSS/budget/last_reload when we
  // don't have a number to put there.
  const out = getPrometheusMetrics({
    workerd: {
      pid: null,
      generation: 0,
      recycles: 0,
      rss_bytes: null,
      budget_bytes: null,
      last_reload_duration_ms: null,
      bundle_bytes: {},
    },
  });
  assertStringIncludes(out, "onetube_workerd_up 0");
  assertStringIncludes(out, "onetube_workerd_pid 0");
  assertEquals(out.includes("onetube_workerd_rss_bytes"), false);
  assertEquals(out.includes("onetube_workerd_budget_bytes"), false);
  assertEquals(out.includes("onetube_workerd_last_reload_duration_ms"), false);
  // No bundle_bytes lines either — empty maps shouldn't emit a HELP/TYPE
  // header for a gauge with zero series.
  assertEquals(out.includes("onetube_workerd_bundle_bytes"), false);
});

Deno.test("getPrometheusMetrics: breaker view emits all three gauges per function", () => {
  const out = getPrometheusMetrics({
    breakers: {
      hello: { breakerOpen: false, recycleRecommended: false, errorRate: 0 },
      boom: { breakerOpen: true, recycleRecommended: true, errorRate: 1 },
    },
  });
  assertStringIncludes(
    out,
    `onetube_function_breaker_open{function="hello"} 0`,
  );
  assertStringIncludes(
    out,
    `onetube_function_breaker_open{function="boom"} 1`,
  );
  assertStringIncludes(
    out,
    `onetube_function_recycle_recommended{function="boom"} 1`,
  );
  // Error rate emits with 4-decimal precision so we keep operator-
  // visible signal even on small windows (1/3 → 0.3333).
  assertStringIncludes(
    out,
    `onetube_function_error_rate{function="boom"} 1.0000`,
  );
});

Deno.test("getPrometheusMetrics: label values escape backslash, quote, newline", () => {
  // Defence-in-depth: function names are sanitised at registration
  // time, but a future bug could let a non-clean name reach this
  // path. The label-quoting helper must be airtight so a name like
  // `weird"` can't ever produce malformed exposition lines that break
  // the whole scrape.
  const out = getPrometheusMetrics({
    workerd: {
      pid: 1,
      generation: 0,
      recycles: 0,
      rss_bytes: null,
      budget_bytes: null,
      last_reload_duration_ms: null,
      bundle_bytes: { 'weird"\\name': 12 },
    },
  });
  assertStringIncludes(
    out,
    `onetube_workerd_bundle_bytes{function="weird\\"\\\\name"} 12`,
  );
});

Deno.test("getPrometheusMetrics: trailing newline is preserved (Prometheus requires it)", () => {
  const out = getPrometheusMetrics();
  assert(out.endsWith("\n"), "Prometheus exposition must terminate with a newline");
});
