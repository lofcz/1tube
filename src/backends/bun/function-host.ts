/**
 * Function host for the Bun backend: one `Bun.ModuleGraph` per function.
 *
 * Each function's entry is imported into its own module graph, which gives
 * it fresh module state (its own copy of every module it imports, its own
 * `require.cache`, its own timers) while Bun shares parsed code and bytecode
 * across graphs. That is the property both of the old Deno modes were
 * approximating from opposite ends:
 *
 *   - Worker-per-function had isolation but compiled the shared npm graph
 *     once per function.
 *   - The colocated dev isolate compiled once but shared module state, and
 *     needed `?v=` cache-busting plus "peel into a fresh isolate" to reload.
 *
 * With graphs, HMR is just: build a new graph, swap the route, let the old
 * one drain its in-flight requests, `dispose()` it. Dispatch is a direct
 * in-process call — no postMessage, no body transfer, no structured clone.
 *
 * Globals: every graph gets its own `Deno` namespace (env scoped by the
 * function's manifest when enforcement is on), `EdgeRuntime`, registry
 * stub, event target, and optionally a capturing `console` — see
 * `compat/globals.ts` for how `globalThis.*` lookups are layered.
 *
 * The boot state machine (eager/deferred boot, prioritize, whenReady, MRU
 * ordering, per-name spawn serialization) is unchanged from the Worker
 * host so the gateway's warming/staleness logic works as before.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import type { DependencyManager } from "../../compat/deps.ts";
import {
  createDenoNamespace,
  createEdgeRuntime,
  DenoErrors,
} from "../../compat/deno-shim.ts";
import { compatState } from "../../compat/plugin.ts";
import {
  createDenoEnv,
  createGlobalProxy,
  createScopedEnvObject,
  createScopedProcess,
} from "../../compat/globals.ts";
import type { ImportMap } from "../../compat/import-map.ts";
import {
  defaultManifest,
  type FunctionManifest,
  loadManifest,
  mergeServeRateLimit,
  type RateLimitBy,
} from "../../manifest.ts";
import type {
  AuthContext,
  FunctionRegistry,
  WorkerFunctionHandle,
} from "../../registry.ts";
import type { FunctionSupervisor } from "../../supervisor.ts";
import { createDepGraph, type DepGraph } from "./dep-graph.ts";
import type { SharedRuntime } from "./shared-runtime.ts";

/** A console line (or runtime error) emitted by function code. */
export interface FunctionConsoleEvent {
  functionName: string;
  /** Null for boot/import-time and fire-and-forget background output. */
  invocationId: string | null;
  level: "debug" | "log" | "info" | "warn" | "error";
  message: string;
  tsMs: number;
}

export interface FunctionHostOptions {
  functionsDir: string;
  registry: FunctionRegistry;
  supervisor: FunctionSupervisor;
  /**
   * Max functions importing concurrently at boot/reload. Imports run on the
   * main thread, so this mostly overlaps file + network I/O. Defaults to the
   * CPU count clamped to [4, 16].
   */
  concurrency?: number;
  /**
   * Grace window (ms) a superseded graph keeps serving its in-flight
   * requests after an HMR swap before it is disposed. Defaults to 10000;
   * 0 disposes immediately.
   */
  reloadDrainMs?: number;
  /** The project's deno.json import map (dep-graph resolution). */
  importMap?: ImportMap;
  /** Installs `npm:`/`jsr:` requests before a function is imported. */
  deps?: DependencyManager;
  /** Gateway-owned shared modules (already wired into the compat plugin). */
  sharedRuntime?: SharedRuntime;
  /**
   * Filter each function's env reads (`Deno.env`, `process.env`) by its
   * manifest `permissions.env` allowlist; env writes throw.
   */
  enforceEnv?: boolean;
  /** Capture console output from function code into {@link onConsole}. */
  captureConsole?: boolean;
  /**
   * Keep a superseded graph alive while response bodies it returned are
   * still streaming (SSE, chunked AI output), and close them cleanly if it
   * is disposed anyway. Costs a stream wrapper per response, so the gateway
   * enables it only with HMR — the only time graphs get replaced.
   */
  trackStreams?: boolean;
  onConsole?: (event: FunctionConsoleEvent) => void;
  /** Last-dispatch timestamps from a previous run (MRU warm-up order). */
  initialRecency?: ReadonlyMap<string, number>;
  /** Fired after every reload with its summary. */
  onReloaded?: (summary: ReloadSummary) => void;
}

export interface ReloadSummary {
  reason: string;
  reloaded: string[];
  added: string[];
  removed: string[];
  errors: Array<{ name: string; error: string }>;
  durationMs: number;
}

export interface SpawnProgress {
  /** 1-based index of this function in the boot sequence. */
  index: number;
  total: number;
  name: string;
  ok: boolean;
  durationMs: number;
  /** Time spent walking the function's local import graph. */
  graphMs: number;
  /** Time spent installing missing npm:/jsr: dependencies. */
  installMs: number;
  /** Time spent importing the entry into its module graph. */
  importMs: number;
  error?: string;
}

export interface StartOptions {
  /** Fired as functions are discovered, before any import begins. */
  onScanProgress?: (p: { found: number; phase: "scan" | "graph" | "install" }) => void;
  onSpawnStart?: (p: { index: number; total: number; name: string }) => void;
  onSpawnFinish?: (p: SpawnProgress) => void;
  /** Fired after the boot-wide graph + dependency install finishes. */
  onBatchGraph?: (p: { total: number; durationMs: number; installMs: number }) => void;
}

/**
 *   queued ──▶ loading ──▶ ready
 *                  └──────▶ failed
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
  discovered: string[];
  /** Resolves once every queued function has booted (never rejects). */
  done: Promise<{ loaded: string[]; errors: Array<{ name: string; error: string }> }>;
}

export interface FunctionHost {
  start(opts?: StartOptions): Promise<{
    loaded: string[];
    errors: Array<{ name: string; error: string }>;
  }>;
  /**
   * Discover functions, register them as known-but-queued, and boot them
   * in the background. Use {@link prioritize} to pull one forward.
   */
  startDeferred(opts?: StartOptions): Promise<DeferredStart>;
  reload(names: ReadonlySet<string> | "all", reason?: string): Promise<ReloadSummary>;
  stop(): Promise<void>;
  /** Names with a live graph. */
  list(): string[];
  bootState(name: string): BootState | undefined;
  bootStatus(): BootStatus;
  prioritize(name: string): void;
  whenReady(
    name: string,
    timeoutMs?: number,
  ): Promise<"ready" | "failed" | "timeout" | "unknown">;
  readonly depGraph: DepGraph;
}

type Handler = (req: Request, auth?: AuthContext) => Response | Promise<Response>;

type RegisterOpts = { public?: boolean; timeoutMs?: number; rpm?: number; rateLimitBy?: RateLimitBy };

// ---------------------------------------------------------------------------
// Shared-code hooks
//
// With shared dependencies on, a project's `_shared/handler.ts` (the thing
// that calls the registry on behalf of each function) is evaluated ONCE in
// the shared graph, so the registry it sees can't be per function. Instead
// function imports are serialized and the shared registry forwards to the
// function being imported right now — exactly how the old colocated mode
// attributed `serve()` calls. Each import is cheap here (only the
// function's own files evaluate), so serializing costs little.
// ---------------------------------------------------------------------------

let importingRegister: ((handler: Handler, opts: RegisterOpts) => void) | null = null;
let importChain: Promise<unknown> = Promise.resolve();
/** Latest live instance's waitUntil tracker, by function name. */
const backgroundByFunction = new Map<string, (p: Promise<unknown>) => void>();

function serializeImport<T>(fn: () => Promise<T>): Promise<T> {
  const run = importChain.then(fn, fn);
  importChain = run.then(() => {}, () => {});
  return run;
}

/**
 * Registry / `Deno.serve` / `EdgeRuntime.waitUntil` for code evaluated in
 * the shared-dependency graph, routed to the right function: registrations
 * to the one being imported, background work to the one whose request is
 * running.
 */
export const sharedCodeHooks = {
  register(handler: Handler, opts: RegisterOpts = {}): void {
    if (!importingRegister) {
      throw new Error("[1tube] serve() was called from shared code outside a function import");
    }
    importingRegister(handler, opts);
  },
  serve(handler: Handler): void {
    // Supabase verifies JWTs at its gateway by default (verify_jwt = true).
    sharedCodeHooks.register(handler, { public: false });
  },
  waitUntil(p: Promise<unknown>): void {
    const fn = invocationContext.getStore()?.functionName;
    const track = fn ? backgroundByFunction.get(fn) : undefined;
    if (track) track(p);
    else p.catch(() => {});
  },
};

interface Captured {
  handler: Handler;
  isPublic: boolean;
  timeoutMs?: number;
  rpm?: number;
  rateLimitBy?: RateLimitBy;
}

interface Instance extends WorkerFunctionHandle {
  readonly graph: Bun.ModuleGraph;
}

interface Candidate {
  name: string;
  entryPath: string;
  manifest: FunctionManifest;
}

/**
 * Per-dispatch context. Bun propagates AsyncLocalStorage through graph
 * code (timers and promise chains included), so console output emitted
 * while handling a request attributes to it.
 */
const invocationContext = new AsyncLocalStorage<{ functionName: string; invocationId?: string }>();

/**
 * The function + invocation the current async context belongs to. Lets
 * code evaluated outside a function's graph (shared dependencies) still
 * attribute console output and errors to the request that triggered it.
 */
export function currentInvocation(): { functionName: string; invocationId?: string } | undefined {
  return invocationContext.getStore();
}

/**
 * A `console` for code shared across functions (the shared-dependency
 * graph): prints as usual and reports each line to `onConsole`, attributed
 * to whichever function's request is running when it is emitted.
 */
export function createAttributedConsole(
  onConsole: (event: FunctionConsoleEvent) => void,
): Console {
  const c: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(console)) {
    const v = (console as unknown as Record<string, unknown>)[key];
    c[key] = typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(console) : v;
  }
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    c[level] = (...args: unknown[]) => {
      original(...args);
      const inv = invocationContext.getStore();
      if (!inv) return; // boot-time output of shared code: terminal only
      try {
        const message = args.map(formatConsoleArg).join(" ");
        onConsole({
          functionName: inv.functionName,
          invocationId: inv.invocationId ?? null,
          level,
          message: message.length > MAX_CONSOLE_MESSAGE
            ? message.slice(0, MAX_CONSOLE_MESSAGE) + "…"
            : message,
          tsMs: Date.now(),
        });
      } catch {
        // Logging must never break user code.
      }
    };
  }
  return c as unknown as Console;
}

const CONSOLE_LEVELS = ["debug", "log", "info", "warn", "error"] as const;
const MAX_CONSOLE_MESSAGE = 8 * 1024;
const DISCOVERY_CONCURRENCY = 64;

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return Bun.inspect(arg, { depth: 4, colors: false });
  } catch {
    try {
      return String(arg);
    } catch {
      return "[unprintable]";
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deno's `ServeHandlerInfo` for a `Deno.serve` handler. The gateway owns
 * the socket, so the peer comes from the forwarding headers when present.
 */
function serveHandlerInfo(req: Request) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    remoteAddr: { transport: "tcp" as const, hostname: forwarded || "127.0.0.1", port: 0 },
    completed: Promise.resolve(),
  };
}

async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        await fn(items[i]);
      }
    }),
  );
}

function isFunctionDir(name: string): boolean {
  return !name.startsWith("_") && !name.endsWith("_shared") && !name.startsWith(".");
}

async function candidateFor(root: string, name: string): Promise<Candidate | null> {
  const entryPath = join(root, name, "index.ts");
  try {
    if (!(await stat(entryPath)).isFile()) return null;
  } catch {
    return null;
  }
  const manifest = await loadManifest(root, name).catch(() => defaultManifest());
  return { name, entryPath, manifest };
}

async function discoverCandidates(
  root: string,
  onFound?: (count: number) => void,
): Promise<Candidate[]> {
  const names: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && isFunctionDir(entry.name)) names.push(entry.name);
  }
  const out: Candidate[] = [];
  let found = 0;
  await forEachBounded(names, DISCOVERY_CONCURRENCY, async (name) => {
    const c = await candidateFor(root, name);
    if (!c) return;
    out.push(c);
    onFound?.(++found);
  });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function discoverNamed(root: string, names: ReadonlySet<string>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  await Promise.all([...names].filter(isFunctionDir).map(async (name) => {
    const c = await candidateFor(root, name);
    if (c) out.push(c);
  }));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function createFunctionHost(opts: FunctionHostOptions): FunctionHost {
  const handles = new Map<string, Instance>();
  const depGraph = createDepGraph({ importMap: opts.importMap });
  const concurrency = Math.max(
    1,
    opts.concurrency ?? Math.max(4, Math.min(availableParallelism(), 16)),
  );
  const reloadDrainMs = Math.max(0, opts.reloadDrainMs ?? 10_000);

  let rootPromise: Promise<string> | null = null;
  function functionsRoot(): Promise<string> {
    rootPromise ??= realpath(opts.functionsDir).catch((err) => {
      rootPromise = null;
      throw err;
    });
    return rootPromise;
  }

  // -------------------------------------------------------------------
  // Graph instances
  // -------------------------------------------------------------------

  /** Superseded instances still draining in-flight requests. */
  const draining = new Set<Instance>();

  function emitConsole(
    name: string,
    level: FunctionConsoleEvent["level"],
    message: string,
  ): void {
    if (!opts.onConsole) return;
    try {
      opts.onConsole({
        functionName: name,
        invocationId: invocationContext.getStore()?.invocationId ?? null,
        level,
        message: message.length > MAX_CONSOLE_MESSAGE
          ? message.slice(0, MAX_CONSOLE_MESSAGE) + "…"
          : message,
        tsMs: Date.now(),
      });
    } catch {
      // Logging must never break user code.
    }
  }

  function capturingConsole(name: string): Console {
    const c: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(console)) {
      const v = (console as unknown as Record<string, unknown>)[key];
      c[key] = typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(console) : v;
    }
    for (const level of CONSOLE_LEVELS) {
      const original = console[level].bind(console);
      c[level] = (...args: unknown[]) => {
        // Terminal first: the developer-facing stream must never depend
        // on the capture path.
        original(...args);
        emitConsole(name, level, args.map(formatConsoleArg).join(" "));
      };
    }
    return c as unknown as Console;
  }

  async function createInstance(cand: Candidate): Promise<Instance> {
    const name = cand.name;
    let captured: Captured | null = null;
    const register = (handler: Handler, o: RegisterOpts = {}) => {
      if (captured) {
        console.warn(`[1tube] "${name}" called serve() twice; using the last handler`);
      }
      captured = {
        handler,
        isPublic: Boolean(o.public),
        timeoutMs: o.timeoutMs,
        rpm: o.rpm,
        rateLimitBy: o.rateLimitBy,
      };
    };

    const background = new Set<Promise<unknown>>();
    const trackBackground = (p: Promise<unknown>) => {
      background.add(p);
      p.catch(() => {}).finally(() => {
        background.delete(p);
        notifyIdle();
      });
    };

    const reportUncaught = (err: unknown, kind: string) => {
      const label = kind === "unhandledRejection" ? "Unhandled rejection" : "Uncaught error";
      const stack = err instanceof Error && err.stack ? `\n${err.stack}` : "";
      // Count it against the function so the breaker can trip on
      // fire-and-forget code that consistently leaks.
      opts.supervisor.record(name, true);
      console.error(`[1tube] ${label} in "${name}": ${errorMessage(err)}`);
      emitConsole(name, "error", `${label}: ${errorMessage(err)}${stack}`);
    };

    const allow = opts.enforceEnv ? new Set(cand.manifest.permissions.env) : null;
    const env = createDenoEnv(name, allow, DenoErrors.PermissionDenied);
    const events = new EventTarget();
    // EventTarget reports a throwing listener as a process-level uncaught
    // exception instead of throwing from dispatchEvent(); wrap listeners so
    // it is attributed to the function instead.
    type Listener = EventListenerOrEventListenerObject;
    const guarded = new WeakMap<Listener, EventListener>();
    const guard = (l: Listener | null): Listener | null => {
      if (!l) return l;
      let g = guarded.get(l);
      if (!g) {
        g = function (this: unknown, ev: Event) {
          try {
            if (typeof l === "function") l.call(this, ev);
            else l.handleEvent(ev);
          } catch (err) {
            reportUncaught(err, "uncaughtException");
          }
        };
        guarded.set(l, g);
      }
      return g;
    };
    const globals: Record<string, unknown> = {
      Deno: createDenoNamespace({
        functionName: name,
        env,
        // A stock Supabase function calls `Deno.serve(handler)`. Supabase
        // verifies JWTs at its gateway by default (`verify_jwt = true`), so
        // the handler is registered as authenticated. Its second argument
        // is Deno's ServeHandlerInfo, not the gateway's auth context.
        onServe: (handler) =>
          register((req) => handler(req, serveHandlerInfo(req)), { public: false }),
        onWaitUntil: trackBackground,
      }),
      EdgeRuntime: createEdgeRuntime({ onWaitUntil: trackBackground }),
      __edgeFunctionRegistry: { register },
      addEventListener: (type: string, l: Listener | null, o?: AddEventListenerOptions | boolean) =>
        events.addEventListener(type, guard(l), o),
      removeEventListener: (type: string, l: Listener | null, o?: EventListenerOptions | boolean) =>
        events.removeEventListener(type, l && (guarded.get(l) ?? l), o),
      dispatchEvent: events.dispatchEvent.bind(events),
    };
    if (allow) globals.process = createScopedProcess(createScopedEnvObject(allow));
    if (opts.captureConsole) globals.console = capturingConsole(name);
    const scope = createGlobalProxy(globals);
    globals.globalThis = scope;
    globals.self = scope;

    const graph = new Bun.ModuleGraph({
      globals,
      onError: reportUncaught,
    });
    // Pin the shared-dependency generation this graph's stubs bind to, so
    // an HMR bump can't dispose it while this function is still live.
    const sharedDeps = compatState().sharedDeps;
    const depGeneration = sharedDeps?.retain();
    const releaseDeps = () => {
      if (sharedDeps && depGeneration !== undefined) sharedDeps.release(depGeneration);
    };

    const importEntry = () => graph.run(() => graph.import(cand.entryPath));
    try {
      if (sharedDeps) {
        await serializeImport(async () => {
          importingRegister = register;
          try {
            await importEntry();
          } finally {
            importingRegister = null;
          }
        });
      } else {
        await importEntry();
      }
    } catch (err) {
      graph.dispose();
      releaseDeps();
      throw err;
    }
    if (!captured) {
      graph.dispose();
      releaseDeps();
      throw new Error(`Function "${name}" loaded without calling serve()`);
    }
    const fn: Captured = captured;

    // Fold a `serve({ rateLimit })` override into the reported manifest so
    // the gateway's limiter honours code-declared limits.
    const manifest = mergeServeRateLimit(cand.manifest, {
      rpm: fn.rpm,
      rateLimitBy: fn.rateLimitBy,
    });

    let inflight = 0;
    let disposed = false;
    const idleWaiters = new Set<() => void>();
    /** Controllers of response bodies still streaming (trackStreams). */
    const openStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
    const isIdle = () => inflight === 0 && background.size === 0 && openStreams.size === 0;
    function notifyIdle(): void {
      if (!isIdle()) return;
      for (const w of [...idleWaiters]) w();
    }

    /** Re-wrap `resp` so its body counts as in-flight work until it ends. */
    function trackStream(resp: Response): Response {
      const source = resp.body;
      if (!source) return resp;
      const reader = source.getReader();
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      const done = () => {
        if (openStreams.delete(ctrl)) notifyIdle();
      };
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          openStreams.add(c);
        },
        async pull(c) {
          try {
            const r = await reader.read();
            if (r.done) {
              c.close();
              done();
            } else c.enqueue(r.value);
          } catch (err) {
            c.error(err);
            done();
          }
        },
        cancel(reason) {
          done();
          return reader.cancel(reason);
        },
      }, { highWaterMark: 0 });
      return new Response(body, {
        status: resp.status,
        statusText: resp.statusText,
        headers: resp.headers,
      });
    }

    backgroundByFunction.set(name, trackBackground);

    function dispose(): void {
      if (disposed) return;
      disposed = true;
      if (backgroundByFunction.get(name) === trackBackground) backgroundByFunction.delete(name);
      // Supabase's edge runtime reports why the isolate is going away.
      events.dispatchEvent(new CustomEvent("beforeunload", { detail: { reason: "termination" } }));
      try {
        graph.dispose();
      } catch { /* already disposed */ }
      releaseDeps();
      // The graph's timers and I/O are gone: end bodies it was still
      // producing instead of leaving clients hanging forever.
      for (const c of openStreams) {
        try {
          c.error(new Error(`Function "${name}" was unloaded mid-stream`));
        } catch { /* already closed */ }
      }
      openStreams.clear();
      for (const w of [...idleWaiters]) w();
      idleWaiters.clear();
    }

    return {
      name,
      manifest,
      isPublic: fn.isPublic,
      timeoutMs: fn.timeoutMs,
      graph,
      async dispatch(req, auth, signal, invocationId) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (disposed) throw new Error(`Function "${name}" was unloaded`);
        inflight++;
        try {
          const call = () =>
            invocationContext.run(
              { functionName: name, invocationId },
              () => fn.isPublic ? fn.handler(req) : fn.handler(req, auth ?? undefined),
            );
          const result = Promise.resolve().then(() => graph.run(call));
          return await new Promise<Response>((resolve, reject) => {
            const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
            signal.addEventListener("abort", onAbort, { once: true });
            result.then(
              (resp) => resolve(opts.trackStreams ? trackStream(resp) : resp),
              reject,
            ).finally(() =>
              signal.removeEventListener("abort", onAbort)
            );
          });
        } finally {
          inflight--;
          notifyIdle();
        }
      },
      terminate(termOpts) {
        const drainMs = termOpts?.drainMs ?? 0;
        if (disposed) return Promise.resolve();
        if (drainMs <= 0) {
          dispose();
          return Promise.resolve();
        }
        // Keep serving what is already in flight (and any waitUntil work),
        // then dispose once idle — plus a short linger so a just-returned
        // streaming body can finish — or when the grace window expires.
        const lingerMs = Math.min(500, drainMs);
        return new Promise<void>((resolve) => {
          let linger: ReturnType<typeof setTimeout> | undefined;
          const finish = () => {
            clearTimeout(cap);
            if (linger) clearTimeout(linger);
            idleWaiters.delete(onIdle);
            dispose();
            resolve();
          };
          const onIdle = () => {
            if (disposed) return finish();
            linger ??= setTimeout(finish, lingerMs);
          };
          const cap = setTimeout(finish, drainMs);
          idleWaiters.add(onIdle);
          if (isIdle()) onIdle();
        });
      },
    };
  }

  function retire(inst: Instance): void {
    if (reloadDrainMs <= 0) {
      void inst.terminate();
      return;
    }
    draining.add(inst);
    void inst.terminate({ drainMs: reloadDrainMs }).finally(() => draining.delete(inst));
  }

  // -------------------------------------------------------------------
  // Boot state machine (shared by eager + deferred boot and reload)
  // -------------------------------------------------------------------

  const bootStates = new Map<string, BootState>();
  const bootErrors = new Map<string, string>();
  const bootWaiters = new Map<string, Array<(s: "ready" | "failed") => void>>();
  /**
   * Claimable spawn queue shared by deferred boot and reload. Claiming
   * (from a lane, prioritize(), or a superseding reload) starts the spawn
   * exactly once; lanes check claim identity so a newer claim wins.
   */
  const pendingClaims = new Map<string, () => Promise<void>>();
  const outOfBandSpawns = new Set<Promise<void>>();
  const lastDispatch = new Map<string, number>(opts.initialRecency ?? []);
  /** Per-name spawn serialization: the last writer wins, never a race. */
  const spawnChains = new Map<string, Promise<unknown>>();

  interface ClaimItem {
    name: string;
    claim: () => Promise<void>;
    started: () => Promise<void> | null;
  }

  function enqueueClaim(name: string, process: () => Promise<void>): ClaimItem {
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

  async function drainClaims(items: ClaimItem[]): Promise<void> {
    await forEachBounded(items, concurrency, async (it) => {
      if (pendingClaims.get(it.name) !== it.claim) return;
      await it.claim();
    });
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
      let timer: ReturnType<typeof setTimeout> | null = null;
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
        }, timeoutMs);
      }
    });
  }

  function bootStatus(): BootStatus {
    const status: BootStatus = { total: bootStates.size, ready: [], loading: [], queued: [], failed: [] };
    for (const [name, s] of bootStates) {
      if (s === "failed") status.failed.push({ name, error: bootErrors.get(name) ?? "unknown error" });
      else status[s].push(name);
    }
    status.ready.sort();
    status.loading.sort();
    status.queued.sort();
    status.failed.sort((a, b) => a.name.localeCompare(b.name));
    return status;
  }

  function byRecency(a: Candidate, b: Candidate): number {
    return (lastDispatch.get(b.name) ?? 0) - (lastDispatch.get(a.name) ?? 0) ||
      a.name.localeCompare(b.name);
  }

  // -------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------

  interface Timings {
    graphMs: number;
    installMs: number;
    importMs: number;
  }

  /**
   * Walk every candidate's graph in one pass (shared parse cache) and
   * install the union of their npm:/jsr: requests with ONE `bun install`.
   */
  async function prepareBatch(
    cands: readonly Candidate[],
    startOpts: StartOptions,
  ): Promise<void> {
    if (cands.length === 0) return;
    const t0 = performance.now();
    startOpts.onScanProgress?.({ found: cands.length, phase: "graph" });
    await depGraph.refreshMany(cands.map((c) => ({ name: c.name, entry: c.entryPath })));
    let installMs = 0;
    if (opts.deps) {
      const reqs = cands.flatMap((c) => depGraph.packagesFor(c.name));
      if (reqs.length > 0) {
        startOpts.onScanProgress?.({ found: cands.length, phase: "install" });
        const i0 = performance.now();
        // Functions share one root, so any entry anchors the host lookup.
        await opts.deps.ensure(reqs, cands[0].entryPath).catch((err) => {
          // Per-function imports surface the precise failure; boot goes on.
          console.error(errorMessage(err));
        });
        installMs = performance.now() - i0;
      }
    }
    startOpts.onBatchGraph?.({
      total: cands.length,
      durationMs: performance.now() - t0,
      installMs,
    });
  }

  async function spawnAndRegister(
    cand: Candidate,
    o: { prepared?: boolean } = {},
  ): Promise<{ handle: Instance; timings: Timings } | { error: string; timings: Timings }> {
    const timings: Timings = { graphMs: 0, installMs: 0, importMs: 0 };
    try {
      if (!o.prepared) {
        const g0 = performance.now();
        await depGraph.refresh(cand.name, cand.entryPath);
        timings.graphMs = performance.now() - g0;
        const reqs = depGraph.packagesFor(cand.name);
        if (opts.deps && reqs.length > 0) {
          const i0 = performance.now();
          await opts.deps.ensure(reqs, cand.entryPath);
          timings.installMs = performance.now() - i0;
        }
      }
      const i0 = performance.now();
      const handle = await createInstance(cand);
      timings.importMs = performance.now() - i0;

      const old = handles.get(cand.name);
      handles.set(cand.name, handle);
      opts.registry.setWorkerHandle(cand.name, {
        name: handle.name,
        manifest: handle.manifest,
        isPublic: handle.isPublic,
        timeoutMs: handle.timeoutMs,
        dispatch: (req, auth, signal, invocationId) => {
          lastDispatch.set(cand.name, Date.now());
          return handle.dispatch(req, auth, signal, invocationId);
        },
        terminate: (t) => handle.terminate(t),
      });
      opts.supervisor.setManifest(cand.name, handle.manifest);
      // Deferred boot pre-registers a candidate; keep its manifest fresh so
      // `manifestFor()` never serves a stale 1tube.json after a reload.
      if (opts.registry.candidate(cand.name)) {
        opts.registry.registerCandidate({
          name: cand.name,
          moduleUrl: cand.entryPath,
          manifest: handle.manifest,
        });
      }
      // New requests already route to the fresh graph; let the old one
      // finish what it has in flight in the background.
      if (old) retire(old);
      return { handle, timings };
    } catch (err) {
      return { error: errorMessage(err), timings };
    }
  }

  function finishProgress(
    startOpts: StartOptions,
    p: { index: number; total: number; name: string; t0: number },
    r: Awaited<ReturnType<typeof spawnAndRegister>>,
  ): void {
    startOpts.onSpawnFinish?.({
      index: p.index,
      total: p.total,
      name: p.name,
      ok: !("error" in r),
      durationMs: performance.now() - p.t0,
      ...r.timings,
      ...("error" in r ? { error: r.error } : {}),
    });
  }

  async function start(startOpts: StartOptions = {}) {
    const candidates = await discoverCandidates(
      await functionsRoot(),
      (found) => startOpts.onScanProgress?.({ found, phase: "scan" }),
    );
    await prepareBatch(candidates, startOpts);
    const loaded: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];
    const total = candidates.length;
    let nextIndex = 1;
    for (const c of candidates) bootStates.set(c.name, "queued");
    await forEachBounded(candidates, concurrency, async (cand) => {
      const index = nextIndex++;
      startOpts.onSpawnStart?.({ index, total, name: cand.name });
      bootStates.set(cand.name, "loading");
      const t0 = performance.now();
      const r = await runSerialized(cand.name, () => spawnAndRegister(cand, { prepared: true }));
      if ("error" in r) {
        errors.push({ name: cand.name, error: r.error });
        settleBootState(cand.name, false, r.error);
      } else {
        loaded.push(cand.name);
        settleBootState(cand.name, true);
      }
      finishProgress(startOpts, { index, total, name: cand.name, t0 }, r);
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
    /** Boot-wide graph + install; every spawn waits on it. */
    prepared: Promise<void>;
  }
  let deferredCtx: DeferredCtx | null = null;

  async function processDeferred(cand: Candidate): Promise<void> {
    const ctx = deferredCtx;
    if (!ctx) return;
    bootStates.set(cand.name, "loading");
    const index = ++ctx.nextIndex;
    ctx.startOpts.onSpawnStart?.({ index, total: ctx.total, name: cand.name });
    const t0 = performance.now();
    await ctx.prepared;
    const r = await runSerialized(cand.name, () => spawnAndRegister(cand, { prepared: true }));
    if ("error" in r) {
      ctx.errors.push({ name: cand.name, error: r.error });
      settleBootState(cand.name, false, r.error);
    } else {
      ctx.loaded.push(cand.name);
      settleBootState(cand.name, true);
    }
    finishProgress(ctx.startOpts, { index, total: ctx.total, name: cand.name, t0 }, r);
  }

  async function startDeferred(startOpts: StartOptions = {}): Promise<DeferredStart> {
    const candidates = await discoverCandidates(
      await functionsRoot(),
      (found) => startOpts.onScanProgress?.({ found, phase: "scan" }),
    );
    // MRU-first: functions the developer was hitting before the restart
    // warm up before the ones nobody calls.
    candidates.sort(byRecency);
    const ctx: DeferredCtx = {
      total: candidates.length,
      startOpts,
      loaded: [],
      errors: [],
      nextIndex: 0,
      prepared: prepareBatch(candidates, startOpts).catch(() => {}),
    };
    deferredCtx = ctx;
    const items: ClaimItem[] = [];
    for (const c of candidates) {
      bootStates.set(c.name, "queued");
      // Known to the gateway (fast-fail, rate limiter) before it boots.
      opts.registry.registerCandidate({
        name: c.name,
        moduleUrl: c.entryPath,
        manifest: c.manifest,
      });
      items.push(enqueueClaim(c.name, () => processDeferred(c)));
    }
    const done = (async () => {
      await drainClaims(items);
      while (outOfBandSpawns.size > 0) await Promise.all([...outOfBandSpawns]);
      return { loaded: ctx.loaded, errors: ctx.errors };
    })();
    return { discovered: candidates.map((c) => c.name), done };
  }

  function prioritize(name: string): void {
    // Any queued spawn (deferred boot or a pending HMR respawn) starts now,
    // above the concurrency bound: a request is waiting on it.
    if (bootStates.get(name) !== "queued") return;
    const claim = pendingClaims.get(name);
    if (!claim) return;
    const p: Promise<void> = claim()
      .catch(() => {})
      .finally(() => outOfBandSpawns.delete(p));
    outOfBandSpawns.add(p);
  }

  // -------------------------------------------------------------------
  // Reload
  // -------------------------------------------------------------------

  async function reload(
    names: ReadonlySet<string> | "all",
    reason = "fs change",
  ): Promise<ReloadSummary> {
    const started = performance.now();
    const root = await functionsRoot();
    const candidates = names === "all"
      ? await discoverCandidates(root)
      : await discoverNamed(root, names);
    const candByName = new Map(candidates.map((c) => [c.name, c]));
    const targets = names === "all" ? new Set(candByName.keys()) : new Set(names);

    const removed: string[] = [];
    const known = names === "all" ? [...handles.keys()] : [...targets];
    for (const n of known) {
      if (!candByName.has(n) && handles.has(n)) removed.push(n);
    }
    for (const n of removed) {
      const h = handles.get(n);
      if (h) retire(h);
      handles.delete(n);
      opts.registry.clearWorkerHandle(n);
      opts.registry.delete(n);
      opts.supervisor.forget(n);
      depGraph.forget(n);
      forgetBootState(n);
    }

    const toSpawn = [...targets].map((n) => candByName.get(n)).filter(
      (c): c is Candidate => c !== undefined,
    ).sort(byRecency);

    const reloaded: string[] = [];
    const added: string[] = [];
    const errors: Array<{ name: string; error: string }> = [];

    const items = toSpawn.map((cand) => {
      bootStates.set(cand.name, "queued");
      return enqueueClaim(cand.name, async () => {
        bootStates.set(cand.name, "loading");
        const wasKnown = handles.has(cand.name);
        const r = await runSerialized(cand.name, () => spawnAndRegister(cand));
        // Fresh code (or a fresh failure) — the breaker starts over.
        opts.supervisor.reset(cand.name);
        if ("error" in r) {
          errors.push({ name: cand.name, error: r.error });
          settleBootState(cand.name, false, r.error);
          return;
        }
        (wasKnown ? reloaded : added).push(cand.name);
        settleBootState(cand.name, true);
      });
    });

    await drainClaims(items);
    // Join spawns prioritize() started out-of-band; ones superseded by a
    // newer reload before starting belong to that reload now.
    await Promise.all(items.map((it) => it.started()).filter((p) => p !== null));

    const summary: ReloadSummary = {
      reason,
      reloaded: reloaded.sort(),
      added: added.sort(),
      removed: removed.sort(),
      errors,
      durationMs: performance.now() - started,
    };
    opts.onReloaded?.(summary);
    return summary;
  }

  async function stop(): Promise<void> {
    const all = [...handles.values(), ...draining];
    handles.clear();
    draining.clear();
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
