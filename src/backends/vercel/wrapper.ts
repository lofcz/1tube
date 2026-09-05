/**
 * Vercel (Node / Fluid) bundle wrapper.
 *
 * Unlike the workerd wrapper (which installs a `__edgeFunctionRegistry` and
 * exports a workerd `default { fetch(request, env, ctx) }`), the Vercel target
 * runs each function as a standalone Vercel Node Function. The goals:
 *
 *  1. **Stay on the shared handler's standalone path.** The host project's
 *     `_shared/handler.ts` checks for `globalThis.__edgeFunctionRegistry`. We
 *     deliberately do NOT install it, so `serve()` falls through to
 *     `getStandaloneServe()` -> `globalThis.Deno.serve(...)`. The banner
 *     installs a `Deno.serve` shim that simply captures the fetch handler.
 *     This keeps auth (JWT verification, service-role), CORS preflight,
 *     claims checks, Supabase context construction, and route dispatch exactly
 *     where they already live — no per-function changes required.
 *
 *  2. **`Deno.env` -> `process.env`.** User code reads env via `Deno.env.get`.
 *     On Vercel Node there is no `Deno`, so the banner installs a `Deno.env`
 *     shim backed by `process.env`.
 *
 *  3. **`EdgeRuntime.waitUntil`.** Supabase Edge Runtime exposes
 *     `EdgeRuntime.waitUntil()` for background work after the response is sent.
 *     On Vercel the equivalent is provided through the `@vercel/request-context`
 *     global (which is precisely what `@vercel/functions`' `waitUntil()` reads).
 *     The banner shims `globalThis.EdgeRuntime.waitUntil` onto it, and falls
 *     back to locally draining pending promises before the handler resolves
 *     when no platform context is present (e.g. local execution / tests).
 *
 *  4. **Node request/response bridge.** The footer exports a Vercel Node
 *     handler `(req, res)` that converts the Node request into a Web `Request`
 *     (preserving the raw body stream for uploads), invokes the captured fetch
 *     handler, and streams the Web `Response` back to the Node `res` (so SSE /
 *     NDJSON / AI token streaming keep flowing incrementally).
 *
 *  5. **Skew Protection marker.** When Vercel provides `VERCEL_DEPLOYMENT_ID`
 *     (system env vars enabled), every response carries it as
 *     `x-deployment-id` unless the function already set that header. A client
 *     that bakes its own deployment id at build time (see `1tube build
 *     --target vercel --deployment-id`) compares the two to detect skew — e.g.
 *     when its pinned deployment aged out and Vercel fell through to the
 *     latest one — and can prompt a reload instead of failing mid-session.
 *
 * The banner intentionally avoids the workerd console-capture marker: on Vercel
 * `console.*` is already routed to the function's logs.
 */

/**
 * Response header carrying the serving deployment's id. Same name Vercel uses
 * for the request-side pin so one constant covers both directions on clients.
 */
export const DEPLOYMENT_ID_HEADER = "x-deployment-id";

/**
 * Node builtin module names. Imports of these (bare or `node:`-prefixed) are
 * marked external for the Vercel target so the real Node runtime provides them
 * instead of bundling Deno's polyfills. Subpath imports (e.g. `stream/web`,
 * `fs/promises`) are matched by their head segment.
 */
export const NODE_BUILTIN_MODULES: readonly string[] = [
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
];

/**
 * Output preamble prepended to EVERY emitted file — entry points and the
 * code-split chunks alike (see `BundleProfile.outputPreamble`).
 *
 * Why this can't live in the banner: esbuild only injects `banner` into entry
 * points. When CJS dependencies `require()` at module-init time (e.g.
 * `google-auth-library` → `require("node:child_process")`), esbuild hoists its
 * `__require` helper into a *shared chunk*. That helper falls back to a real
 * `require` only `if (typeof require !== "undefined")` — and an ESM module has
 * no `require` in scope, so the chunk throws "Dynamic require of … is not
 * supported" at runtime on Vercel.
 *
 * Defining a module-scoped `require` backed by `node:module`'s `createRequire`
 * gives esbuild's `__require` a working delegate in whichever chunk it lands.
 * The per-file minify pass renames our `require` (and the helper's `typeof
 * require` checks) consistently, collapsing `__require` to the real delegate.
 * The shim is kept in every file (minify can't prove `createRequire()` is
 * side-effect-free) — a few harmless bytes where unused. `import.meta.url` is
 * always valid because every output is ESM.
 */
export const VERCEL_REQUIRE_SHIM =
  `import { createRequire as __1tubeCreateRequire } from "node:module";
var require = __1tubeCreateRequire(import.meta.url);`;

/**
 * Banner injected at the top of every Vercel bundle. Runs before the user
 * entrypoint import so top-level `Deno.env.get(...)` / `serve(...)` calls find
 * the shims installed. The captured handler lives in module scope; the footer
 * exports the Vercel Node handler that dispatches to it.
 */
export const VERCEL_BANNER =
  `// AUTO-GENERATED by 1tube vercel bundler — do not edit
import { Readable as __1tubeReadable } from "node:stream";

let __1tubeCapturedHandler;
let __1tubeCapturedOpts = { public: false };
const __1tubePending = [];

// --- Deno.env / Deno.serve shim ------------------------------------------
const __1tubeProcessEnv = () => (globalThis.process && globalThis.process.env) || {};
const __1tubeDenoEnv = {
  get(key) {
    const v = __1tubeProcessEnv()[key];
    return typeof v === "string" ? v : undefined;
  },
  set(key, value) {
    __1tubeProcessEnv()[key] = String(value);
  },
  delete(key) {
    delete __1tubeProcessEnv()[key];
  },
  has(key) {
    return typeof __1tubeProcessEnv()[key] === "string";
  },
  toObject() {
    const out = {};
    const env = __1tubeProcessEnv();
    for (const k of Object.keys(env)) {
      if (typeof env[k] === "string") out[k] = env[k];
    }
    return out;
  },
};

// Captures the fetch handler passed to Deno.serve(). Deno.serve supports
// serve(handler), serve(options, handler) and serve({ handler }); we accept
// all three shapes. Returns a Deno.HttpServer-like object so callers that
// inspect the return value don't crash.
function __1tubeCaptureServe(arg1, arg2) {
  const handler = typeof arg1 === "function"
    ? arg1
    : (typeof arg2 === "function"
      ? arg2
      : (arg1 && typeof arg1.handler === "function" ? arg1.handler : undefined));
  if (typeof handler === "function") __1tubeCapturedHandler = handler;
  return {
    finished: Promise.resolve(),
    shutdown() { return Promise.resolve(); },
    ref() {},
    unref() {},
    addr: { transport: "tcp", hostname: "0.0.0.0", port: 0 },
  };
}

if (typeof globalThis.Deno === "undefined") {
  // Pure Node (Vercel): install the full shim.
  Object.defineProperty(globalThis, "Deno", {
    value: { env: __1tubeDenoEnv, serve: __1tubeCaptureServe },
    writable: true,
    configurable: true,
    enumerable: false,
  });
} else {
  // Host Deno (1tube's own tests): override only serve so the handler is
  // captured instead of binding a real port; leave the rest of Deno intact.
  try {
    globalThis.Deno.serve = __1tubeCaptureServe;
  } catch (_e) { /* serve not writable — capture unavailable in this realm */ }
}

// --- EdgeRuntime.waitUntil shim ------------------------------------------
function __1tubeRequestContext() {
  try {
    const rc = globalThis[Symbol.for("@vercel/request-context")];
    return rc && typeof rc.get === "function" ? rc.get() : undefined;
  } catch (_e) {
    return undefined;
  }
}
function __1tubeHasPlatformWaitUntil() {
  const ctx = __1tubeRequestContext();
  return !!(ctx && typeof ctx.waitUntil === "function");
}
function __1tubePlatformWaitUntil(promise) {
  const ctx = __1tubeRequestContext();
  if (ctx && typeof ctx.waitUntil === "function") {
    try {
      ctx.waitUntil(promise);
      return true;
    } catch (_e) { /* fall through to local draining */ }
  }
  return false;
}
if (!globalThis.EdgeRuntime || typeof globalThis.EdgeRuntime.waitUntil !== "function") {
  const edgeRuntime = (globalThis.EdgeRuntime && typeof globalThis.EdgeRuntime === "object")
    ? globalThis.EdgeRuntime
    : {};
  edgeRuntime.waitUntil = (promise) => {
    const p = Promise.resolve(promise);
    __1tubePending.push(p.catch(() => {}));
    __1tubePlatformWaitUntil(p);
    return p;
  };
  try {
    globalThis.EdgeRuntime = edgeRuntime;
  } catch (_e) { /* read-only EdgeRuntime — waitUntil shim unavailable */ }
}
`;

/**
 * Footer injected at the bottom of every Vercel bundle. Exports the Vercel
 * Node handler. By the time Vercel invokes it the entrypoint import has run, so
 * `__1tubeCapturedHandler` is populated.
 */
export const VERCEL_FOOTER = `
function __1tubeHeadersFromNode(req) {
  const headers = new Headers();
  const raw = req.headers || {};
  for (const key of Object.keys(raw)) {
    const value = raw[key];
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, String(v));
    } else if (value !== undefined && value !== null) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function __1tubeToWebRequest(req) {
  const headers = __1tubeHeadersFromNode(req);
  const xfproto = headers.get("x-forwarded-proto");
  const proto = (xfproto ? xfproto.split(",")[0] : "https").trim() || "https";
  const host = headers.get("x-forwarded-host") || headers.get("host") || "localhost";
  const path = req.url || "/";
  const url = /^https?:\\/\\//.test(path) ? path : (proto + "://" + host + path);
  const method = (req.method || "GET").toUpperCase();
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    // Stream the raw request body through untouched — multipart uploads and
    // proxied request streams must not be buffered/parsed here.
    init.body = __1tubeReadable.toWeb(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

const __1tubeDeploymentIdHeader = ${JSON.stringify(DEPLOYMENT_ID_HEADER)};

async function __1tubeWriteWebResponse(res, response) {
  res.statusCode = response.status;
  const setCookie = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [];
  let hasDeploymentIdHeader = false;
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") return;
    if (lower === __1tubeDeploymentIdHeader) hasDeploymentIdHeader = true;
    try { res.setHeader(key, value); } catch (_e) { /* ignore invalid header */ }
  });
  if (setCookie.length > 0) {
    try { res.setHeader("set-cookie", setCookie); } catch (_e) { /* ignore */ }
  }
  // Skew Protection: advertise the serving deployment so clients can compare
  // it with the id they were built against. Function-set values win.
  if (!hasDeploymentIdHeader) {
    const deploymentId = __1tubeProcessEnv().VERCEL_DEPLOYMENT_ID;
    if (typeof deploymentId === "string" && deploymentId.length > 0) {
      try { res.setHeader(__1tubeDeploymentIdHeader, deploymentId); } catch (_e) { /* ignore */ }
    }
  }
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        const ok = res.write(value);
        if (ok === false) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    }
  } finally {
    res.end();
  }
}

export default async function handler(req, res) {
  try {
    if (typeof __1tubeCapturedHandler !== "function") {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "function did not register a handler" }));
      return;
    }
    const request = __1tubeToWebRequest(req);
    const response = await __1tubeCapturedHandler(request);
    await __1tubeWriteWebResponse(res, response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      console.error(err instanceof Error ? (err.stack || message) : message);
    } catch (_e) { /* logging must never throw */ }
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: message }));
    } else {
      try { res.end(); } catch (_e) { /* already ended */ }
    }
  } finally {
    // When no platform waitUntil is available (local execution / tests), drain
    // background work before resolving so it isn't dropped.
    if (!__1tubeHasPlatformWaitUntil() && __1tubePending.length > 0) {
      const pending = __1tubePending.splice(0, __1tubePending.length);
      await Promise.allSettled(pending);
    }
  }
}
`;
