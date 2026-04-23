/**
 * 1tube -- Self-hosted Supabase Edge Functions gateway.
 *
 * Discovers and loads edge function modules, exposes them via a single HTTP
 * server with JWT auth, CORS, body size cap, rate limiting, structured logging,
 * graceful shutdown, and per-function timeouts.
 *
 * Usage:
 *   deno run --allow-all src/server.ts
 *   deno run --allow-all src/server.ts --functions ../sciobot-next/supabase/functions --port 3100
 *   deno run --allow-all src/server.ts --dev --hmr   # local development
 */

// All third-party imports below use `npm:` / `node:` / `jsr:` specifiers
// directly (not bare aliases from our deno.json) so this entry point loads
// cleanly when launched from a host project's node_modules — bare
// specifiers would otherwise require the host's deno.json to mirror our
// import map. Same convention applies to every src/ file.
import { Hono } from "npm:hono@4";
import { bodyLimit } from "npm:hono@4/body-limit";
import { relative, sep as SEPARATOR } from "node:path";
import { currentRequestStorage, FunctionRegistry } from "./registry.ts";
import { discoverAndLoad, type DiscoveryProgress } from "./discovery.ts";
import { createBootProgress } from "./boot-progress.ts";
import { validateRequest } from "./gateway/auth.ts";
import { watchdogBody } from "./gateway/body-watchdog.ts";
import { corsMiddleware } from "./gateway/cors.ts";
import { loggingMiddleware } from "./gateway/logging.ts";
import { createRateLimiter } from "./gateway/rate-limit.ts";
import { createHealthHandler, createMetricsHandler } from "./health.ts";
import { FunctionSupervisor } from "./supervisor.ts";
import { installEnvScope, runWithEnvScope } from "./env-scope.ts";
import { flushLogs } from "./log-buffer.ts";
import { VERSION } from "./version.ts";

// ---------------------------------------------------------------------------
// CLI args & env
// ---------------------------------------------------------------------------

interface CliOpts {
  port: number;
  host: string;
  functionsPath: string;
  defaultTimeoutMs: number;
  bodyLimitBytes: number;
  /**
   * Max idle gap (ms) between body chunks before we abort the request as a
   * suspected slow-loris. NOT a total body-read deadline — large but fast
   * uploads pass through unhindered. 0 disables.
   */
  bodyReadIdleMs: number;
  shutdownGraceMs: number;
  dev: boolean;
  hmr: boolean;
  lazy: boolean;
}

function parseArgs(): CliOpts {
  const args = Deno.args;

  const envFlag = (name: string) => {
    const v = Deno.env.get(name);
    return v === "1" || v === "true";
  };

  let dev = envFlag("1TUBE_DEV");
  let hmr = envFlag("1TUBE_HMR");
  // Eager loading is the default — first-request latency reflects real
  // function cost (no on-demand transpile tax). Opt in to lazy with
  // --lazy or 1TUBE_LAZY=1 when boot speed matters more than first-hit
  // latency (e.g. sites with hundreds of rarely-called functions).
  const lazyEnv = Deno.env.get("1TUBE_LAZY");
  let lazy = lazyEnv === undefined ? false : (lazyEnv === "1" || lazyEnv === "true");
  let port = parseInt(Deno.env.get("PORT") || "3100", 10);
  let host = (Deno.env.get("1TUBE_HOST") || "127.0.0.1").trim();
  let functionsPath = Deno.env.get("FUNCTIONS_PATH") || "./supabase/functions";
  let defaultTimeoutMs = parseInt(Deno.env.get("FUNCTION_TIMEOUT_MS") || "150000", 10);
  const bodyLimitMb = parseFloat(Deno.env.get("1TUBE_BODY_LIMIT_MB") || "30");
  const bodyReadIdleMs = parseInt(Deno.env.get("1TUBE_BODY_READ_MS") || "30000", 10);
  const shutdownGraceMs = parseInt(Deno.env.get("1TUBE_SHUTDOWN_GRACE_MS") || "10000", 10);

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      port = parseInt(args[++i], 10);
    } else if (a === "--host" && args[i + 1]) {
      host = args[++i];
    } else if (a === "--functions" && args[i + 1]) {
      functionsPath = args[++i];
    } else if (a === "--timeout" && args[i + 1]) {
      defaultTimeoutMs = parseInt(args[++i], 10);
    } else if (a === "--dev") {
      dev = true;
    } else if (a === "--hmr") {
      hmr = true;
    } else if (a === "--eager") {
      lazy = false;
    } else if (a === "--lazy") {
      lazy = true;
    }
  }

  // Make derived dev state observable to other modules via env.
  if (dev) Deno.env.set("1TUBE_DEV", "1");

  return {
    port,
    host,
    functionsPath,
    defaultTimeoutMs,
    bodyLimitBytes: Math.max(0, Math.floor(bodyLimitMb * 1024 * 1024)),
    bodyReadIdleMs: Math.max(0, bodyReadIdleMs),
    shutdownGraceMs: Math.max(0, shutdownGraceMs),
    dev,
    hmr,
    lazy,
  };
}

// Well-known defaults for local Supabase (identical for every `supabase init` project).
// These are applied ONLY in dev mode. The JWT secret below is documented in
// public Supabase samples — applying it in production silently would let any
// caller forge service-role tokens.
const LOCAL_SUPABASE_DEFAULTS: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
};

const SECRETS_REQUIRED_IN_PROD = ["JWT_SECRET", "SUPABASE_SERVICE_ROLE_KEY"];

function applyDevDefaults() {
  let applied = 0;
  for (const [key, value] of Object.entries(LOCAL_SUPABASE_DEFAULTS)) {
    if (!Deno.env.get(key)) {
      Deno.env.set(key, value);
      applied++;
    }
  }
  if (applied > 0) {
    console.log(`[1tube] Applied ${applied} dev default(s) (1TUBE_DEV=1)`);
  }
}

function enforceProdSecrets() {
  const missing: string[] = [];
  for (const k of SECRETS_REQUIRED_IN_PROD) {
    const v = Deno.env.get(k);
    if (!v) {
      missing.push(k);
      continue;
    }
    if (LOCAL_SUPABASE_DEFAULTS[k] && v === LOCAL_SUPABASE_DEFAULTS[k]) {
      console.error(
        `[1tube] FATAL: ${k} is set to the well-known dev default. ` +
          `That secret is publicly documented; rotate it before running in production.`,
      );
      Deno.exit(1);
    }
  }
  if (missing.length > 0) {
    console.error(
      `[1tube] FATAL: ${missing.join(", ")} not set. ` +
        `Set them in the environment, or pass --dev / 1TUBE_DEV=1 to use the ` +
        `built-in local Supabase defaults (NEVER do this in production).`,
    );
    Deno.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const opts = parseArgs();
const internalKey = Deno.env.get("INTERNAL_KEY")?.trim() || undefined;

if (opts.dev) {
  applyDevDefaults();
} else {
  enforceProdSecrets();
}

const denoVersion = `${Deno.version.deno} (V8 ${Deno.version.v8}, TS ${Deno.version.typescript})`;
const bannerText = `  1tube v${VERSION}  ·  Deno ${denoVersion}  `;
const bannerLine = "─".repeat(bannerText.length);
console.log(`\x1b[36m┌${bannerLine}┐\x1b[0m`);
console.log(`\x1b[36m│\x1b[0m  \x1b[1m1tube\x1b[0m v${VERSION}  \x1b[2m·\x1b[0m  Deno ${denoVersion}  \x1b[36m│\x1b[0m`);
console.log(`\x1b[36m└${bannerLine}┘\x1b[0m`);
console.log(
  `[1tube] mode=${opts.dev ? "dev" : "prod"} hmr=${opts.hmr ? "on" : "off"} ` +
    `lazy=${opts.lazy ? "on" : "off"} ` +
    `host=${opts.host} bodyLimit=${(opts.bodyLimitBytes / 1024 / 1024).toFixed(1)}MB ` +
    `bodyReadIdle=${opts.bodyReadIdleMs > 0 ? opts.bodyReadIdleMs + "ms" : "off"}`,
);

const registry = new FunctionRegistry();
const supervisor = new FunctionSupervisor();
(globalThis as any).__edgeFunctionRegistry = registry;

// ---------------------------------------------------------------------------
// Process-level error handlers
//
// Installed AFTER `supervisor` exists so they can attribute orphan rejections
// to the originating function. AsyncLocalStorage context propagation through
// unhandled rejections requires Deno 2.7+ — older runtimes will see no
// `currentRequestStorage` value and just log the error without function tag.
// ---------------------------------------------------------------------------

function fnNameFromAsyncContext(): string | null {
  const store = currentRequestStorage.getStore();
  return store?.functionName ?? null;
}

globalThis.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  const fn = fnNameFromAsyncContext();
  if (fn) {
    console.error(`[1tube] Unhandled rejection in "${fn}":`, e.reason);
    // Count this against the function so the breaker can trip on
    // fire-and-forget code that consistently leaks rejections.
    supervisor.record(fn, true);
  } else {
    console.error("[1tube] Unhandled promise rejection:", e.reason);
  }
});

globalThis.addEventListener("error", (e) => {
  const fn = fnNameFromAsyncContext();
  const detail = (e as ErrorEvent).error ?? (e as ErrorEvent).message;
  if (fn) {
    console.error(`[1tube] Uncaught error in "${fn}":`, detail);
  } else {
    console.error("[1tube] Uncaught error:", detail);
  }
});

const enforceManifest = (Deno.env.get("1TUBE_ENFORCE_MANIFEST") ?? "") === "1";
const allowAll = (Deno.env.get("1TUBE_ALLOW_ALL") ?? "") === "1";
if (enforceManifest && !allowAll) {
  installEnvScope();
  console.log(
    "[1tube] Manifest enforcement ON: per-function env reads filtered by 1tube.json permissions.env",
  );
} else if (allowAll) {
  console.warn(
    "[1tube] 1TUBE_ALLOW_ALL=1 — manifest permissions are NOT enforced. Use only for local debugging.",
  );
}

const resolvedFunctionsPath = await Deno.realPath(opts.functionsPath);

/**
 * Map a changed filesystem path to either a function name or `null` ("shared",
 * meaning the change is outside any function dir / under `_shared` / under any
 * dir starting with `_`, so it could affect any function — reload all).
 */
function classifyChangedPath(absPath: string): string | null {
  const rel = relative(resolvedFunctionsPath, absPath);
  if (!rel || rel.startsWith("..") || rel.startsWith(SEPARATOR + "..") || rel === ".") {
    return null;
  }
  const first = rel.split(/[\\/]/, 1)[0];
  if (!first) return null;
  if (first.startsWith("_") || first.endsWith("_shared")) return null;
  return first;
}

function progressLine(p: DiscoveryProgress): string {
  const pad = String(p.total).length;
  const idx = String(p.index).padStart(pad, " ");
  const status = p.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  const dur = `${p.durationMs.toFixed(0)}ms`;
  const tail = p.ok ? "" : ` — ${p.error ?? "error"}`;
  return `[1tube] [${idx}/${p.total}] ${status} ${p.name} \x1b[2m(${dur})\x1b[0m${tail}`;
}

async function reloadFunctions(
  reason: string,
  changedFunctionNames: Set<string> | "all",
) {
  const isFullReload = changedFunctionNames === "all";
  const start = performance.now();

  if (isFullReload) {
    console.log(`[1tube] Reloading all functions (${reason})...`);
    registry.clear();
  } else {
    const names = [...changedFunctionNames].sort();
    if (names.length === 0) return;
    console.log(
      `[1tube] Reloading ${names.length} function(s) (${reason}): ${names.join(", ")}`,
    );
  }

  // Cache-bust only when re-importing modules that may already be in Deno's
  // module cache — i.e. any reload after the initial boot.
  const cacheBust =
    reason === "initial boot" ? undefined : `${Date.now()}-${crypto.randomUUID()}`;

  // HMR reloads always import eagerly so the change is observable on the
  // very next request — even when boot-time discovery was lazy.
  const useLazy = opts.lazy && isFullReload;

  // Append-only "still working" heartbeat. Does not redraw, does not race
  // with foreign console.log() from imported modules — see
  // src/boot-progress.ts for the design rationale. Heartbeat is silent for
  // tiny HMR reloads (≤2 functions) where the per-completion line is
  // already enough signal.
  const isTinyReload = changedFunctionNames instanceof Set &&
    changedFunctionNames.size <= 2;
  const progress = createBootProgress(Deno.stdout, {
    pulseMs: isTinyReload ? 0 : 2000,
  });

  let result;
  try {
    result = await discoverAndLoad(
      opts.functionsPath,
      registry,
      {
        cacheBust,
        only: isFullReload ? undefined : changedFunctionNames,
        onStart: (p) => {
          // Late-bind the total on the first start event — by then we
          // know the real work-list size after `only`/exists filtering.
          if (p.index === 1) progress.start(p.total);
          progress.onStart(p.name);
        },
        onProgress: (p) => progress.onFinish(progressLine(p), p.name),
        lazy: useLazy,
      },
    );
  } finally {
    progress.stop();
  }
  const { loaded, skipped, errors, removed, deferred } = result;

  for (const name of removed) {
    if (registry.delete(name)) {
      supervisor.forget(name);
      console.log(`[1tube] Removed "${name}" (index.ts gone)`);
    }
  }

  for (const name of loaded) {
    const reg = registry.get(name);
    if (reg) supervisor.setManifest(name, reg.manifest);
    // On reload, drop accumulated stats so the breaker doesn't immediately
    // re-trip on stale counts after the operator fixed the function.
    if (!isFullReload) supervisor.reset(name);
  }
  // Lazy candidates also get a manifest so the supervisor can rate-limit /
  // circuit-break BEFORE the first import — protects against startup-amplified
  // attacks.
  for (const name of deferred) {
    const cand = registry.candidate(name);
    if (cand) supervisor.setManifest(name, cand.manifest);
  }
  if (isFullReload) {
    // Full reloads are explicit operator action — clear all stats.
    for (const name of registry.list()) {
      supervisor.setManifest(name, registry.get(name)!.manifest);
    }
  }

  const totalMs = performance.now() - start;
  if (isFullReload) {
    const deferTag = deferred.length > 0 ? `, deferred ${deferred.length}` : "";
    console.log(
      `[1tube] Loaded ${loaded.length} function(s)${deferTag}, ` +
        `skipped ${skipped.length} dir(s) in ${totalMs.toFixed(0)}ms`,
    );
    const all = registry.knownNames();
    if (all.length > 0) {
      console.log(`[1tube] Functions: ${all.join(", ")}`);
    }
  } else {
    console.log(
      `[1tube] Reloaded ${loaded.length} function(s) in ${totalMs.toFixed(0)}ms ` +
        `(${registry.size} total registered)`,
    );
  }

  if (errors.length > 0) {
    console.error(
      `[1tube] ${errors.length} function(s) failed to load (check .env for missing vars):`,
    );
    for (const e of errors) {
      console.error(`  ${e.name}: ${e.error}`);
    }
  }
}

console.log(`[1tube] Loading functions from: ${opts.functionsPath}`);
await reloadFunctions("initial boot", "all");

let reloadTimer: number | undefined;
let isReloading = false;
const pendingChanges = new Set<string>();
let pendingSharedChange = false;

function scheduleReload(paths: string[]) {
  for (const p of paths) {
    const name = classifyChangedPath(p);
    if (name === null) {
      pendingSharedChange = true;
    } else {
      pendingChanges.add(name);
    }
  }
  if (!pendingSharedChange && pendingChanges.size === 0) return;

  if (reloadTimer !== undefined) {
    clearTimeout(reloadTimer);
  }
  reloadTimer = setTimeout(async () => {
    reloadTimer = undefined;

    if (isReloading) return;

    const sharedChanged = pendingSharedChange;
    const names = new Set(pendingChanges);
    pendingSharedChange = false;
    pendingChanges.clear();

    isReloading = true;
    try {
      const reason = sharedChanged
        ? `shared change (+${names.size} function(s))`
        : `${names.size} function(s) changed`;
      await reloadFunctions(reason, sharedChanged ? "all" : names);
    } catch (err) {
      console.error("[1tube] Reload failed:", err);
    } finally {
      isReloading = false;
      if (pendingSharedChange || pendingChanges.size > 0) {
        scheduleReload([]);
      }
    }
  }, 200);
}

let watcherAbort: AbortController | undefined;

async function watchFunctions() {
  watcherAbort = new AbortController();
  try {
    const watcher = Deno.watchFs(opts.functionsPath, { recursive: true });
    console.log(`[1tube] HMR watching: ${opts.functionsPath}`);
    for await (const event of watcher) {
      if (watcherAbort.signal.aborted) break;
      if (event.paths.length === 0) continue;
      scheduleReload(event.paths);
    }
  } catch (err) {
    console.warn("[1tube] HMR watcher disabled:", err);
  }
}

if (opts.hmr) {
  watchFunctions();
} else {
  console.log("[1tube] HMR disabled (set 1TUBE_HMR=1 or pass --hmr to enable)");
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

/** Set on authenticated function calls; read in logging middleware. */
type GatewayVariables = { userId?: string };

const app = new Hono<{ Variables: GatewayVariables }>();
const rateLimiter = createRateLimiter({ registry });

// Middleware order matters:
//   1. CORS (handle preflight before anything else can short-circuit)
//   2. Fast-fail unknown function names (no auth/rate-limit cost for scans)
//   3. Logging (wraps everything below)
//   4. Body size cap (reject early before reading the body)
//   5. JWT auth probe (sets c.userId when token is valid; does NOT enforce
//      auth here — the dispatcher decides per function based on `isPublic`)
//   6. Rate limiter (now sees a real userId for per-user keying)
app.use("/functions/v1/*", corsMiddleware);
app.use("/functions/v1/*", async (c, next) => {
  // Fast-fail unknown function names before paying for logging, auth, body
  // limit, and rate-limit. Without this, a scanner hammering random names
  // exhausts rate-limit buckets keyed by IP and pollutes the log stream.
  // Cheap: a single Map lookup against names already known on disk.
  const path = c.req.path;
  const prefix = "/functions/v1/";
  if (path.length > prefix.length) {
    const after = path.slice(prefix.length);
    const slash = after.indexOf("/");
    const name = slash === -1 ? after : after.slice(0, slash);
    if (name && !registry.has(name)) {
      return c.json({ error: `Function "${name}" not found` }, 404);
    }
  }
  await next();
});
app.use("/functions/v1/*", loggingMiddleware);
app.use(
  "/functions/v1/*",
  bodyLimit({
    maxSize: opts.bodyLimitBytes,
    onError: (c) =>
      c.json(
        {
          error: "Request body too large",
          maxBytes: opts.bodyLimitBytes,
        },
        413,
      ),
  }),
);
app.use("/functions/v1/*", async (c, next) => {
  // Probe-only auth: validate the bearer token if present, but don't reject
  // unauthenticated requests here. Public functions need to pass through and
  // rate-limit by IP; protected functions are gated below in the dispatcher.
  try {
    const auth = await validateRequest(c.req.raw);
    if (auth) {
      c.set("userId", auth.userId);
      (c as any).set("__authContext", auth);
    }
  } catch {
    // Ignore validation errors at probe time — dispatcher will return 401.
  }
  await next();
});
app.use("/functions/v1/*", rateLimiter);

// Function dispatch
app.all("/functions/v1/:name{.+}", async (c) => {
  // c.req.param("name") greedily captures the trailing path with the {.+}
  // matcher; restrict it to the first segment.
  const rawName = c.req.param("name");
  const name = rawName.split("/", 1)[0];
  // getOrLoad triggers a one-time dynamic import for lazy candidates; subsequent
  // calls are a hot map lookup. Concurrent first-requests dedupe on the same
  // in-flight Promise.
  let fn: Awaited<ReturnType<typeof registry.getOrLoad>>;
  try {
    fn = await registry.getOrLoad(name);
  } catch (err) {
    console.error(`[1tube] Lazy import of "${name}" failed:`, err);
    return c.json({ error: "Function failed to load" }, 500);
  }

  if (!fn) {
    return c.json({ error: `Function "${name}" not found` }, 404);
  }

  // Circuit breaker: refuse early if the supervisor has tripped this function.
  const decision = supervisor.admit(name);
  if (!decision.ok) {
    const headers: Record<string, string> = {};
    if (decision.retryAfter) headers["Retry-After"] = String(decision.retryAfter);
    return c.json(
      { error: "Service temporarily unavailable", reason: decision.reason },
      decision.status as 503,
      headers,
    );
  }

  const timeoutMs = fn.timeoutMs ?? fn.manifest.timeoutMs ?? opts.defaultTimeoutMs;

  // Strip /functions/v1 prefix to match Supabase Edge Runtime behavior.
  const originalUrl = new URL(c.req.raw.url);
  const rewrittenPath = originalUrl.pathname.replace(/^\/functions\/v1/, "") || "/";
  const rewrittenUrl = new URL(rewrittenPath + originalUrl.search, originalUrl.origin);

  const abort = new AbortController();

  // Wrap an actual body stream with the slow-loris watchdog. Body-less
  // methods (GET / HEAD / DELETE-without-body) skip wrapping — there's
  // nothing to read. The watchdog resets its idle timer on every chunk;
  // if no chunk arrives within `bodyReadIdleMs`, it aborts the same
  // signal the handler is already wired to, so `req.json()` /
  // `req.text()` / `req.arrayBuffer()` reject with AbortError and the
  // request slot is freed immediately.
  const rawBody = c.req.raw.body;
  const wrappedBody = rawBody !== null
    ? watchdogBody(rawBody, opts.bodyReadIdleMs, abort, (idleMs) => {
        console.warn(
          `[1tube] Body read stalled in "${name}" (no progress in ${idleMs}ms) — aborting request.`,
        );
      }).body
    : null;

  const rewrittenReq = new Request(rewrittenUrl.toString(), {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: wrappedBody,
    signal: abort.signal,
    // @ts-ignore -- Deno supports duplex on Request
    duplex: "half",
  });

  const invoke = (): Promise<Response> => {
    if (!fn.isPublic) {
      const auth = (c as any).get("__authContext");
      if (!auth) {
        // Surfaced to the caller via the outer try/catch path below.
        return Promise.resolve(c.json({ error: "Unauthorized" }, 401));
      }
      return Promise.resolve((fn.handler as any)(rewrittenReq, auth));
    }
    return Promise.resolve((fn.handler as any)(rewrittenReq));
  };

  // Bind the function name as the active async context for the entire handler
  // call tree. This lets the global `unhandledrejection` listener attribute
  // orphan rejections (from setTimeout/fire-and-forget Promises inside the
  // function) to the correct function — preserved across awaits in 2.7+.
  const inner = enforceManifest && !allowAll
    ? () =>
        runWithEnvScope(
          { functionName: name, allow: new Set(fn.manifest.permissions.env) },
          invoke,
        )
    : invoke;

  const handlerPromise = Promise.resolve(
    currentRequestStorage.run({ functionName: name }, inner),
  ) as Promise<Response>;

  let response: Response;
  let errored = false;
  try {
    if (timeoutMs > 0) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => {
          abort.abort();
          reject(new Error(`Function "${name}" timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      );
      response = await Promise.race([handlerPromise, timeout]);
    } else {
      response = await handlerPromise;
    }
  } catch (err) {
    errored = true;
    if (err instanceof Error && err.message.includes("timed out")) {
      console.error(`[1tube] ${err.message}`);
      response = c.json({ error: "Function execution timed out" }, 504);
    } else if (
      err instanceof DOMException && err.name === "AbortError" &&
      err.message.includes("Body read stalled")
    ) {
      // Slow-loris watchdog tripped. The handler was awaiting the body and
      // the abort propagated up. Return 408 so legitimate clients can retry
      // — 503 would imply we'd accept a retry from the same offender.
      response = c.json({ error: "Request body read timed out" }, 408);
    } else {
      console.error(`[1tube] Unhandled error in "${name}":`, err);
      response = c.json({ error: "Internal server error" }, 500);
    }
  }

  if (response.status >= 500) errored = true;

  const outcome = supervisor.record(name, errored);
  if (outcome.breakerJustTripped) {
    console.warn(
      `[1tube] Circuit breaker OPEN for "${name}" — refusing requests for ${
        fn.manifest.recycle.cooldownMs
      }ms (errorRate >= ${fn.manifest.recycle.errorRate}).`,
    );
  }
  if (outcome.recycleJustRecommended) {
    console.warn(
      `[1tube] "${name}" reached ${fn.manifest.recycle.maxRequests} invocations — recycle recommended.`,
    );
  }

  return response;
});

// Health & observability
app.get("/health", createHealthHandler(registry, internalKey, supervisor));
app.get("/metrics", createMetricsHandler(internalKey));

// Root liveness probe — intentionally minimal so we don't leak the registered
// function count or endpoint map to unauthenticated callers.
app.get("/", (c) => c.json({ status: "ok" }));

// ---------------------------------------------------------------------------
// Serve + graceful shutdown
// ---------------------------------------------------------------------------

console.log(`[1tube] Starting on http://${opts.host}:${opts.port}`);
if (opts.host === "127.0.0.1" || opts.host === "localhost") {
  console.log(
    "[1tube] Bound to loopback only. Pass --host 0.0.0.0 (or 1TUBE_HOST=0.0.0.0) to expose externally.",
  );
}

const serverAbort = new AbortController();
const server = Deno.serve(
  { port: opts.port, hostname: opts.host, signal: serverAbort.signal },
  app.fetch,
);

let shuttingDown = false;
async function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[1tube] Shutdown requested (${reason}); draining up to ${opts.shutdownGraceMs}ms...`);

  watcherAbort?.abort();

  // Stop accepting new connections; in-flight finish on their own.
  serverAbort.abort();

  // Drain any buffered request log lines so they make it to stdout/stderr
  // before we exit.
  flushLogs();

  const timed = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), opts.shutdownGraceMs),
  );
  const finished = server.finished.then(() => "drained" as const);
  const result = await Promise.race([finished, timed]);
  if (result === "timeout") {
    console.warn("[1tube] Shutdown grace expired; some requests may have been dropped.");
  } else {
    console.log("[1tube] Drain complete; exiting.");
  }
  flushLogs();
  Deno.exit(0);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  try {
    Deno.addSignalListener(sig, () => shutdown(sig));
  } catch {
    // SIGTERM not supported on Windows; ignore.
  }
}
