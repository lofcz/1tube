/**
 * Gateway-owned shared modules for the Bun backend.
 *
 * A shared module (Supabase's `_shared/profile-cache.ts` convention, or any
 * `--workerd-shared` path) has process-wide side effects — a realtime
 * subscription, an interval cache refresh — that must run ONCE, not once
 * per function. Every function gets its own `Bun.ModuleGraph`, so a plain
 * import would evaluate it N times.
 *
 * Instead the runtime evaluates all shared modules in one dedicated graph
 * and publishes their namespaces under a process-global symbol. The compat
 * plugin redirects any function's import of a shared source path to a tiny
 * stub that re-exports from that singleton. Because everything lives in one
 * process, functions get the real objects (functions, classes, maps) —
 * no RPC, no serialization, no generated rewrite copies.
 *
 * HMR: {@link SharedRuntime.reload} disposes the shared graph and evaluates
 * a fresh one; the caller then reloads every function that imports a
 * shared module so its stub re-binds to the new exports.
 */

import { resolve } from "node:path";
import { discoverSharedModules, type WorkerdSharedModuleInput } from "../../bundler/core.ts";
import { createDenoNamespace, createEdgeRuntime } from "../../compat/deno-shim.ts";
import { SHARED_REGISTRY_KEY, type SharedModuleProvider } from "../../compat/plugin.ts";

export type SharedModuleSpec = WorkerdSharedModuleInput;
export { discoverSharedModules };

export interface SharedModuleRecord {
  readonly id: string;
  readonly sourcePath: string;
  readonly exportNames: readonly string[];
}

export interface SharedRuntime extends SharedModuleProvider {
  /** Absolute source paths of every loaded shared module. */
  readonly sourcePaths: readonly string[];
  list(): readonly SharedModuleRecord[];
  bySourcePath(absPath: string): SharedModuleRecord | undefined;
  /** Re-evaluate every shared module (one of them changed on disk). */
  reload(): Promise<readonly SharedModuleRecord[]>;
  /** Dispose the shared graph, calling `dispose()` hooks where exported. */
  stop(): Promise<void>;
}

type Registry = Map<string, Record<string, unknown>>;

function registry(): Registry {
  const g = globalThis as unknown as Record<symbol, Registry | undefined>;
  return g[SHARED_REGISTRY_KEY] ??= new Map();
}

function processEnv() {
  return {
    get: (k: string) => process.env[k],
    set: (k: string, v: string) => {
      process.env[k] = v;
    },
    delete: (k: string) => {
      delete process.env[k];
    },
    has: (k: string) => k in process.env,
    toObject: () => ({ ...process.env }) as Record<string, string>,
  };
}

async function disposeModule(mod: Record<string | symbol, unknown>): Promise<void> {
  try {
    const dispose = (mod.dispose ?? mod[Symbol.asyncDispose] ?? mod[Symbol.dispose]) as
      | ((this: unknown) => unknown)
      | undefined;
    if (typeof dispose === "function") {
      await Promise.resolve(dispose.call(mod)).catch(() => {});
    }
  } catch {
    // A misbehaving teardown must never abort gateway shutdown / reload.
  }
}

export async function createSharedRuntime(
  modules: readonly SharedModuleSpec[],
  opts: { onError?: (err: unknown, kind: string) => void } = {},
): Promise<SharedRuntime> {
  let specs = modules.map((m) => ({ ...m, sourcePath: resolve(m.sourcePath) }));
  const records = new Map<string, SharedModuleRecord>();
  const byPath = new Map<string, SharedModuleRecord>();
  let graph: Bun.ModuleGraph | null = null;

  async function loadAll(): Promise<void> {
    const g = new Bun.ModuleGraph({
      globals: {
        Deno: createDenoNamespace({
          functionName: "<shared>",
          env: processEnv(),
          onServe: () => {
            throw new Error("shared modules cannot call serve()");
          },
        }),
        EdgeRuntime: createEdgeRuntime({}),
      },
      onError: (err, kind) => {
        if (opts.onError) opts.onError(err, kind);
        else console.error(`[1tube] shared module ${kind}:`, err);
      },
    });
    const loaded = new Map<string, Record<string, unknown>>();
    try {
      for (const spec of specs) {
        loaded.set(spec.id, await g.import(spec.sourcePath) as Record<string, unknown>);
      }
    } catch (err) {
      g.dispose();
      throw err;
    }
    const reg = registry();
    const previous = graph;
    const previousModules = [...records.keys()].map((id) => reg.get(id))
      .filter((ns): ns is Record<string, unknown> => ns !== undefined);
    for (const id of records.keys()) reg.delete(id);
    records.clear();
    byPath.clear();
    for (const spec of specs) {
      const ns = loaded.get(spec.id)!;
      reg.set(spec.id, ns);
      const record: SharedModuleRecord = {
        id: spec.id,
        sourcePath: spec.sourcePath,
        exportNames: Object.keys(ns),
      };
      records.set(spec.id, record);
      byPath.set(spec.sourcePath, record);
    }
    graph = g;
    // Only now that the fresh generation is live: tear down the old one.
    for (const ns of previousModules) await disposeModule(ns);
    previous?.dispose();
  }

  await loadAll();

  return {
    get sourcePaths() {
      return [...byPath.keys()];
    },
    list: () => [...records.values()],
    bySourcePath: (absPath) => byPath.get(resolve(absPath)),
    idForPath: (absPath) => byPath.get(absPath)?.id,
    exportNames: (id) => records.get(id)?.exportNames ?? [],
    async reload() {
      // Re-discover so an edited export list or a deleted module is seen.
      const fresh: SharedModuleSpec[] = [];
      for (const spec of specs) {
        const dir = resolve(spec.sourcePath, "..", "..");
        const found = (await discoverSharedModules(dir, [spec.sourcePath]))
          .find((m) => resolve(m.sourcePath) === spec.sourcePath);
        if (found) fresh.push({ ...found, sourcePath: spec.sourcePath });
      }
      specs = fresh;
      await loadAll();
      return [...records.values()];
    },
    async stop() {
      const reg = registry();
      for (const id of records.keys()) {
        const ns = reg.get(id);
        if (ns) await disposeModule(ns);
        reg.delete(id);
      }
      records.clear();
      byPath.clear();
      graph?.dispose();
      graph = null;
    },
  };
}
