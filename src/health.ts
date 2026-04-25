/**
 * Health check and metrics endpoints.
 *
 * Without an `INTERNAL_KEY` set, /health responds with a minimal `{status:"ok"}`
 * and /metrics returns 403. With one configured, callers must present
 * `Authorization: Bearer <INTERNAL_KEY>` — header-only. The legacy
 * `?key=<INTERNAL_KEY>` query parameter has been removed (was deprecated; query
 * strings leak into access logs, browser history, and proxy buffers).
 */

import type { Context } from "npm:hono@4";
import type { FunctionRegistry } from "./registry.ts";
import type { FunctionSupervisor } from "./supervisor.ts";
import {
  getCollectedMetrics,
  getPrometheusMetrics,
  type PrometheusExtras,
} from "./gateway/logging.ts";

type MemoryReader = () => number | null;

const realReader: MemoryReader = () => {
  try {
    const proc = (globalThis as unknown as {
      process?: { constrainedMemory?: () => number };
    }).process;
    const v = proc?.constrainedMemory?.();
    if (typeof v === "number" && v > 0) return v;
    return null;
  } catch {
    return null;
  }
};

let _memReader: MemoryReader = realReader;

/**
 * Read the cgroup / job-object memory cap (bytes) using `process.constrainedMemory()`
 * (Deno 2.7+, Node compat). Returns `null` on bare metal or when the runtime
 * doesn't support it.
 */
export function readConstrainedMemoryBytes(): number | null {
  return _memReader();
}

/** Test-only: stub the memory cap reader. */
export function _setConstrainedMemoryReaderForTests(fn: MemoryReader | null): void {
  _memReader = fn ?? realReader;
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function authorize(c: Context, secretKey?: string): boolean {
  if (!secretKey) return false;
  const headerKey = parseBearer(c.req.header("Authorization") ?? null);
  return headerKey !== null && headerKey === secretKey;
}

/**
 * Optional provider for workerd-backend state surfaced on /health.
 * Wired by `server.ts` only when the workerd backend is active; the
 * Deno-only path leaves it undefined and the response simply omits
 * the `workerd` field. Returning a fresh snapshot on every call
 * means the watchdog's `recycles` counter and the backend's `pid`
 * always reflect the latest state.
 */
export type WorkerdHealthProvider = () => {
  pid: number | null;
  generation: number;
  recycles: number;
  rss_bytes: number | null;
  budget_bytes: number | null;
  /**
   * Wall-clock duration of the most recent successful reload, in
   * milliseconds. `null` until the first reload happens.
   */
  last_reload_duration_ms: number | null;
  /**
   * Per-function esbuild output size in bytes. Lets ops eyeball
   * which function ballooned without scraping /metrics. Updated on
   * every successful boot/reload.
   */
  bundle_bytes: Record<string, number>;
} | null;

export function createHealthHandler(
  registry: FunctionRegistry,
  secretKey?: string,
  supervisor?: FunctionSupervisor,
  workerd?: WorkerdHealthProvider,
) {
  return (c: Context) => {
    if (!authorize(c, secretKey)) {
      return c.json({ status: "ok" });
    }

    const metrics = getCollectedMetrics();
    const mem = Deno.memoryUsage();
    const supervisorStats = supervisor?.allStats() ?? {};
    const limitBytes = readConstrainedMemoryBytes();
    const limitMb = limitBytes ? Math.round(limitBytes / 1024 / 1024) : null;
    const headroomPct = limitBytes && mem.rss > 0
      ? Math.max(0, Math.round((1 - mem.rss / limitBytes) * 100))
      : null;
    const wd = workerd?.() ?? null;
    return c.json({
      status: "ok",
      function_count: registry.size,
      functionList: registry.list(),
      memory: {
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        // `limit_mb` is the cgroup / job-object memory cap (Linux containers,
        // Windows job objects). `null` on bare metal or runtimes without
        // `process.constrainedMemory()`. `headroom_pct` is operator-friendly:
        // 0 means we're at the cap, 100 means we have the whole cap free.
        limit_mb: limitMb,
        headroom_pct: headroomPct,
      },
      supervisor: supervisorStats,
      ...(wd !== null ? { workerd: wd } : {}),
      ...metrics,
    });
  };
}

/**
 * Provider for /metrics extras (Prometheus). Lives separately from the
 * /health workerd provider so callers can build them independently —
 * /metrics needs a different shape (per-function bundle map, breaker
 * gauges) than /health (which renders both as JSON anyway).
 */
export type MetricsExtrasProvider = () => PrometheusExtras;

export function createMetricsHandler(
  secretKey?: string,
  extras?: MetricsExtrasProvider,
) {
  return (c: Context) => {
    if (!authorize(c, secretKey)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    const extrasSnapshot = extras?.() ?? undefined;
    return new Response(getPrometheusMetrics(extrasSnapshot), {
      headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  };
}
