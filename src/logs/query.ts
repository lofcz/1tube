/**
 * Read-side query layer for the invocation log store.
 *
 * Used by the gateway's `/1tube/api/logs/*` endpoints and by tests.
 * All queries are keyset-paginated (never OFFSET) so deep pages stay
 * fast, and full-text search goes through the FTS5 index with a
 * sanitized MATCH expression — raw user input is never spliced into
 * the MATCH grammar.
 *
 * The OneTube .NET reader implements the same queries independently
 * against the same file; if you change SQL semantics here, mirror the
 * change in `dotnet/OneTube/Logs/SqliteOneTubeLogReader.cs`.
 */

import type { LogDb } from "./db.ts";
import type { InvocationErrorKind, LogLevel, LogSource } from "./writer.ts";

export interface InvocationRecord {
  id: string;
  tsMs: number;
  functionName: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId: string | null;
  backend: string;
  errorKind: InvocationErrorKind | null;
  errorMessage: string | null;
  errorStack: string | null;
  /** Captured console lines owned by this invocation. */
  logCount: number;
}

export interface LogRecord {
  id: number;
  invocationId: string | null;
  tsMs: number;
  level: LogLevel;
  functionName: string | null;
  source: LogSource;
  message: string;
}

export interface InvocationFilter {
  functionName?: string;
  method?: string;
  /** Exact status match. Takes precedence over statusClass. */
  status?: number;
  /** 2, 3, 4 or 5 — matches the whole status class. */
  statusClass?: number;
  errorKind?: InvocationErrorKind;
  /** Only invocations the gateway classified as errored (status >= 400). */
  errorsOnly?: boolean;
  fromMs?: number;
  toMs?: number;
  /** Full-text query matched against the invocation's captured log lines. */
  q?: string;
  limit?: number;
  /** Keyset cursor returned by a previous page. */
  cursor?: InvocationCursor;
}

export interface InvocationCursor {
  tsMs: number;
  id: string;
}

export interface InvocationPage {
  items: InvocationRecord[];
  /** Pass back as `filter.cursor` to fetch the next (older) page. */
  nextCursor: InvocationCursor | null;
}

export interface LogSearchFilter {
  /** Full-text query. When omitted, results are a plain filtered listing. */
  q?: string;
  invocationId?: string;
  functionName?: string;
  level?: LogLevel;
  source?: LogSource;
  fromMs?: number;
  toMs?: number;
  limit?: number;
  /** Keyset: only rows with id < beforeId (newest-first paging). */
  beforeId?: number;
}

export interface LogSearchPage {
  items: LogRecord[];
  nextBeforeId: number | null;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || (limit ?? 0) <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(limit!), MAX_LIMIT);
}

/**
 * Convert free-form user input into a safe FTS5 MATCH expression.
 * Every term is double-quoted (disabling the MATCH grammar's operators
 * inside it); a trailing `*` survives as a prefix query. Returns null
 * when no usable term remains.
 */
export function buildFtsMatch(input: string): string | null {
  const parts: string[] = [];
  for (let term of input.split(/\s+/)) {
    term = term.trim();
    if (!term) continue;
    let prefix = false;
    if (term.endsWith("*")) {
      prefix = true;
      term = term.slice(0, -1);
    }
    // The unicode61 tokenizer indexes only letters/digits; a term made
    // purely of punctuation can never match anything, so drop it rather
    // than emit a zero-token quoted string.
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    // Quotes are the only character that can escape a quoted FTS5
    // string — double them per the spec.
    term = term.replace(/"/g, '""');
    parts.push(`"${term}"${prefix ? "*" : ""}`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

type SqlValue = string | number;

interface InvocationDbRow {
  id: string;
  ts_ms: number;
  function_name: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  user_id: string | null;
  backend: string;
  error_kind: string | null;
  error_message: string | null;
  error_stack: string | null;
  log_count: number;
}

interface LogDbRow {
  id: number;
  invocation_id: string | null;
  ts_ms: number;
  level: string;
  function_name: string | null;
  source: string;
  message: string;
}

function mapInvocation(r: InvocationDbRow): InvocationRecord {
  return {
    id: r.id,
    tsMs: Number(r.ts_ms),
    functionName: r.function_name,
    method: r.method,
    path: r.path,
    status: Number(r.status),
    durationMs: Number(r.duration_ms),
    userId: r.user_id,
    backend: r.backend,
    errorKind: (r.error_kind ?? null) as InvocationErrorKind | null,
    errorMessage: r.error_message,
    errorStack: r.error_stack,
    logCount: Number(r.log_count),
  };
}

function mapLog(r: LogDbRow): LogRecord {
  return {
    id: Number(r.id),
    invocationId: r.invocation_id,
    tsMs: Number(r.ts_ms),
    level: r.level as LogLevel,
    functionName: r.function_name,
    source: r.source as LogSource,
    message: r.message,
  };
}

export interface LogQuery {
  queryInvocations(filter: InvocationFilter): InvocationPage;
  getInvocation(
    id: string,
  ): { invocation: InvocationRecord; logs: LogRecord[] } | null;
  searchLogs(filter: LogSearchFilter): LogSearchPage;
  /** Ascending tail: rows with id > afterId, oldest first. For live polling. */
  logsSince(afterId: number, limit?: number): LogRecord[];
  /** Distinct function names seen in the store (for filter dropdowns). */
  functionNames(): string[];
}

export function createLogQuery(db: LogDb): LogQuery {
  const raw = db.raw;

  function queryInvocations(filter: InvocationFilter): InvocationPage {
    const where: string[] = [];
    const params: SqlValue[] = [];

    if (filter.functionName) {
      where.push("i.function_name = ?");
      params.push(filter.functionName);
    }
    if (filter.method) {
      where.push("i.method = ?");
      params.push(filter.method.toUpperCase());
    }
    if (typeof filter.status === "number") {
      where.push("i.status = ?");
      params.push(filter.status);
    } else if (typeof filter.statusClass === "number") {
      where.push("i.status >= ? AND i.status < ?");
      params.push(filter.statusClass * 100, (filter.statusClass + 1) * 100);
    }
    if (filter.errorKind) {
      where.push("i.error_kind = ?");
      params.push(filter.errorKind);
    }
    if (filter.errorsOnly) {
      where.push("i.status >= 400");
    }
    if (typeof filter.fromMs === "number") {
      where.push("i.ts_ms >= ?");
      params.push(filter.fromMs);
    }
    if (typeof filter.toMs === "number") {
      where.push("i.ts_ms <= ?");
      params.push(filter.toMs);
    }
    if (filter.q) {
      const match = buildFtsMatch(filter.q);
      if (match) {
        // An invocation matches when any of its captured lines (or its
        // own gateway error message) matches the FTS query. No DISTINCT:
        // IN builds its own ephemeral dedup index, while DISTINCT would
        // force an extra sort over the full match set first.
        where.push(
          `(i.id IN (
             SELECT l.invocation_id
             FROM logs_fts f JOIN logs l ON l.id = f.rowid
             WHERE logs_fts MATCH ? AND l.invocation_id IS NOT NULL
           ) OR i.error_message LIKE '%' || ? || '%')`,
        );
        params.push(match, filter.q.trim());
      }
    }
    if (filter.cursor) {
      where.push("(i.ts_ms < ? OR (i.ts_ms = ? AND i.id < ?))");
      params.push(filter.cursor.tsMs, filter.cursor.tsMs, filter.cursor.id);
    }

    const limit = clampLimit(filter.limit);
    const sql = `
      SELECT i.*,
             (SELECT COUNT(*) FROM logs l WHERE l.invocation_id = i.id) AS log_count
      FROM invocations i
      ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY i.ts_ms DESC, i.id DESC
      LIMIT ?`;
    params.push(limit + 1);

    const rows = raw.prepare(sql).all(...params) as unknown as InvocationDbRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapInvocation);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: hasMore && last ? { tsMs: last.tsMs, id: last.id } : null,
    };
  }

  function getInvocation(id: string) {
    const row = raw.prepare(
      `SELECT i.*,
              (SELECT COUNT(*) FROM logs l WHERE l.invocation_id = i.id) AS log_count
       FROM invocations i WHERE i.id = ?`,
    ).get(id) as unknown as InvocationDbRow | undefined;
    if (!row) return null;
    const logRows = raw.prepare(
      `SELECT * FROM logs WHERE invocation_id = ? ORDER BY id ASC LIMIT 1000`,
    ).all(id) as unknown as LogDbRow[];
    return { invocation: mapInvocation(row), logs: logRows.map(mapLog) };
  }

  function searchLogs(filter: LogSearchFilter): LogSearchPage {
    const where: string[] = [];
    const params: SqlValue[] = [];
    const match = filter.q ? buildFtsMatch(filter.q) : null;

    if (filter.invocationId) {
      where.push("l.invocation_id = ?");
      params.push(filter.invocationId);
    }
    if (filter.functionName) {
      where.push("l.function_name = ?");
      params.push(filter.functionName);
    }
    if (filter.level) {
      where.push("l.level = ?");
      params.push(filter.level);
    }
    if (filter.source) {
      where.push("l.source = ?");
      params.push(filter.source);
    }
    if (typeof filter.fromMs === "number") {
      where.push("l.ts_ms >= ?");
      params.push(filter.fromMs);
    }
    if (typeof filter.toMs === "number") {
      where.push("l.ts_ms <= ?");
      params.push(filter.toMs);
    }
    if (typeof filter.beforeId === "number") {
      where.push("l.id < ?");
      params.push(filter.beforeId);
    }

    const limit = clampLimit(filter.limit);
    let sql: string;
    if (match) {
      where.unshift("logs_fts MATCH ?");
      params.unshift(match);
      sql = `
        SELECT l.*
        FROM logs_fts f JOIN logs l ON l.id = f.rowid
        WHERE ${where.join(" AND ")}
        ORDER BY l.id DESC
        LIMIT ?`;
    } else {
      sql = `
        SELECT l.*
        FROM logs l
        ${where.length > 0 ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY l.id DESC
        LIMIT ?`;
    }
    params.push(limit + 1);

    const rows = raw.prepare(sql).all(...params) as unknown as LogDbRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapLog);
    const last = items[items.length - 1];
    return {
      items,
      nextBeforeId: hasMore && last ? last.id : null,
    };
  }

  function logsSince(afterId: number, limit?: number): LogRecord[] {
    const rows = raw.prepare(
      `SELECT * FROM logs WHERE id > ? ORDER BY id ASC LIMIT ?`,
    ).all(afterId, clampLimit(limit)) as unknown as LogDbRow[];
    return rows.map(mapLog);
  }

  function functionNames(): string[] {
    const rows = raw.prepare(
      `SELECT DISTINCT function_name FROM invocations ORDER BY function_name`,
    ).all() as unknown as Array<{ function_name: string }>;
    return rows.map((r) => r.function_name);
  }

  return { queryInvocations, getInvocation, searchLogs, logsSince, functionNames };
}
