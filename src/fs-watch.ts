/**
 * `Deno.watchFs`-shaped file watching on top of `node:fs.watch`.
 *
 * The HMR loops consume an async iterable of `{ paths }` batches and close
 * it on shutdown; keeping that shape lets them take a fake stream in tests.
 * Paths are absolute (`node:fs.watch` reports names relative to the
 * watched directory).
 */

import { type FSWatcher, watch } from "node:fs";
import { join } from "node:path";

export interface FsEvent {
  kind: string;
  paths: string[];
}

export type FsEventStream = AsyncIterable<{ paths: readonly string[] }> & {
  close(): void;
};

export function watchFs(
  dirs: string | readonly string[],
  opts: { recursive?: boolean } = {},
): AsyncIterableIterator<FsEvent> & { close(): void } {
  const list = typeof dirs === "string" ? [dirs] : [...dirs];
  const queue: FsEvent[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const watchers: FSWatcher[] = [];

  const push = (ev: FsEvent) => {
    if (closed) return;
    queue.push(ev);
    wake?.();
    wake = null;
  };

  for (const dir of list) {
    const w = watch(dir, { recursive: opts.recursive ?? true }, (kind, filename) => {
      push({ kind, paths: [filename ? join(dir, filename.toString()) : dir] });
    });
    // A watched directory disappearing must not crash the gateway.
    w.on("error", () => {});
    watchers.push(w);
  }

  const close = () => {
    if (closed) return;
    closed = true;
    for (const w of watchers) {
      try {
        w.close();
      } catch { /* already closed */ }
    }
    wake?.();
    wake = null;
  };

  const iter: AsyncIterableIterator<FsEvent> & { close(): void } = {
    close,
    [Symbol.asyncIterator]() {
      return iter;
    },
    async next(): Promise<IteratorResult<FsEvent>> {
      while (queue.length === 0) {
        if (closed) return { done: true, value: undefined };
        await new Promise<void>((r) => (wake = r));
      }
      return { done: false, value: queue.shift()! };
    },
    return(): Promise<IteratorResult<FsEvent>> {
      close();
      return Promise.resolve({ done: true, value: undefined });
    },
  };
  return iter;
}
