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
import { Hono, type Context } from "npm:hono@4";
import { bodyLimit } from "npm:hono@4/body-limit";
import { currentRequestStorage, FunctionRegistry } from "./registry.ts";
import { validateRequest } from "./gateway/auth.ts";
import { watchdogBody } from "./gateway/body-watchdog.ts";
import { corsMiddleware } from "./gateway/cors.ts";
import { loggingMiddleware } from "./gateway/logging.ts";
import { createRateLimiter } from "./gateway/rate-limit.ts";
import { createHealthHandler, createMetricsHandler } from "./health.ts";
import { FunctionSupervisor } from "./supervisor.ts";
import { installEnvScope } from "./env-scope.ts";
import { flushLogs } from "./log-buffer.ts";
import { VERSION } from "./version.ts";
import { createWorkerdBackend, type WorkerdBackend } from "./backends/workerd/backend.ts";
import { createWorkerdHotReloader, type WorkerdHotReloader } from "./backends/workerd/hot-reloader.ts";
import { createDenoWorkerHost, type DenoWorkerHost } from "./backends/deno/worker-host.ts";
import {
  createDenoHotReloader,
  type DenoHotReloader,
} from "./backends/deno/hot-reloader.ts";
import {
  createDenoSharedRuntime,
  type DenoSharedRuntime,
  discoverSharedModules,
} from "./backends/deno/shared-runtime.ts";
import {
  createRewriteCache,
  type RewriteCache,
} from "./backends/deno/source-rewriter.ts";
import { createBootProgress } from "./boot-progress.ts";
import {
  createWorkerdWatchdog,
  recommendedBudgetBytes,
  type WorkerdWatchdog,
} from "./backends/workerd/watchdog.ts";

// ---------------------------------------------------------------------------
// Exit-code contract
// ---------------------------------------------------------------------------
//
// These are part of 1tube's public process supervisor contract. Any host
// (the OneTube .NET package, a systemd unit, a Docker healthcheck, …)
// can rely on them to distinguish failures the gateway considers
// permanent — restarting will not help — from transient crashes worth
// retrying. We follow the BSD sysexits.h conventions where applicable
// so off-the-shelf supervisors (systemd's RestartPreventExitStatus,
// runit, etc.) can act on them without bespoke wiring.
//
//   0   OK              clean shutdown (SIGTERM / completed --build)
//   1   CRASH           generic runtime crash (transient — retry OK)
//   64  EX_USAGE        bad CLI args (e.g. unknown --backend value)
//   78  EX_CONFIG       config error: required env vars missing,
//                       dev secret used in prod, prebuilt manifest
//                       mismatch, etc.
//
// Anything in PERMANENT_EXIT_CODES is the gateway's way of telling
// the supervisor "stop respawning me; fix the config and restart."
export const EXIT_CODES = {
  OK: 0,
  CRASH: 1,
  USAGE: 64,
  CONFIG: 78,
} as const;
/** Mirror in any external supervisor (see dotnet/OneTube/DenoHostService.cs). */
export const PERMANENT_EXIT_CODES: ReadonlySet<number> = new Set([
  EXIT_CODES.USAGE,
  EXIT_CODES.CONFIG,
]);

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
  /**
   * Function execution backend. `"deno"` (default) imports each
   * function as a Deno module in this process — same as 1tube has
   * always done. `"workerd"` bundles each function into a
   * Cloudflare-style worker and serves it from a workerd subprocess
   * for hard isolation between functions and the gateway.
   */
  backend: "deno" | "workerd";
  /**
   * Optional path to the workerd binary. Falls back to
   * `1TUBE_WORKERD_BIN`, then plain `"workerd"` resolved via PATH.
   * Only consulted when `backend === "workerd"`.
   */
  workerdBin?: string;
  /**
   * Names of env vars to forward to bundled functions via workerd's
   * `fromEnvironment` bindings. Sourced from `--workerd-env=A,B,C`,
   * else falls back to the `1TUBE_WORKERD_ENV` env var (resolved
   * inside the backend itself). When neither is set, the backend
   * forwards every env var the gateway can see — opt in to a tighter
   * surface by listing only what your functions actually need. Only
   * consulted under `backend=workerd`.
   */
  workerdEnv?: readonly string[];
  /** Shared module paths for gateway-owned process-wide code. */
  workerdShared?: readonly string[];
  /**
   * First loopback port workerd may use for per-function sockets.
   * The backend reserves a second generation range at +500 during
   * reload, so callers embedding multiple gateways should keep at
   * least 1000 ports between slots.
   */
  workerdBasePort?: number;
  /**
   * Auto-kill leftover `workerd` processes when the boot-time port
   * preflight finds a conflict. Off by default; enabled via
   * `--kill-stale-workerd` or `1TUBE_KILL_STALE_WORKERD=1`. The
   * cleanup only ever targets processes named `workerd` — see
   * `WorkerdBackendOptions.killStaleWorkerd` for the full rationale.
   */
  killStaleWorkerd?: boolean;
  /**
   * When set, launches workerd with `--inspector-addr=<addr>` so the
   * V8 inspector is reachable from Chrome DevTools. Off by default —
   * opens an unauthenticated debug port and is for local dev only.
   * Empty string means "off"; any non-empty string is treated as the
   * bind address (host:port, port-only, or operator-managed format).
   */
  workerdInspector?: string;
  /**
   * Hard cap on workerd's V8 old-generation heap, in MB. Translates
   * to `--v8-max-heap-size=<n>` on the workerd CLI. Sourced from
   * `--workerd-max-heap-mb=<n>` or `1TUBE_WORKERD_MAX_HEAP_MB=<n>`.
   * Off by default — workerd uses V8's defaults.
   */
  workerdMaxHeapMB?: number;
  /** Workerd compatibility date passed to generated config.capnp files. */
  workerdCompatibilityDate?: string;
  /** Workerd compatibility flags passed to generated config.capnp files. */
  workerdCompatibilityFlags?: readonly string[];
  /** Pass `--experimental` to the workerd process itself. */
  workerdExperimental?: boolean;
  /**
   * Path to a `1tube build`-produced artifact directory. When set,
   * the workerd backend skips esbuild entirely and serves the
   * pre-bundled functions found inside. HMR is rejected and `--functions`
   * is ignored — a prebuilt deploy is sealed by design.
   *
   * Mutually exclusive with `--functions` (we warn rather than error so
   * Docker images can pass both env vars without breaking).
   */
  prebuiltDir?: string;
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
  const backendEnv = (Deno.env.get("1TUBE_BACKEND") ?? "").trim().toLowerCase();
  let backend: "deno" | "workerd" = backendEnv === "workerd" ? "workerd" : "deno";
  let workerdBin: string | undefined = Deno.env.get("1TUBE_WORKERD_BIN") || undefined;
  // Operator can either use --workerd-env=A,B,C on the CLI or set
  // 1TUBE_WORKERD_ENV. The CLI flag wins; otherwise the backend reads
  // the env var itself so a missing flag still picks up the var.
  let workerdEnv: readonly string[] | undefined;
  const workerdShared: string[] = (Deno.env.get("1TUBE_WORKERD_SHARED") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let workerdBasePort: number | undefined = (() => {
    const v = Deno.env.get("1TUBE_WORKERD_BASE_PORT");
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  // Inspector default address. `--inspector` (no value) → 127.0.0.1:9229;
  // `--inspector=<addr>` / `--inspector-addr=<addr>` / `1TUBE_INSPECTOR`
  // → operator-supplied bind. Empty string disables.
  const DEFAULT_INSPECTOR_ADDR = "127.0.0.1:9229";
  let workerdInspector: string | undefined = (() => {
    const v = Deno.env.get("1TUBE_INSPECTOR");
    if (v === undefined) return undefined;
    if (v === "" || v === "0" || v.toLowerCase() === "false") return undefined;
    if (v === "1" || v.toLowerCase() === "true") return DEFAULT_INSPECTOR_ADDR;
    return v;
  })();
  let prebuiltDir: string | undefined = Deno.env.get("1TUBE_PREBUILT") || undefined;
  // Auto-kill leftover workerd processes if the boot preflight finds
  // port conflicts. CLI flag overrides env var; both default to off.
  let killStaleWorkerd: boolean = (() => {
    const v = Deno.env.get("1TUBE_KILL_STALE_WORKERD");
    return v === "1" || v?.toLowerCase() === "true";
  })();
  // V8 max heap size for workerd, in MB. CLI flag overrides env var.
  let workerdMaxHeapMB: number | undefined = (() => {
    const v = Deno.env.get("1TUBE_WORKERD_MAX_HEAP_MB");
    if (!v) return undefined;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  })();
  let workerdCompatibilityDate: string | undefined = Deno.env.get("1TUBE_WORKERD_COMPAT_DATE") || undefined;
  const workerdCompatibilityFlags: string[] = (Deno.env.get("1TUBE_WORKERD_COMPAT_FLAGS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let workerdExperimental = envFlag("1TUBE_WORKERD_EXPERIMENTAL");
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
    } else if (a === "--backend" && args[i + 1]) {
      const v = args[++i].toLowerCase();
      if (v !== "deno" && v !== "workerd") {
        console.error(`[1tube] FATAL: --backend must be 'deno' or 'workerd', got ${JSON.stringify(v)}`);
        Deno.exit(EXIT_CODES.USAGE);
      }
      backend = v;
    } else if (a.startsWith("--backend=")) {
      const v = a.slice("--backend=".length).toLowerCase();
      if (v !== "deno" && v !== "workerd") {
        console.error(`[1tube] FATAL: --backend must be 'deno' or 'workerd', got ${JSON.stringify(v)}`);
        Deno.exit(EXIT_CODES.USAGE);
      }
      backend = v;
    } else if (a === "--workerd-bin" && args[i + 1]) {
      workerdBin = args[++i];
    } else if (a === "--workerd-env" && args[i + 1]) {
      workerdEnv = args[++i]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a.startsWith("--workerd-env=")) {
      workerdEnv = a.slice("--workerd-env=".length)
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === "--workerd-shared" && args[i + 1]) {
      workerdShared.push(args[++i]);
    } else if (a.startsWith("--workerd-shared=")) {
      workerdShared.push(a.slice("--workerd-shared=".length));
    } else if (a === "--workerd-base-port" && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (Number.isFinite(n) && n > 0) workerdBasePort = n;
    } else if (a.startsWith("--workerd-base-port=")) {
      const n = parseInt(a.slice("--workerd-base-port=".length), 10);
      if (Number.isFinite(n) && n > 0) workerdBasePort = n;
    } else if (a === "--inspector") {
      // Bare flag: V8 inspector on the conventional Node/Chrome port.
      workerdInspector = DEFAULT_INSPECTOR_ADDR;
    } else if (a === "--inspector-addr" && args[i + 1]) {
      workerdInspector = args[++i];
    } else if (a.startsWith("--inspector-addr=")) {
      workerdInspector = a.slice("--inspector-addr=".length);
    } else if (a.startsWith("--inspector=")) {
      // `--inspector=` with a value also lets operators set the addr
      // inline, matching Node's `--inspect=host:port` ergonomics.
      workerdInspector = a.slice("--inspector=".length);
    } else if (a === "--prebuilt" && args[i + 1]) {
      prebuiltDir = args[++i];
    } else if (a.startsWith("--prebuilt=")) {
      prebuiltDir = a.slice("--prebuilt=".length);
    } else if (a === "--workerd-max-heap-mb" && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (Number.isFinite(n) && n > 0) workerdMaxHeapMB = n;
    } else if (a.startsWith("--workerd-max-heap-mb=")) {
      const n = parseInt(a.slice("--workerd-max-heap-mb=".length), 10);
      if (Number.isFinite(n) && n > 0) workerdMaxHeapMB = n;
    } else if (a === "--compat-date" && args[i + 1]) {
      workerdCompatibilityDate = args[++i];
    } else if (a.startsWith("--compat-date=")) {
      workerdCompatibilityDate = a.slice("--compat-date=".length);
    } else if (a === "--compat-flag" && args[i + 1]) {
      workerdCompatibilityFlags.push(args[++i]);
    } else if (a.startsWith("--compat-flag=")) {
      workerdCompatibilityFlags.push(a.slice("--compat-flag=".length));
    } else if (a === "--workerd-experimental" || a === "--workerd-experimental=true") {
      workerdExperimental = true;
    } else if (a === "--workerd-experimental=false" || a === "--no-workerd-experimental") {
      workerdExperimental = false;
    } else if (a === "--kill-stale-workerd" || a === "--kill-stale-workerd=true") {
      // Boolean flag — accept both bare-flag and explicit `=true` forms
      // so we don't surprise scripts that programmatically generate
      // CLI strings. `--no-kill-stale-workerd` is the explicit override
      // for cases where the env var is set globally but a particular
      // run wants the safer behavior.
      killStaleWorkerd = true;
    } else if (a === "--kill-stale-workerd=false" || a === "--no-kill-stale-workerd") {
      killStaleWorkerd = false;
    }
  }
  if (prebuiltDir !== undefined) {
    // Workerd is the only backend that knows how to consume the
    // artifact (it's a workerd-bundle index). Coerce instead of
    // erroring so `1TUBE_PREBUILT=...` env-var deploys with no
    // explicit `--backend` flag still do the right thing.
    if (backend !== "workerd") {
      console.warn(
        `[1tube] --prebuilt implies --backend workerd; coercing backend ` +
          `(was "${backend}").`,
      );
      backend = "workerd";
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
    backend,
    workerdBin,
    workerdEnv,
    workerdShared,
    workerdBasePort,
    workerdInspector,
    workerdMaxHeapMB,
    workerdCompatibilityDate,
    workerdCompatibilityFlags,
    workerdExperimental,
    killStaleWorkerd,
    prebuiltDir,
  };
}

// Well-known defaults for local Supabase (identical for every `supabase init`
// project). Applied ONLY in dev mode. The JWT secret below is documented in
// public Supabase samples — applying it in production silently would let any
// caller forge tokens.
//
// NOTE on Supabase's new key model:
// Supabase is migrating from the JWT-based `anon` / `service_role` keys to
// opaque `sb_publishable_*` / `sb_secret_*` API keys. The gateway itself
// only consumes one secret directly — JWT_SECRET — to verify user tokens
// issued by Supabase Auth (still HS256 JWTs in both old and new models).
// Edge functions consume the publishable / secret keys directly via
// process.env; they're not the gateway's concern, so we don't gatekeep on
// them at boot.
const LOCAL_SUPABASE_DEFAULTS: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
};

const LOCAL_SUPABASE_STATUS_KEYS: Record<string, string[]> = {
  SUPABASE_URL: ["API_URL"],
  JWT_SECRET: ["JWT_SECRET"],
  SUPABASE_ANON_KEY: ["ANON_KEY"],
  SUPABASE_PUBLISHABLE_KEY: ["PUBLISHABLE_KEY"],
  SUPABASE_SECRET_KEY: ["SECRET_KEY"],
  SUPABASE_SERVICE_ROLE_KEY: ["SERVICE_ROLE_KEY"],
};

// Only secrets the gateway *itself* uses on the hot path. Anything an edge
// function happens to need (publishable/secret keys, OPENAI_API_KEY, …) is
// the function author's contract with the host — refusing to boot because
// some downstream module is missing a key it never told us about leads to
// confusing failures.
const SECRETS_REQUIRED_IN_PROD = ["JWT_SECRET"];

async function applyDevDefaults() {
  let applied = 0;
  const statusEnv = await readLocalSupabaseStatusEnv();
  for (const [target, sources] of Object.entries(LOCAL_SUPABASE_STATUS_KEYS)) {
    if (Deno.env.get(target)) continue;
    const value = sources
      .map((source) => statusEnv[source])
      .find((candidate) => typeof candidate === "string" && candidate.length > 0);
    if (!value) continue;
    Deno.env.set(target, value);
    applied++;
  }

  if (!Deno.env.get("SUPABASE_URL") && Deno.env.get("VITE_SUPABASE_URL")) {
    Deno.env.set("SUPABASE_URL", Deno.env.get("VITE_SUPABASE_URL")!);
    applied++;
  }

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

async function readLocalSupabaseStatusEnv(): Promise<Record<string, string>> {
  const runners: Array<{ command: string; args: string[] }> = [
    { command: "supabase", args: ["status", "-o", "env"] },
    { command: "bunx", args: ["supabase", "status", "-o", "env"] },
  ];

  for (const runner of runners) {
    try {
      const output = await new Deno.Command(runner.command, {
        args: runner.args,
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!output.success) continue;
      return parseSupabaseStatusEnv(new TextDecoder().decode(output.stdout));
    } catch {
      // CLI not installed on PATH (or bunx unavailable). Try the next runner.
    }
  }
  return {};
}

function parseSupabaseStatusEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function enforceProdSecrets() {
  // We deliberately do NOT reject "well-known dev default" values
  // here. The local Supabase Docker stack ships with a fixed
  // JWT_SECRET that's published in their docs, and a self-hosted
  // Supabase instance is free to keep using it indefinitely — the
  // gateway has no business deciding the operator's threat model.
  // The check used to refuse to boot in that case; that turned a
  // perfectly valid dev/staging setup into an unfixable startup
  // crash, so it's gone.
  const missing: string[] = [];
  for (const k of SECRETS_REQUIRED_IN_PROD) {
    const v = Deno.env.get(k);
    if (!v) {
      missing.push(k);
    }
  }
  if (missing.length > 0) {
    console.error(
      `[1tube] FATAL: ${missing.join(", ")} not set. ` +
        `Set them in the environment, or pass --dev / 1TUBE_DEV=1 to use the ` +
        `built-in local Supabase defaults (NEVER do this in production).`,
    );
    Deno.exit(EXIT_CODES.CONFIG);
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const opts = parseArgs();
const internalKey = Deno.env.get("INTERNAL_KEY")?.trim() || undefined;

function isInternalRequest(req: Request): boolean {
  if (!internalKey) return false;
  const header = req.headers.get("Authorization");
  const match = header?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() === internalKey;
}

function requireInternal(c: Context): Response | null {
  return isInternalRequest(c.req.raw) ? null : c.json({ error: "Forbidden" }, 403);
}

if (opts.dev) {
  await applyDevDefaults();
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
    `lazy=${opts.lazy ? "on" : "off"} backend=${opts.backend} ` +
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

// Skip realpath resolution when serving a prebuilt artifact — the
// source tree typically isn't present on the box, and the gateway
// doesn't need it (the bundles + inline manifests carry every detail
// the dispatcher consults). Empty string is a sentinel for "no
// functions dir"; the only caller that uses this path is the HMR
// watcher, and that's gated off when prebuilt is on.
const resolvedFunctionsPath = opts.prebuiltDir
  ? ""
  : await (async () => {
    try {
      return await Deno.realPath(opts.functionsPath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[1tube] FATAL: functions directory not found: ${opts.functionsPath} (${msg})`);
      flushLogs();
      Deno.exit(EXIT_CODES.CONFIG);
    }
  })();

// Backend selection. The workerd path runs functions inside an isolated
// workerd subprocess. The deno path runs each function in a Web Worker
// so HMR is a clean `worker.terminate()` + new Worker, and so functions
// don't share an isolate (each has its own module cache and globals).
// In both cases the gateway is a thin auth/rate-limit/proxy layer.
let workerdBackend: WorkerdBackend | null = null;
let workerdHotReloader: WorkerdHotReloader | null = null;
let workerdWatchdog: WorkerdWatchdog | null = null;
const workerdNames = new Set<string>();
let denoWorkerHost: DenoWorkerHost | null = null;
let denoHotReloader: DenoHotReloader | null = null;
let denoSharedRuntimeRef: DenoSharedRuntime | null = null;
let denoRewriteCacheRef: RewriteCache | null = null;

if (opts.backend === "workerd") {
  if (opts.workerdInspector) {
    // Surface the security implication BEFORE we bring workerd up so
    // an operator who typo'd `--inspector` on a public host has a
    // chance to ctrl-C before any code runs.
    const isLoopback = /^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(opts.workerdInspector) ||
      /^(127\.0\.0\.1|localhost):/.test(opts.workerdInspector) ||
      /^\d+$/.test(opts.workerdInspector);
    if (!isLoopback) {
      console.warn(
        `[1tube] WARNING: workerd V8 inspector bound to ${opts.workerdInspector} — ` +
          `this is an unauthenticated debug port. Bind to 127.0.0.1 unless you know what you're doing.`,
      );
    } else {
      console.log(
        `[1tube] workerd V8 inspector enabled at ${opts.workerdInspector} ` +
          `(open chrome://inspect or attach via DevTools)`,
      );
    }
  }
  if (opts.prebuiltDir) {
    console.log(`[1tube] Serving prebuilt artifact from: ${opts.prebuiltDir}`);
  } else {
    console.log(`[1tube] Bundling functions from: ${opts.functionsPath}`);
  }
  if (opts.workerdMaxHeapMB) {
    console.log(
      `[1tube] workerd V8 max heap: ${opts.workerdMaxHeapMB}MB (--v8-max-heap-size; per-process, all isolates)`,
    );
  }
  if (opts.killStaleWorkerd) {
    console.log(
      `[1tube] auto-kill leftover workerd: ON (--kill-stale-workerd)`,
    );
  }
  if (opts.workerdCompatibilityDate || (opts.workerdCompatibilityFlags?.length ?? 0) > 0) {
    console.log(
      `[1tube] workerd compatibility: date=${opts.workerdCompatibilityDate ?? "default"} ` +
        `flags=${(opts.workerdCompatibilityFlags ?? []).join(",") || "default"}`,
    );
  }
  if (opts.workerdExperimental) {
    console.log(`[1tube] workerd process experimental mode: ON (--experimental)`);
  }
  workerdBackend = createWorkerdBackend({
    functionsDir: opts.functionsPath,
    // The bundler resolves npm: / jsr: / https: specifiers via Deno's
    // own loader, so it needs the project's deno.json to find the
    // import map and lockfile. Look for one alongside cwd; tests
    // override via the configPath option directly.
    configPath: `${Deno.cwd()}/deno.json`,
    workerdBin: opts.workerdBin,
    envAllowlist: opts.workerdEnv,
    sharedModulePaths: opts.workerdShared,
    ...(opts.workerdBasePort ? { basePort: opts.workerdBasePort } : {}),
    ...(opts.workerdInspector ? { inspectorAddr: opts.workerdInspector } : {}),
    ...(opts.workerdMaxHeapMB ? { maxHeapMB: opts.workerdMaxHeapMB } : {}),
    ...(opts.workerdCompatibilityDate ? { compatibilityDate: opts.workerdCompatibilityDate } : {}),
    ...((opts.workerdCompatibilityFlags?.length ?? 0) > 0
      ? { compatibilityFlags: opts.workerdCompatibilityFlags }
      : {}),
    ...(opts.workerdExperimental ? { experimental: true } : {}),
    ...(opts.killStaleWorkerd ? { killStaleWorkerd: true } : {}),
    ...(opts.prebuiltDir ? { prebuiltDir: opts.prebuiltDir } : {}),
    sourcemap: opts.dev ? "inline" : "linked",
    logLineSink: (line) => {
      // Surface workerd's own logs through stderr with a tag so they
      // interleave with [1tube] output cleanly.
      try { Deno.stderr.writeSync(new TextEncoder().encode(`[workerd] ${line}\n`)); } catch { /* */ }
    },
    onUnexpectedExit: ({ crashCount, expectedRetry }) => {
      if (!expectedRetry) {
        console.error(
          `[1tube] workerd has crashed ${crashCount} times — auto-recovery disabled. ` +
            `Fix the bundle (or restart the gateway) to clear the counter.`,
        );
      }
    },
    // Single re-sync hook for ALL reload triggers (HMR, memory
    // watchdog, crash recovery). Re-bridges the freshly-loaded
    // manifests into the registry + supervisor and refreshes the
    // 404-fast-fail name set so removed functions stop matching
    // and added ones become reachable.
    onReloaded: (newManifests, _result) => {
      registry.clearExternalManifests();
      for (const [n, m] of newManifests) {
        registry.setExternalManifest(n, m);
        supervisor.setManifest(n, m);
      }
      const live = new Set(newManifests.keys());
      for (const old of [...workerdNames]) {
        if (!live.has(old)) supervisor.forget(old);
      }
      workerdNames.clear();
      for (const n of newManifests.keys()) workerdNames.add(n);
    },
  });

  const wdStart = performance.now();
  try {
    await workerdBackend.start();
  } catch (err) {
    console.error("[1tube] FATAL: workerd backend failed during startup:", err);
    flushLogs();
    Deno.exit(EXIT_CODES.CONFIG);
  }
  for (const n of workerdBackend.functionNames) workerdNames.add(n);
  // Bridge workerd manifests into the in-process registry + supervisor.
  // Without this, per-function `rpm` / `timeoutMs` / circuit-breaker
  // settings authored in `1tube.json` would silently fall through to
  // gateway defaults on the workerd path. The supervisor needs the
  // manifest to admit/record requests; the registry's `manifestFor()`
  // is what the rate-limiter consults for lazy candidates and now
  // workerd-backed functions alike.
  for (const [name, manifest] of workerdBackend.manifests) {
    registry.setExternalManifest(name, manifest);
    supervisor.setManifest(name, manifest);
  }
  const wdMs = performance.now() - wdStart;
  console.log(
    `[1tube] workerd backend ready (v${workerdBackend.workerdVersion ?? "?"}) ` +
      `· ${workerdNames.size} function(s) in ${wdMs.toFixed(0)}ms`,
  );
  if (workerdNames.size > 0) {
    console.log(`[1tube] Functions: ${[...workerdNames].sort().join(", ")}`);
  }

  // Memory watchdog. Opt-in via `1TUBE_WORKERD_MAX_RSS_MB`; if unset,
  // we fall back to `recommendedBudgetBytes()` derived from the sum
  // of `manifest.memoryMB` across loaded functions. If THAT also
  // yields nothing (no manifest declares a memory hint), the
  // watchdog stays off — silently, so existing deployments aren't
  // surprised by sudden recycle behaviour.
  const explicitCap = parseInt(Deno.env.get("1TUBE_WORKERD_MAX_RSS_MB") || "", 10);
  const explicitBudget = Number.isFinite(explicitCap) && explicitCap > 0
    ? explicitCap * 1024 * 1024
    : null;
  const recommended = recommendedBudgetBytes(workerdBackend.manifests);
  // Sum of declared per-function memoryMB hints, purely for the
  // boot log so operators know what the recommendation was based on.
  let declaredSum = 0;
  for (const m of workerdBackend.manifests.values()) {
    if (typeof m.memoryMB === "number" && m.memoryMB > 0) declaredSum += m.memoryMB;
  }
  const budget = explicitBudget ?? recommended;
  if (budget !== null) {
    const intervalMs = parseInt(Deno.env.get("1TUBE_WORKERD_RSS_INTERVAL_MS") || "", 10);
    workerdWatchdog = createWorkerdWatchdog({
      backend: workerdBackend,
      budgetBytes: budget,
      ...(Number.isFinite(intervalMs) && intervalMs >= 500
        ? { intervalMs }
        : {}),
    });
    workerdWatchdog.start();
    const src = explicitBudget !== null
      ? "1TUBE_WORKERD_MAX_RSS_MB"
      : `manifest sum (${declaredSum}MB × 1.5 + 64MB overhead)`;
    console.log(
      `[1tube] workerd memory watchdog ON: budget=${(budget / 1024 / 1024).toFixed(0)}MB (source: ${src})`,
    );
  } else {
    console.log(
      `[1tube] workerd memory watchdog OFF (no 1TUBE_WORKERD_MAX_RSS_MB and no manifest.memoryMB declared)`,
    );
  }

  if (opts.hmr) {
    if (opts.prebuiltDir) {
      console.warn(
        "[1tube] --hmr ignored: prebuilt artifacts are sealed. " +
          "Re-run `1tube build` and restart to pick up changes.",
      );
    } else {
      // The hot reloader doesn't need its own onManifestsUpdated hook
      // anymore — the backend's `onReloaded` (wired above) is the one
      // place that re-syncs registry / supervisor / workerdNames for
      // every reload trigger.
      workerdHotReloader = createWorkerdHotReloader({
        functionsDir: resolvedFunctionsPath,
        backend: workerdBackend,
      });
      await workerdHotReloader.start();
    }
  }
} else {
  // Deno backend: each function runs in its own Web Worker so HMR is
  // a clean `worker.terminate()` + new Worker (fresh module cache for
  // the entire dep graph). The dep-graph keeps the affected-set
  // precise — touching a file under `_shared/` only restarts the
  // workers that actually transitively import it.
  if (opts.lazy) {
    console.warn(
      "[1tube] --lazy is ignored on the Deno backend (Workers are spawned eagerly at boot).",
    );
  }
  console.log(`[1tube] Loading functions from: ${opts.functionsPath}`);
  // Pull the deno.json import map (if any) so the dep-graph can
  // resolve bare specifiers to their actual file URLs. Best-effort:
  // missing or malformed JSON degrades to "no import map", which is
  // fine for projects that use only relative imports.
  const denoConfigPath = `${Deno.cwd()}/deno.json`;
  let importMap: Record<string, string> | undefined;
  try {
    const raw = await Deno.readTextFile(denoConfigPath);
    const parsed = JSON.parse(raw) as { imports?: Record<string, string> };
    if (parsed.imports && typeof parsed.imports === "object") {
      importMap = parsed.imports;
    }
  } catch {
    // No host deno.json or it isn't JSON; proceed without an import map.
  }

  // Shared modules (Supabase _shared/profile-cache.ts convention +
  // any explicit --workerd-shared paths) are evaluated ONCE here in
  // the gateway main isolate. Function Workers receive auto-generated
  // RPC stubs in place of the real source via the source rewriter,
  // so a top-level `subscribeToProfileChanges()` runs once total
  // instead of once per Worker.
  const discoveredShared = await discoverSharedModules(
    resolvedFunctionsPath,
    opts.workerdShared ?? [],
  );
  let denoSharedRuntime: DenoSharedRuntime | undefined;
  let denoRewriteCache: RewriteCache | undefined;
  if (discoveredShared.length > 0) {
    denoSharedRuntime = await createDenoSharedRuntime(discoveredShared);
    const cacheDir = await Deno.makeTempDir({ prefix: "1tube-deno-shared-" });
    denoRewriteCache = createRewriteCache({
      cacheDir,
      sharedRuntime: denoSharedRuntime,
    });
    denoSharedRuntimeRef = denoSharedRuntime;
    denoRewriteCacheRef = denoRewriteCache;
    console.log(
      `[1tube] Shared module(s) loaded once in gateway: ${
        discoveredShared.map((m) => m.id).join(", ")
      }`,
    );
  }

  denoWorkerHost = createDenoWorkerHost({
    functionsDir: opts.functionsPath,
    registry,
    supervisor,
    ...(importMap ? { importMap, importMapBase: denoConfigPath } : {}),
    ...(denoSharedRuntime ? { sharedRuntime: denoSharedRuntime } : {}),
    ...(denoRewriteCache ? { rewriteCache: denoRewriteCache } : {}),
  });

  // Boot progress: append-only `[i/N] ✓ name (123ms)` per worker plus
  // a heartbeat every 2s so a project with many functions / a slow
  // import shows progress instead of looking hung. Suppressed for
  // small projects (≤2 functions) where the per-completion line is
  // already enough signal.
  const bootStart = performance.now();
  const progress = createBootProgress(Deno.stdout, { pulseMs: 2000 });
  let started = false;
  const padTo = (n: number, width: number) =>
    String(n).padStart(width, " ");
  // Workers spawn in parallel, so `p.index` (assigned at spawn-start
  // time) doesn't match the order in which finish lines are printed
  // — the result reads as a jumbled `[8/53] ... [4/53] ... [7/53]`.
  // Track a separate "print order" counter so the output reads
  // monotonically. We still get the correct total + per-fn name +
  // duration; the only thing that changes is the column we display.
  let printOrder = 0;
  const { loaded, errors } = await denoWorkerHost.start({
    onSpawnStart: (p) => {
      if (!started) {
        progress.start(p.total);
        started = true;
      }
      progress.onStart(p.name);
    },
    onSpawnFinish: (p) => {
      const w = String(p.total).length;
      const status = p.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
      const tail = p.ok ? "" : ` — ${p.error ?? "error"}`;
      const idx = ++printOrder;
      progress.onFinish(
        `[1tube] [${padTo(idx, w)}/${p.total}] ${status} ${p.name} ` +
          `\x1b[2m(${p.durationMs.toFixed(0)}ms)\x1b[0m${tail}`,
        p.name,
      );
    },
  });
  progress.stop();
  const bootMs = performance.now() - bootStart;
  console.log(
    `[1tube] Loaded ${loaded.length} function(s) in ${bootMs.toFixed(0)}ms`,
  );
  if (loaded.length > 0) {
    console.log(`[1tube] Functions: ${[...loaded].sort().join(", ")}`);
  }
  if (errors.length > 0) {
    console.error(
      `[1tube] ${errors.length} function(s) failed to load (check .env for missing vars):`,
    );
    for (const e of errors) console.error(`  ${e.name}: ${e.error}`);
  }

  if (opts.hmr) {
    denoHotReloader = createDenoHotReloader({
      host: denoWorkerHost,
      functionsDir: opts.functionsPath,
      ...(denoSharedRuntime ? { sharedRuntime: denoSharedRuntime } : {}),
      ...(denoRewriteCache ? { rewriteCache: denoRewriteCache } : {}),
    });
    await denoHotReloader.start();
  } else {
    console.log("[1tube] HMR disabled (set 1TUBE_HMR=1 or pass --hmr to enable)");
  }
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

/** Set on authenticated function calls; read in logging middleware. */
type GatewayVariables = { userId?: string };

const app = new Hono<{ Variables: GatewayVariables }>();
// Operators can bump the default RPM cap via `1TUBE_DEFAULT_RPM`. The
// hard-coded fallback (120 = 2 rps) is conservative and trips
// benchmarking tools immediately, so the script in `scripts/bench.ts`
// sets a high value when running. Per-function manifests still win.
// Operators tuning the global default for prod use `1TUBE_DEFAULT_RPM`;
// load-testers needing zero limits use `1TUBE_DISABLE_RATE_LIMIT=1`,
// honoured inside the limiter factory itself.
const defaultRpmEnv = parseInt(Deno.env.get("1TUBE_DEFAULT_RPM") || "", 10);
const rpmOverride = Number.isFinite(defaultRpmEnv) && defaultRpmEnv > 0
  ? defaultRpmEnv
  : null;
if (rpmOverride !== null) {
  console.log(`[1tube] default rpm overridden via 1TUBE_DEFAULT_RPM=${rpmOverride}`);
}
const rateLimiter = createRateLimiter({
  registry,
  ...(rpmOverride !== null ? { defaultRpm: rpmOverride } : {}),
});

// Middleware order matters:
//   1. CORS (handle preflight before anything else can short-circuit)
//   2. Fast-fail unknown function names (no auth/rate-limit cost for scans)
//   3. Logging (wraps everything below)
//   4. Body size cap (reject early before reading the body)
//   5. JWT auth probe (sets c.userId when token is valid; does NOT enforce
//      auth here — the dispatcher decides per function based on `isPublic`)
//   6. Rate limiter (now sees a real userId for per-user keying)
app.use("/functions/v1/*", corsMiddleware);
// Backend-aware function-existence probe. On the workerd backend the
// bundled-set captured at boot is the source; on the deno backend the
// registry's worker-handle map is. Both expose the same Map-lookup-cost
// contract.
const functionExists = (name: string): boolean =>
  opts.backend === "workerd" ? workerdNames.has(name) : registry.has(name);

app.use("/functions/v1/*", async (c, next) => {
  // Fast-fail unknown function names before paying for logging, auth, body
  // limit, and rate-limit. Without this, a scanner hammering random names
  // exhausts rate-limit buckets keyed by IP and pollutes the log stream.
  const path = c.req.path;
  const prefix = "/functions/v1/";
  if (path.length > prefix.length) {
    const after = path.slice(prefix.length);
    const slash = after.indexOf("/");
    const name = slash === -1 ? after : after.slice(0, slash);
    if (name && !functionExists(name)) {
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

  // Workerd backend dispatch path. Same gateway pipeline (CORS, auth
  // probe, body limit, rate limit, body-watchdog) is applied above —
  // here we translate the validated request into a proxy call to the
  // right workerd service, and gate it through the same circuit-
  // breaker the Deno path uses. Per-function timeouts come from the
  // manifest (loaded at workerd boot and registered with `registry`
  // + `supervisor`); request bodies still pass through the body-read
  // watchdog so a slow client can't pin a workerd-backed slot.
  if (opts.backend === "workerd" && workerdBackend) {
    const wdManifest = workerdBackend.manifests.get(name);

    // Gate on the supervisor BEFORE forwarding so an open breaker
    // fails fast — never wakes the workerd subprocess for a request
    // we'd reject anyway. This mirrors the Deno path exactly.
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

    const abort = new AbortController();
    const rawBody = c.req.raw.body;
    const wrappedBody = rawBody !== null
      ? watchdogBody(rawBody, opts.bodyReadIdleMs, abort, (idleMs) => {
          console.warn(
            `[1tube] Body read stalled in "${name}" (no progress in ${idleMs}ms) — aborting request.`,
          );
        }).body
      : null;
    // Mirror the Deno-path URL rewrite: user code expects to see the
    // pathname without the `/functions/v1` prefix, matching Supabase
    // Edge Runtime behaviour. Without this strip, hello/echo see the
    // gateway prefix in their `new URL(req.url).pathname`.
    const originalUrl = new URL(c.req.raw.url);
    const rewrittenPath = originalUrl.pathname.replace(/^\/functions\/v1/, "") || "/";
    const rewrittenUrl = new URL(rewrittenPath + originalUrl.search, originalUrl.origin);
    const proxyReq = new Request(rewrittenUrl.toString(), {
      method: c.req.raw.method,
      headers: c.req.raw.headers,
      body: wrappedBody,
      signal: abort.signal,
      // @ts-ignore -- Deno supports duplex on Request
      duplex: "half",
    });
    const auth = (c as any).get("__authContext") ?? null;

    // Per-function timeout from the manifest, falling back to the
    // gateway-wide default. Same precedence the Deno path uses.
    const timeoutMs = wdManifest?.timeoutMs ?? opts.defaultTimeoutMs;
    const timer = timeoutMs > 0
      ? setTimeout(() => abort.abort(new Error(`workerd dispatch timed out after ${timeoutMs}ms`)), timeoutMs)
      : null;

    let response: Response;
    let errored = false;
    try {
      response = await workerdBackend.dispatch(proxyReq, name, auth, abort.signal);
    } catch (err) {
      errored = true;
      const reasonMsg = (abort.signal.reason as Error | undefined)?.message ?? "";
      if (err instanceof DOMException && err.name === "AbortError" && reasonMsg.includes("timed out")) {
        response = c.json({ error: "Function execution timed out" }, 504);
      } else if (
        err instanceof DOMException && err.name === "AbortError" && reasonMsg.includes("Body read stalled")
      ) {
        response = c.json({ error: "Request body read timed out" }, 408);
      } else {
        console.error(`[1tube] workerd dispatch failed for "${name}":`, err);
        response = c.json({ error: "Internal server error" }, 500);
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    if (response.status >= 500) errored = true;

    // Record outcome with the supervisor so repeated failures trip
    // the breaker. We only record when we actually have a manifest —
    // otherwise the supervisor is a no-op for this name and there's
    // nothing for it to act on (`admit()` already returned `ok`).
    if (wdManifest) {
      const outcome = supervisor.record(name, errored);
      if (outcome.breakerJustTripped) {
        console.warn(
          `[1tube] Circuit breaker OPEN for "${name}" (workerd) — refusing requests for ${
            wdManifest.recycle.cooldownMs
          }ms (errorRate >= ${wdManifest.recycle.errorRate}).`,
        );
      }
      if (outcome.recycleJustRecommended) {
        console.warn(
          `[1tube] "${name}" reached ${wdManifest.recycle.maxRequests} invocations (workerd) — recycle recommended.`,
        );
      }
    }

    return response;
  }

  // Deno backend dispatch path: forward the request to the function's
  // Worker over postMessage. Each function lives in its own Worker so
  // there's no in-process handler to invoke; HMR works by terminating
  // the worker (clean module cache) and spawning a fresh one.
  const handle = registry.workerHandle(name);
  if (!handle) {
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

  const timeoutMs = handle.timeoutMs ?? handle.manifest.timeoutMs ??
    opts.defaultTimeoutMs;

  // Strip /functions/v1 prefix to match Supabase Edge Runtime behavior.
  const originalUrl = new URL(c.req.raw.url);
  const rewrittenPath = originalUrl.pathname.replace(/^\/functions\/v1/, "") || "/";
  const rewrittenUrl = new URL(rewrittenPath + originalUrl.search, originalUrl.origin);

  const abort = new AbortController();

  // Slow-loris watchdog around any actual body stream, same as the
  // workerd path. The watchdog aborts the request signal we forward to
  // the worker if the client stalls mid-upload.
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

  const auth = (c as any).get("__authContext") ?? null;
  if (!handle.isPublic && !auth) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const timer = timeoutMs > 0
    ? setTimeout(
      () =>
        abort.abort(
          new Error(`Function "${name}" timed out after ${timeoutMs}ms`),
        ),
      timeoutMs,
    )
    : null;

  let response: Response;
  let errored = false;
  try {
    response = await handle.dispatch(rewrittenReq, auth, abort.signal);
  } catch (err) {
    errored = true;
    const reasonMsg = (abort.signal.reason as Error | undefined)?.message ?? "";
    if (
      err instanceof DOMException && err.name === "AbortError" &&
      reasonMsg.includes("timed out")
    ) {
      console.error(`[1tube] Function "${name}" timed out after ${timeoutMs}ms`);
      response = c.json({ error: "Function execution timed out" }, 504);
    } else if (
      err instanceof DOMException && err.name === "AbortError" &&
      reasonMsg.includes("Body read stalled")
    ) {
      response = c.json({ error: "Request body read timed out" }, 408);
    } else {
      console.error(`[1tube] Unhandled error in "${name}":`, err);
      response = c.json({ error: "Internal server error" }, 500);
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }

  if (response.status >= 500) errored = true;

  const outcome = supervisor.record(name, errored);
  if (outcome.breakerJustTripped) {
    console.warn(
      `[1tube] Circuit breaker OPEN for "${name}" — refusing requests for ${
        handle.manifest.recycle.cooldownMs
      }ms (errorRate >= ${handle.manifest.recycle.errorRate}).`,
    );
  }
  if (outcome.recycleJustRecommended) {
    console.warn(
      `[1tube] "${name}" reached ${handle.manifest.recycle.maxRequests} invocations — recycle recommended.`,
    );
  }

  return response;
});

// Health & observability
app.get(
  "/health",
  createHealthHandler(
    registry,
    internalKey,
    supervisor,
    workerdBackend
      ? () => ({
        pid: workerdBackend!.pid,
        generation: workerdBackend!.generation,
        recycles: workerdWatchdog?.stats.recycles ?? 0,
        rss_bytes: workerdWatchdog?.stats.lastRssBytes ?? null,
        budget_bytes: workerdWatchdog?.stats.budgetBytes ?? null,
        last_reload_duration_ms: workerdBackend!.lastReloadDurationMs,
        bundle_bytes: Object.fromEntries(workerdBackend!.bundleBytes),
      })
      : undefined,
  ),
);
app.get(
  "/metrics",
  createMetricsHandler(internalKey, () => {
    // Cheap snapshot built fresh on every scrape so dashboards always
    // see live state. Both branches are safe to call even when the
    // respective subsystem is empty (Deno-only mode → no workerd
    // block; supervisor with zero functions → empty breakers map).
    const extras: import("./gateway/logging.ts").PrometheusExtras = {
      breakers: Object.fromEntries(
        Object.entries(supervisor.allStats()).map(([name, s]) => [name, {
          breakerOpen: s.breakerOpen,
          recycleRecommended: s.recycleRecommended,
          errorRate: s.errorRate,
        }]),
      ),
    };
    if (workerdBackend) {
      extras.workerd = {
        pid: workerdBackend.pid,
        generation: workerdBackend.generation,
        recycles: workerdWatchdog?.stats.recycles ?? 0,
        rss_bytes: workerdWatchdog?.stats.lastRssBytes ?? null,
        budget_bytes: workerdWatchdog?.stats.budgetBytes ?? null,
        last_reload_duration_ms: workerdBackend.lastReloadDurationMs,
        bundle_bytes: Object.fromEntries(workerdBackend.bundleBytes),
      };
    }
    return extras;
  }),
);

async function runFunctionAdmin(c: Context, action: (backend: WorkerdBackend) => Promise<Response>): Promise<Response> {
  const forbidden = requireInternal(c);
  if (forbidden) return forbidden;
  if (!workerdBackend) {
    return c.json({ error: "Edge function editor is available only with backend=workerd" }, 503);
  }
  try {
    return await action(workerdBackend);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
}

app.get("/1tube/api/functions", (c) =>
  runFunctionAdmin(c, async (backend) => c.json({
    functions: await backend.listEditableFunctions(),
  }))
);

app.get("/1tube/api/functions/:name/source", (c) =>
  runFunctionAdmin(c, async (backend) => c.json(await backend.readEditableSource(c.req.param("name"))))
);

app.post("/1tube/api/functions", (c) =>
  runFunctionAdmin(c, async (backend) => {
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return c.json({ error: "Missing function name" }, 400);
    }
    const source = await backend.createEditableFunction(body.name);
    return c.json({ source, functions: await backend.listEditableFunctions() }, 201);
  })
);

app.put("/1tube/api/functions/:name/source", (c) =>
  runFunctionAdmin(c, async (backend) => {
    const body = await c.req.json().catch(() => ({})) as { files?: unknown };
    if (!body.files || typeof body.files !== "object" || Array.isArray(body.files)) {
      return c.json({ error: "Expected JSON body { files: { path: content } }" }, 400);
    }
    const reload = await backend.saveEditableSource(
      c.req.param("name"),
      { files: body.files as Record<string, string> },
    );
    return c.json({ reload, functions: await backend.listEditableFunctions() });
  })
);

app.delete("/1tube/api/functions/:name", (c) =>
  runFunctionAdmin(c, async (backend) => {
    const reload = await backend.deleteEditableFunction(c.req.param("name"));
    return c.json({ reload, functions: await backend.listEditableFunctions() });
  })
);

app.post("/1tube/api/functions/:name/revert", (c) =>
  runFunctionAdmin(c, async (backend) => {
    const reload = await backend.revertEditableFunction(c.req.param("name"));
    return c.json({ reload, functions: await backend.listEditableFunctions() });
  })
);

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
  const totalGraceMs = opts.shutdownGraceMs;
  console.log(`[1tube] Shutdown requested (${reason}); draining up to ${totalGraceMs}ms...`);
  const shutdownStartedAt = performance.now();
  const remaining = () => Math.max(0, totalGraceMs - (performance.now() - shutdownStartedAt));

  // Stop the workerd watchdog FIRST so a poll racing this shutdown
  // can't observe a half-down workerd and trigger a doomed recycle
  // mid-drain. Same reason we stop the hot reloader before we stop
  // the backend itself.
  if (workerdWatchdog) workerdWatchdog.stop();
  if (workerdHotReloader) {
    workerdHotReloader.stop().catch((err) => {
      console.warn("[1tube] workerd hot reloader stop() error:", err);
    });
  }
  if (denoHotReloader) {
    denoHotReloader.stop().catch((err) => {
      console.warn("[1tube] deno hot reloader stop() error:", err);
    });
  }

  // Phase 1: stop accepting NEW connections. Already-accepted
  // requests keep running against the still-live workerd. This is
  // the call that lets `server.finished` eventually resolve.
  serverAbort.abort();

  // Phase 2: wait for the gateway's in-flight requests to drain.
  // Critically, we await BEFORE tearing down workerd — the previous
  // implementation fired-and-forgot workerd.stop() in parallel with
  // the drain, which killed workerd while requests were still
  // forwarding through it (502s on the way out).
  const drainStart = performance.now();
  const drained = await Promise.race([
    server.finished.then(() => "drained" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), remaining())),
  ]);
  const drainMs = performance.now() - drainStart;
  if (drained === "timeout") {
    console.warn(
      `[1tube] Gateway drain grace expired after ${drainMs.toFixed(0)}ms; ` +
        `forcing workerd teardown — some in-flight requests may have been dropped.`,
    );
  } else {
    console.log(`[1tube] Gateway drained ${drainMs.toFixed(0)}ms; tearing down workerd...`);
  }

  // Phase 3: stop the workerd subprocess. Now safe to tear down —
  // either the gateway has no in-flight requests left, or grace
  // expired and we'd drop them anyway. Bound by whatever shutdown
  // budget remains; if the drain ate the whole grace we still give
  // workerd a fixed minimum (1s) to terminate gracefully so its log
  // pumps can flush a final line before SIGKILL.
  if (workerdBackend) {
    const wdGraceMs = Math.max(1000, remaining());
    const wdStart = performance.now();
    const wdResult = await Promise.race([
      workerdBackend.stop().then(() => "stopped" as const).catch((err) => {
        console.warn("[1tube] workerd backend stop() error:", err);
        return "stopped" as const;
      }),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), wdGraceMs)),
    ]);
    const wdMs = performance.now() - wdStart;
    if (wdResult === "timeout") {
      console.warn(`[1tube] workerd stop() did not return within ${wdGraceMs}ms — abandoning.`);
    } else {
      console.log(`[1tube] workerd stopped in ${wdMs.toFixed(0)}ms.`);
    }
  }

  // Phase 3 (deno): terminate every per-function Worker. Bounded by
  // whatever shutdown grace remains; teardown is fast (just SIGKILL
  // equivalents in V8 isolate-land) so we don't bother racing it.
  if (denoWorkerHost) {
    await denoWorkerHost.stop().catch((err) => {
      console.warn("[1tube] deno worker host stop() error:", err);
    });
  }
  if (denoSharedRuntimeRef) {
    await denoSharedRuntimeRef.stop().catch((err) => {
      console.warn("[1tube] deno shared runtime stop() error:", err);
    });
  }
  if (denoRewriteCacheRef) {
    await denoRewriteCacheRef.stop().catch(() => {});
  }

  flushLogs();
  console.log("[1tube] Drain complete; exiting.");
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
