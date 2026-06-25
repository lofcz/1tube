/**
 * HTTP query surface for the invocation log store.
 *
 * Mounted under `/1tube/api/logs` and gated by INTERNAL_KEY (same
 * contract as `/metrics`): non-.NET integrators get the same data the
 * OneTube package reads straight from the SQLite file.
 */

import type { Context, Hono } from "npm:hono@4";
import type { InvocationErrorKind, LogLevel, LogSource } from "./writer.ts";
import type { InvocationFilter, LogQuery, LogSearchFilter } from "./query.ts";

const ERROR_KINDS: ReadonlySet<string> = new Set([
  "timeout",
  "body_timeout",
  "breaker",
  "unhandled",
  "boot",
]);
const LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "log",
  "info",
  "warn",
  "error",
]);
const SOURCES: ReadonlySet<string> = new Set(["function", "boot", "gateway"]);

function intParam(c: Context, name: string): number | undefined {
  const v = c.req.query(name);
  if (v === undefined || v === "") return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function strParam(c: Context, name: string): string | undefined {
  const v = c.req.query(name)?.trim();
  return v ? v : undefined;
}

export interface LogApiOptions {
  /** Returns a 403 response when the request lacks the internal key. */
  requireInternal: (c: Context) => Response | null;
  query: LogQuery;
}

export function registerLogRoutes(
  // deno-lint-ignore no-explicit-any
  app: Hono<any>,
  opts: LogApiOptions,
): void {
  const { requireInternal, query } = opts;

  app.get("/1tube/api/logs/invocations", (c) => {
    const forbidden = requireInternal(c);
    if (forbidden) return forbidden;

    const filter: InvocationFilter = {
      functionName: strParam(c, "fn"),
      method: strParam(c, "method"),
      status: intParam(c, "status"),
      statusClass: intParam(c, "statusClass"),
      errorsOnly: c.req.query("errorsOnly") === "1" ||
        c.req.query("errorsOnly") === "true",
      fromMs: intParam(c, "from"),
      toMs: intParam(c, "to"),
      q: strParam(c, "q"),
      limit: intParam(c, "limit"),
    };
    const errorKind = strParam(c, "errorKind");
    if (errorKind !== undefined) {
      if (!ERROR_KINDS.has(errorKind)) {
        return c.json({ error: `Unknown errorKind "${errorKind}"` }, 400);
      }
      filter.errorKind = errorKind as InvocationErrorKind;
    }
    const cursorTs = intParam(c, "cursorTs");
    const cursorId = strParam(c, "cursorId");
    if (cursorTs !== undefined && cursorId !== undefined) {
      filter.cursor = { tsMs: cursorTs, id: cursorId };
    }
    return c.json(query.queryInvocations(filter));
  });

  app.get("/1tube/api/logs/invocations/:id", (c) => {
    const forbidden = requireInternal(c);
    if (forbidden) return forbidden;
    const detail = query.getInvocation(c.req.param("id"));
    if (!detail) return c.json({ error: "Invocation not found" }, 404);
    return c.json(detail);
  });

  app.get("/1tube/api/logs/search", (c) => {
    const forbidden = requireInternal(c);
    if (forbidden) return forbidden;

    const filter: LogSearchFilter = {
      q: strParam(c, "q"),
      invocationId: strParam(c, "invocationId"),
      functionName: strParam(c, "fn"),
      fromMs: intParam(c, "from"),
      toMs: intParam(c, "to"),
      limit: intParam(c, "limit"),
      beforeId: intParam(c, "beforeId"),
    };
    const level = strParam(c, "level");
    if (level !== undefined) {
      if (!LEVELS.has(level)) {
        return c.json({ error: `Unknown level "${level}"` }, 400);
      }
      filter.level = level as LogLevel;
    }
    const source = strParam(c, "source");
    if (source !== undefined) {
      if (!SOURCES.has(source)) {
        return c.json({ error: `Unknown source "${source}"` }, 400);
      }
      filter.source = source as LogSource;
    }
    return c.json(query.searchLogs(filter));
  });

  app.get("/1tube/api/logs/tail", (c) => {
    const forbidden = requireInternal(c);
    if (forbidden) return forbidden;
    const afterId = intParam(c, "afterId") ?? 0;
    const items = query.logsSince(afterId, intParam(c, "limit"));
    const last = items[items.length - 1];
    return c.json({ items, lastId: last ? last.id : afterId });
  });

  app.get("/1tube/api/logs/functions", (c) => {
    const forbidden = requireInternal(c);
    if (forbidden) return forbidden;
    return c.json({ functions: query.functionNames() });
  });
}
