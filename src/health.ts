/**
 * Health check and metrics endpoints.
 */

import type { Context } from "npm:hono@4";
import type { FunctionRegistry } from "./registry.ts";
import { getCollectedMetrics, getPrometheusMetrics } from "./gateway/logging.ts";

function hasValidKey(c: Context, secretKey?: string): boolean {
  return !!secretKey && c.req.query("key") === secretKey;
}

export function createHealthHandler(
  registry: FunctionRegistry,
  secretKey?: string,
) {
  return (c: Context) => {
    if (!hasValidKey(c, secretKey)) {
      return c.json({ status: "ok" });
    }

    const metrics = getCollectedMetrics();
    const mem = Deno.memoryUsage();
    return c.json({
      status: "ok",
      function_count: registry.size,
      functionList: registry.list(),
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
      },
      ...metrics,
    });
  };
}

export function createMetricsHandler(secretKey?: string) {
  return (c: Context) => {
    if (!hasValidKey(c, secretKey)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    return new Response(getPrometheusMetrics(), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  };
}
