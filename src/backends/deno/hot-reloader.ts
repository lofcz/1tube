/**
 * Hot reloader for the Deno backend (Worker-per-function model).
 *
 * The flow:
 *
 *     Deno.watchFs ─▶ pendingPaths set ─▶ debounce(200ms)
 *                                              │
 *                                              ▼
 *                       affected = depGraph.affected(paths)
 *                       affected ∪= names with index.ts created/deleted
 *                                              │
 *                                              ▼
 *                                  host.reload(affected)
 *
 * The dep-graph (built and maintained by {@link DenoWorkerHost}) is the
 * source of truth for "which function does this file belong to" — much
 * more precise than the historical
 * "first directory of the relative path, with `_*` promoted to full
 * reload" heuristic used by the workerd backend.
 *
 * Two seams keep this testable without spinning up real Workers:
 *
 *   - {@link createDenoReloadDebouncer}: the pure debounce + flush
 *     buffer, exported on its own so unit tests can drive it with a
 *     fake clock and assert pending-set semantics.
 *   - {@link createDenoHotReloader}: the loop that consumes a watcher
 *     iterable. Tests pass an async iterator of fake events instead
 *     of the real `Deno.watchFs` to avoid filesystem flake.
 */

import type { DenoWorkerHost, ReloadSummary } from "./worker-host.ts";
import type { DepGraph } from "./dep-graph.ts";

export type FsEventStream = AsyncIterable<{ paths: readonly string[] }> & {
  close(): void;
};

export interface DenoHotReloaderOptions {
  host: DenoWorkerHost;
  functionsDir: string;
  /** Defaults to 200ms — same as the workerd path. */
  debounceMs?: number;
  /** Test seam: factory for the watcher iterable. */
  watch?: (dir: string) => FsEventStream;
  /** Test seams for the debouncer's clock. */
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /** Override the log function (defaults to console.log). */
  log?: (line: string) => void;
  /** Optional hook fired after each reload, with the summary. */
  onReloaded?: (summary: ReloadSummary) => void;
}

export interface DenoHotReloader {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DenoReloadDebouncer {
  push(paths: readonly string[]): void;
  cancel(): void;
  /** Drain the pending-path set without flushing. Test seam. */
  drain(): string[];
  readonly isFlushing: boolean;
}

export interface DenoReloadDebouncerOptions {
  debounceMs: number;
  flushFn: (paths: readonly string[]) => Promise<void>;
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
export function createDenoReloadDebouncer(
  opts: DenoReloadDebouncerOptions,
): DenoReloadDebouncer {
  const setTimer = opts.setTimer ??
    ((cb, ms) => setTimeout(cb, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));

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
 * Compute the set of function names that need reloading given a batch
 * of changed file paths and the current dep-graph. Exposed for tests.
 *
 * Three sources, in order of precision:
 *
 * 1. Files inside the dep-graph: their owners are affected. This is the
 *    precise case — exactly the functions that transitively import the
 *    changed file.
 * 2. Files matching `<functionsDir>/<name>/index.ts`: include `<name>`.
 *    Catches newly-added function dirs whose entry hasn't been graphed
 *    yet, plus the entry's own edits.
 * 3. Path is the directory `<functionsDir>/<name>` itself or anything
 *    under it (subtree change, including whole-dir removal). This is
 *    the case `Deno.watchFs` emits on Windows when a function dir is
 *    deleted — events come back as paths to the dir, not to the
 *    nonexistent files inside. Only matched against `knownNames` so
 *    random sibling-dir activity doesn't trigger spurious reloads.
 */
export function computeAffected(
  paths: readonly string[],
  depGraph: DepGraph,
  options: { functionsDir?: string; knownNames?: Iterable<string> } = {},
): Set<string> {
  const out = depGraph.affected(paths);
  for (const p of paths) {
    const m = /[\\/]([^\\/]+)[\\/]index\.ts$/.exec(p);
    if (m && m[1]) out.add(m[1]);
  }
  if (options.functionsDir && options.knownNames) {
    const fnDir = options.functionsDir.replace(/[\\/]$/, "");
    for (const name of options.knownNames) {
      // Cheap substring test — avoids escaping the name for a regex
      // and works for both forward- and back-slashed paths.
      const needleA = `${fnDir}\\${name}`;
      const needleB = `${fnDir}/${name}`;
      for (const p of paths) {
        if (p === needleA || p === needleB) {
          out.add(name);
          break;
        }
        if (p.startsWith(needleA + "\\") || p.startsWith(needleB + "/")) {
          out.add(name);
          break;
        }
      }
    }
  }
  return out;
}

export function createDenoHotReloader(
  opts: DenoHotReloaderOptions,
): DenoHotReloader {
  const log = opts.log ?? ((line) => console.log(line));
  const watcherFactory = opts.watch ?? ((dir: string) =>
    Deno.watchFs(dir, { recursive: true }) as unknown as FsEventStream
  );

  let stream: FsEventStream | null = null;
  let stopped = false;
  let consumeLoop: Promise<void> | null = null;

  const debouncer = createDenoReloadDebouncer({
    debounceMs: opts.debounceMs ?? 200,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    flushFn: async (paths) => {
      const affected = computeAffected(paths, opts.host.depGraph, {
        functionsDir: opts.functionsDir,
        knownNames: opts.host.list(),
      });
      if (affected.size === 0) return;
      const reason = `${affected.size} function(s) changed: ${
        [...affected].sort().join(", ")
      }`;
      log(`[1tube] HMR ${reason}`);
      try {
        const summary = await opts.host.reload(affected, reason);
        const parts: string[] = [];
        if (summary.reloaded.length > 0) {
          parts.push(`reloaded=${summary.reloaded.join(",")}`);
        }
        if (summary.added.length > 0) {
          parts.push(`added=${summary.added.join(",")}`);
        }
        if (summary.removed.length > 0) {
          parts.push(`removed=${summary.removed.join(",")}`);
        }
        log(
          `[1tube] HMR reload ok in ${summary.durationMs.toFixed(0)}ms${
            parts.length > 0 ? ` (${parts.join("; ")})` : ""
          }`,
        );
        for (const e of summary.errors) {
          log(`[1tube] HMR ${e.name}: ${e.error}`);
        }
        opts.onReloaded?.(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`[1tube] HMR reload FAILED — keeping previous workers alive. Error: ${msg}`);
      }
    },
  });

  return {
    async start() {
      if (stream) return;
      stream = watcherFactory(opts.functionsDir);
      log(`[1tube] HMR watching: ${opts.functionsDir}`);
      consumeLoop = (async () => {
        try {
          for await (const event of stream!) {
            if (stopped) break;
            if (event.paths.length === 0) continue;
            debouncer.push(event.paths);
          }
        } catch (err) {
          if (!stopped) log(`[1tube] HMR watcher disabled: ${err}`);
        }
      })();
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
        let timeoutId: number | undefined;
        const bound = new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, 250) as unknown as number;
        });
        await Promise.race([consumeLoop, bound]);
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    },
  };
}
