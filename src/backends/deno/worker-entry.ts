/**
 * Worker-side entry point used by the Deno backend.
 *
 * One Worker per function. The Worker's lifecycle:
 *
 *   host → init     :  { entryUrl, manifest, name }
 *                      Worker installs the registry stub, dynamically
 *                      imports the function entry. The entry's top-level
 *                      `serve()` call lands in our stub, which posts back
 *                      `{ type: "ready", isPublic, timeoutMs, manifest }`.
 *
 *   host → dispatch :  { id, url, method, headers, body, auth }
 *                      Body comes through as a transferred ReadableStream
 *                      or null. We rebuild a Request and call the captured
 *                      handler. The Response (status + headers + body) is
 *                      posted back, body transferred.
 *
 *   host ← error    :  handler threw, or unhandledrejection inside the
 *                      function code. The host forwards to the supervisor.
 *
 * HMR: the host calls `worker.terminate()`. Termination drops Deno's
 * module cache for everything in the worker's graph, so the next
 * spawned Worker imports the entry from a clean slate. No filesystem
 * snapshots, no `?v=` cache-bust hacks.
 */

/// <reference lib="deno.worker" />

import { AsyncLocalStorage } from "node:async_hooks";
import type { FunctionManifest } from "../../manifest.ts";
import type { AuthContext } from "../../registry.ts";

interface InitMessage {
  type: "init";
  name: string;
  entryUrl: string;
  manifest: FunctionManifest;
  /** Wrap console.* and stream lines back to the host. */
  captureConsole?: boolean;
}

interface DispatchMessage {
  type: "dispatch";
  id: number;
  url: string;
  method: string;
  headers: Array<[string, string]>;
  body: ReadableStream<Uint8Array> | null;
  auth: AuthContext | null;
  /** Gateway-assigned invocation id for console attribution. */
  invocationId?: string;
}

interface SharedCallResultMessage {
  type: "shared_call_result";
  id: number;
  ok: boolean;
  value?: unknown;
  message?: string;
  stack?: string;
}

type HostMessage = InitMessage | DispatchMessage | SharedCallResultMessage;

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
}

let captured: CapturedHandler | null = null;
let functionName = "<unknown>";
let manifest: FunctionManifest | null = null;
let initDone = false;

// ---------------------------------------------------------------------------
// Console capture
//
// Each dispatch runs inside `invocationContext.run({ invocationId }, …)`
// so concurrent requests in the same Worker attribute their console
// output correctly (AsyncLocalStorage follows the await chain). Lines
// emitted outside any dispatch — module top-level code, timers started
// at import time — carry no invocation id and are stored as boot/
// background output by the host.
// ---------------------------------------------------------------------------

const invocationContext = new AsyncLocalStorage<{ invocationId?: string }>();

type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error";
const CONSOLE_LEVELS: ConsoleLevel[] = [
  "debug",
  "log",
  "info",
  "warn",
  "error",
];
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

function installConsoleCapture(): void {
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      // Original first: the developer-facing terminal stream must never
      // depend on the capture path working.
      original(...args);
      try {
        let message = args.map(formatConsoleArg).join(" ");
        if (message.length > MAX_CONSOLE_MESSAGE) {
          message = message.slice(0, MAX_CONSOLE_MESSAGE) + "…";
        }
        postMessage({
          type: "console",
          level,
          message,
          tsMs: Date.now(),
          invocationId: invocationContext.getStore()?.invocationId ?? null,
        });
      } catch {
        // postMessage can throw during teardown; losing a captured line
        // is acceptable, breaking user code is not.
      }
    };
  }
}

// Shared-module RPC: a tainted module imports the gateway-generated
// stub, which calls `globalThis.__1tube_call_shared(id, name, args)`
// to round-trip into the gateway's DenoSharedRuntime. We correlate
// requests + responses by a per-Worker monotonic id.
let nextSharedCallId = 1;
const sharedCallPending = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}>();

function callSharedFromWorker(
  moduleId: string,
  exportName: string,
  args: readonly unknown[],
): Promise<unknown> {
  const id = nextSharedCallId++;
  return new Promise((resolve, reject) => {
    sharedCallPending.set(id, { resolve, reject });
    try {
      postMessage({
        type: "shared_call",
        id,
        moduleId,
        exportName,
        args: [...args],
      });
    } catch (err) {
      sharedCallPending.delete(id);
      reject(err);
    }
  });
}

(globalThis as { __1tube_call_shared?: typeof callSharedFromWorker })
  .__1tube_call_shared = callSharedFromWorker;

const stub: RegistryStub = {
  register(handler, opts) {
    if (captured) {
      // The function called serve() twice. Last write wins, matching the
      // in-process registry's behaviour. Surface a warning so authors notice
      // the bug.
      console.warn(
        `[1tube] "${functionName}" called serve() twice; using the last handler`,
      );
    }
    captured = {
      handler,
      isPublic: opts.public,
      timeoutMs: opts.timeoutMs,
    };
  },
};

(globalThis as { __edgeFunctionRegistry?: RegistryStub })
  .__edgeFunctionRegistry = stub;

self.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  const err = (e as PromiseRejectionEvent).reason;
  postMessage({
    type: "unhandledrejection",
    name: functionName,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    // Deno 2.7+ propagates async context through rejections, so most
    // orphan rejections still attribute to the request that leaked them.
    invocationId: invocationContext.getStore()?.invocationId ?? null,
  });
});

self.addEventListener("error", (e) => {
  const err = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
  postMessage({
    type: "error_event",
    name: functionName,
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    invocationId: invocationContext.getStore()?.invocationId ?? null,
  });
});

async function runDispatch(msg: DispatchMessage): Promise<void> {
  if (!captured) {
    postMessage({
      type: "response_error",
      id: msg.id,
      message:
        `Function "${functionName}" did not call serve() before dispatch`,
    });
    return;
  }
  const headers = new Headers(msg.headers);
  const init: RequestInit = {
    method: msg.method,
    headers,
  };
  if (msg.body !== null) {
    init.body = msg.body;
    // Half-duplex marker required by Deno when constructing a Request with
    // a streaming body.
    (init as unknown as { duplex: "half" }).duplex = "half";
  }
  const req = new Request(msg.url, init);
  let resp: Response;
  try {
    const run = () =>
      Promise.resolve(
        captured!.isPublic
          ? captured!.handler(req)
          : captured!.handler(req, msg.auth ?? undefined),
      );
    resp = msg.invocationId !== undefined
      ? await invocationContext.run({ invocationId: msg.invocationId }, run)
      : await run();
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
  // We need to send `body` (a ReadableStream) over postMessage. Transfer it
  // explicitly so the host owns it; that also bypasses structured-clone
  // limitations on Response objects.
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

self.onmessage = (ev: MessageEvent<HostMessage>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    if (initDone) return;
    initDone = true;
    functionName = msg.name;
    manifest = msg.manifest;
    // Install BEFORE the dynamic import so module top-level console
    // output (boot logs) is captured too.
    if (msg.captureConsole) installConsoleCapture();
    void (async () => {
      try {
        await import(msg.entryUrl);
      } catch (err) {
        postMessage({
          type: "init_error",
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
        return;
      }
      if (!captured) {
        postMessage({
          type: "init_error",
          message: `Function "${functionName}" loaded without calling serve()`,
        });
        return;
      }
      postMessage({
        type: "ready",
        name: functionName,
        isPublic: captured.isPublic,
        timeoutMs: captured.timeoutMs,
        manifest,
      });
    })();
    return;
  }
  if (msg.type === "dispatch") {
    void runDispatch(msg);
    return;
  }
  if (msg.type === "shared_call_result") {
    const pending = sharedCallPending.get(msg.id);
    if (!pending) return;
    sharedCallPending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.value);
    } else {
      const err = new Error(msg.message ?? "shared runtime error");
      if (msg.stack) (err as Error).stack = msg.stack;
      pending.reject(err);
    }
    return;
  }
};
