/**
 * Health check and metrics endpoints.
 */

import type { Context } from "npm:hono@4";
import type { FunctionRegistry } from "./registry.ts";
import { getCollectedMetrics, getPrometheusMetrics } from "./gateway/logging.ts";

export function createHealthHandler(registry: FunctionRegistry) {
  return (c: Context) => {
    const metrics = getCollectedMetrics();
    return c.json({
      status: "ok",
      function_count: registry.size,
      functionList: registry.list(),
      ...metrics,
    });
  };
}

export function createMetricsHandler() {
  return (c: Context) => {
    return new Response(getPrometheusMetrics(), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  };
}
