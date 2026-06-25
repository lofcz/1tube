/**
 * Hot reloader for the workerd backend.
 *
 * Owns a `Deno.watchFs` loop over the functions directory and a tiny
 * debounce + classify pipeline:
 *
 *     fs event ─▶ classifyChangedPath ─▶ pendingChanges set
 *                                          │
 *                                          ▼
 *                              setTimeout(debounceMs)
 *                                          │
 *                                          ▼
 *                       backend.reload(changed) ─▶ syncManifests(callback)
 *
 * Only the *names* of the changed functions reach `backend.reload()`;
 * the backend re-bundles those names and atomically swaps the new
 * workerd in. If a change touches a "shared" path (top-level files,
 * `_shared/`, anything starting with `_`), we promote to a full
 * reload — that change could affect any function and we can't tell
 * which without a dependency graph.
 *
 * Two seams keep this testable without spinning up workerd:
 *
 *   - {@link createReloadDebouncer}: the pure debounce + classify
 *     buffer, exported on its own so unit tests can drive it with
 *     a fake clock.
 *   - {@link createWorkerdHotReloader}: the loop that consumes a
 *     watcher iterable. Tests pass an async iterator of fake events
 *     instead of the real `Deno.watchFs` to avoid filesystem flake.
 */

import { relative, sep as SEPARATOR } from "node:path";
import type { FunctionManifest } from "../../manifest.ts";
import type { WorkerdBackend, WorkerdReloadResult } from "./backend.ts";

/**
 * Map a changed filesystem path to either a function name or `null`
 * meaning "shared change — reload everything".
 *
 * Mirrors the helper in `server.ts` (Deno-path HMR) so a single
 * change-classification rule applies across both backends.
 */
export function classifyChangedPath(
  resolvedFunctionsDir: string,
  absPath: string,
): string | null {
  const rel = relative(resolvedFunctionsDir, absPath);
  if (
    !rel || rel.startsWith("..") || rel.startsWith(SEPARATOR + "..") ||
    rel === "."
  ) {
    return null;
  }
  const first = rel.split(/[\\/]/, 1)[0];
  if (!first) return null;
  // Underscore-prefixed dirs (`_shared/`, `_internal/`) and anything
  // ending in `_shared` are treated as cross-cutting code that any
  // function may import. We can't selectively rebundle, so promote
  // to a full reload.
  if (first.startsWith("_") || first.endsWith("_shared")) return null;
  return first;
}

/**
 * Pending-change buffer + debounce timer.
 *
 * The hot reloader pushes raw fs paths in via {@link push}; the
 * buffer classifies them and holds the result until either:
 *
 *   - {@link flush} is called (the timer fired), or
 *   - {@link drain} is called (caller wants the pending set right now,
 *     e.g. on shutdown).
 *
 * `flushFn` is invoked at most once per debounce window. While a
 * flush is in flight, new pushes accumulate and trigger another
 * flush once the in-flight one resolves — this way a save burst
 * during a slow reload doesn't get lost.
 */
export interface ReloadDebouncer {
  /** Buffer one or more changed paths. Schedules a flush. */
  push(paths: readonly string[]): void;
  /** Cancel the pending flush timer; do not call flushFn. */
  cancel(): void;
  /** Returns the current pending set without flushing. Test seam. */
  drain(): { sharedChange: boolean; functions: string[] };
  /** True when a flush is currently in progress. Test seam. */
  readonly isFlushing: boolean;
}

export interface ReloadDebouncerOptions {
  /** Resolved (real-path) functions directory. */
  functionsDir: string;
  /** ms to wait after the last fs event before triggering a flush. */
  debounceMs: number;
  /**
   * Called once per debounce window with the coalesced change set.
   * `sharedChange === true` means "reload everything"; otherwise
   * `functions` lists the changed names.
   */
  flushFn: (
    changes: { sharedChange: boolean; functions: string[] },
  ) => Promise<void>;
  /** Defaults to `setTimeout`/`clearTimeout`; tests inject a fake clock. */
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export function createReloadDebouncer(
  opts: ReloadDebouncerOptions,
): ReloadDebouncer {
  const setTimer = opts.setTimer ??
    ((cb, ms) => setTimeout(cb, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));

  const pendingFunctions = new Set<string>();
  let pendingShared = false;
  let timerId: number | null = null;
  let flushing = false;

  const flush = async () => {
    timerId = null;
    if (flushing) {
      // A flush was already in progress when the timer fired. Schedule
      // another so changes buffered during the in-flight reload aren't
      // lost. The flushing-guard in the running flushFn will let it
      // pick up the new state.
      return;
    }
    if (!pendingShared && pendingFunctions.size === 0) return;
    const changes = {
      sharedChange: pendingShared,
      functions: pendingShared ? [] : [...pendingFunctions].sort(),
    };
    pendingShared = false;
    pendingFunctions.clear();
    flushing = true;
    try {
      await opts.flushFn(changes);
    } finally {
      flushing = false;
      // If new events arrived while we were flushing, schedule a
      // follow-up — the simple "schedule once per push" loop in
      // push() can't do that itself because timerId may have already
      // been set to null when the flush kicked off.
      if (pendingShared || pendingFunctions.size > 0) {
        if (timerId !== null) clearTimer(timerId);
        timerId = setTimer(flush, opts.debounceMs);
      }
    }
  };

  return {
    push(paths) {
      let added = false;
      for (const p of paths) {
        const cls = classifyChangedPath(opts.functionsDir, p);
        if (cls === null) {
          if (!pendingShared) {
            pendingShared = true;
            added = true;
          }
        } else if (!pendingFunctions.has(cls)) {
          pendingFunctions.add(cls);
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
      const out = {
        sharedChange: pendingShared,
        functions: [...pendingFunctions].sort(),
      };
      pendingShared = false;
      pendingFunctions.clear();
      return out;
    },
    get isFlushing() {
      return flushing;
    },
  };
}

/**
 * Iterable surface compatible with both real `Deno.watchFs` and a
 * test-time fake. `Deno.watchFs` already implements this shape; we
 * type it explicitly so tests don't have to depend on the global.
 */
export type FsEventStream = AsyncIterable<{ paths: readonly string[] }> & {
  close(): void;
};

export interface WorkerdHotReloaderOptions {
  /** Resolved functions directory. Same string fed to the watcher. */
  functionsDir: string;
  /** Backend instance produced by `createWorkerdBackend`. Must already be `start()`ed. */
  backend: WorkerdBackend;
  /**
   * Debounce window in ms. 200ms is the same value the Deno-path HMR
   * uses; mirrors editor save-burst behaviour (e.g. format-on-save +
   * autosave write the file twice within ~50ms).
   */
  debounceMs?: number;
  /**
   * Called after each successful reload with the new manifest map so
   * the gateway can re-sync registry / supervisor state. Errors
   * thrown here are logged but do NOT roll back the reload — the
   * new code is already live.
   */
  onManifestsUpdated?: (
    manifests: ReadonlyMap<string, FunctionManifest>,
    result: WorkerdReloadResult,
  ) => void;
  /**
   * Test seam: factory for the underlying watcher. Defaults to
   * `Deno.watchFs(functionsDir, { recursive: true })`. Tests inject
   * an in-memory async iterator instead.
   */
  watch?: (functionsDir: string) => FsEventStream;
  /** Test seam: setTimeout/clearTimeout overrides forwarded to the debouncer. */
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /** Override the log function (defaults to console.log). Tests use this to assert output. */
  log?: (line: string) => void;
}

export interface WorkerdHotReloader {
  /** Begin watching. Returns once the watcher is established. */
  start(): Promise<void>;
  /** Stop watching, cancel any pending flush, and release the watcher. Idempotent. */
  stop(): Promise<void>;
}

export function createWorkerdHotReloader(
  opts: WorkerdHotReloaderOptions,
): WorkerdHotReloader {
  const log = opts.log ?? ((line) => console.log(line));
  const watcherFactory = opts.watch ??
    ((dir) =>
      Deno.watchFs(dir, { recursive: true }) as unknown as FsEventStream);

  let stream: FsEventStream | null = null;
  let stopped = false;
  let consumeLoop: Promise<void> | null = null;

  // The debouncer's flushFn is the actual workhorse: take the
  // coalesced change set and call backend.reload(). On error we
  // log loudly but do NOT throw — the watcher loop must keep going,
  // because the next save is the user's chance to fix the bug.
  const debouncer = createReloadDebouncer({
    functionsDir: opts.functionsDir,
    debounceMs: opts.debounceMs ?? 200,
    setTimer: opts.setTimer,
    clearTimer: opts.clearTimer,
    flushFn: async ({ sharedChange, functions }) => {
      const reason = sharedChange
        ? "shared change → full reload"
        : `${functions.length} function(s) changed: ${functions.join(", ")}`;
      log(`[1tube] HMR ${reason}`);
      try {
        const result = await opts.backend.reload(
          sharedChange ? "all" : new Set(functions),
        );
        const parts: string[] = [];
        if (result.rebundled.length > 0) {
          parts.push(`rebundled=${result.rebundled.join(",")}`);
        }
        if (result.added.length > 0) {
          parts.push(`added=${result.added.join(",")}`);
        }
        if (result.removed.length > 0) {
          parts.push(`removed=${result.removed.join(",")}`);
        }
        log(
          `[1tube] HMR reload ok in ${result.durationMs.toFixed(0)}ms${
            parts.length > 0 ? ` (${parts.join("; ")})` : ""
          }`,
        );
        if (opts.onManifestsUpdated) {
          try {
            opts.onManifestsUpdated(opts.backend.manifests, result);
          } catch (err) {
            log(`[1tube] HMR onManifestsUpdated callback threw: ${err}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(
          `[1tube] HMR reload FAILED — keeping previous workerd alive. Error: ${msg}`,
        );
      }
    },
  });

  return {
    async start() {
      if (stream) return;
      stream = watcherFactory(opts.functionsDir);
      log(`[1tube] HMR watching: ${opts.functionsDir}`);
      // Drive the watcher in a detached loop; surfacing errors via
      // `log` so an unexpected close doesn't silently kill HMR.
      consumeLoop = (async () => {
        try {
          for await (const event of stream!) {
            if (stopped) break;
            if (event.paths.length === 0) continue;
            debouncer.push(event.paths);
          }
        } catch (err) {
          if (!stopped) {
            log(`[1tube] HMR watcher disabled: ${err}`);
          }
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
      // Don't await consumeLoop forever — the watcher iterator may
      // be blocked on a syscall. A short bounded wait is enough to
      // let it observe `stopped`. Using a clearable timer so test
      // sanitisers don't flag it as a leak when stop() races a
      // completed loop.
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
