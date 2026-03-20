/**
 * Structured request logging and metrics collection.
 *
 * Logs every request as a JSON line to stdout.
 * Tracks per-function metrics (count, latency, errors) for the /metrics endpoint.
 */

import type { Context, Next } from "npm:hono@4";

export interface FunctionMetrics {
  invocations: number;
  errors: number;
  totalDurationMs: number;
  lastInvocation: number;
}

const metricsMap = new Map<string, FunctionMetrics>();
let globalRequests = 0;
let globalErrors = 0;
const startedAt = Date.now();

function getMetrics(name: string): FunctionMetrics {
  let m = metricsMap.get(name);
  if (!m) {
    m = { invocations: 0, errors: 0, totalDurationMs: 0, lastInvocation: 0 };
    metricsMap.set(name, m);
  }
  return m;
}

export async function loggingMiddleware(c: Context, next: Next) {
  const start = performance.now();
  const fnName = c.req.path.replace("/functions/v1/", "") || "unknown";

  await next();

  const durationMs = Math.round(performance.now() - start);
  const status = c.res.status;
  const isError = status >= 400;

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
  const userTag = userId ? ` [user:${userId.slice(0, 8)}]` : "";
  const statusColor = isError ? "\x1b[31m" : "\x1b[32m";
  const reset = "\x1b[0m";
  const dim = "\x1b[2m";

  const line = `\x1b[36m[1tube]${reset} ${c.req.method} /functions/v1/${fnName} → ${statusColor}${status}${reset} ${dim}(${durationMs}ms)${reset}${userTag}`;

  if (isError) {
    console.error(line);
  } else {
    console.log(line);
  }
}

/**
 * Returns collected metrics for the /metrics endpoint.
 */
export function getCollectedMetrics(): {
  uptime_ms: number;
  total_requests: number;
  total_errors: number;
  functions: Record<string, FunctionMetrics>;
} {
  return {
    uptime_ms: Date.now() - startedAt,
    total_requests: globalRequests,
    total_errors: globalErrors,
    functions: Object.fromEntries(metricsMap),
  };
}

/**
 * Prometheus-compatible text format for /metrics.
 */
export function getPrometheusMetrics(): string {
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

  return lines.join("\n") + "\n";
}
