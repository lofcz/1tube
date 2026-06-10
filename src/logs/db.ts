/**
 * Invocation log database bootstrap.
 *
 * Opens (or creates) the SQLite log store and migrates it forward by
 * applying the generated SQL migrations from the package's `drizzle/`
 * folder via drizzle's migrator. The schema itself is code-first in
 * `schema.ts`; this module only owns the connection + pragmas.
 *
 * Concurrency contract: the gateway is the ONLY writer. External
 * consumers (the OneTube .NET package, sqlite3 CLI, …) open the same
 * file read-only; WAL mode makes that safe without writer stalls.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "npm:drizzle-orm@1.0.0-rc.3/node-sqlite";
import { migrate } from "npm:drizzle-orm@1.0.0-rc.3/node-sqlite/migrator";

/**
 * Shipped at the package root, two levels up from `src/logs/`. Works for
 * every supported launch mode (repo checkout, npm package, OneTube
 * gateway assets) because the `drizzle/` folder always travels next to
 * `src/`.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export interface LogDb {
  /** Synchronous low-level handle used by the hot write path. */
  readonly raw: DatabaseSync;
  /** Absolute-ish path the database was opened with. */
  readonly path: string;
  close(): void;
}

/**
 * Open the log database at `path`, creating parent directories and the
 * file as needed, and bring the schema up to date.
 */
export async function openLogDb(path: string): Promise<LogDb> {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // Either the directory exists or the open below will surface a
    // far more actionable error than mkdir's.
  }

  const raw = new DatabaseSync(path);
  // WAL lets the .NET reader query concurrently with the gateway's
  // batched writes. NORMAL sync is the standard WAL pairing — a power
  // loss can drop the last batch but never corrupts the file. The busy
  // timeout covers the rare checkpoint/reader collision instead of
  // surfacing SQLITE_BUSY to the writer.
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA foreign_keys = ON");
  // Read performance on a store that can hold millions of rows:
  // mmap serves index pages straight from the page cache (no read()
  // syscalls), a 16 MiB page cache keeps the hot FTS b-tree resident,
  // and ephemeral sort/IN structures stay off disk. All three are
  // no-ops semantically; mmap_size is silently capped by the OS.
  raw.exec("PRAGMA mmap_size = 268435456");
  raw.exec("PRAGMA cache_size = -16384");
  raw.exec("PRAGMA temp_store = MEMORY");

  const db = drizzle({ client: raw });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  return {
    raw,
    path,
    close() {
      try {
        raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } catch { /* readers may hold the lock; the next open checkpoints */ }
      try {
        raw.close();
      } catch { /* already closed */ }
    },
  };
}
