/**
 * Shared dependency instances — the graph-era successor of "colocated" dev
 * mode.
 *
 * Every function gets its own `Bun.ModuleGraph`, so by default each one
 * evaluates its own copy of everything it imports. Bun shares parsed code
 * and bytecode, but evaluation is per graph — and on a large project the
 * shared code dwarfs the functions themselves: a heavy SDK (`ai` + a
 * provider + zod) is ~300ms per function, and a big `_shared/` tree costs
 * as much again, all on the main thread.
 *
 * With sharing on, everything a function imports from OUTSIDE its own
 * directory — npm/jsr/https packages and local shared code (`_shared/**`,
 * `*_shared/**`) — is evaluated once in a dependency graph, and the
 * function graph receives a stub re-exporting that instance. Each
 * function's own files stay isolated per graph. That is the trade the
 * colocated mode made (shared module state for shared code), without
 * putting the functions themselves in one isolate.
 *
 * Generations: when a shared source file changes, {@link bump} starts a
 * fresh dependency graph. Functions reloaded afterwards bind to the new
 * generation; untouched functions keep the old one, which is disposed once
 * the last function using it is gone ({@link retain} / {@link release}).
 */

import { createDenoNamespace, createEdgeRuntime, type ServeHandler } from "./deno-shim.ts";
import { createGlobalProxy } from "./globals.ts";

export const SHARED_DEPS_KEY = Symbol.for("1tube.sharedDependencies");

export interface SharedDependenciesOptions {
  /** Extra globals for the dependency graph (e.g. an attributing console). */
  globals?: Record<string, unknown>;
  /** `Deno.serve()` reached through shared code. */
  onServe?: (handler: ServeHandler) => void;
  /** `EdgeRuntime.waitUntil()` reached through shared code. */
  onWaitUntil?: (p: Promise<unknown>) => void;
  onError?: (err: unknown, kind: string) => void;
}

export interface SharedDependencies {
  /** The generation new loads bind to. */
  readonly generation: number;
  /**
   * Evaluate (once per generation) the module at `key` (absolute path or
   * URL) and return the registry key its stub reads.
   */
  load(key: string): Promise<{ registryKey: string; exportNames: string[] }>;
  /** A function instance starts using the current generation. */
  retain(): number;
  /** A function instance using `generation` went away. */
  release(generation: number): void;
  /** Shared source changed: future loads use a fresh dependency graph. */
  bump(): void;
  /** Dispose every generation (gateway shutdown). */
  dispose(): void;
}

interface Generation {
  id: number;
  graph: Bun.ModuleGraph;
  refs: number;
  inflight: Map<string, Promise<string[]>>;
  keys: Set<string>;
}

function registry(): Map<string, Record<string, unknown>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Record<string, unknown>> | undefined>;
  return g[SHARED_DEPS_KEY] ??= new Map();
}

export function createSharedDependencies(
  opts: SharedDependenciesOptions = {},
): SharedDependencies {
  const reg = registry();
  // Distinct per instance so two instances (tests) never share keys.
  const instanceId = crypto.randomUUID().slice(0, 8);
  let nextId = 1;

  function newGeneration(): Generation {
    const globals: Record<string, unknown> = {
        Deno: createDenoNamespace({
          functionName: "<shared>",
          env: {
            get: (k) => process.env[k],
            set: (k, v) => {
              process.env[k] = v;
            },
            delete: (k) => {
              delete process.env[k];
            },
            has: (k) => k in process.env,
            toObject: () => ({ ...process.env }) as Record<string, string>,
          },
          onServe: opts.onServe ?? (() => {
            throw new Error("shared code cannot call Deno.serve()");
          }),
          onWaitUntil: opts.onWaitUntil,
        }),
        EdgeRuntime: createEdgeRuntime({ onWaitUntil: opts.onWaitUntil }),
        ...opts.globals,
    };
    // Shared code reads `globalThis.Deno`, `globalThis.EdgeRuntime`,
    // `globalThis.__edgeFunctionRegistry` too — layer them like a function's.
    const scope = createGlobalProxy(globals);
    globals.globalThis = scope;
    globals.self = scope;
    const graph = new Bun.ModuleGraph({
      globals,
      onError: (err, kind) => {
        if (opts.onError) opts.onError(err, kind);
        else console.error(`[1tube] shared code ${kind}:`, err);
      },
    });
    return { id: nextId++, graph, refs: 0, inflight: new Map(), keys: new Set() };
  }

  let current = newGeneration();
  const retired = new Map<number, Generation>();

  function disposeGeneration(gen: Generation): void {
    for (const k of gen.keys) reg.delete(k);
    gen.keys.clear();
    try {
      gen.graph.dispose();
    } catch { /* already disposed */ }
  }

  return {
    get generation() {
      return current.id;
    },
    load(key) {
      const gen = current;
      const registryKey = `${instanceId}:${gen.id}:${key}`;
      const loaded = reg.get(registryKey);
      if (loaded) return Promise.resolve({ registryKey, exportNames: Object.keys(loaded) });
      let p = gen.inflight.get(key);
      if (!p) {
        p = gen.graph.import(key).then((ns) => {
          reg.set(registryKey, ns);
          gen.keys.add(registryKey);
          return Object.keys(ns);
        }).finally(() => gen.inflight.delete(key));
        gen.inflight.set(key, p);
      }
      return p.then((exportNames) => ({ registryKey, exportNames }));
    },
    retain() {
      current.refs++;
      return current.id;
    },
    release(id) {
      if (id === current.id) {
        current.refs = Math.max(0, current.refs - 1);
        return;
      }
      const gen = retired.get(id);
      if (!gen) return;
      gen.refs--;
      if (gen.refs <= 0) {
        retired.delete(id);
        disposeGeneration(gen);
      }
    },
    bump() {
      const old = current;
      current = newGeneration();
      if (old.refs > 0) retired.set(old.id, old);
      else disposeGeneration(old);
    },
    dispose() {
      for (const gen of retired.values()) disposeGeneration(gen);
      retired.clear();
      disposeGeneration(current);
    },
  };
}
