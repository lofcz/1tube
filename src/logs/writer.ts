/**
 * Batched, non-blocking writer for the invocation log store.
 *
 * Mirrors the design of `src/log-buffer.ts`: events are queued in
 * memory and flushed inside a single transaction either every
 * `flushIntervalMs` or when `flushThreshold` rows have accumulated.
 * The request hot path only ever pays for an array push.
 *
 * Backpressure: the queue is bounded. When full, the OLDEST entries
 * are dropped (newest data is the most valuable while debugging an
 * incident) and a drop counter is kept for observability. Logging can
 * never block a request or grow memory without bound.
 *
 * Retention: `prune()` enforces a max age and max row count, and runs
 * automatically on an interval (plus once at startup). Deletes are
 * chunked — each FTS-trigger-heavy DELETE transaction is bounded, and
 * the interval job yields to the event loop between chunks so a big
 * retention pass can never stall in-flight requests.
 */

import type { LogDb } from "./db.ts";

export type LogLevel = "debug" | "log" | "info" | "warn" | "error";
export type LogSource = "function" | "boot" | "gateway";
export type InvocationErrorKind =
  | "timeout"
  | "body_timeout"
  | "breaker"
  | "unhandled"
  | "boot";

export interface InvocationRow {
  id: string;
  tsMs: number;
  functionName: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string | null;
  backend: "deno" | "workerd";
  errorKind?: InvocationErrorKind | null;
  errorMessage?: string | null;
  errorStack?: string | null;
}

export interface LogRow {
  invocationId?: string | null;
  tsMs: number;
  level: LogLevel;
  functionName?: string | null;
  source: LogSource;
  message: string;
}

export interface LogWriterOptions {
  db: LogDb;
  /** Flush latency budget. 0 = flush synchronously on every record (tests/dev). */
  flushIntervalMs?: number;
  /** Rows queued before an early flush. */
  flushThreshold?: number;
  /** Max queued rows before oldest entries are dropped. */
  maxQueue?: number;
  /** Delete rows older than this many days. 0 disables age-based pruning. */
  retentionDays?: number;
  /** Hard cap on `logs` rows. 0 disables. */
  maxLogRows?: number;
  /** Hard cap on `invocations` rows. 0 disables. */
  maxInvocationRows?: number;
  /** Interval between automatic prune passes. */
  pruneIntervalMs?: number;
  /** Cap on a single stored message, in UTF-16 code units. */
  maxMessageLength?: number;
}

export interface LogWriterStats {
  queued: number;
  written: number;
  dropped: number;
  writeErrors: number;
  lastPruneMs: number | null;
}

export interface LogWriter {
  recordInvocation(row: InvocationRow): void;
  recordLog(row: LogRow): void;
  /** Synchronously flush everything queued. Safe to call anytime. */
  flushNow(): void;
  /** Run retention enforcement immediately. */
  prune(): void;
  /** Flush, stop timers. The writer must not be used afterwards. */
  stop(): void;
  readonly stats: LogWriterStats;
}

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_LOG_ROWS = 1_000_000;
const DEFAULT_MAX_INVOCATION_ROWS = 500_000;
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_MESSAGE_LENGTH = 8 * 1024;

type Queued =
  | { kind: "invocation"; row: InvocationRow }
  | { kind: "log"; row: LogRow };

export function createLogWriter(opts: LogWriterOptions): LogWriter {
  const db = opts.db.raw;
  const flushIntervalMs = opts.flushIntervalMs ?? 100;
  const flushThreshold = opts.flushThreshold ?? 500;
  const maxQueue = opts.maxQueue ?? 10_000;
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const maxLogRows = opts.maxLogRows ?? DEFAULT_MAX_LOG_ROWS;
  const maxInvocationRows = opts.maxInvocationRows ??
    DEFAULT_MAX_INVOCATION_ROWS;
  const pruneIntervalMs = opts.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const maxMessageLength = opts.maxMessageLength ?? DEFAULT_MAX_MESSAGE_LENGTH;

  const insertInvocation = db.prepare(
    `INSERT OR REPLACE INTO invocations
       (id, ts_ms, function_name, method, path, status, duration_ms,
        user_id, backend, error_kind, error_message, error_stack)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertLog = db.prepare(
    `INSERT INTO logs
       (invocation_id, ts_ms, level, function_name, source, message)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let queue: Queued[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let pruneTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stats: LogWriterStats = {
    queued: 0,
    written: 0,
    dropped: 0,
    writeErrors: 0,
    lastPruneMs: null,
  };

  const clamp = (msg: string): string =>
    msg.length > maxMessageLength ? msg.slice(0, maxMessageLength) + "…" : msg;

  function writeOne(item: Queued): void {
    if (item.kind === "invocation") {
      const r = item.row;
      insertInvocation.run(
        r.id,
        Math.floor(r.tsMs),
        r.functionName,
        r.method,
        r.path,
        r.status,
        Math.max(0, Math.floor(r.durationMs)),
        r.userId ?? null,
        r.backend,
        r.errorKind ?? null,
        r.errorMessage != null ? clamp(r.errorMessage) : null,
        r.errorStack != null ? clamp(r.errorStack) : null,
      );
    } else {
      const r = item.row;
      insertLog.run(
        r.invocationId ?? null,
        Math.floor(r.tsMs),
        r.level,
        r.functionName ?? null,
        r.source,
        clamp(r.message),
      );
    }
  }

  function flushNow(): void {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    stats.queued = 0;
    try {
      db.exec("BEGIN");
      let committed = false;
      try {
        for (const item of batch) writeOne(item);
        db.exec("COMMIT");
        committed = true;
        stats.written += batch.length;
      } finally {
        if (!committed) {
          try {
            db.exec("ROLLBACK");
          } catch { /* connection gone — nothing to roll back */ }
        }
      }
    } catch (err) {
      stats.writeErrors += batch.length;
      // Per-batch (not per-row) warning so a wedged disk can't flood
      // the gateway's own log stream.
      console.warn(
        `[1tube] invocation-log flush failed (${batch.length} row(s) lost): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  function enqueue(item: Queued): void {
    if (stopped) return;
    if (flushIntervalMs <= 0) {
      // Synchronous mode: write straight through. Used by tests and
      // available for dev when immediate visibility matters more than
      // throughput.
      try {
        writeOne(item);
        stats.written++;
      } catch (err) {
        stats.writeErrors++;
        console.warn(
          `[1tube] invocation-log write failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      return;
    }
    queue.push(item);
    stats.queued = queue.length;
    if (queue.length > maxQueue) {
      const overflow = queue.length - maxQueue;
      queue.splice(0, overflow);
      stats.dropped += overflow;
      stats.queued = queue.length;
    }
    if (queue.length >= flushThreshold) {
      flushNow();
      return;
    }
    if (flushTimer === undefined) {
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flushNow();
      }, flushIntervalMs);
      // Never keep the event loop alive just for a pending log flush.
      const t = flushTimer as unknown as { unref?: () => void };
      if (typeof t?.unref === "function") t.unref();
    }
  }

  // Rows deleted per transaction. Each deleted log row also pays the
  // logs_fts delete trigger, so this bounds both the transaction size
  // and the worst-case synchronous chunk on the gateway event loop
  // (a few ms each rather than seconds for a full retention sweep).
  const PRUNE_CHUNK = 4_000;

  /**
   * Delete up to PRUNE_CHUNK rows for every retention rule.
   * Returns true when any rule still has rows left to delete.
   */
  function pruneStep(): boolean {
    let deleted = 0;
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      deleted += Number(
        db.prepare(
          `DELETE FROM logs WHERE id IN (
             SELECT id FROM logs WHERE ts_ms < ? LIMIT ?
           )`,
        ).run(cutoff, PRUNE_CHUNK).changes,
      );
      deleted += Number(
        db.prepare(
          `DELETE FROM invocations WHERE rowid IN (
             SELECT rowid FROM invocations WHERE ts_ms < ? LIMIT ?
           )`,
        ).run(cutoff, PRUNE_CHUNK).changes,
      );
    }
    if (maxLogRows > 0) {
      // Cutoff id = oldest row inside the newest `maxLogRows` window.
      const cut = db.prepare(
        `SELECT COALESCE(MIN(id), 0) AS cut FROM (
           SELECT id FROM logs ORDER BY id DESC LIMIT ?
         )`,
      ).get(maxLogRows) as { cut: number | bigint };
      deleted += Number(
        db.prepare(
          `DELETE FROM logs WHERE id IN (
             SELECT id FROM logs WHERE id < ? LIMIT ?
           )`,
        ).run(Number(cut.cut), PRUNE_CHUNK).changes,
      );
    }
    if (maxInvocationRows > 0) {
      const cut = db.prepare(
        `SELECT COALESCE(MIN(ts_ms), 0) AS cut FROM (
           SELECT ts_ms FROM invocations ORDER BY ts_ms DESC LIMIT ?
         )`,
      ).get(maxInvocationRows) as { cut: number | bigint };
      deleted += Number(
        db.prepare(
          `DELETE FROM invocations WHERE rowid IN (
             SELECT rowid FROM invocations WHERE ts_ms < ? LIMIT ?
           )`,
        ).run(Number(cut.cut), PRUNE_CHUNK).changes,
      );
    }
    return deleted > 0;
  }

  function checkpoint(): void {
    // Fold the WAL back into the main file so the on-disk footprint
    // actually shrinks after a prune (and stays small for readers).
    // TRUNCATE waits on concurrent readers — drop the busy timeout for
    // the attempt so a long-running reader costs us 250 ms, not the
    // writer's full 5 s budget; the next prune (or close()) retries.
    db.exec("PRAGMA busy_timeout = 250");
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch { /* reader held the lock; WAL is folded on a later pass */ } finally {
      db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  function prune(): void {
    const start = performance.now();
    try {
      while (pruneStep()) { /* run to completion, chunked transactions */ }
      checkpoint();
      stats.lastPruneMs = performance.now() - start;
    } catch (err) {
      console.warn(
        `[1tube] invocation-log prune failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  let pruning = false;

  /** Interval variant: yields to the event loop between chunks. */
  async function pruneIncremental(): Promise<void> {
    if (pruning) return;
    pruning = true;
    const start = performance.now();
    try {
      while (pruneStep()) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (stopped) return;
      }
      checkpoint();
      stats.lastPruneMs = performance.now() - start;
    } catch (err) {
      console.warn(
        `[1tube] invocation-log prune failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      pruning = false;
    }
  }

  if (pruneIntervalMs > 0) {
    pruneTimer = setInterval(() => void pruneIncremental(), pruneIntervalMs);
    const t = pruneTimer as unknown as { unref?: () => void };
    if (typeof t?.unref === "function") t.unref();
  }

  return {
    recordInvocation: (row) => enqueue({ kind: "invocation", row }),
    recordLog: (row) => enqueue({ kind: "log", row }),
    flushNow,
    prune,
    stop() {
      if (stopped) return;
      stopped = true;
      if (pruneTimer !== undefined) clearInterval(pruneTimer);
      flushNow();
    },
    stats,
  };
}
