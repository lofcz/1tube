/**
 * Colocated worker-side entry point (dev) for the Deno backend.
 *
 * Where {@link ./worker-entry.ts} runs ONE function per Worker, this
 * bootstrap hosts EVERY function in a single isolate. The point is
 * dependency sharing: a 100-function project where most functions import
 * the same heavy npm graph (`ai`, `@supabase/supabase-js`, `@google/genai`,
 * `zod`, ù) pays to compile + evaluate that graph exactly once here,
 * instead of once per function across 100 isolates. On a real project that
 * collapses warm-boot from ~per-function-sum/cores down to roughly the
 * one-time cost of the union graph (measured ~6s vs ~18s).
 *
 * Trade-off: functions share globals and a crash takes the whole isolate
 * down. That's why this mode is dev-only ù production keeps isolate-per-
 * function (or workerd) for real isolation.
 *
 * Lifecycle:
 *
 *   host ? init      : { functions: [{name, entryUrl, manifest}], ù }
 *                      Imported SERIALLY so each function's top-level
 *                      `serve()` registration can be attributed to the
 *                      right name (parallel imports would interleave the
 *                      single global registry stub). The first import pays
 *                      the shared-graph cost; the rest are cache hits, so
 *                      serial is nearly as fast as parallel but correct.
 *                      Streams `fn_ready` / `fn_error` per function, then
 *                      `all_done`.
 *
 *   host ? dispatch  : { id, name, ù } ? look up the captured handler by
 *                      name and run it (per-request AsyncLocalStorage so
 *                      concurrent invocations attribute console output).
 *
 *   host ? reload    : { functions: [...] } ? re-import each entry with a
 *                      `?v=` cache-bust so only the edited module (and its
 *                      changed local deps) re-evaluates; unchanged npm
 *                      modules stay warm in the isolate. Updates the
 *                      handler map and streams `fn_ready` / `fn_error`.
 *
 *   host ? remove    : { names: [...] } ? drop handlers for deleted fns.
 */

/// <reference lib="deno.worker" />

import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionManifest } from "../../manifest.ts";
import type { AuthContext } from "../../registry.ts";

interface FnSpec {
  name: string;
  entryUrl: string;
  manifest: FunctionManifest;
}

interface InitMessage {
  type: "init";
  functions: FnSpec[];
  captureConsole?: boolean;
  /** Per-import hard cap (ms) so one function blocking at top-level can't
   *  stall the whole boot. */
  importTimeoutMs?: number;
}

interface DispatchMessage {
  type: "dispatch";
  id: number;
  name: string;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: ReadableStream<Uint8Array> | null;
  auth: AuthContext | null;
  invocationId?: string;
}

interface ReloadMessage {
  type: "reload";
  functions: FnSpec[];
}

interface RemoveMessage {
  type: "remove";
  names: string[];
}

type HostMessage =
  | InitMessage
  | DispatchMessage
  | ReloadMessage
  | RemoveMessage;

type Handler = (
  req: Request,
  auth?: AuthContext,
) => Response | Promise<Response>;

interface RegistryStub {
  register(
    handler: Handler,
    opts: { public: boolean; timeoutMs?: number },
  ): void;
}

interface CapturedHandler {
  handler: Handler;
  isPublic: boolean;
  timeoutMs?: number;
  manifest: FunctionManifest;
}

const handlers = new Map<string, CapturedHandler>();

// Set immediately before each import so the registry stub can attribute a
// `serve()` call (and any boot-time console output) to the right function.
let importing: { name: string; captured: CapturedHandler | null } | null = null;

const invocationContext = new AsyncLocalStorage<
  { invocationId?: string; name: string }
>();

let consoleCaptureOn = false;

// ---------------------------------------------------------------------------
// Console capture (mirrors worker-entry.ts, but tags every line with the
// owning function so the host can attribute output in a shared isolate).
// ---------------------------------------------------------------------------

type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";
const CONSOLE_LEVELS: ConsoleLevel[] = ["debug", "log", "info", "warn", "error"];
const MAX_CONSOLE_MESSAGE = 8 * 1024;

function formatConsoleArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return Deno.inspect(arg, {
      depth: 4,
      colors: false,
      strAbbreviateSize: 4096,
    });
  } catch {
    try {
      return String(arg);
    } catch {
      return "[unprintable]";
    }
  }
}

function currentFunctionName(): string {
  return invocationContext.getStore()?.name ?? importing?.name ?? "<colocated>";
}

function installConsoleCapture(): void {
  if (consoleCaptureOn) return;
  consoleCaptureOn = true;
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        let message = args.map(formatConsoleArg).join(" ");
        if (message.length > MAX_CONSOLE_MESSAGE) {
          message = message.slice(0, MAX_CONSOLE_MESSAGE) + "ù";
        }
        postMessage({
          type: "console",
          name: currentFunctionName(),
          level,
          message,
          tsMs: Date.now(),
          invocationId: invocationContext.getStore()?.invocationId ?? null,
        });
      } catch {
        // postMessage can throw during teardown; dropping a captured line
        // is acceptable, breaking user code is not.
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Registry stub: function top-level `serve()` lands here. We attribute the
// registration to whichever function is currently importing.
// ---------------------------------------------------------------------------

const stub: RegistryStub = {
  register(handler, opts) {
    if (!importing) return; // serve() called outside an import window ù ignore
    if (importing.captured) {
      console.warn(
        `[1tube] "${importing.name}" called serve() twice; using the last handler`,
      );
    }
    importing.captured = {
      handler,
      isPublic: opts.public,
      timeoutMs: opts.timeoutMs,
      manifest: { runtime: "deno" } as unknown as FunctionManifest,
    };
  },
};

(globalThis as { __edgeFunctionRegistry?: RegistryStub })
  .__edgeFunctionRegistry = stub;

// Shared-module RPC is unnecessary in colocated mode: a shared module like
// `_shared/profile-cache.ts` is imported once in THIS isolate, so its side
// effects already run exactly once. Provide a no-op so any leftover stub
// reference doesn't throw.
(globalThis as { __1tube_call_shared?: unknown }).__1tube_call_shared =
  async () => {
    throw new Error(
      "shared-module RPC is not used in colocated dev mode (module runs in-isolate)",
    );
  };

self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  const err = (e as PromiseRejectionEvent).reason;
  postMessage({
    type: "unhandledrejection",
    name: currentFunctionName(),
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    invocationId: invocationContext.getStore()?.invocationId ?? null,
  });
});

// ---------------------------------------------------------------------------
// Import + (re)registration
// ---------------------------------------------------------------------------

function importWithTimeout(url: string, timeoutMs: number): Promise<void> {
  return Promise.race([
    import(url).then(() => {}),
    new Promise<void>((_, reject) =>
      setTimeout(
        () => reject(new Error(`import timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    ),
  ]);
}

/**
 * Import one function entry and capture its handler. `bust` appends a
 * cache-busting query so reloads re-evaluate the edited module instead of
 * reusing the isolate's cached copy.
 */
async function loadFunction(
  fn: FnSpec,
  importTimeoutMs: number,
  bust: boolean,
): Promise<void> {
  const t0 = performance.now();
  importing = { name: fn.name, captured: null };
  const url = bust
    ? `${fn.entryUrl}${fn.entryUrl.includes("?") ? "&" : "?"}v=${Date.now()}-${
      Math.random().toString(36).slice(2, 8)
    }`
    : fn.entryUrl;
  try {
    await importWithTimeout(url, importTimeoutMs);
  } catch (err) {
    importing = null;
    postMessage({
      type: "fn_error",
      name: fn.name,
      ms: performance.now() - t0,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return;
  }
  const captured = importing.captured;
  importing = null;
  if (!captured) {
    postMessage({
      type: "fn_error",
      name: fn.name,
      ms: performance.now() - t0,
      message: `Function "${fn.name}" loaded without calling serve()`,
    });
    return;
  }
  captured.manifest = fn.manifest;
  handlers.set(fn.name, captured);
  postMessage({
    type: "fn_ready",
    name: fn.name,
    ms: performance.now() - t0,
    isPublic: captured.isPublic,
    timeoutMs: captured.timeoutMs,
    manifest: fn.manifest,
  });
}

async function runDispatch(msg: DispatchMessage): Promise<void> {
  const captured = handlers.get(msg.name);
  if (!captured) {
    postMessage({
      type: "response_error",
      id: msg.id,
      message: `Function "${msg.name}" is not loaded`,
    });
    return;
  }
  const headers = new Headers(msg.headers);
  const init: RequestInit = { method: msg.method, headers };
  if (msg.body !== null) {
    init.body = msg.body;
    (init as unknown as { duplex: "half" }).duplex = "half";
  }
  const req = new Request(msg.url, init);
  let resp: Response;
  try {
    const run = () =>
      Promise.resolve(
        captured.isPublic
          ? captured.handler(req)
          : captured.handler(req, msg.auth ?? undefined),
      );
    resp = await invocationContext.run(
      { invocationId: msg.invocationId, name: msg.name },
      run,
    );
  } catch (err) {
    postMessage({
      type: "response_error",
      id: msg.id,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return;
  }
  const respHeaders: Array<[string, string]> = [];
  resp.headers.forEach((v, k) => respHeaders.push([k, v]));
  const body = resp.body;
  postMessage(
    {
      type: "response",
      id: msg.id,
      status: resp.status,
      headers: respHeaders,
      body,
    },
    body ? [body as unknown as Transferable] : [],
  );
}

let importTimeoutMs = 30_000;

self.onmessage = (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "init": {
      if (msg.captureConsole) installConsoleCapture();
      importTimeoutMs = msg.importTimeoutMs ?? 30_000;
      void (async () => {
        // Serial: the first import warms the shared graph, the rest are
        // cache hits. Serial keeps `serve()` attribution unambiguous.
        for (const fn of msg.functions) {
          await loadFunction(fn, importTimeoutMs, false);
        }
        postMessage({ type: "all_done" });
      })();
      return;
    }
    case "dispatch": {
      void runDispatch(msg);
      return;
    }
    case "reload": {
      void (async () => {
        for (const fn of msg.functions) {
          await loadFunction(fn, importTimeoutMs, true);
        }
        postMessage({ type: "reload_done" });
      })();
      return;
    }
    case "remove": {
      for (const name of msg.names) handlers.delete(name);
      return;
    }
  }
};
