/**
 * Watches `--env-file` / `.env` paths and hot-applies secret changes.
 *
 * Deno only loads `--env-file` once at process start. With `--hmr`, a
 * save to `.env` must:
 *   1. Re-parse the file(s) into `Deno.env`
 *   2. Respawn function workers / workerd so top-level env captures
 *      and workerd `fromEnvironment` bindings see the new values
 *
 * The functions-dir HMR loop never sees these paths (they live at the
 * project root), so this watcher runs alongside it.
 */

import {
  applyEnvFiles,
  type EnvApplyDiff,
  type EnvSource,
  envFileWatchDirs,
  isEnvFileEvent,
} from "../env-file.ts";
import type { FsEventStream } from "./deno/hot-reloader.ts";

export interface EnvHotReloaderOptions {
  /** Absolute paths of env files to watch (order = precedence). */
  envFiles: readonly string[];
  /** Called after a real env diff is applied. Should reload workers. */
  onChanged: (diff: EnvApplyDiff) => void | Promise<void>;
  debounceMs?: number;
  leadingMs?: number;
  /** Test seam: inject a fake watcher. */
  watch?: (dirs: readonly string[]) => FsEventStream;
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  log?: (line: string) => void;
  /** Test seam: alternate env target (defaults to Deno.env). */
  env?: EnvSource;
  /** Test seam: override apply. */
  apply?: (files: readonly string[], env: EnvSource) => EnvApplyDiff;
}

export interface EnvHotReloader {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createEnvHotReloader(
  opts: EnvHotReloaderOptions,
): EnvHotReloader {
  const log = opts.log ?? ((line) => console.log(line));
  const envFiles = [...opts.envFiles];
  const env = opts.env ?? Deno.env;
  const apply = opts.apply ?? applyEnvFiles;
  const setTimer = opts.setTimer ??
    ((cb, ms) => setTimeout(cb, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
  const debounceMs = opts.debounceMs ?? 200;
  const leadingMs = opts.leadingMs !== undefined && opts.leadingMs > 0
    ? opts.leadingMs
    : 40;

  const watcherFactory = opts.watch ??
    ((dirs: readonly string[]) =>
      Deno.watchFs([...dirs], { recursive: false }) as unknown as FsEventStream);

  let stream: FsEventStream | null = null;
  let stopped = false;
  let consumeLoop: Promise<void> | null = null;
  let timerId: number | null = null;
  let flushing = false;
  let pending = false;

  const flush = async () => {
    timerId = null;
    if (flushing) return;
    if (!pending) return;
    pending = false;
    flushing = true;
    try {
      const diff = apply(envFiles, env);
      if (!diff.changed) return;
      const parts: string[] = [];
      if (diff.updated.length > 0) {
        parts.push(`updated=${diff.updated.join(",")}`);
      }
      if (diff.added.length > 0) parts.push(`added=${diff.added.join(",")}`);
      if (diff.removed.length > 0) {
        parts.push(`removed=${diff.removed.join(",")}`);
      }
      log(
        `[1tube] HMR env file changed (${parts.join("; ") || "secrets"})  reloading functions`,
      );
      await opts.onChanged(diff);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[1tube] HMR env reload FAILED: ${msg}`);
    } finally {
      flushing = false;
      if (pending) {
        timerId = setTimer(flush, debounceMs);
      }
    }
  };

  const schedule = () => {
    pending = true;
    if (flushing) return;
    if (timerId !== null) {
      // Leading-edge: first event of a quiet period already armed 
      // don't keep pushing the flush out.
      return;
    }
    timerId = setTimer(flush, leadingMs);
  };

  return {
    start() {
      if (stream || envFiles.length === 0) return Promise.resolve();
      const dirs = envFileWatchDirs(envFiles).filter((d) => {
        try {
          return Deno.statSync(d).isDirectory;
        } catch {
          return false;
        }
      });
      if (dirs.length === 0) return Promise.resolve();

      // Seed ownership from the current files so a subsequent delete of
      // a key from `.env` can be removed from Deno.env on the next save.
      apply(envFiles, env);

      stream = watcherFactory(dirs);
      log(
        `[1tube] HMR watching env: ${envFiles.join(", ")}`,
      );
      consumeLoop = (async () => {
        try {
          for await (const event of stream!) {
            if (stopped) break;
            if (event.paths.length === 0) continue;
            if (!isEnvFileEvent(event.paths, envFiles)) continue;
            schedule();
          }
        } catch (err) {
          if (!stopped) log(`[1tube] HMR env watcher disabled: ${err}`);
        }
      })();
      return Promise.resolve();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
      }
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
