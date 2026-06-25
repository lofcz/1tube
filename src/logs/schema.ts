/**
 * Code-first schema for the invocation log database (SQLite).
 *
 * This file is the single source of truth for the log store's shape:
 *
 *   - The gateway (writer) applies generated SQL migrations from the
 *     `drizzle/` folder at boot (see `db.ts`), so the database file is
 *     always migrated forward before the first row is written.
 *   - The OneTube .NET package reads the same file read-only; it never
 *     migrates. Column names below are snake_case on disk so the C#
 *     reader can use them verbatim.
 *
 * Changing the schema:
 *
 *   1. Edit the tables below.
 *   2. Run `npx drizzle-kit generate` (config: `drizzle.config.ts`) to
 *      emit a new SQL migration into `drizzle/`.
 *   3. Ship — the gateway migrates on next boot.
 *
 * The FTS5 index over `logs.message` lives in a hand-written custom
 * migration (`drizzle-kit generate --custom`) because virtual tables
 * aren't expressible in drizzle's TS schema. See `drizzle/0001_logs_fts.sql`.
 *
 * NOTE: unlike most of `src/`, this module imports `drizzle-orm` via the
 * bare specifier (mapped in `deno.json`) instead of an `npm:` prefix —
 * `drizzle-kit generate` bundles this file under Node and cannot resolve
 * `npm:` specifiers. Every supported launch path (repo tasks, the npm
 * CLI shim's `--config`, the OneTube host's cwd) provides our `deno.json`,
 * so the alias always resolves at runtime.
 */

import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per function invocation that reached the dispatcher (i.e.
 * passed the fast-fail 404 probe). Mirrors what Supabase surfaces in
 * its edge-function invocation logs: request shape, response status,
 * timing, and error metadata when the gateway produced the failure.
 */
export const invocations = sqliteTable("invocations", {
  /** UUIDv7 — time-ordered, also echoed as `x-1tube-invocation-id`. */
  id: text("id").primaryKey(),
  /** Wall-clock start of the request, Unix ms. */
  tsMs: integer("ts_ms").notNull(),
  functionName: text("function_name").notNull(),
  method: text("method").notNull(),
  /** Path + query string as received (already past the 404 probe). */
  path: text("path").notNull(),
  status: integer("status").notNull(),
  durationMs: integer("duration_ms").notNull(),
  /** Authenticated user id when the JWT probe succeeded. */
  userId: text("user_id"),
  /** Execution backend: "deno" | "workerd". */
  backend: text("backend").notNull(),
  /**
   * Failure classification when the GATEWAY produced the error response:
   * "timeout" (504), "body_timeout" (408), "breaker" (503),
   * "unhandled" (500), "boot" (function failed to load). Null for
   * responses produced by the function itself (including its own 4xx/5xx).
   */
  errorKind: text("error_kind"),
  errorMessage: text("error_message"),
  errorStack: text("error_stack"),
}, (t) => [
  index("idx_invocations_ts").on(t.tsMs),
  index("idx_invocations_fn_ts").on(t.functionName, t.tsMs),
  index("idx_invocations_status_ts").on(t.status, t.tsMs),
]);

/**
 * Console output and runtime events. Lines emitted inside a dispatched
 * request carry the owning `invocation_id`; boot-time/import-time and
 * process-level lines have a null invocation id.
 */
export const logs = sqliteTable("logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invocationId: text("invocation_id"),
  /** Unix ms when the line was emitted. */
  tsMs: integer("ts_ms").notNull(),
  /** "debug" | "log" | "info" | "warn" | "error". */
  level: text("level").notNull(),
  /** Owning function, when attributable. */
  functionName: text("function_name"),
  /** "function" (request console), "boot" (import-time), "gateway" (process lines). */
  source: text("source").notNull().default("function"),
  message: text("message").notNull(),
}, (t) => [
  index("idx_logs_invocation").on(t.invocationId),
  index("idx_logs_ts").on(t.tsMs),
]);
