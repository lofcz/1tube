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
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defaultManifest,
  type FunctionManifest,
  loadManifest,
} from "../../manifest.ts";
import type { FunctionRegistry, WorkerFunctionHandle } from "../../registry.ts";
import type { FunctionSupervisor } from "../../supervisor.ts";
import { createDepGraph, type DepGraph } from "./dep-graph.ts";
import type { DenoSharedRuntime } from "./shared-runtime.ts";
import type { RewriteCache } from "./source-rewriter.ts";

export type DenoWorkerHandle = WorkerFunctionHandle;

/** A console line (or runtime error) captured inside a function Worker. */
export interface WorkerConsoleEvent {
  functionName: string;
  /** Null for boot/import-time and fire-and-forget background output. */
  invocationId: string | null;
  level: "debug" | "log" | "info" | "warn" | "error";
  message: string;
  tsMs: number;
}

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
  /** Parsed `scopes` from the host project's deno.json import map. */
  importMapScopes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
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
  /**
   * Wrap each Worker's `console.*` and stream captured lines to
   * {@link onConsole}. Off by default — workers behave exactly as
   * before when the gateway's invocation log store is disabled.
   */
  captureConsole?: boolean;
  /** Sink for captured console lines + worker runtime errors. */
  onConsole?: (event: WorkerConsoleEvent) => void;
  /**
   * Last-dispatch timestamp per function from a PREVIOUS run (e.g. the
   * invocation log store). Seeds the MRU ordering used by deferred
   * boot and HMR respawns, so the functions the developer was hitting
   * before a gateway restart warm up first instead of alphabetically.
   * Fresh in-process dispatches overwrite the seed as traffic arrives.
   */
  initialRecency?: ReadonlyMap<string, number>;
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
  /** Ask the worker to wrap console.* and stream lines back. */
  captureConsole?: boolean;
  /** Sink for captured console lines + worker runtime errors. */
  onConsole?: (event: WorkerConsoleEvent) => void;
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
        failBoot(
          new Error(`Worker for "${opts.name}" failed to start: ${message}`),
        );
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
        const timeoutMs = typeof m.timeoutMs === "number"
          ? m.timeoutMs
          : undefined;
        const manifest = (m.manifest as FunctionManifest) ?? opts.manifest;

        const handle: InternalHandle = {
          name: opts.name,
          manifest,
          isPublic,
          timeoutMs,
          worker,
          async dispatch(req, auth, signal, invocationId) {
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
                  invocationId,
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
          terminate() {
            try {
              worker.terminate();
            } catch { /* already dead */ }
            for (const p of pending.values()) {
              p.reject(new Error(`Worker for "${opts.name}" terminated`));
            }
            pending.clear();
            return Promise.resolve();
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

      if (m.type === "console") {
        opts.onConsole?.({
          functionName: opts.name,
          invocationId: typeof m.invocationId === "string"
            ? m.invocationId
            : null,
          level: (m.level as WorkerConsoleEvent["level"]) ?? "log",
          message: String(m.message ?? ""),
          tsMs: typeof m.tsMs === "number" ? m.tsMs : Date.now(),
        });
        return;
      }

      if (m.type === "unhandledrejection" || m.type === "error_event") {
        opts.onUnhandledRejection?.(String(m.message ?? "unknown"));
        // Mirror runtime errors into the log store as error-level lines
        // so they show up next to the invocation that leaked them.
        const label = m.type === "unhandledrejection"
          ? "Unhandled rejection"
          : "Uncaught error";
        const stack = typeof m.stack === "string" && m.stack.length > 0
          ? `\n${m.stack}`
          : "";
        opts.onConsole?.({
          functionName: opts.name,
          invocationId: typeof m.invocationId === "string"
            ? m.invocationId
            : null,
          level: "error",
          message: `${label}: ${String(m.message ?? "unknown")}${stack}`,
          tsMs: Date.now(),
        });
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
      captureConsole: opts.captureConsole === true,
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
  /** Time spent building this function's dep graph, if on the per-function path. */
  graphMs: number;
  /** Time spent rewriting shared-module imports for this function. */
  rewriteMs: number;
  /** Time spent waiting for the Worker to import the function and report ready. */
  workerMs: number;
  /** Error message when `ok === false`. */
  error?: string;
}

export interface StartOptions {
  /** Fired before each worker spawn begins. */
  onSpawnStart?: (p: { index: number; total: number; name: string }) => void;
  /** Fired after each worker either becomes ready or errors out. */
  onSpawnFinish?: (p: SpawnProgress) => void;
  /** Fired after the initial shared-module batch graph finishes. */
  onBatchGraph?: (p: { total: number; durationMs: number }) => void;
}

/**
 * Lifecycle of a single function during boot.
 *
 *   queued ──▶ loading ──▶ ready
 *                  └──────▶ failed
 *
 * Eager boot walks every function through the same states, so
 * `bootStatus()` works identically in both boot modes.
 */
export type BootState = "queued" | "loading" | "ready" | "failed";

export interface BootStatus {
  total: number;
  ready: string[];
  loading: string[];
  queued: string[];
  failed: Array<{ name: string; error: string }>;
}

export interface DeferredStart {
  /** Function names discovered on disk, all registered as `queued`. */
  discovered: string[];
  /**
   * Resolves once the background queue has drained (including any
   * out-of-band prioritized spawns). Never rejects — failures are
   * collected in `errors`.
   */
  done: Promise<{
    loaded: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
}

export interface DenoWorkerHost {
  start(opts?: StartOptions): Promise<{
    loaded: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
  /**
   * Deferred boot: discover functions, register them as known-but-queued
   * (so the gateway's fast-fail middleware doesn't 404 them), and return
   * immediately. Workers spawn in the background with the same bounded
   * concurrency as eager boot. Use {@link prioritize} to jump a function
   * to the front when a request arrives for it.
   */
  startDeferred(opts?: StartOptions): Promise<DeferredStart>;
  reload(
    names: ReadonlySet<string> | "all",
    reason?: string,
  ): Promise<ReloadSummary>;
  stop(): Promise<void>;
  /** Currently registered function names (loaded + booting). */
  list(): string[];
  /** Boot state for `name`, or undefined if unknown. */
  bootState(name: string): BootState | undefined;
  /** Snapshot of all boot states. */
  bootStatus(): BootStatus;
  /**
   * Pull a queued function out of the background boot queue and spawn it
   * immediately (out-of-band, above the concurrency bound). No-op when the
   * function is already loading, ready, failed, or unknown.
   */
  prioritize(name: string): void;
  /**
   * Wait until `name` finishes booting. Resolves `"timeout"` when
   * `timeoutMs > 0` elapses first; waits indefinitely when `timeoutMs`
   * is 0 or omitted.
   */
  whenReady(
    name: string,
    timeoutMs?: number,
  ): Promise<"ready" | "failed" | "timeout" | "unknown">;
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

/**
 * Targeted variant of {@link discoverCandidates}: stats only the named
 * function dirs instead of scanning the whole functions root. An HMR
 * reload of one function in a 100-function project shouldn't pay for
 * 100 stat + manifest reads (which are painfully slow on Windows).
 */
async function discoverNamed(
  functionsDir: string,
  names: ReadonlySet<string>,
): Promise<DiscoveredCandidate[]> {
  const resolved = await Deno.realPath(functionsDir);
  const out: DiscoveredCandidate[] = [];
  await Promise.all([...names].map(async (name) => {
    if (name.startsWith("_") || name.endsWith("_shared")) return;
    const indexPath = join(resolved, name, "index.ts");
    try {
      const st = await Deno.stat(indexPath);
      if (!st.isFile) return;
    } catch {
      return;
    }
    const manifest = await loadManifest(resolved, name).catch(() =>
      defaultManifest()
    );
    out.push({
      name,
      entryUrl: pathToFileURL(indexPath).href,
      manifest,
    });
  }));
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export function createDenoWorkerHost(
  opts: DenoWorkerHostOptions,
): DenoWorkerHost {
  const handles = new Map<string, InternalHandle>();
  const depGraph = createDepGraph(
    opts.importMapBase && (opts.importMap || opts.importMapScopes)
      ? {
        importMap: opts.importMap,
        importMapScopes: opts.importMapScopes,
        importMapBase: opts.importMapBase,
      }
      : undefined,
  );
  const concurrency = Math.max(1, opts.concurrency ?? 8);

  const sharedRuntime = opts.sharedRuntime;
  const rewriteCache = opts.rewriteCache;

  // -------------------------------------------------------------------
  // Boot state machine (shared by eager + deferred boot and reload)
  // -------------------------------------------------------------------
  const bootStates = new Map<string, BootState>();
  const bootErrors = new Map<string, string>();
  const bootWaiters = new Map<
    string,
    Array<(state: "ready" | "failed") => void>
  >();
  /**
   * Unified claimable spawn queue, shared by deferred boot and HMR
   * reload. Every spawn that is waiting for a lane registers a claim
   * keyed by function name; claiming it (from a lane, from
   * `prioritize()`, or from a competing reload) removes it from the map
   * and starts the spawn exactly once. Lanes verify claim *identity*
   * before running, so a reload that re-enqueues a name supersedes a
   * stale boot-queue entry instead of double-spawning it.
   */
  const pendingClaims = new Map<string, () => Promise<void>>();
  /** Spawns started out-of-band by prioritize(), above the lane bound. */
  const outOfBandSpawns = new Set<Promise<void>>();
  /** Last gateway dispatch per function — drives MRU reload ordering. */
  const lastDispatch = new Map<string, number>(opts.initialRecency ?? []);
  /**
   * Per-name spawn serialization. Deferred boot and HMR reload can both
   * want to spawn the same function concurrently (e.g. an edit lands
   * while the function is still in the boot queue); chaining through
   * this map guarantees the last writer wins instead of racing two
   * `handles.set()` calls.
   */
  const spawnChains = new Map<string, Promise<unknown>>();

  interface ClaimItem {
    name: string;
    claim: () => Promise<void>;
    /** The in-flight (or finished) spawn, or null if never claimed. */
    started: () => Promise<void> | null;
  }

  function enqueueClaim(
    name: string,
    process: () => Promise<void>,
  ): ClaimItem {
    let started: Promise<void> | null = null;
    const claim = () => {
      if (!started) {
        if (pendingClaims.get(name) === claim) pendingClaims.delete(name);
        started = process();
      }
      return started;
    };
    pendingClaims.set(name, claim);
    return { name, claim, started: () => started };
  }

  /**
   * Drain `items` with at most `concurrency` lanes. Items claimed
   * elsewhere (prioritize, a superseding reload) are skipped — their
   * spawn is already running out-of-band.
   */
  async function drainClaims(items: ClaimItem[]): Promise<void> {
    let cursor = 0;
    const lanes = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (true) {
          const i = cursor++;
          if (i >= items.length) return;
          const it = items[i];
          if (pendingClaims.get(it.name) !== it.claim) continue;
          await it.claim();
        }
      },
    );
    await Promise.all(lanes);
  }

  function runSerialized<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = spawnChains.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    spawnChains.set(name, run.then(() => {}, () => {}));
    return run;
  }

  function settleBootState(name: string, ok: boolean, error?: string): void {
    bootStates.set(name, ok ? "ready" : "failed");
    if (ok) bootErrors.delete(name);
    else bootErrors.set(name, error ?? "unknown error");
    const waiters = bootWaiters.get(name);
    if (waiters) {
      bootWaiters.delete(name);
      for (const w of waiters) w(ok ? "ready" : "failed");
    }
  }

  function forgetBootState(name: string): void {
    bootStates.delete(name);
    bootErrors.delete(name);
    pendingClaims.delete(name);
    lastDispatch.delete(name);
    // A deleted function will never become ready; release any waiters
    // as "failed" so gateway grace-waits don't hang until timeout.
    const waiters = bootWaiters.get(name);
    if (waiters) {
      bootWaiters.delete(name);
      for (const w of waiters) w("failed");
    }
  }

  function whenReady(
    name: string,
    timeoutMs = 0,
  ): Promise<"ready" | "failed" | "timeout" | "unknown"> {
    const s = bootStates.get(name);
    if (s === "ready") return Promise.resolve("ready");
    if (s === "failed") return Promise.resolve("failed");
    if (s === undefined) return Promise.resolve("unknown");
    return new Promise((resolve) => {
      let timer: number | null = null;
      const cb = (state: "ready" | "failed") => {
        if (timer !== null) clearTimeout(timer);
        resolve(state);
      };
      const waiters = bootWaiters.get(name) ?? [];
      waiters.push(cb);
      bootWaiters.set(name, waiters);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const live = bootWaiters.get(name);
          if (live) {
            const i = live.indexOf(cb);
            if (i >= 0) live.splice(i, 1);
          }
          resolve("timeout");
        }, timeoutMs) as unknown as number;
      }
    });
  }

  function bootStatus(): BootStatus {
    const ready: string[] = [];
    const loading: string[] = [];
    const queued: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const [name, s] of bootStates) {
      if (s === "ready") ready.push(name);
      else if (s === "loading") loading.push(name);
      else if (s === "queued") queued.push(name);
      else {
        failed.push({ name, error: bootErrors.get(name) ?? "unknown error" });
      }
    }
    ready.sort();
    loading.sort();
    queued.sort();
    failed.sort((a, b) => a.name.localeCompare(b.name));
    return { total: bootStates.size, ready, loading, queued, failed };
  }

  interface SpawnTimings {
    graphMs: number;
    rewriteMs: number;
    workerMs: number;
  }

  function zeroTimings(): SpawnTimings {
    return { graphMs: 0, rewriteMs: 0, workerMs: 0 };
  }

  async function spawnAndRegister(
    cand: DiscoveredCandidate,
    spawnOpts: { graphReady?: boolean } = {},
  ): Promise<
    | { handle: InternalHandle; timings: SpawnTimings }
    | { error: string; timings: SpawnTimings }
  > {
    const timings = zeroTimings();
    let graphReady: Promise<void> | null = null;
    try {
      // The dep-graph build runs `deno_graph` over the function's
      // transitive imports, which is non-trivial for big projects
      // (npm:ai, supabase-js, etc. crawl wide). Two boot regimes:
      //
      //   - No shared runtime: kick off the graph in PARALLEL with
      //     the Worker spawn. The graph is only needed for HMR's
      //     affected-set, which the user can't trigger before boot
      //     completes — so we don't need it on the critical path.
      //   - Shared runtime present: the rewriter needs the file
      //     list to decide which files are tainted, so we have to
      //     await a graph BEFORE spawning. Initial eager boot builds
      //     one batch graph for every entry, so per-function reloads
      //     are the only shared-runtime path that still pays this here.
      let entryUrlForWorker = cand.entryUrl;
      if (rewriteCache && sharedRuntime && sharedRuntime.list().length > 0) {
        if (!spawnOpts.graphReady) {
          const graphStart = performance.now();
          await depGraph.refresh(cand.name, cand.entryUrl);
          timings.graphMs = performance.now() - graphStart;
        }
        const entryPath = fileURLToPath(cand.entryUrl);
        const graphPaths = depGraph.filesFor(cand.name);
        const rewriteStart = performance.now();
        const r = await rewriteCache.rewrite({ entryPath, graphPaths });
        timings.rewriteMs = performance.now() - rewriteStart;
        entryUrlForWorker = r.entryUrl;
      } else {
        const graphStart = performance.now();
        graphReady = depGraph.refresh(cand.name, cand.entryUrl).finally(() => {
          timings.graphMs = performance.now() - graphStart;
        });
      }

      const workerStart = performance.now();
      const handle = await spawnWorker({
        name: cand.name,
        entryUrl: entryUrlForWorker,
        manifest: cand.manifest,
        captureConsole: opts.captureConsole,
        onConsole: opts.onConsole,
        onUnhandledRejection: (msg) => {
          // Count orphan rejections against the function so the breaker
          // can trip on fire-and-forget code that consistently leaks.
          opts.supervisor.record(cand.name, true);
          console.error(
            `[1tube] Unhandled rejection in "${cand.name}": ${msg}`,
          );
        },
        onSharedCall: sharedRuntime
          ? (moduleId, exportName, args) =>
            sharedRuntime.call(moduleId, exportName, args)
          : undefined,
      });
      timings.workerMs = performance.now() - workerStart;
      // Update the registry + supervisor in one step so dispatch + admit
      // see consistent state.
      const old = handles.get(cand.name);
      handles.set(cand.name, handle);
      // The registry gets a thin wrapper that records dispatch recency —
      // HMR reloads respawn most-recently-used functions first, so the
      // function the developer is actively hitting refreshes soonest.
      opts.registry.setWorkerHandle(cand.name, {
        name: handle.name,
        manifest: handle.manifest,
        isPublic: handle.isPublic,
        timeoutMs: handle.timeoutMs,
        dispatch: (req, auth, signal, invocationId) => {
          lastDispatch.set(cand.name, Date.now());
          return handle.dispatch(req, auth, signal, invocationId);
        },
        terminate: () => handle.terminate(),
      });
      opts.supervisor.setManifest(cand.name, handle.manifest);
      // Deferred boot registers a candidate so `registry.has()` is true
      // before the worker exists. Refresh its manifest on every spawn so
      // `manifestFor()` (which prefers candidates) never serves a stale
      // `1tube.json` after an HMR reload.
      if (opts.registry.candidate(cand.name)) {
        opts.registry.registerCandidate({
          name: cand.name,
          moduleUrl: cand.entryUrl,
          manifest: handle.manifest,
        });
      }
      if (old) {
        await old.terminate().catch(() => {});
      }
      // If the dep-graph was kicked off in parallel (no shared
      // runtime case), make sure it lands before we return —
      // otherwise the hot reloader's first flush could see an empty
      // graph for this name and miss its file→owner mapping. The
      // graph is now tracked by `name`, so concurrent refreshes for
      // different functions don't interfere with each other; we
      // just need to await our own.
      if (graphReady) {
        await graphReady.catch(() => {});
      }
      return { handle, timings };
    } catch (err) {
      // If the spawn failed but the graph was building in the
      // background, drop the floating promise so unhandled-rejection
      // detectors don't fire. The graph state for this name will be
      // overwritten on the next reload attempt anyway.
      graphReady?.catch(() => {});
      return {
        error: err instanceof Error ? err.message : String(err),
        timings,
      };
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
    const useSharedRewrite = Boolean(
      rewriteCache && sharedRuntime && sharedRuntime.list().length > 0,
    );

    if (useSharedRewrite && candidates.length > 0) {
      const graphStart = performance.now();
      await depGraph.refreshMany(
        candidates.map((c) => ({ name: c.name, entryFileUrl: c.entryUrl })),
      );
      startOpts.onBatchGraph?.({
        total,
        durationMs: performance.now() - graphStart,
      });
    }

    for (const cand of candidates) bootStates.set(cand.name, "queued");
    await runBounded(candidates, async (cand) => {
      const index = nextIndex++;
      startOpts.onSpawnStart?.({ index, total, name: cand.name });
      bootStates.set(cand.name, "loading");
      const t0 = performance.now();
      const r = await runSerialized(
        cand.name,
        () => spawnAndRegister(cand, { graphReady: useSharedRewrite }),
      );
      const durationMs = performance.now() - t0;
      if ("error" in r) {
        errors.push({ name: cand.name, error: r.error });
        settleBootState(cand.name, false, r.error);
        startOpts.onSpawnFinish?.({
          index,
          total,
          name: cand.name,
          ok: false,
          durationMs,
          graphMs: r.timings.graphMs,
          rewriteMs: r.timings.rewriteMs,
          workerMs: r.timings.workerMs,
          error: r.error,
        });
      } else {
        loaded.push(cand.name);
        settleBootState(cand.name, true);
        startOpts.onSpawnFinish?.({
          index,
          total,
          name: cand.name,
          ok: true,
          durationMs,
          graphMs: r.timings.graphMs,
          rewriteMs: r.timings.rewriteMs,
          workerMs: r.timings.workerMs,
        });
      }
    });
    return { loaded, errors };
  }

  // -------------------------------------------------------------------
  // Deferred boot
  // -------------------------------------------------------------------

  interface DeferredCtx {
    total: number;
    startOpts: StartOptions;
    loaded: string[];
    errors: Array<{ name: string; error: string }>;
    nextIndex: number;
    /**
     * Resolves when the boot-wide batch dep-graph (shared-rewrite mode
     * only) has landed. Spawns wait on it instead of each paying a
     * full per-function graph crawl — one batch graph parses every
     * `_shared` file once instead of once per function.
     */
    batchGraphReady: Promise<void> | null;
  }
  let deferredCtx: DeferredCtx | null = null;

  async function processDeferredCandidate(
    cand: DiscoveredCandidate,
  ): Promise<void> {
    const ctx = deferredCtx;
    if (!ctx) return;
    bootStates.set(cand.name, "loading");
    const index = ++ctx.nextIndex;
    ctx.startOpts.onSpawnStart?.({ index, total: ctx.total, name: cand.name });
    const t0 = performance.now();
    if (ctx.batchGraphReady) await ctx.batchGraphReady;
    const r = await runSerialized(
      cand.name,
      () => spawnAndRegister(cand, { graphReady: ctx.batchGraphReady !== null }),
    );
    const durationMs = performance.now() - t0;
    if ("error" in r) {
      ctx.errors.push({ name: cand.name, error: r.error });
      settleBootState(cand.name, false, r.error);
      ctx.startOpts.onSpawnFinish?.({
        index,
        total: ctx.total,
        name: cand.name,
        ok: false,
        durationMs,
        graphMs: r.timings.graphMs,
        rewriteMs: r.timings.rewriteMs,
        workerMs: r.timings.workerMs,
        error: r.error,
      });
    } else {
      ctx.loaded.push(cand.name);
      settleBootState(cand.name, true);
      ctx.startOpts.onSpawnFinish?.({
        index,
        total: ctx.total,
        name: cand.name,
        ok: true,
        durationMs,
        graphMs: r.timings.graphMs,
        rewriteMs: r.timings.rewriteMs,
        workerMs: r.timings.workerMs,
      });
    }
  }

  async function startDeferred(
    startOpts: StartOptions = {},
  ): Promise<DeferredStart> {
    const candidates = await discoverCandidates(opts.functionsDir);
    // MRU-first warm-up: the background queue boots the functions the
    // developer was hitting most recently (seeded from the invocation
    // log store across restarts) before the ones nobody calls. Ties —
    // including everything on a first run — keep name order.
    candidates.sort((a, b) =>
      (lastDispatch.get(b.name) ?? 0) - (lastDispatch.get(a.name) ?? 0) ||
      a.name.localeCompare(b.name)
    );
    // Shared-rewrite mode needs each function's file list BEFORE its
    // worker spawns. Build ONE batch graph in the background (the
    // gateway still starts serving immediately) rather than letting
    // every spawn crawl its own graph — the per-function crawls
    // re-parse the same shared files over and over.
    const useSharedRewrite = Boolean(
      rewriteCache && sharedRuntime && sharedRuntime.list().length > 0,
    );
    let batchGraphReady: Promise<void> | null = null;
    if (useSharedRewrite && candidates.length > 0) {
      const graphStart = performance.now();
      batchGraphReady = depGraph
        .refreshMany(
          candidates.map((c) => ({ name: c.name, entryFileUrl: c.entryUrl })),
        )
        .then(() => {
          startOpts.onBatchGraph?.({
            total: candidates.length,
            durationMs: performance.now() - graphStart,
          });
        })
        .catch(() => {});
    }
    const ctx: DeferredCtx = {
      total: candidates.length,
      startOpts,
      loaded: [],
      errors: [],
      nextIndex: 0,
      batchGraphReady,
    };
    deferredCtx = ctx;
    const items: ClaimItem[] = [];
    for (const c of candidates) {
      bootStates.set(c.name, "queued");
      // Make the name known to the gateway (fast-fail middleware,
      // rate-limiter manifest lookup) before its worker exists.
      opts.registry.registerCandidate({
        name: c.name,
        moduleUrl: c.entryUrl,
        manifest: c.manifest,
      });
      items.push(enqueueClaim(c.name, () => processDeferredCandidate(c)));
    }

    const done = (async () => {
      await drainClaims(items);
      // Prioritized spawns run outside the lanes; drain them too
      // (more can be added while we wait, hence the loop).
      while (outOfBandSpawns.size > 0) {
        await Promise.all([...outOfBandSpawns]);
      }
      return { loaded: ctx.loaded, errors: ctx.errors };
    })();

    return { discovered: candidates.map((c) => c.name), done };
  }

  function prioritize(name: string): void {
    // Works for any queued spawn — deferred boot AND pending HMR
    // respawns. Spawn immediately, above the concurrency bound: an
    // interactive request is waiting on this function right now, and
    // the rest of the queue keeps loading in the background regardless.
    if (bootStates.get(name) !== "queued") return;
    const claim = pendingClaims.get(name);
    if (!claim) return;
    const p: Promise<void> = claim()
      .catch(() => {})
      .finally(() => outOfBandSpawns.delete(p));
    outOfBandSpawns.add(p);
  }

  async function reload(
    names: ReadonlySet<string> | "all",
    reason = "fs change",
  ): Promise<ReloadSummary> {
    const start = performance.now();
    // Targeted re-discovery: only stat/load the affected names. The
    // full-scan path is reserved for "all" (initial boot semantics).
    const candidates = names === "all"
      ? await discoverCandidates(opts.functionsDir)
      : await discoverNamed(opts.functionsDir, names);
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
      // Deferred boot may have registered a candidate for this name;
      // drop it too so `registry.has()` goes false for deleted functions.
      opts.registry.delete(n);
      opts.supervisor.forget(n);
      depGraph.forget(n);
      forgetBootState(n);
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

    // MRU-first: when an edit affects more functions than we have spawn
    // lanes (shared-module edits), the functions the developer is
    // actively hitting respawn first. Ties fall back to name order.
    toSpawn.sort((a, b) =>
      (lastDispatch.get(b.name) ?? 0) - (lastDispatch.get(a.name) ?? 0) ||
      a.name.localeCompare(b.name)
    );

    // Enqueue every respawn as a claim. This (a) supersedes any stale
    // deferred-boot claim for the same name, and (b) lets the gateway's
    // `prioritize()` pull a specific respawn forward when a request
    // arrives for it mid-reload.
    const items = toSpawn.map((cand) => {
      bootStates.set(cand.name, "queued");
      return enqueueClaim(cand.name, async () => {
        bootStates.set(cand.name, "loading");
        const wasKnown = handles.has(cand.name);
        const r = await runSerialized(cand.name, () => spawnAndRegister(cand));
        if ("error" in r) {
          errors.push({ name: cand.name, error: r.error });
          settleBootState(cand.name, false, r.error);
          // Reset stats for the failing function so the breaker doesn't keep
          // counting against the dead worker.
          opts.supervisor.reset(cand.name);
          return;
        }
        if (wasKnown) reloaded.push(cand.name);
        else added.push(cand.name);
        settleBootState(cand.name, true);
        opts.supervisor.reset(cand.name);
      });
    });

    await drainClaims(items);
    // Items claimed out-of-band by prioritize() may still be running —
    // join them. Items that were superseded by a newer reload before
    // ever starting are left alone (the newer reload owns them now).
    await Promise.all(
      items.map((it) => it.started()).filter((p) => p !== null),
    );

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
    startDeferred,
    reload,
    stop,
    list: () => [...handles.keys()].sort(),
    bootState: (name) => bootStates.get(name),
    bootStatus,
    prioritize,
    whenReady,
    depGraph,
  };
}
