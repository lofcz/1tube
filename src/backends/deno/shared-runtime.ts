/**
 * Gateway-side shared-runtime for the Deno backend.
 *
 * Mirrors the workerd backend's shared-runtime concept (run a shared
 * module once in the gateway process; expose its exports to function
 * isolates over RPC) but adapted for Web Workers in the same process:
 *
 *   - No HTTP loopback. Workers reach the runtime via the host's
 *     `postMessage` channel, which is one round-trip and avoids the
 *     localhost socket overhead workerd needs.
 *   - The shared module's side effects (websocket subscriptions,
 *     interval timers, etc.) execute exactly once, in the gateway
 *     main isolate, instead of N times across N function Workers.
 *
 * Lifecycle:
 *
 *     boot        →  load(modules)         // dynamic import each
 *     hot reload  →  reload(sourcePath)    // cache-bust + re-import
 *     shutdown    →  stop()                // best-effort dispose hooks
 *
 * The runtime's public `call(moduleId, exportName, args)` returns
 * the awaited result of the export. Errors are thrown back so the
 * Worker-side stub can re-throw with the right shape.
 *
 * Reusing {@link discoverSharedModules} (and the export-name
 * extractor) from `src/bundler/core.ts` keeps the
 * `_shared/profile-cache.ts` convention identical between backends —
 * users don't have to remember which flag corresponds to which
 * runtime, and a single project can target both backends.
 */

import { pathToFileURL } from "node:url";
import {
  discoverSharedModules,
  type WorkerdSharedModuleInput,
} from "../../bundler/core.ts";

export type SharedModuleSpec = WorkerdSharedModuleInput;

export interface SharedModuleRecord {
  readonly id: string;
  readonly sourcePath: string;
  readonly exportNames: readonly string[];
  /**
   * Module URL the gateway used to load this shared module (the
   * cache-busted URL for re-imports). Useful for diagnostics only.
   */
  readonly loadedUrl: string;
}

export interface DenoSharedRuntime {
  /** Source paths (absolute, normalised) of every loaded shared module. */
  readonly sourcePaths: readonly string[];
  /** All loaded modules' descriptors (for stub generation + diagnostics). */
  list(): readonly SharedModuleRecord[];
  /** Look up by absolute source path (the rewriter's use case). */
  bySourcePath(absPath: string): SharedModuleRecord | undefined;
  /**
   * Invoke a function exported by a shared module. Throws if the
   * module or export is unknown, or if the export itself throws.
   */
  call(moduleId: string, exportName: string, args: readonly unknown[]): Promise<unknown>;
  /**
   * Re-import a shared module after its source file changed. Returns
   * the new record. If the export list changed, callers should
   * regenerate stubs and reload every Worker that depends on this
   * module — the runtime cannot do that on its own.
   */
  reload(sourcePath: string): Promise<{
    record: SharedModuleRecord;
    exportListChanged: boolean;
  }>;
  /**
   * Best-effort teardown: drops the export map and calls each
   * module's `dispose()` / `[Symbol.asyncDispose]()` if exposed.
   */
  stop(): Promise<void>;
}

/**
 * Discover shared modules under `functionsDir` (Supabase convention
 * + explicit paths) and return their descriptors. Re-exported from
 * the bundler core so server.ts has a single import path.
 */
export { discoverSharedModules };

/**
 * Load shared modules into the gateway main isolate. Each module is
 * imported exactly once; its exports are captured for later RPC.
 *
 * Cache-busting: a unique query string is appended to every loaded
 * URL so subsequent `reload()` calls produce a fresh module instance
 * (Deno keys its module cache by URL, so query-string-different
 * imports are evaluated independently). The cost is one re-evaluation
 * per HMR event, which is exactly what we want.
 */
export async function createDenoSharedRuntime(
  modules: readonly SharedModuleSpec[],
): Promise<DenoSharedRuntime> {
  const records = new Map<string, SharedModuleRecord>();
  const exports = new Map<string, Record<string, unknown>>();

  async function loadOne(
    spec: SharedModuleSpec,
  ): Promise<SharedModuleRecord> {
    const cacheBust = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const url = `${pathToFileURL(spec.sourcePath).href}?v=${cacheBust}`;
    const mod = await import(url) as Record<string, unknown>;
    for (const name of spec.exportNames) {
      if (typeof mod[name] !== "function") {
        throw new Error(
          `shared module "${spec.id}" (${spec.sourcePath}) does not export function ${name}()`,
        );
      }
    }
    exports.set(spec.id, mod);
    const record: SharedModuleRecord = {
      id: spec.id,
      sourcePath: spec.sourcePath,
      exportNames: [...spec.exportNames],
      loadedUrl: url,
    };
    records.set(spec.id, record);
    return record;
  }

  for (const spec of modules) {
    await loadOne(spec);
  }

  // Pre-compute the path→record reverse index. Updated on reload.
  function rebuildBySourcePath(): Map<string, SharedModuleRecord> {
    const m = new Map<string, SharedModuleRecord>();
    for (const r of records.values()) m.set(r.sourcePath, r);
    return m;
  }
  let bySourcePathIndex = rebuildBySourcePath();

  return {
    get sourcePaths() {
      return [...records.values()].map((r) => r.sourcePath);
    },
    list() {
      return [...records.values()];
    },
    bySourcePath(absPath) {
      return bySourcePathIndex.get(absPath);
    },
    async call(moduleId, exportName, args) {
      const mod = exports.get(moduleId);
      if (!mod) throw new Error(`unknown shared module: ${moduleId}`);
      const fn = mod[exportName];
      if (typeof fn !== "function") {
        throw new Error(`unknown shared export: ${moduleId}.${exportName}`);
      }
      return await (fn as (...a: unknown[]) => unknown).apply(null, [...args]);
    },
    async reload(sourcePath) {
      const old = bySourcePathIndex.get(sourcePath);
      if (!old) {
        throw new Error(`not a tracked shared module: ${sourcePath}`);
      }
      // Re-extract exports from the on-disk source, since the
      // export list may have changed in the edit. This re-uses the
      // same regex-based extractor that powers initial discovery.
      const updatedSpec = await reExtractSpec(old, sourcePath);
      const oldNames = new Set(old.exportNames);
      const newNames = new Set(updatedSpec.exportNames);
      const exportListChanged = oldNames.size !== newNames.size ||
        [...oldNames].some((n) => !newNames.has(n));
      const record = await loadOne(updatedSpec);
      bySourcePathIndex = rebuildBySourcePath();
      return { record, exportListChanged };
    },
    async stop() {
      const all = [...exports.values()];
      records.clear();
      exports.clear();
      bySourcePathIndex = new Map();
      // Best-effort dispose. We don't want a misbehaving shared
      // module's teardown to throw and abort gateway shutdown.
      for (const mod of all) {
        try {
          const m = mod as Record<string | symbol, unknown>;
          const dispose = (m.dispose ?? m[Symbol.asyncDispose] ??
            m[Symbol.dispose]) as ((this: unknown) => unknown) | undefined;
          if (typeof dispose === "function") {
            await Promise.resolve(dispose.call(mod)).catch(() => {});
          }
        } catch {
          /* */
        }
      }
    },
  };
}

async function reExtractSpec(
  old: SharedModuleRecord,
  sourcePath: string,
): Promise<SharedModuleSpec> {
  // Re-use the workerd bundler's extractor by re-running discovery
  // for this single path. Cheaper than duplicating the regex here
  // and keeps the two runtimes in lockstep.
  const candidates = await discoverSharedModules(
    `${sourcePath.replace(/[\\/][^\\/]+$/, "")}/..`,
    [sourcePath],
  );
  const found = candidates.find((c) => c.sourcePath === old.sourcePath);
  if (!found) {
    throw new Error(`shared module disappeared on reload: ${sourcePath}`);
  }
  return found;
}
