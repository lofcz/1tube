/**
 * Structured request logging and metrics collection.
 *
 * Logs every request as a single line to stdout — no headers, no bodies, no
 * query strings — so that secrets in `Authorization` headers or request
 * payloads never reach logs.
 *
 * The metrics map is bounded (insertion-order eviction) so an attacker cannot
 * grow it unboundedly with synthetic high-cardinality function names.
 */

import type { Context, Next } from "npm:hono@4";
import { logError, logInfo } from "../log-buffer.ts";
import { getRoutePrefix, routeRemainder } from "./route-prefix.ts";
import { uuidv7 } from "../logs/id.ts";
import type {
  InvocationErrorKind,
  InvocationRow,
} from "../logs/writer.ts";

export interface FunctionMetrics {
  invocations: number;
  errors: number;
  totalDurationMs: number;
  lastInvocation: number;
}

const METRICS_MAX_ENTRIES = 5_000;

const metricsMap = new Map<string, FunctionMetrics>();
let globalRequests = 0;
let globalErrors = 0;
const startedAt = Date.now();

function getMetrics(name: string): FunctionMetrics {
  let m = metricsMap.get(name);
  if (m) return m;

  if (metricsMap.size >= METRICS_MAX_ENTRIES) {
    const oldest = metricsMap.keys().next().value;
    if (oldest !== undefined) {
      metricsMap.delete(oldest);
    }
  }
  m = { invocations: 0, errors: 0, totalDurationMs: 0, lastInvocation: 0 };
  metricsMap.set(name, m);
  return m;
}

/** Function names are URL-pathy by default; clamp them so log-injection is impossible. */
export function safeFnName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._\-/]/g, "_");
  return cleaned.length > 80 ? cleaned.slice(0, 80) + "…" : cleaned;
}

/** Response header carrying the invocation id back to the caller. */
export const INVOCATION_ID_HEADER = "x-1tube-invocation-id";

/**
 * Gateway-classified failure info, set by the dispatcher's catch
 * branches via {@link setInvocationError} so the persisted invocation
 * row carries the real cause (timeout/breaker/…) instead of just a
 * status code.
 */
export interface InvocationErrorInfo {
  kind: InvocationErrorKind;
  message?: string;
  stack?: string;
}

/**
 * Persistence hook for invocation rows. Installed by the gateway at
 * boot when the invocation log store is enabled; when absent the
 * middleware behaves exactly as before (stdout line + metrics only).
 */
let invocationSink: ((row: InvocationRow) => void) | null = null;
let invocationBackend: "deno" | "workerd" = "deno";

export function configureInvocationLogging(
  opts: { sink: ((row: InvocationRow) => void) | null; backend: "deno" | "workerd" },
): void {
  invocationSink = opts.sink;
  invocationBackend = opts.backend;
}

/** Read the invocation id assigned by the logging middleware, if any. */
export function invocationIdOf(c: Context): string | undefined {
  return (c.get("invocationId" as never) as string | undefined) ?? undefined;
}

/** Attach gateway-side error classification to the current invocation. */
export function setInvocationError(c: Context, info: InvocationErrorInfo): void {
  c.set("invocationError" as never, info as never);
}

export async function loggingMiddleware(c: Context, next: Next) {
  const start = performance.now();
  const startedAtMs = Date.now();
  const fnName = safeFnName(routeRemainder(c.req.path) || "unknown");
  // UUIDv7: time-ordered, so the persisted id doubles as a stable sort
  // tiebreaker. Assigned for every request — even when persistence is
  // off the header is useful for support tickets / client-side traces.
  const invocationId = uuidv7();
  c.set("invocationId" as never, invocationId as never);

  await next();

  const durationMs = Math.round(performance.now() - start);
  const status = c.res.status;
  const isError = status >= 400;
  try {
    c.res.headers.set(INVOCATION_ID_HEADER, invocationId);
  } catch {
    // Immutable response headers (e.g. a passthrough Response) — the
    // id still lands in the log store.
  }

  const m = getMetrics(fnName);
  m.invocations++;
  m.totalDurationMs += durationMs;
  m.lastInvocation = Date.now();
  globalRequests++;

  if (isError) {
    m.errors++;
    globalErrors++;
  }

  const userId = (c.get("userId") as string) || null;

  if (invocationSink) {
    const errorInfo = c.get("invocationError" as never) as
      | InvocationErrorInfo
      | undefined;
    // NOTE: like the stdout line below, the persisted row carries the
    // pathname only — no headers, no body, no query string — so tokens
    // in query params can never end up at rest in the log store.
    invocationSink({
      id: invocationId,
      tsMs: startedAtMs,
      functionName: fnName,
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs,
      userId,
      backend: invocationBackend,
      errorKind: errorInfo?.kind ?? null,
      errorMessage: errorInfo?.message ?? null,
      errorStack: errorInfo?.stack ?? null,
    });
  }

  const userTag = userId ? ` [user:${userId.slice(0, 8)}]` : "";
  const statusColor = isError ? "\x1b[31m" : "\x1b[32m";
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";

  // Note: only method, function name, status, duration, and a truncated user
  // id are logged. No headers (esp. Authorization), no body, no query string.
  const line = `\x1b[36m[1tube]${reset} ${c.req.method} ${getRoutePrefix()}/${fnName} → ${statusColor}${status}${reset} ${dim}(${durationMs}ms)${reset}${userTag}`;

  if (isError) {
    logError(line);
  } else {
    logInfo(line);
  }
}

/**
 * Returns collected metrics for the /metrics endpoint.
 */
export function getCollectedMetrics(): {
  uptime_ms: number;
  total_requests: number;
  total_errors: number;
  metric_entries: number;
  metric_capacity: number;
  functions: Record<string, FunctionMetrics>;
} {
  return {
    uptime_ms: Date.now() - startedAt,
    total_requests: globalRequests,
    total_errors: globalErrors,
    metric_entries: metricsMap.size,
    metric_capacity: METRICS_MAX_ENTRIES,
    functions: Object.fromEntries(metricsMap),
  };
}

/**
 * Optional extras passed by the gateway to enrich /metrics output with
 * runtime state that doesn't live in the request-counting maps.
 *
 * - `workerd`: snapshot of the active workerd backend (process state,
 *   memory budget, last reload duration, per-function bundle bytes).
 *   Omitted when running on the Deno backend.
 * - `breakers`: per-function circuit breaker view from the supervisor.
 *   Lets dashboards alert on `breaker_open == 1` without scraping
 *   /health.
 *
 * Pure data — built fresh by the caller every scrape.
 */
export interface PrometheusExtras {
  workerd?: {
    pid: number | null;
    generation: number;
    recycles: number;
    rss_bytes: number | null;
    budget_bytes: number | null;
    last_reload_duration_ms: number | null;
    bundle_bytes: Record<string, number>;
  };
  breakers?: Record<string, {
    breakerOpen: boolean;
    recycleRecommended: boolean;
    errorRate: number;
  }>;
}

/** Quote a Prometheus label value per the exposition spec. */
function quoteLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Prometheus-compatible text format for /metrics.
 */
export function getPrometheusMetrics(extras?: PrometheusExtras): string {
  const lines: string[] = [];

  lines.push("# HELP onetube_uptime_seconds Gateway uptime in seconds");
  lines.push("# TYPE onetube_uptime_seconds gauge");
  lines.push(`onetube_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);

  lines.push("# HELP onetube_requests_total Total number of function invocations");
  lines.push("# TYPE onetube_requests_total counter");
  lines.push(`onetube_requests_total ${globalRequests}`);

  lines.push("# HELP onetube_errors_total Total number of error responses");
  lines.push("# TYPE onetube_errors_total counter");
  lines.push(`onetube_errors_total ${globalErrors}`);

  lines.push("# HELP onetube_metric_entries Number of distinct functions observed");
  lines.push("# TYPE onetube_metric_entries gauge");
  lines.push(`onetube_metric_entries ${metricsMap.size}`);

  lines.push("# HELP onetube_function_invocations_total Invocations per function");
  lines.push("# TYPE onetube_function_invocations_total counter");
  for (const [name, m] of metricsMap) {
    lines.push(`onetube_function_invocations_total{function="${name}"} ${m.invocations}`);
  }

  lines.push("# HELP onetube_function_errors_total Errors per function");
  lines.push("# TYPE onetube_function_errors_total counter");
  for (const [name, m] of metricsMap) {
    lines.push(`onetube_function_errors_total{function="${name}"} ${m.errors}`);
  }

  lines.push("# HELP onetube_function_duration_ms_avg Average request duration per function");
  lines.push("# TYPE onetube_function_duration_ms_avg gauge");
  for (const [name, m] of metricsMap) {
    const avg = m.invocations > 0 ? Math.round(m.totalDurationMs / m.invocations) : 0;
    lines.push(`onetube_function_duration_ms_avg{function="${name}"} ${avg}`);
  }

  if (extras?.breakers) {
    // Per-function circuit-breaker view. Two gauges + one ratio so an
    // alert can fire on either "breaker tripped" or "error rate over
    // threshold" without a join. We emit ALL functions the supervisor
    // knows about — including those whose breaker is closed — so the
    // gauge stays present for `absent()` queries during normal ops.
    lines.push("# HELP onetube_function_breaker_open 1 when the circuit breaker is open, 0 otherwise");
    lines.push("# TYPE onetube_function_breaker_open gauge");
    for (const [name, b] of Object.entries(extras.breakers)) {
      lines.push(`onetube_function_breaker_open{function="${quoteLabel(name)}"} ${b.breakerOpen ? 1 : 0}`);
    }
    lines.push("# HELP onetube_function_error_rate Rolling error rate inside the supervisor's window (0..1)");
    lines.push("# TYPE onetube_function_error_rate gauge");
    for (const [name, b] of Object.entries(extras.breakers)) {
      lines.push(`onetube_function_error_rate{function="${quoteLabel(name)}"} ${b.errorRate.toFixed(4)}`);
    }
    lines.push("# HELP onetube_function_recycle_recommended 1 when the supervisor has flagged this function for recycle");
    lines.push("# TYPE onetube_function_recycle_recommended gauge");
    for (const [name, b] of Object.entries(extras.breakers)) {
      lines.push(`onetube_function_recycle_recommended{function="${quoteLabel(name)}"} ${b.recycleRecommended ? 1 : 0}`);
    }
  }

  if (extras?.workerd) {
    // Workerd-backend gauges. Wrapped in `extras.workerd` rather than
    // emitted from a per-call closure so the logging module stays
    // agnostic of which backend is active.
    const w = extras.workerd;
    lines.push("# HELP onetube_workerd_up 1 when a workerd subprocess is currently running, 0 otherwise");
    lines.push("# TYPE onetube_workerd_up gauge");
    lines.push(`onetube_workerd_up ${w.pid !== null ? 1 : 0}`);

    lines.push("# HELP onetube_workerd_pid Current workerd subprocess PID (0 when not running)");
    lines.push("# TYPE onetube_workerd_pid gauge");
    lines.push(`onetube_workerd_pid ${w.pid ?? 0}`);

    lines.push("# HELP onetube_workerd_generation Generation counter — increments on every reload (HMR / watchdog / crash recovery)");
    lines.push("# TYPE onetube_workerd_generation counter");
    lines.push(`onetube_workerd_generation ${w.generation}`);

    lines.push("# HELP onetube_workerd_recycles_total Workerd processes recycled by the memory watchdog");
    lines.push("# TYPE onetube_workerd_recycles_total counter");
    lines.push(`onetube_workerd_recycles_total ${w.recycles}`);

    if (w.rss_bytes !== null) {
      lines.push("# HELP onetube_workerd_rss_bytes Last sampled resident set size of the workerd process");
      lines.push("# TYPE onetube_workerd_rss_bytes gauge");
      lines.push(`onetube_workerd_rss_bytes ${w.rss_bytes}`);
    }
    if (w.budget_bytes !== null) {
      lines.push("# HELP onetube_workerd_budget_bytes RSS budget enforced by the watchdog");
      lines.push("# TYPE onetube_workerd_budget_bytes gauge");
      lines.push(`onetube_workerd_budget_bytes ${w.budget_bytes}`);
    }
    if (w.last_reload_duration_ms !== null) {
      lines.push("# HELP onetube_workerd_last_reload_duration_ms Wall-clock duration of the most recent successful reload");
      lines.push("# TYPE onetube_workerd_last_reload_duration_ms gauge");
      lines.push(`onetube_workerd_last_reload_duration_ms ${w.last_reload_duration_ms.toFixed(1)}`);
    }
    if (Object.keys(w.bundle_bytes).length > 0) {
      lines.push("# HELP onetube_workerd_bundle_bytes esbuild output size per function bundle");
      lines.push("# TYPE onetube_workerd_bundle_bytes gauge");
      for (const [name, bytes] of Object.entries(w.bundle_bytes)) {
        lines.push(`onetube_workerd_bundle_bytes{function="${quoteLabel(name)}"} ${bytes}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}
