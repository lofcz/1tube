/**
 * Discovers and loads edge function modules from the filesystem.
 *
 * Scans `functionsDir` for subdirectories containing an `index.ts`.
 * Skips directories starting with `_` or ending with `_shared`.
 * Each discovered module is dynamically imported in parallel — the top-level
 * `serve()` call in the module registers the handler via the global
 * FunctionRegistry. Concurrent imports are kept registration-safe via the
 * registry's async-context binding.
 */

// node: specifiers so this module loads cleanly from node_modules in any
// host Deno project (no shared import-map entry required).
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FunctionRegistry } from "./registry.ts";
import { loadManifest } from "./manifest.ts";

export interface DiscoveryProgress {
  name: string;
  index: number;
  total: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface DiscoveryOptions {
  /** When set, appended as `?v=` to module URLs to force re-transpilation. */
  cacheBust?: string;
  /** Restrict loading to this set of function names (others are skipped entirely). */
  only?: ReadonlySet<string>;
  /** Max number of concurrent dynamic imports. Defaults to 8. */
  concurrency?: number;
  /** Invoked once per function as it finishes (success or failure). */
  onProgress?: (p: DiscoveryProgress) => void;
  /**
   * When true, candidates are registered for lazy import on first dispatch.
   * Functions whose manifest sets `warm: true` are still imported eagerly
   * (in parallel, alongside other warm functions). Significantly cuts
   * startup wall-clock and resident memory when many functions exist.
   */
  lazy?: boolean;
}

export interface DiscoveryResult {
  loaded: string[];
  skipped: string[];
  errors: Array<{ name: string; error: string }>;
  /** Function names whose `index.ts` no longer exists (caller should evict from registry). */
  removed: string[];
  /** Names registered as lazy candidates (only populated when `options.lazy` is true). */
  deferred: string[];
}

export async function discoverAndLoad(
  functionsDir: string,
  registry: FunctionRegistry,
  options?: DiscoveryOptions,
): Promise<DiscoveryResult> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  const removed: string[] = [];
  const deferred: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  const resolvedDir = await Deno.realPath(functionsDir);

  const candidates: string[] = [];
  for await (const entry of Deno.readDir(resolvedDir)) {
    if (!entry.isDirectory) continue;
    if (entry.name.startsWith("_") || entry.name.endsWith("_shared")) {
      skipped.push(entry.name);
      continue;
    }
    candidates.push(entry.name);
  }
  candidates.sort();

  // Build the work list: exists check + `only` filter.
  const work: string[] = [];
  for (const name of candidates) {
    if (options?.only && !options.only.has(name)) continue;

    const indexPath = join(resolvedDir, name, "index.ts");
    try {
      await Deno.stat(indexPath);
      work.push(name);
    } catch {
      // No index.ts. If we were asked to reload this name explicitly, treat as
      // a deletion so the caller can evict it. Otherwise just skip.
      if (options?.only?.has(name)) {
        removed.push(name);
      } else {
        skipped.push(name);
      }
    }
  }

  // Also detect deletions from `only` that didn't appear as candidates at all
  // (e.g. the whole directory was removed).
  if (options?.only) {
    const present = new Set(candidates);
    for (const name of options.only) {
      if (!present.has(name) && !removed.includes(name)) {
        removed.push(name);
      }
    }
  }

  const total = work.length;
  let completed = 0;

  const loadOne = async (name: string): Promise<void> => {
    const indexPath = join(resolvedDir, name, "index.ts");
    // pathToFileURL is the node:url equivalent of std/path's toFileUrl;
    // both produce a `file://` URL whose searchParams we mutate below for
    // HMR cache-busting.
    const moduleUrl = pathToFileURL(indexPath);
    if (options?.cacheBust) {
      moduleUrl.searchParams.set("v", options.cacheBust);
    }

    const start = performance.now();
    try {
      // Load the manifest first so it is attached to the registry before the
      // module's top-level `serve()` call captures the handler. Manifest
      // failures degrade to defaults inside loadManifest().
      const manifest = await loadManifest(resolvedDir, name);

      // Lazy mode: skip the dynamic import unless the manifest opts in via
      // `warm: true`. Register a candidate so the first dispatch can import
      // on demand. This is the single biggest startup-time win for sites
      // with many rarely-called functions.
      if (options?.lazy && !manifest.warm) {
        registry.registerCandidate({ name, moduleUrl: moduleUrl.href, manifest });
        deferred.push(name);
        const durationMs = performance.now() - start;
        options?.onProgress?.({
          name,
          index: ++completed,
          total,
          durationMs,
          ok: true,
        });
        return;
      }

      registry.attachManifest(name, manifest);
      // Even in lazy mode, eagerly-warm functions still register a candidate
      // so HMR reloads can re-import via the same URL.
      if (options?.lazy && manifest.warm) {
        registry.registerCandidate({ name, moduleUrl: moduleUrl.href, manifest });
      }
      await registry.runWithCurrentFunction(name, async () => {
        await import(moduleUrl.href);
      });
      loaded.push(name);
      const durationMs = performance.now() - start;
      options?.onProgress?.({
        name,
        index: ++completed,
        total,
        durationMs,
        ok: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ name, error: msg });
      const durationMs = performance.now() - start;
      options?.onProgress?.({
        name,
        index: ++completed,
        total,
        durationMs,
        ok: false,
        error: msg,
      });
    }
  };

  // Bounded parallel loader. Deno's module loader serializes some FS work
  // internally, but we still benefit from overlapping transpile + JSR fetches.
  const concurrency = Math.max(1, options?.concurrency ?? 8);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, work.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= work.length) return;
      await loadOne(work[i]);
    }
  });
  await Promise.all(workers);

  return { loaded, skipped, errors, removed, deferred };
}
