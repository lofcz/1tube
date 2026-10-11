/**
 * Hot reloader for the Bun backend.
 *
 *     fs.watch ─▶ pending path set ─▶ debounce (40ms leading / 200ms trailing)
 *                                              │
 *                                              ▼
 *                    drop byte-identical rewrites (content digests)
 *                    shared module touched?  → re-evaluate shared graph
 *                    affected = depGraph.affected(paths)
 *                             ∪ <fn>/index.ts | <fn>/1tube.json edits
 *                             ∪ function dirs created / deleted
 *                                              │
 *                                              ▼
 *                                   host.reload(affected)
 *
 * The dep-graph is the source of truth for "which functions import this
 * file", so an edit to `_shared/x.ts` reloads exactly its importers.
 *
 * Two seams keep it testable without real graphs or a real watcher:
 * {@link createReloadDebouncer} (pure debounce buffer, fake-clock friendly)
 * and the `watch` option (inject a fake event stream).
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type FsEventStream, watchFs } from "../../fs-watch.ts";
import { compatState, isFunctionOwnFile } from "../../compat/plugin.ts";
import type { DepGraph } from "./dep-graph.ts";
import type { FunctionHost, ReloadSummary } from "./function-host.ts";
import type { SharedRuntime } from "./shared-runtime.ts";

export type { FsEventStream };

export interface HotReloaderOptions {
  host: FunctionHost;
  functionsDir: string;
  /** Trailing debounce window. Defaults to 200ms. */
  debounceMs?: number;
  /**
   * Leading-edge flush delay for the first event of a quiet period.
   * Defaults to 40ms so a single save reloads ~160ms sooner than the
   * trailing debounce alone. ≤0 disables (trailing-only).
   */
  leadingMs?: number;
  /** Test seam: factory for the watcher iterable. */
  watch?: (dir: string) => FsEventStream;
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  log?: (line: string) => void;
  onReloaded?: (summary: ReloadSummary) => void;
  /** Re-evaluated when one of its source files changes. */
  sharedRuntime?: SharedRuntime;
}

export interface HotReloader {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ReloadDebouncer {
  push(paths: readonly string[]): void;
  cancel(): void;
  /** Drain the pending-path set without flushing. Test seam. */
  drain(): string[];
  readonly isFlushing: boolean;
}

export interface ReloadDebouncerOptions {
  debounceMs: number;
  /**
   * Leading-edge flush: when set, the FIRST event of a quiet period
   * schedules a flush after `leadingMs` instead of `debounceMs`, and
   * later events in the same burst do NOT push the timer out. A single
   * editor save reloads after ~leadingMs instead of always paying the
   * full trailing debounce; stragglers (multi-file saves, slow fs
   * event delivery) coalesce into a follow-up flush armed with
   * `debounceMs`. Unset = classic trailing-only behavior.
   */
  leadingMs?: number;
  // Awaited at the call site, so a synchronous callback is fine too (a test
  // that just records the paths needn't be `async`, which would trip
  // require-await). The real reloader flush is async.
  flushFn: (paths: readonly string[]) => void | Promise<void>;
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

/**
 * Path-set debouncer. Coalesces fs events arriving inside a single
 * `debounceMs` window into one `flushFn` call carrying the union.
 *
 * If a flush is already in progress when the timer fires, it re-arms
 * itself so changes saved during the in-flight reload aren't lost.
 */
export function createReloadDebouncer(
  opts: ReloadDebouncerOptions,
): ReloadDebouncer {
  const setTimer = opts.setTimer ??
    ((cb, ms) => setTimeout(cb, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
  const leadingMs = opts.leadingMs !== undefined && opts.leadingMs > 0
    ? opts.leadingMs
    : undefined;

  const pending = new Set<string>();
  let timerId: number | null = null;
  let flushing = false;

  const flush = async () => {
    timerId = null;
    if (flushing) return;
    if (pending.size === 0) return;
    const paths = [...pending];
    pending.clear();
    flushing = true;
    try {
      await opts.flushFn(paths);
    } finally {
      flushing = false;
      if (pending.size > 0) {
        if (timerId !== null) clearTimer(timerId);
        // Stragglers always get the calmer trailing window — the
        // leading edge only applies to the first burst of a quiet
        // period.
        timerId = setTimer(flush, opts.debounceMs);
      }
    }
  };

  return {
    push(paths) {
      let added = false;
      for (const p of paths) {
        if (!pending.has(p)) {
          pending.add(p);
          added = true;
        }
      }
      if (!added) return;
      if (leadingMs !== undefined) {
        // Leading mode: arm once per burst and let it fire — don't keep
        // pushing the flush out while events stream in. Anything that
        // lands during/after the flush re-arms via the finally above.
        if (timerId === null && !flushing) {
          timerId = setTimer(flush, leadingMs);
        }
        return;
      }
      if (timerId !== null) clearTimer(timerId);
      timerId = setTimer(flush, opts.debounceMs);
    },
    cancel() {
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
      }
    },
    drain() {
      const out = [...pending];
      pending.clear();
      return out;
    },
    get isFlushing() {
      return flushing;
    },
  };
}

/**
 * Function names affected by a batch of changed paths. Exposed for tests.
 *
 *   1. Files in the dep-graph → their owners (exact transitive importers).
 *   2. `<functionsDir>/<name>/index.ts` or `/1tube.json` → `<name>`.
 *   3. Optionally a bare `<functionsDir>/<name>` directory event — a new
 *      function dir may report only the directory itself, and deleting a
 *      tree can report only directory paths. Callers that can stat the
 *      directory should disable this and decide precisely.
 */
export function computeAffected(
  paths: readonly string[],
  depGraph: DepGraph,
  options: { functionsDir?: string; includeDirectoryEvents?: boolean } = {},
): Set<string> {
  const out = depGraph.affected(paths);
  for (const p of paths) {
    const m = /[\\/]([^\\/]+)[\\/](?:index\.ts|1tube\.json)$/.exec(p);
    if (m && m[1] && !m[1].startsWith("_") && !m[1].endsWith("_shared")) {
      out.add(m[1]);
    }
  }
  if (options.functionsDir && options.includeDirectoryEvents !== false) {
    for (const name of directoryEventFunctionNames(paths, options.functionsDir)) {
      out.add(name);
    }
  }
  return out;
}

function directoryEventFunctionNames(
  paths: readonly string[],
  functionsDir: string,
): Set<string> {
  const out = new Set<string>();
  const fnDir = functionsDir.replace(/[\\/]$/, "");
  for (const p of paths) {
    let rest: string | null = null;
    if (p.startsWith(fnDir + "/") || p.startsWith(fnDir + "\\")) {
      rest = p.slice(fnDir.length + 1);
    }
    if (!rest || /[\\/]/.test(rest)) continue;
    if (rest.startsWith("_") || rest.endsWith("_shared")) continue;
    out.add(rest);
  }
  return out;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export function createHotReloader(opts: HotReloaderOptions): HotReloader {
  const log = opts.log ?? ((line) => console.log(line));
  const functionsDir = resolve(opts.functionsDir);
  const watcherFactory = opts.watch ?? ((dir: string) => watchFs(dir, { recursive: true }));

  let stream: FsEventStream | null = null;
  let stopped = false;
  let consumeLoop: Promise<void> | null = null;

  // Editors, formatters and agents routinely rewrite files with identical
  // bytes (format-on-save no-ops, touch, atomic-save double events). Each
  // would otherwise cost a reload.
  const contentDigests = new Map<string, string>();

  async function fileDigest(path: string): Promise<string | null> {
    try {
      if (!(await stat(path)).isFile()) return null;
      return createHash("sha1").update(await readFile(path)).digest("hex");
    } catch {
      return null;
    }
  }

  async function filterNoopPaths(paths: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    await Promise.all([...new Set(paths)].map(async (p) => {
      const digest = await fileDigest(p);
      if (digest === null) {
        contentDigests.delete(p);
        out.push(p);
        return;
      }
      if (contentDigests.get(p) === digest) return;
      contentDigests.set(p, digest);
      out.push(p);
    }));
    return out;
  }

  const debouncer = createReloadDebouncer({
    debounceMs: opts.debounceMs ?? 200,
    leadingMs: opts.leadingMs ?? 40,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    flushFn: async (rawPaths) => {
      const paths = await filterNoopPaths(rawPaths);
      if (paths.length === 0) return;

      // A shared module must be re-evaluated BEFORE dependents reload, so
      // their stubs bind to the fresh exports. The dep-graph lists the
      // shared source as a dependency of each importer, so the affected
      // pass below picks them all up.
      const shared = opts.sharedRuntime;
      if (shared) {
        const sharedPaths = new Set(shared.sourcePaths);
        if (paths.some((p) => sharedPaths.has(resolve(p)))) {
          try {
            const records = await shared.reload();
            log(`[1tube] HMR shared module(s) reloaded: ${records.map((r) => r.id).join(", ")}`);
          } catch (err) {
            log(`[1tube] HMR shared module reload FAILED: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Shared code is evaluated once in the shared-dependency graph; a
      // fresh generation makes the functions reloaded below re-evaluate
      // it, while untouched functions keep the previous one.
      const sharedDeps = compatState().sharedDeps;
      if (
        sharedDeps &&
        paths.some((p) =>
          /\.[cm]?[jt]sx?$/.test(p) && !/[\\/]node_modules[\\/]/.test(p) &&
          !isFunctionOwnFile(p)
        )
      ) {
        sharedDeps.bump();
      }

      const raw = computeAffected(paths, opts.host.depGraph, {
        functionsDir,
        includeDirectoryEvents: false,
      });
      // Directory events: a created function dir counts if its entry now
      // exists; a deleted one if it was loaded.
      const known = new Set(opts.host.list());
      for (const name of directoryEventFunctionNames(paths, functionsDir)) {
        const exists = await isFile(join(functionsDir, name, "index.ts"));
        if (exists ? !known.has(name) : known.has(name)) raw.add(name);
      }
      // Keep loaded names and names with an entry on disk; drops noise from
      // non-function files at the functions root (README.md, .gitignore…).
      const affected = new Set<string>();
      for (const name of raw) {
        if (known.has(name) || await isFile(join(functionsDir, name, "index.ts"))) {
          affected.add(name);
        }
      }
      if (affected.size === 0) return;
      const reason = `${affected.size} function(s) changed: ${[...affected].sort().join(", ")}`;
      log(`[1tube] HMR ${reason}`);
      try {
        const summary = await opts.host.reload(affected, reason);
        const parts: string[] = [];
        if (summary.reloaded.length > 0) parts.push(`reloaded=${summary.reloaded.join(",")}`);
        if (summary.added.length > 0) parts.push(`added=${summary.added.join(",")}`);
        if (summary.removed.length > 0) parts.push(`removed=${summary.removed.join(",")}`);
        log(
          `[1tube] HMR reload ok in ${summary.durationMs.toFixed(0)}ms${
            parts.length > 0 ? ` (${parts.join("; ")})` : ""
          }`,
        );
        for (const e of summary.errors) log(`[1tube] HMR ${e.name}: ${e.error}`);
        opts.onReloaded?.(summary);
      } catch (err) {
        log(
          `[1tube] HMR reload FAILED — keeping previous graphs alive. Error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  });

  return {
    start() {
      if (stream) return Promise.resolve();
      stream = watcherFactory(functionsDir);
      log(`[1tube] HMR watching: ${functionsDir}`);
      consumeLoop = (async () => {
        try {
          for await (const event of stream!) {
            if (stopped) break;
            if (event.paths.length > 0) debouncer.push(event.paths);
          }
        } catch (err) {
          if (!stopped) log(`[1tube] HMR watcher disabled: ${err}`);
        }
      })();
      return Promise.resolve();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      debouncer.cancel();
      try {
        stream?.close();
      } catch { /* */ }
      stream = null;
      if (consumeLoop) {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          consumeLoop,
          new Promise<void>((r) => (timeoutId = setTimeout(r, 250))),
        ]);
        clearTimeout(timeoutId);
      }
    },
  };
}
