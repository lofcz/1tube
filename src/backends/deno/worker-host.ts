/**
 * Worker-per-function execution host for the Deno backend.
 *
 * Each function lives in its own Web Worker. HMR is just
 *
 *     handle.terminate(); handle = spawnWorker(...);
 *
 * which drops every cached module in that worker's import graph at
 * once. No filesystem snapshots, no `?v=` cache-bust hacks, no
 * cross-function state leakage through globals.
 *
 * The host owns:
 *   - one Worker per function, addressable by name
 *   - in-flight request bookkeeping (correlate by numeric id)
 *   - per-function dep-graphs (for the hot reloader's affected set)
 *   - a single Deno.watchFs loop with a debounced flush
 *
 * The dispatch path is:
 *
 *     gateway → handle.dispatch(req, auth) → postMessage to worker
 *                                              ↓
 *                                       worker rebuilds Request
 *                                              ↓
 *                                       handler(req, auth?)
 *                                              ↓
 *                                       postMessage(response)
 *                                              ↓
 *     gateway ← reconstructed Response
 *
 * Request and Response bodies are transferred as `ReadableStream`
 * via the postMessage transfer list, so even multi-megabyte uploads
 * don't get serialized through structured clone.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { defaultManifest, type FunctionManifest, loadManifest } from "../../manifest.ts";
import type {
  AuthContext,
  FunctionRegistry,
  WorkerFunctionHandle,
} from "../../registry.ts";
import type { FunctionSupervisor } from "../../supervisor.ts";
import { createDepGraph, type DepGraph } from "./dep-graph.ts";
import type { DenoSharedRuntime } from "./shared-runtime.ts";
import type { RewriteCache } from "./source-rewriter.ts";

export type DenoWorkerHandle = WorkerFunctionHandle;

export interface DenoWorkerHostOptions {
  functionsDir: string;
  registry: FunctionRegistry;
  supervisor: FunctionSupervisor;
  /** Debounce window in ms for batched fs change events. Defaults to 200ms. */
  debounceMs?: number;
  /** Max concurrent worker spawns at boot/reload. Defaults to 8. */
  concurrency?: number;
  /**
   * Parsed `imports` from the host project's deno.json. Forwarded to the
   * dep-graph so import-map aliases resolve to the right file URLs. Optional.
   */
  importMap?: Readonly<Record<string, string>>;
  /** Absolute path to the deno.json the import map came from. Required when `importMap` is set. */
  importMapBase?: string;
  /** Hook fired on every reload completion (for tests / observability). */
  onReloaded?: (summary: ReloadSummary) => void;
  /**
   * Optional shared-module runtime. When set, every Worker's
   * `globalThis.__1tube_call_shared(moduleId, exportName, args)`
   * round-trips into this runtime, and the source rewriter (also
   * required) replaces tainted imports with stub URLs. When both
   * are omitted the host behaves as before — no shared modules.
   */
  sharedRuntime?: DenoSharedRuntime;
  rewriteCache?: RewriteCache;
}

export interface ReloadSummary {
  reason: string;
  reloaded: string[];
  added: string[];
  removed: string[];
  errors: Array<{ name: string; error: string }>;
  durationMs: number;
}

interface PendingRequest {
  resolve: (resp: Response) => void;
  reject: (err: unknown) => void;
}

interface InternalHandle extends WorkerFunctionHandle {
  readonly worker: Worker;
}

/**
 * URL of the worker bootstrap module. Captured once so tests can override it
 * via the option bag if they need to point at a fake.
 */
const DEFAULT_WORKER_ENTRY = new URL("./worker-entry.ts", import.meta.url).href;

interface SpawnOpts {
  name: string;
  entryUrl: string;
  manifest: FunctionManifest;
  workerEntry?: string;
  /**
   * Forwarded to FunctionSupervisor when the worker reports an
   * unhandled rejection. Lets the host attribute orphan rejections
   * without going through AsyncLocalStorage.
   */
  onUnhandledRejection?: (msg: string) => void;
  /**
   * Resolve a shared-module RPC initiated inside this Worker.
   * Returns the value (or rejects with an Error) from the
   * gateway-side {@link DenoSharedRuntime}. Omit to disable shared
   * runtime calls — the worker will reject `__1tube_call_shared`
   * with a "not configured" message in that case.
   */
  onSharedCall?: (
    moduleId: string,
    exportName: string,
    args: readonly unknown[],
  ) => Promise<unknown>;
}

function spawnWorker(opts: SpawnOpts): Promise<InternalHandle> {
  return new Promise<InternalHandle>((resolve, reject) => {
    const worker = new Worker(
      opts.workerEntry ?? DEFAULT_WORKER_ENTRY,
      { type: "module", name: `1tube-fn-${opts.name}` },
    );

    const pending = new Map<number, PendingRequest>();
    let nextId = 1;
    let booted = false;

    const finishBoot = (handle: InternalHandle) => {
      booted = true;
      resolve(handle);
    };

    const failBoot = (err: Error) => {
      if (booted) return;
      try {
        worker.terminate();
      } catch { /* */ }
      reject(err);
    };

    worker.onerror = (e) => {
      // Boot-time errors surface here before the worker module finishes
      // executing (e.g. type errors). After boot, we route per-request
      // failures through `response_error` instead.
      const message = e.message || "Worker error";
      if (!booted) {
        failBoot(new Error(`Worker for "${opts.name}" failed to start: ${message}`));
      } else {
        // Drain any in-flight callers — the worker is dead.
        for (const p of pending.values()) p.reject(new Error(message));
        pending.clear();
      }
      e.preventDefault?.();
    };

    worker.onmessage = (ev) => {
      const m = ev.data as { type: string; [k: string]: unknown };
      if (m.type === "ready") {
        const isPublic = Boolean(m.isPublic);
        const timeoutMs = typeof m.timeoutMs === "number" ? m.timeoutMs : undefined;
        const manifest = (m.manifest as FunctionManifest) ?? opts.manifest;

        const handle: InternalHandle = {
          name: opts.name,
          manifest,
          isPublic,
          timeoutMs,
          worker,
          async dispatch(req, auth, signal) {
            if (signal.aborted) {
              throw new DOMException("Aborted", "AbortError");
            }
            const id = nextId++;
            const headers: Array<[string, string]> = [];
            req.headers.forEach((v, k) => headers.push([k, v]));
            const body = req.body;
            const transferList: Transferable[] = body
              ? [body as unknown as Transferable]
              : [];
            const promise = new Promise<Response>((res, rej) => {
              pending.set(id, { resolve: res, reject: rej });
            });
            const onAbort = () => {
              const p = pending.get(id);
              if (p) {
                pending.delete(id);
                p.reject(new DOMException("Aborted", "AbortError"));
              }
            };
            signal.addEventListener("abort", onAbort, { once: true });
            try {
              worker.postMessage(
                {
                  type: "dispatch",
                  id,
                  url: req.url,
                  method: req.method,
                  headers,
                  body,
                  auth,
                },
                transferList,
              );
            } catch (err) {
              pending.delete(id);
              signal.removeEventListener("abort", onAbort);
              throw err;
            }
            try {
              return await promise;
            } finally {
              signal.removeEventListener("abort", onAbort);
            }
          },
          async terminate() {
            try {
              worker.terminate();
            } catch { /* already dead */ }
            for (const p of pending.values()) {
              p.reject(new Error(`Worker for "${opts.name}" terminated`));
            }
            pending.clear();
          },
        };
        finishBoot(handle);
        return;
      }

      if (m.type === "init_error") {
        failBoot(new Error(String(m.message ?? "init failed")));
        return;
      }

      if (m.type === "response") {
        const id = m.id as number;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        const headers = new Headers(m.headers as Array<[string, string]>);
        const status = m.status as number;
        const body = (m.body as ReadableStream<Uint8Array> | null) ?? null;
        // 1xx and 204/205/304 forbid a body; suppress to avoid the
        // Response constructor throwing.
        const wantsBody = status >= 200 && status !== 204 && status !== 205 &&
          status !== 304;
        p.resolve(new Response(wantsBody ? body : null, { status, headers }));
        return;
      }

      if (m.type === "response_error") {
        const id = m.id as number;
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        const err = new Error(String(m.message ?? "handler error"));
        if (m.stack) (err as Error).stack = String(m.stack);
        p.reject(err);
        return;
      }

      if (m.type === "unhandledrejection" || m.type === "error_event") {
        opts.onUnhandledRejection?.(String(m.message ?? "unknown"));
        return;
      }

      if (m.type === "shared_call") {
        // Round-trip the call through the gateway-side runtime. The
        // worker side waits on a matching `shared_call_result` so we
        // post one in both success and failure paths. Errors are
        // serialized to a message + stack — structured clone can't
        // ferry a real Error across without losing the prototype.
        const id = m.id as number;
        const moduleId = String(m.moduleId ?? "");
        const exportName = String(m.exportName ?? "");
        const args = Array.isArray(m.args) ? (m.args as unknown[]) : [];
        const handler = opts.onSharedCall;
        const reply = (payload: Record<string, unknown>) => {
          try {
            worker.postMessage({ type: "shared_call_result", id, ...payload });
          } catch {
            // The worker may have terminated mid-call; nothing to do.
          }
        };
        if (!handler) {
          reply({
            ok: false,
            message: "shared runtime is not configured for this worker host",
          });
          return;
        }
        Promise.resolve()
          .then(() => handler(moduleId, exportName, args))
          .then(
            (value) => reply({ ok: true, value }),
            (err) => {
              const e = err instanceof Error ? err : new Error(String(err));
              reply({ ok: false, message: e.message, stack: e.stack });
            },
          );
        return;
      }
    };

    // Kick off init; the worker will reply with `ready` once the
    // function module's top-level serve() landed in the registry stub.
    worker.postMessage({
      type: "init",
      name: opts.name,
      entryUrl: opts.entryUrl,
      manifest: opts.manifest,
    });
  });
}

export interface SpawnProgress {
  /** 1-based index of this function in the boot sequence. */
  index: number;
  /** Total functions discovered for this start() call. */
  total: number;
  name: string;
  /** True when the worker spawned + reported `ready`. False on error. */
  ok: boolean;
  /** Time taken to spawn this worker, in milliseconds. */
  durationMs: number;
  /** Error message when `ok === false`. */
  error?: string;
}

export interface StartOptions {
  /** Fired before each worker spawn begins. */
  onSpawnStart?: (p: { index: number; total: number; name: string }) => void;
  /** Fired after each worker either becomes ready or errors out. */
  onSpawnFinish?: (p: SpawnProgress) => void;
}

export interface DenoWorkerHost {
  start(opts?: StartOptions): Promise<{
    loaded: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
  reload(names: ReadonlySet<string> | "all", reason?: string): Promise<ReloadSummary>;
  stop(): Promise<void>;
  /** Currently registered function names (loaded + booting). */
  list(): string[];
  /** Internal: dep-graph accessor for the hot reloader. */
  readonly depGraph: DepGraph;
}

interface DiscoveredCandidate {
  name: string;
  entryUrl: string;
  manifest: FunctionManifest;
}

async function discoverCandidates(
  functionsDir: string,
): Promise<DiscoveredCandidate[]> {
  const resolved = await Deno.realPath(functionsDir);
  const out: DiscoveredCandidate[] = [];
  for await (const entry of Deno.readDir(resolved)) {
    if (!entry.isDirectory) continue;
    if (entry.name.startsWith("_") || entry.name.endsWith("_shared")) continue;
    const indexPath = join(resolved, entry.name, "index.ts");
    try {
      await Deno.stat(indexPath);
    } catch {
      continue;
    }
    const manifest = await loadManifest(resolved, entry.name).catch(() =>
      defaultManifest()
    );
    out.push({
      name: entry.name,
      entryUrl: pathToFileURL(indexPath).href,
      manifest,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function createDenoWorkerHost(opts: DenoWorkerHostOptions): DenoWorkerHost {
  const handles = new Map<string, InternalHandle>();
  const depGraph = createDepGraph(
    opts.importMap && opts.importMapBase
      ? { importMap: opts.importMap, importMapBase: opts.importMapBase }
      : undefined,
  );
  const concurrency = Math.max(1, opts.concurrency ?? 8);

  const sharedRuntime = opts.sharedRuntime;
  const rewriteCache = opts.rewriteCache;

  async function spawnAndRegister(
    cand: DiscoveredCandidate,
  ): Promise<{ handle: InternalHandle } | { error: string }> {
    try {
      // Build the dep-graph BEFORE spawning. The rewriter needs the
      // file list to decide which files are tainted by a shared
      // module, and the worker needs to import the rewritten entry
      // URL (not the original) when any file in its graph touches a
      // shared module.
      await depGraph.refresh(cand.name, cand.entryUrl);

      let entryUrlForWorker = cand.entryUrl;
      if (rewriteCache && sharedRuntime && sharedRuntime.list().length > 0) {
        const entryPath = fileURLToPath(cand.entryUrl);
        const graphPaths = depGraph.filesFor(cand.name);
        const r = await rewriteCache.rewrite({ entryPath, graphPaths });
        entryUrlForWorker = r.entryUrl;
      }

      const handle = await spawnWorker({
        name: cand.name,
        entryUrl: entryUrlForWorker,
        manifest: cand.manifest,
        onUnhandledRejection: (msg) => {
          // Count orphan rejections against the function so the breaker
          // can trip on fire-and-forget code that consistently leaks.
          opts.supervisor.record(cand.name, true);
          console.error(`[1tube] Unhandled rejection in "${cand.name}": ${msg}`);
        },
        onSharedCall: sharedRuntime
          ? (moduleId, exportName, args) =>
            sharedRuntime.call(moduleId, exportName, args)
          : undefined,
      });
      // Update the registry + supervisor in one step so dispatch + admit
      // see consistent state.
      const old = handles.get(cand.name);
      handles.set(cand.name, handle);
      opts.registry.setWorkerHandle(cand.name, handle);
      opts.supervisor.setManifest(cand.name, handle.manifest);
      if (old) {
        await old.terminate().catch(() => {});
      }
      return { handle };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function runBounded<T>(
    items: T[],
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          await fn(items[i]);
        }
      },
    );
    await Promise.all(workers);
  }

  async function start(startOpts: StartOptions = {}) {
    const candidates = await discoverCandidates(opts.functionsDir);
    const loaded: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    const total = candidates.length;
    let nextIndex = 1;

    await runBounded(candidates, async (cand) => {
      const index = nextIndex++;
      startOpts.onSpawnStart?.({ index, total, name: cand.name });
      const t0 = performance.now();
      const r = await spawnAndRegister(cand);
      const durationMs = performance.now() - t0;
      if ("error" in r) {
        errors.push({ name: cand.name, error: r.error });
        startOpts.onSpawnFinish?.({
          index,
          total,
          name: cand.name,
          ok: false,
          durationMs,
          error: r.error,
        });
      } else {
        loaded.push(cand.name);
        startOpts.onSpawnFinish?.({
          index,
          total,
          name: cand.name,
          ok: true,
          durationMs,
        });
      }
    });
    return { loaded, errors };
  }

  async function reload(
    names: ReadonlySet<string> | "all",
    reason = "fs change",
  ): Promise<ReloadSummary> {
    const start = performance.now();
    const candidates = await discoverCandidates(opts.functionsDir);
    const candByName = new Map(candidates.map((c) => [c.name, c]));

    const targetNames = names === "all"
      ? new Set(candidates.map((c) => c.name))
      : new Set(names);

    // Detect deletions: names we currently know about that no longer
    // have an index.ts on disk.
    const removed: string[] = [];
    if (names === "all") {
      for (const old of handles.keys()) {
        if (!candByName.has(old)) removed.push(old);
      }
    } else {
      for (const n of targetNames) {
        if (!candByName.has(n) && handles.has(n)) removed.push(n);
      }
    }

    for (const n of removed) {
      const h = handles.get(n);
      if (h) await h.terminate().catch(() => {});
      handles.delete(n);
      opts.registry.clearWorkerHandle(n);
      opts.supervisor.forget(n);
      depGraph.forget(n);
    }

    const reloaded: string[] = [];
    const added: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    const toSpawn: DiscoveredCandidate[] = [];
    for (const n of targetNames) {
      const c = candByName.get(n);
      if (!c) continue;
      toSpawn.push(c);
    }

    await runBounded(toSpawn, async (cand) => {
      const wasKnown = handles.has(cand.name);
      const r = await spawnAndRegister(cand);
      if ("error" in r) {
        errors.push({ name: cand.name, error: r.error });
        // Reset stats for the failing function so the breaker doesn't keep
        // counting against the dead worker.
        opts.supervisor.reset(cand.name);
        return;
      }
      if (wasKnown) reloaded.push(cand.name);
      else added.push(cand.name);
      opts.supervisor.reset(cand.name);
    });

    const summary: ReloadSummary = {
      reason,
      reloaded: reloaded.sort(),
      added: added.sort(),
      removed: removed.sort(),
      errors,
      durationMs: performance.now() - start,
    };
    opts.onReloaded?.(summary);
    return summary;
  }

  async function stop() {
    const all = [...handles.values()];
    handles.clear();
    await Promise.all(all.map((h) => h.terminate().catch(() => {})));
  }

  return {
    start,
    reload,
    stop,
    list: () => [...handles.keys()].sort(),
    depGraph,
  };
}
