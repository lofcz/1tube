/**
 * Workerd backend orchestrator.
 *
 * Glues bundler + capnp generator + process manager into the surface
 * `src/server.ts` consumes:
 *
 *   1. {@link createWorkerdBackend} returns a {@link WorkerdBackend}
 *      handle without doing any work yet.
 *   2. `start()` discovers function entrypoints, bundles them all into
 *      a cache directory, generates the capnp config, writes it
 *      alongside the bundles, and spawns workerd. It resolves only
 *      after every per-function socket is reachable.
 *   3. `dispatch(req, fnName, auth)` proxies a single request — already
 *      authenticated and rate-limited by the gateway — to the right
 *      workerd socket, injecting the `X-1tube-Auth-*` headers the
 *      bundle wrapper reads when reconstructing `AuthContext`.
 *   4. `stop()` tears down workerd and disposes the bundler. Called
 *      from the gateway's signal handlers.
 *
 * The cache layout under `<cacheDir>/`:
 *
 *     <name>.js          — esbuild bundle
 *     <name>.js.map      — sourcemap (when enabled)
 *     config.capnp       — generated workerd config
 *     .gitignore         — forces the dir to be ignored by git
 *
 * `cacheDir` defaults to `node_modules/.cache/1tube-workerd/` when a
 * `node_modules/` directory exists next to the gateway's cwd, falling
 * back to `.1tube-cache/workerd/`. Either path is conventionally
 * gitignored, but we drop a `.gitignore` inside it as a belt-and-
 * braces guarantee.
 */

import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { type AuthContext } from "../../registry.ts";
import { type FunctionManifest, loadManifest } from "../../manifest.ts";
import {
  bundleSharedModule,
  type BundleResult,
  type Bundler,
  createBundler,
  discoverEntrypoints,
  discoverSharedModules,
} from "./bundler.ts";
import {
  parsePrebuiltManifest,
  type PrebuiltManifest,
} from "./prebuilt.ts";
import { type CapnpRoute, generateCapnp } from "./capnp.ts";
import {
  SHARED_RUNTIME_TOKEN_ENV,
  SHARED_RUNTIME_URL_ENV,
  startWorkerdSharedRuntime,
  type SharedRuntimeModule,
  type WorkerdSharedRuntime,
} from "./shared-runtime.ts";
import {
  createWorkerdProcess,
  isCompatDateAtMost,
  maxCompatDateFromVersion,
  probeVersion,
  type WorkerdProcess,
} from "./process.ts";

export interface WorkerdBackendOptions {
  /** Directory containing per-function `index.ts` entrypoints. */
  functionsDir: string;
  /** Path to the host project's deno.json (for the bundler's import map). */
  configPath: string;
  /** Path or PATH-resolvable name of the workerd binary. Defaults to `"workerd"`. */
  workerdBin?: string;
  /**
   * Directory where bundles + capnp + sourcemaps are written. Optional;
   * defaults to `node_modules/.cache/1tube-workerd/` when a sibling
   * `node_modules/` exists, else `.1tube-cache/workerd/`.
   */
  cacheDir?: string;
  /** Loopback address for workerd sockets. Defaults to `"127.0.0.1"`. */
  bindAddress?: string;
  /** First port to assign to a function. Defaults to `8800`. */
  basePort?: number;
  /** Compatibility date for every service. See capnp.ts for the default. */
  compatibilityDate?: string;
  /** Compatibility flags applied to every service. */
  compatibilityFlags?: readonly string[];
  /** Sourcemap mode passed to the bundler. */
  sourcemap?: boolean | "linked" | "inline";
  /** Sink for workerd's [workerd]-prefixed log lines. Defaults to stderr. */
  logLineSink?: (line: string) => void;
  /** Bundler concurrency. Defaults to 4. */
  bundleConcurrency?: number;
  /**
   * Enable workerd's V8 inspector and bind it to the given address
   * (`host:port`). When present, every spawned workerd is launched
   * with `--inspector-addr=<host>:<shifted-port>`; the port is shifted
   * by one each generation slot so an HMR-spawned successor doesn't
   * collide with the still-listening predecessor. Operators attach
   * via Chrome DevTools' `chrome://inspect` (auto-discovers loopback)
   * or a fixed devtools URL printed at boot.
   *
   * Off by default — opens an unauthenticated debug port and should
   * not be enabled in shared / production environments. Honour
   * loopback (`127.0.0.1`) unless the operator explicitly opts into
   * an external bind.
   */
  inspectorAddr?: string;
  /**
   * Hard cap on the V8 old-generation heap (MB) for every workerd
   * generation we spawn. When set, translates to `--v8-max-heap-size=N`
   * on the workerd CLI, which V8 enforces with `OutOfMemoryError`
   * before the process bloats further. The watchdog still polls RSS
   * as a backstop because non-heap memory (compiled code, native
   * allocations) lives outside V8's accounting.
   *
   * Note: this is per workerd *process*, not per function. Workerd
   * OSS does not expose per-isolate caps — every isolate inside the
   * same workerd shares this ceiling. Sized too small the runtime
   * will OOM under normal load; sized too large the cap stops
   * mattering. Operators typically set it close to the watchdog
   * RSS budget, since heap dominates RSS for AI-SDK-shaped workloads.
   */
  maxHeapMB?: number;
  /**
   * Restrict the backend to a specific subset of functions. When
   * omitted, every function discovered in `functionsDir` is bundled.
   * Used by milestone 1's e2e test to scope the backend to just hello+echo.
   */
  only?: readonly string[];
  /**
   * When set, boot in **prebuilt mode**: skip esbuild entirely and read
   * the function set from `<prebuiltDir>/manifest.json`. The bundles
   * are expected to already exist on disk next to the manifest, exactly
   * as written by `1tube build --out <prebuiltDir>`.
   *
   * In this mode `functionsDir` is ignored, no bundler is created (so
   * the operator does not need esbuild's worker subprocess on the box),
   * and `reload()` is unsupported — the artifact is sealed. HMR must
   * not be enabled by the gateway when this is set.
   *
   * Bundle integrity is verified against the manifest's recorded
   * sha-256 at boot, so a tampered bundle fails fast with a clear
   * error rather than silently running modified code.
   */
  prebuiltDir?: string;
  /**
   * Source modules that should run once in the gateway process and be
   * consumed from workerd isolates via generated RPC stubs. Paths are
   * resolved relative to `functionsDir` unless absolute. The
   * Supabase-style `_shared/profile-cache.ts` module is included by
   * convention when present, even if this list is empty.
   */
  sharedModulePaths?: readonly string[];
  /**
   * Names of env vars to forward to every function via workerd's
   * `fromEnvironment` bindings. Each listed name appears under
   * `Deno.env.get(name)` (and the worker's `env` parameter) inside the
   * bundled function, with the value workerd reads from its own
   * process env at boot. Values are NEVER written into the on-disk
   * `config.capnp`.
   *
   * Resolution (highest precedence first):
   *
   *   1. Explicit list passed here (or via `--workerd-env=A,B,C`).
   *   2. Comma-separated `1TUBE_WORKERD_ENV` operator override.
   *   3. **Default: forward every env var the gateway can see.**
   *      Bundled functions behave like a regular Node/Deno script
   *      that inherits its parent's environment. The literal `["*"]`
   *      is the explicit form of the same default, useful when the
   *      operator wants to make their intent obvious in CI.
   *
   * Pass an explicit allowlist when you care about isolation — e.g.
   * shared multi-tenant workerds, or build artifacts where the
   * baked-in env surface should be reproducible. Names that are listed
   * but absent from the parent process env are dropped silently
   * (workerd would otherwise refuse to start), with a single grouped
   * warning logged at boot so misconfigurations stay visible.
   */
  envAllowlist?: readonly string[];
  /**
   * When true and the boot-time port preflight finds at least one of
   * the workerd socket ports already busy, attempt to clean up by
   * running the platform's "kill workerd by name" hammer (`taskkill
   * /F /IM workerd.exe` on Windows, `pkill -9 -x workerd` on Unix)
   * and re-probing. Anything that survives still surfaces the normal
   * port-conflict error, so non-workerd processes (nginx, another
   * team's container, …) are never disturbed. See
   * {@link killStaleWorkerd} for the full rationale on why we use
   * image-name matching instead of port→PID resolution.
   *
   * Off by default — auto-killing processes is exactly the kind of
   * "magic" that surprises operators in production. Recommended dev
   * config: enable via the `--kill-stale-workerd` CLI flag or the
   * `1TUBE_KILL_STALE_WORKERD=1` env var when running 1tube alongside
   * other tooling that may leak workerd subprocesses on iteration.
   */
  killStaleWorkerd?: boolean;
  /**
   * Called when the workerd subprocess exits unexpectedly (i.e. the
   * gateway didn't ask it to stop). The backend will already have
   * scheduled an automatic recycle via {@link WorkerdBackend.reload}
   * before this fires; the callback is purely for observability
   * (log lines, metrics, alerts).
   *
   * The callback is invoked once per crash. `expectedRetry === false`
   * means the backend has given up auto-restart (too many crashes
   * in too short a window) — operator intervention required.
   */
  onUnexpectedExit?: (info: {
    code: number | null;
    generation: number;
    crashCount: number;
    expectedRetry: boolean;
  }) => void;
  /**
   * Called after every successful reload — whether triggered by HMR,
   * the memory watchdog, or crash recovery. Lets the gateway re-sync
   * dependent state (registry's external-manifest map, supervisor
   * counters, the workerdNames fast-fail set) through a single hook
   * regardless of *why* the reload happened.
   *
   * Errors thrown from this callback are logged but do NOT roll
   * back the reload — the new workerd is already serving by the
   * time this fires.
   */
  onReloaded?: (
    manifests: ReadonlyMap<string, FunctionManifest>,
    result: WorkerdReloadResult,
  ) => void;
}

/**
 * Result of a successful {@link WorkerdBackend.reload} call. The hot
 * reloader uses this to re-sync the gateway's registry / supervisor
 * (manifest changes) and to log a one-line summary of what changed.
 */
export interface WorkerdReloadResult {
  /** Wall-clock duration of the swap, including the new process boot. */
  durationMs: number;
  /** Functions present after the reload but not before (new dirs). */
  added: readonly string[];
  /** Functions present before but not after (deleted dirs). */
  removed: readonly string[];
  /** Existing functions whose bundle was rebuilt for this reload. */
  rebundled: readonly string[];
  /** Generation number of the new process (monotonic, starts at 1 after start()). */
  generation: number;
}

export interface WorkerdBackend {
  /**
   * PID of the currently-running workerd child, or `null` when the
   * backend hasn't started, has been stopped, or is mid-recycle
   * (between old-process exit and new-process readiness). The memory
   * watchdog reads this on every poll so it always sees the live
   * process even after a crash-recovery swap.
   */
  readonly pid: number | null;
  /**
   * Generation counter — bumps every successful reload (HMR,
   * watchdog, crash recovery). Starts at 0 after `start()`. Useful
   * as a low-cost "did the backend recycle since I last checked?"
   * probe (surfaced on /health for ops + the e2e crash test).
   */
  readonly generation: number;
  /** Bundle, generate capnp, spawn workerd. Resolves on readiness. */
  start(): Promise<void>;
  /**
   * Hot-reload the running backend with zero gateway downtime.
   *
   * Re-bundles the named functions (or every function when `changed`
   * is undefined / `"all"`), spawns a *new* workerd process on
   * shifted ports, waits for it to be ready, then atomically swaps
   * the route table the dispatcher consults. Only after the swap is
   * the old workerd torn down.
   *
   * In-flight requests against the old process keep running to
   * completion against their original socket — the swap only changes
   * which origin *new* requests are forwarded to. Failed bundles
   * abort the swap entirely; the old process keeps serving and the
   * caller gets the bundling error.
   *
   * Serialised internally: concurrent callers queue behind the
   * in-flight reload. Throws when called before `start()`.
   */
  reload(changed?: ReadonlySet<string> | "all"): Promise<WorkerdReloadResult>;
  /**
   * Forward a request to the workerd service for `fnName`. Auth is
   * already validated upstream; we just attach the verified identity
   * as internal headers. Returns whatever workerd returns, including
   * status and body.
   *
   * Throws when the function isn't part of this backend (unknown name)
   * or when the backend hasn't started yet — both are programmer
   * errors and indicate the gateway routed badly.
   */
  dispatch(
    req: Request,
    fnName: string,
    auth: AuthContext | null,
    signal?: AbortSignal,
  ): Promise<Response>;
  /** Names of functions served by this backend (sorted). */
  readonly functionNames: readonly string[];
  /** Workerd version reported by `--version` at start, or `null` if unknown. */
  readonly workerdVersion: string | null;
  /**
   * Per-function manifests loaded from `<dir>/<name>/1tube.json` at boot.
   * Functions without a manifest file get `defaultManifest()`. The
   * gateway consults this map to wire per-function `rpm`, `timeoutMs`,
   * and circuit-breaker config — same source of truth the Deno path
   * uses, just populated by the workerd discovery loop instead of
   * Deno's import hook.
   */
  readonly manifests: ReadonlyMap<string, FunctionManifest>;
  /**
   * Per-function bundle size in bytes (esbuild output). Updated on every
   * successful reload — passthrough functions keep their previous byte
   * count rather than getting a misleading 0. Surfaced on /metrics so
   * operators can spot a function whose bundle just doubled and on
   * /health for one-shot ops debugging.
   */
  readonly bundleBytes: ReadonlyMap<string, number>;
  /**
   * Wall-clock duration of the most recent successful reload, in
   * milliseconds. `null` until the first reload (i.e. for fresh
   * boots that haven't hot-swapped yet). Driven off
   * {@link WorkerdReloadResult.durationMs} so /metrics matches
   * exactly what the e2e tests assert on.
   */
  readonly lastReloadDurationMs: number | null;
  /** Tear down workerd and dispose esbuild's worker. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Pick the default cache directory based on the layout of the host
 * project. Falls back to a project-local hidden dir when there's no
 * `node_modules/` (e.g. plain Deno projects). Both candidates are
 * conventionally gitignored.
 */
async function defaultCacheDir(cwd: string): Promise<string> {
  const nm = join(cwd, "node_modules");
  try {
    const stat = await Deno.stat(nm);
    if (stat.isDirectory) {
      return join(nm, ".cache", "1tube-workerd");
    }
  } catch {
    // node_modules absent — fall through.
  }
  return join(cwd, ".1tube-cache", "workerd");
}

/**
 * Best-effort guard so the cache dir never gets accidentally committed.
 * Workerd-bundles include resolved npm/jsr/https sources, so checking
 * them in would defeat both reproducibility and security review.
 */
async function writeGitignore(cacheDir: string): Promise<void> {
  const path = join(cacheDir, ".gitignore");
  // Idempotent: only write if absent so we don't churn mtime on every boot.
  try {
    await Deno.stat(path);
    return;
  } catch {
    // missing — write below
  }
  await Deno.writeTextFile(path, "# Generated by 1tube workerd backend\n*\n");
}

/**
 * Probe each socket the about-to-spawn workerd will bind to, and throw
 * a clear error if anything is already listening.
 *
 * Why this exists: workerd binds these sockets internally — by the time
 * its `serve()` call complains, the gateway has already wired up its
 * route table to the (busy) ports. The most common cause is a leftover
 * workerd from a previous run still listening on the default
 * `8800..8800+N` range, which silently intercepts the new gateway's
 * proxy traffic and routes it to whatever bundle the zombie loaded.
 * Symptoms range from "wrong response body" to opaque 405s — see
 * https://github.com/lordoolric/1tube + the e2e test runbook.
 *
 * The check is best-effort. We bind, immediately close, and trust that
 * a TOCTOU race (something binds the port between our close() and
 * workerd's bind() microseconds later) is far less likely than the
 * zombie-process case we're catching. On Windows the bind would fail
 * with `AddrInUse`, on Linux with `EADDRINUSE` — both surface as
 * `Deno.errors.AddrInUse`.
 *
 * Exported so tests can construct a precise fixture (a real listener)
 * and assert the error message format.
 */
export interface PortConflict {
  name: string;
  address: string;
  port: number;
}

export function probeSocketsFree(
  sockets: readonly { name: string; address: string; port: number }[],
): PortConflict[] {
  const conflicts: PortConflict[] = [];
  for (const s of sockets) {
    try {
      const l = Deno.listen({ hostname: s.address, port: s.port, transport: "tcp" });
      l.close();
    } catch (err) {
      if (err instanceof Deno.errors.AddrInUse) {
        conflicts.push({ name: s.name, address: s.address, port: s.port });
        continue;
      }
      // Permission-denied (privileged port) and friends should still
      // surface — they're not zombie-related, they're operator config.
      throw err;
    }
  }
  return conflicts;
}

export interface KillStaleResult {
  /** Whether we attempted a kill at all (false ⇒ no platform support). */
  attempted: boolean;
  /** Command we ran, for diagnostics. */
  command?: readonly string[];
  /** Process exit code, if attempted. `0` is success on both kill tools. */
  code?: number;
  /** Captured stderr (truncated), useful when the kill failed. */
  stderr?: string;
  /** Human-readable stdout for targeted port cleanup. */
  stdout?: string;
}

/**
 * Kill only workerd processes that own the specific conflicted ports.
 * This is the safe first choice for flashing: if a zombie candidate
 * still owns 8800, remove that exact process; if nginx/node/etc. owns
 * the port, leave it alone and let the preflight error explain the
 * non-workerd conflict.
 */
export async function killWorkerdOwnersOfPorts(
  conflicts: readonly PortConflict[],
): Promise<KillStaleResult> {
  if (conflicts.length === 0) return { attempted: false };
  if (Deno.build.os !== "windows") {
    // Keep POSIX on the existing typed name-based path; resolving
    // port->pid portably needs lsof/ss/netstat variants that are not
    // guaranteed on minimal server images.
    return { attempted: false };
  }

  const ports = [...new Set(conflicts.map((c) => c.port))].map(String);
  const script = `
$ErrorActionPreference = 'Continue'
$ports = @(${ports.map((p) => `'${p.replaceAll("'", "''")}'`).join(",")})
$killed = @()
$skipped = @()
foreach ($port in $ports) {
  $conns = Get-NetTCPConnection -LocalPort ([int]$port) -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq 'Listen' }
  foreach ($conn in $conns) {
    $proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    if ($proc.ProcessName -ieq 'workerd') {
      Stop-Process -Id $proc.Id -Force -ErrorAction Stop
      $killed += "$($proc.Id):$($proc.ProcessName):$port"
    } else {
      $skipped += "$($proc.Id):$($proc.ProcessName):$port"
    }
  }
}
Write-Output ("killed=" + ($killed -join ","))
if ($skipped.Count -gt 0) { Write-Output ("skipped=" + ($skipped -join ",")) }
`;

  const cmd = ["powershell", "-NoProfile", "-NonInteractive", "-Command", script];
  try {
    const { code, stdout, stderr } = await new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      attempted: true,
      command: cmd.slice(0, 4),
      code,
      stdout: new TextDecoder().decode(stdout).slice(0, 800),
      stderr: new TextDecoder().decode(stderr).slice(0, 800),
    };
  } catch (err) {
    return {
      attempted: false,
      command: cmd.slice(0, 4),
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fallback: kill leftover `workerd` processes by image name. This is
 * still opt-in via --kill-stale-workerd, and only runs after targeted
 * port-owner cleanup fails to clear the conflict.
 */

export async function killStaleWorkerd(): Promise<KillStaleResult> {
  // Windows ships taskkill in System32, available on every supported
  // Windows release since at least XP — no PowerShell roundtrip
  // needed. The /T flag also kills child processes, which catches the
  // case where the previous gateway exited but its workerd subprocess
  // is now reparented to PID 1 / wininit.exe.
  const cmd = Deno.build.os === "windows"
    ? ["taskkill", "/F", "/T", "/IM", "workerd.exe"]
    // `pkill -9 -x workerd` matches the executable name exactly so we
    // don't accidentally kill a `workerd-helper`-style sibling. `-x`
    // is GNU/BSD-portable. We don't fall back to `killall` (BSD vs
    // GNU semantics differ — `killall` on macOS expects a comma-
    // separated list with different flags).
    : ["pkill", "-9", "-x", "workerd"];
  try {
    const proc = new Deno.Command(cmd[0], {
      args: cmd.slice(1),
      stdout: "null",
      stderr: "piped",
    });
    const { code, stderr } = await proc.output();
    // Truncate stderr — we only log it on unexpected failures.
    const tail = new TextDecoder().decode(stderr).slice(0, 400);
    return { attempted: true, command: cmd, code, stderr: tail };
  } catch (err) {
    // taskkill / pkill missing from PATH (rare). Surface as
    // "attempted but couldn't run" so the caller logs a clear note
    // rather than silently retrying the probe and failing the same way.
    return {
      attempted: false,
      command: cmd,
      stderr: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Format a list of port conflicts into a single actionable error
 * message. Splitting message-formatting from probing keeps the
 * preflight pure and tests stable across platforms.
 */
export function formatPortConflictError(conflicts: readonly PortConflict[]): string {
  const list = conflicts
    .map((c) => `  - ${c.name} → ${c.address}:${c.port}`)
    .join("\n");
  // Keep it short — operators triaging a flake should see the fix in
  // the first scroll. The "stale workerd" hint is the 90% case; the
  // generic alternative is in parentheses for the rest.
  return [
    `workerd backend cannot start: ${conflicts.length} socket(s) already in use:`,
    list,
    "",
    "This usually means a previous workerd process is still running.",
    "  Windows:  taskkill /F /IM workerd.exe",
    "  Unix:     pkill workerd",
    "Or pass --kill-stale-workerd (or set 1TUBE_KILL_STALE_WORKERD=1) to do it automatically.",
    "(Bind to a different range with WorkerdBackendOptions.basePort if a non-workerd process owns the port.)",
  ].join("\n");
}

/**
 * Resolve the effective env-forwarding allowlist for this backend.
 *
 * Order of precedence (highest first):
 *   1. Explicit `envAllowlist` passed by the embedder (CLI / test).
 *      A literal `["*"]` is treated the same as "no list" → forward all.
 *   2. Comma-separated `1TUBE_WORKERD_ENV` operator override (or `*`).
 *   3. No list — **forward every env var the gateway can see**. This is
 *      the developer-friendly default: bundled functions behave like a
 *      regular Node/Deno script that inherits its parent's environment.
 *      Operators who care about isolation pass an explicit allowlist
 *      to narrow it.
 *
 * Returns the resolved list along with the names that were requested
 * but absent from the process env, so the caller can warn loudly
 * exactly once instead of letting workerd fail at boot with a less
 * actionable error message. `missing` is always empty in pass-all mode
 * because we don't make claims about specific names there.
 */
export interface EnvSource {
  get(name: string): string | undefined;
  toObject?(): Record<string, string>;
}

export type EnvAllowlistMode = "all" | "restricted";

export function resolveEnvAllowlist(
  explicit: readonly string[] | undefined,
  envSource: EnvSource = Deno.env,
): { resolved: string[]; missing: string[]; mode: EnvAllowlistMode } {
  let raw: readonly string[];
  if (explicit && explicit.length > 0) {
    raw = explicit;
  } else {
    const fromEnv = envSource.get("1TUBE_WORKERD_ENV") ?? "";
    raw = fromEnv
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // No explicit list, or the literal `["*"]`/`"*"` opt-out → forward
  // every env var the gateway sees. We enumerate at boot (snapshot
  // semantics) rather than re-reading Deno.env per request because
  // workerd's `fromEnvironment` bindings are wired up once when the
  // capnp config is generated.
  //
  // Names are filtered against the workerd-acceptable charset
  // (`[A-Za-z_][A-Za-z0-9_]*`). Windows in particular ships exotic
  // names like `=ExitCode`, `ProgramFiles(x86)`, and `=::=::\` that
  // capnp would reject — silently dropping them in pass-all mode is
  // the right call, since the operator never asked for them by name.
  // Explicit allowlists still validate strictly below: a typo in
  // `--workerd-env=FOO BAR` should fail loud rather than be ignored.
  if (raw.length === 0 || (raw.length === 1 && raw[0] === "*")) {
    const all = envSource.toObject ? envSource.toObject() : {};
    const validRx = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const resolved = Object.keys(all).filter((k) => validRx.test(k)).sort();
    return { resolved, missing: [], mode: "all" };
  }

  const seen = new Set<string>();
  const resolved: string[] = [];
  const missing: string[] = [];
  for (const name of raw) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (envSource.get(name) !== undefined) {
      resolved.push(name);
    } else {
      missing.push(name);
    }
  }
  return { resolved, missing, mode: "restricted" };
}

function runtimeSecretNames(envSource: EnvSource = Deno.env): string[] {
  const raw = envSource.get("1TUBE_SECRET_NAMES") ?? "";
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s));
  return [...new Set(names)].sort();
}

/**
 * Compute the env vars exposed to a single function as workerd
 * `fromEnvironment` bindings.
 *
 * Two modes, mirroring the Deno backend:
 *   - `enforceManifest === false` (default): every function gets the
 *     full gateway allowlist. The manifest's `permissions.env` is
 *     documentation only — same as the Deno path when
 *     `1TUBE_ENFORCE_MANIFEST` is unset.
 *   - `enforceManifest === true`: each function gets the intersection
 *     of the gateway allowlist and its declared `permissions.env`.
 *     The literal `["*"]` is honoured as "everything the gateway
 *     allows", letting operators opt a function back into the wide
 *     surface without listing each name.
 *
 * Pure function so it can be unit-tested without spinning up workerd.
 */
export function intersectEnvForFunction(
  gatewayAllowlist: readonly string[],
  manifestEnv: readonly string[],
  enforceManifest: boolean,
): string[] {
  if (!enforceManifest) return [...gatewayAllowlist];
  if (manifestEnv.length === 1 && manifestEnv[0] === "*") {
    return [...gatewayAllowlist];
  }
  const allowed = new Set(manifestEnv);
  return gatewayAllowlist.filter((name) => allowed.has(name));
}

/**
 * Build the `--inspector-addr=<host>:<port>` argument workerd accepts
 * for V8 inspector access, shifting the port by `slot` so a freshly-
 * spawned (HMR) successor doesn't fight its still-listening predecessor
 * for the inspector port. Returns `[]` when the operator hasn't opted
 * in.
 *
 * Pure function so the test suite can lock down the exact CLI shape
 * without spawning workerd.
 *
 * Accepted forms:
 *   - `host:port`           — port shifts by `slot`. Most common case.
 *   - `port` (digits only)  — implicit `127.0.0.1` host.
 *   - anything else         — passed through unchanged. Lets exotic
 *     bindings (`[::1]:9229`, IPv6 zone IDs) reach workerd verbatim
 *     instead of being silently mangled by our naive parser.
 */
export function buildInspectorExtraArgs(
  inspectorAddr: string | undefined,
  slot: number,
): string[] {
  if (!inspectorAddr) return [];
  const portOnly = /^\d+$/.test(inspectorAddr);
  if (portOnly) {
    const port = parseInt(inspectorAddr, 10) + slot;
    return [`--inspector-addr=127.0.0.1:${port}`];
  }
  // Plain host:port. Match the LAST colon so `host:port` parses but
  // `[::1]:9229` and other bracketed IPv6 forms fall through to the
  // passthrough branch where workerd's own parser handles them.
  const m = /^([^\[][^:]*):(\d+)$/.exec(inspectorAddr);
  if (!m) return [`--inspector-addr=${inspectorAddr}`];
  const host = m[1];
  const port = parseInt(m[2], 10) + slot;
  return [`--inspector-addr=${host}:${port}`];
}

/**
 * Build the `--v8-max-heap-size=<mb>` argument workerd accepts to cap
 * V8's old-generation heap. Returns `[]` when unset / non-positive,
 * so callers can splat the result unconditionally.
 *
 * Pure function so the test suite can lock down the exact CLI shape
 * without spawning workerd.
 */
export function buildMaxHeapExtraArgs(maxHeapMB: number | undefined): string[] {
  if (typeof maxHeapMB !== "number" || !Number.isFinite(maxHeapMB) || maxHeapMB <= 0) {
    return [];
  }
  return [`--v8-max-heap-size=${Math.floor(maxHeapMB)}`];
}

/**
 * Forward a single HTTP request to a workerd origin. Strips hop-by-hop
 * Host headers so workerd doesn't reject the proxied request, and
 * re-attaches the gateway's `X-1tube-Auth-*` envelope so the bundle
 * wrapper can rebuild the AuthContext.
 *
 * `req.body` is forwarded as-is when present so streaming uploads
 * pass through without being buffered into memory. `cache: "no-store"`
 * prevents Deno's HTTP client from interposing a cache layer (this is
 * a hot proxy path; any caching belongs in user-space or the gateway).
 */
async function forwardToWorkerd(
  req: Request,
  origin: string,
  auth: AuthContext | null,
  signal?: AbortSignal,
): Promise<Response> {
  const reqUrl = new URL(req.url);
  // Preserve everything after the function name in the path so handlers
  // that route on sub-paths (e.g. /functions/v1/hello/world) still work.
  // The gateway has already dispatched on `fnName`; we only forward the
  // remainder of the path.
  const target = new URL(origin);
  // Normalise: workerd receives the request at the root of its socket,
  // but user code reads `new URL(req.url).pathname` and expects to see
  // the original request path. Re-write the URL so workerd serves the
  // original pathname as-is, which is what user code on the Deno
  // backend already sees.
  target.pathname = reqUrl.pathname;
  target.search = reqUrl.search;

  // Filter out hop-by-hop headers. `host` would clash with workerd's
  // own; `content-length` is recomputed by the runtime from req.body.
  const headers = new Headers();
  for (const [k, v] of req.headers) {
    const key = k.toLowerCase();
    if (key === "host" || key === "content-length" || key === "connection" || key === "transfer-encoding") {
      continue;
    }
    headers.set(k, v);
  }

  if (auth) {
    headers.set("X-1tube-Auth-User", auth.userId);
    headers.set("X-1tube-Auth-Email", auth.email);
    headers.set("X-1tube-Auth-Token", auth.rawToken);
    // Stringify even when payload is empty so the bundle wrapper can
    // unconditionally JSON.parse without a special-case branch.
    headers.set("X-1tube-Auth-Payload", JSON.stringify(auth.payload ?? {}));
  }

  // Methods with no body must not pass `body: null` because Deno's
  // fetch client rejects body+GET pairings with a TypeError. The
  // RequestInit shape lets us omit the field entirely instead.
  const init: RequestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    cache: "no-store",
    signal,
  };
  if (req.body && req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    // Required by the Fetch spec when body is a stream.
    (init as RequestInit & { duplex?: string }).duplex = "half";
  }

  const upstream = await fetch(target, init);

  // Responses returned from `fetch()` have immutable headers, but the
  // gateway's CORS middleware downstream needs to add headers to the
  // response (e.g. Access-Control-Allow-Origin). Re-wrap into a fresh
  // Response whose headers are mutable; the body stream pipes through
  // unbuffered so streaming responses (SSE, NDJSON) still work.
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  });
}

export function createWorkerdBackend(opts: WorkerdBackendOptions): WorkerdBackend {
  const cwd = Deno.cwd();
  const functionsDir = isAbsolute(opts.functionsDir)
    ? opts.functionsDir
    : resolvePath(cwd, opts.functionsDir);
  const configPath = isAbsolute(opts.configPath)
    ? opts.configPath
    : resolvePath(cwd, opts.configPath);
  const workerdBin = opts.workerdBin ?? Deno.env.get("1TUBE_WORKERD_BIN") ?? "workerd";

  // Mutable state set during start(). Kept in closure scope so dispatch()
  // can reach it without an extra indirection layer.
  let bundler: Bundler | null = null;
  let process: WorkerdProcess | null = null;
  let routesByName = new Map<string, CapnpRoute>();
  let workerdVersion: string | null = null;
  let started = false;
  let stopping = false;
  let names: string[] = [];
  const manifests = new Map<string, FunctionManifest>();
  // Per-function bundle bytes. Populated by every successful boot()
  // (initial + reload). Passthrough functions on incremental reloads
  // KEEP their previous entry — so the gauge always reflects the real
  // on-disk size, never a misleading 0 for unchanged code.
  const bundleBytes = new Map<string, number>();
  // Wall-clock duration of the most recent successful reload. Stays
  // `null` until the first reload happens (initial boot doesn't count
  // since it's not a reload).
  let lastReloadDurationMs: number | null = null;

  // HMR generation counter. Each successful reload bumps this; the
  // value modulo 2 picks an "even" or "odd" port slot so the new
  // process never collides with the still-serving old one. We only
  // ever have at most two generations live at once (during a swap),
  // so a binary slot is sufficient. Cache dir + capnp filename are
  // also keyed off the generation so a crashed-mid-swap workerd
  // can't leave behind a half-written config that confuses a later
  // reload.
  let generation = 0;
  // Serialise reloads. The hot reloader debounces upstream of this,
  // but tests / scripts may legitimately call reload() concurrently
  // and a partial swap would corrupt the closure state.
  let reloadInFlight: Promise<WorkerdReloadResult> | null = null;
  let cacheDir: string | null = null;
  // Cache the resolved cwd absolute paths once so reload doesn't
  // re-run them on every save.
  const resolvedFunctionsDir: string = functionsDir;
  // Prebuilt-mode runtime state. `prebuiltDir` is the (resolved
  // absolute) artifact root; `prebuiltManifest` is the parsed index
  // loaded once at start() and re-used by every dispatch — no I/O
  // beyond the initial load.
  const prebuiltDir = opts.prebuiltDir
    ? (isAbsolute(opts.prebuiltDir)
      ? opts.prebuiltDir
      : resolvePath(cwd, opts.prebuiltDir))
    : null;
  let prebuiltManifest: PrebuiltManifest | null = null;
  let sharedRuntime: WorkerdSharedRuntime | null = null;

  /**
   * Shared boot pipeline used by both `start()` and `reload()`.
   *
   * - On initial boot (`gen===0`): bundles every discovered function,
   *   creates the bundler, generates `config.gen-0.capnp`, and spawns
   *   workerd. The bundler is created here and lives in the closure
   *   for the lifetime of the backend.
   *
   * - On reload (`gen>0`): re-uses the existing bundler so esbuild's
   *   worker subprocess (and its warmed-up Deno loader) survives.
   *   Re-bundles only the functions in `rebundleOnly` when provided;
   *   any other function keeps its on-disk bundle from the previous
   *   generation, which the new workerd reads fresh at boot.
   *
   * Returns the freshly-spawned process and the metadata the caller
   * needs to atomically swap closure state. The caller is responsible
   * for stopping any previous process AFTER the swap (so in-flight
   * requests against it complete first).
   *
   * Throws on bundle / capnp / spawn failure. The bundler is left
   * intact so the next attempt (after the user fixes the error) can
   * reuse it.
   */
  async function boot(args: {
    gen: number;
    rebundleOnly?: ReadonlySet<string>;
  }): Promise<{
    /**
     * `null` only on the "empty functions dir" boot path. The gateway
     * is still healthy and serving — every /functions/v1/* request
     * gets a 503 from `dispatch` until functions appear (typically
     * via a firmware upload promoting a new prebuilt artifact).
     */
    process: WorkerdProcess | null;
    routesByName: Map<string, CapnpRoute>;
    names: string[];
    manifests: Map<string, FunctionManifest>;
    rebundled: string[];
    bundleResults: BundleResult[];
  }> {
    // Cache dir selection differs between "build at boot" and
    // "prebuilt": prebuilt mode reads bundles directly from the
    // artifact dir (it IS the cache, the operator pre-warmed it),
    // while live mode allocates the usual node_modules/.cache slot.
    if (cacheDir === null) {
      if (prebuiltDir !== null) {
        cacheDir = prebuiltDir;
      } else {
        cacheDir = opts.cacheDir
          ? (isAbsolute(opts.cacheDir) ? opts.cacheDir : resolvePath(cwd, opts.cacheDir))
          : await defaultCacheDir(cwd);
        await ensureDir(cacheDir);
        await writeGitignore(cacheDir);
      }
    }

    let bundleResults: BundleResult[];
    const sharedModules: SharedRuntimeModule[] = [];
    // Names of functions that were actually rebuilt this pass (vs.
    // passed-through from a previous bundle on disk). Reported back
    // to the caller for the WorkerdReloadResult; prebuilt mode never
    // rebuilds anything so this stays empty there.
    let rebundledNames: string[] = [];
    if (prebuiltDir !== null) {
      // Prebuilt mode — every "bundle" already exists on disk. We
      // synthesise BundleResults from the manifest so the rest of
      // boot() (capnp generation, manifest wiring, byte-count gauge)
      // sees the same shape live mode does.
      if (!prebuiltManifest) {
        // Defensive — start() loads it before the first boot(). The
        // crash handler can call doReload(), but reload is rejected
        // up-front in prebuilt mode so we should never land here
        // with a null manifest. Raising hard makes the bug obvious.
        throw new Error("prebuilt manifest not loaded");
      }
      let entries = prebuiltManifest.functions;
      if (opts.only && opts.only.length > 0) {
        const allow = new Set(opts.only);
        entries = entries.filter((e) => allow.has(e.name));
        if (entries.length === 0) {
          throw new Error(
            `workerd backend: no prebuilt functions matched 'only' filter ${JSON.stringify(opts.only)}`,
          );
        }
      }
      if (entries.length === 0) {
        throw new Error(
          `workerd backend: prebuilt manifest at ${prebuiltDir}/manifest.json has zero functions`,
        );
      }
      bundleResults = entries.map((e) => ({
        name: e.name,
        bundlePath: join(cacheDir!, e.bundleFile),
        sourcemapPath: null,
        byteLength: e.bundleBytes,
        durationMs: 0,
      }));
      for (const shared of prebuiltManifest.sharedModules) {
        sharedModules.push({
          id: shared.id,
          bundlePath: join(cacheDir!, shared.bundleFile),
          exportNames: shared.exportNames,
        });
      }
    } else {
      let inputs = await discoverEntrypoints(resolvedFunctionsDir);
      if (opts.only && opts.only.length > 0) {
        const allow = new Set(opts.only);
        inputs = inputs.filter((i) => allow.has(i.name));
        if (inputs.length === 0) {
          throw new Error(
            `workerd backend: no functions matched 'only' filter ${JSON.stringify(opts.only)}`,
          );
        }
      }
      if (inputs.length === 0) {
        // Empty functions dir is a legitimate state — typically a
        // fresh deployment that hasn't received its first firmware
        // upload yet. Booting the gateway with an empty function set
        // (no workerd subprocess, no capnp config, no bundles) lets
        // /1tube/api/firmware/upload accept the first artifact while
        // /functions/v1/* responds with a clear 503 instead of the
        // host crash-looping. A subsequent firmware promote spawns a
        // new gateway with --prebuilt pointing at the unpacked
        // artifact, so this instance never has to "transition" out
        // of empty mode — it just gets retired by the side-by-side
        // swap.
        if (args.gen === 0) {
          console.log(
            `[1tube] workerd backend: no functions found under ${resolvedFunctionsDir} — ` +
              `gateway will return 503 for /functions/v1/* until a firmware artifact is promoted`,
          );
        }
        return {
          process: null,
          routesByName: new Map(),
          names: [],
          manifests: new Map(),
          rebundled: [],
          bundleResults: [],
        };
      }

      const discoveredSharedModules = await discoverSharedModules(
        resolvedFunctionsDir,
        opts.sharedModulePaths ?? [],
      );

      if (!bundler) {
        bundler = createBundler({
          outDir: cacheDir,
          configPath,
          sourcemap: opts.sourcemap ?? "linked",
          sharedModules: discoveredSharedModules,
        });
      }

      // For incremental reloads, re-bundle only the named subset and
      // synthesise stub BundleResults for the rest from the existing
      // on-disk bundle filename. Capnp generation only needs the
      // basename, so we don't need byte counts for the unchanged set.
      const rebundleSet = args.rebundleOnly;
      const toBundle = rebundleSet
        ? inputs.filter((i) => rebundleSet.has(i.name))
        : inputs;
      const passthrough = rebundleSet
        ? inputs.filter((i) => !rebundleSet.has(i.name))
        : [];

      try {
        bundleResults = await bundler.bundleAll(toBundle, {
          concurrency: opts.bundleConcurrency ?? 4,
        });
      } catch (err) {
        // On initial boot the caller will dispose the bundler and the
        // backend never reaches a "started" state. On reload we leave
        // the bundler alive so the next save can retry without
        // re-spawning the esbuild worker.
        throw err;
      }
      rebundledNames = toBundle.map((i) => i.name);

      // Synthesise minimal results for unchanged functions so capnp
      // generation has the same shape it expects.
      for (const i of passthrough) {
        bundleResults.push({
          name: i.name,
          bundlePath: join(cacheDir, `${i.name}.js`),
          sourcemapPath: null,
          byteLength: 0,
          durationMs: 0,
        });
      }
      for (const module of discoveredSharedModules) {
        const shared = await bundleSharedModule({
          module,
          outDir: join(cacheDir, "shared"),
          configPath,
        });
        sharedModules.push(shared);
      }
    }

      // Surface per-function bundle stats at boot so operators can spot
      // a 50MB bundle (usually the result of an unintended deep import)
      // before it OOMs the workerd isolate. On HMR reloads we only log
      // the bundles that actually got rebuilt (passthroughs would have
      // a misleading 0B / 0ms entry).
    if (args.gen === 0) {
      const sorted = [...bundleResults].sort((a, b) => b.byteLength - a.byteLength);
      const total = sorted.reduce((acc, r) => acc + r.byteLength, 0);
      const totalMs = sorted.reduce((acc, r) => acc + r.durationMs, 0);
      const fmtBytes = (n: number) => {
        if (n < 1024) return `${n}B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
        return `${(n / (1024 * 1024)).toFixed(2)}MB`;
      };
      // Pad name column to the longest fn name so the table aligns.
      const namePad = sorted.reduce((m, r) => Math.max(m, r.name.length), 8);
      console.log(`[1tube] workerd bundle sizes (sorted, largest first):`);
      for (const r of sorted) {
        console.log(
          `  ${r.name.padEnd(namePad)}  ${fmtBytes(r.byteLength).padStart(8)}  (${r.durationMs.toFixed(0)}ms)`,
        );
      }
      console.log(
        `  ${"total".padEnd(namePad)}  ${fmtBytes(total).padStart(8)}  (${totalMs.toFixed(0)}ms across ${sorted.length} fn${sorted.length === 1 ? "" : "s"})`,
      );
    }

      // Capnp. Clamp the configured compat date down to what this
      // binary actually accepts: workerd refuses any date later than
      // its build date with `compatibility date "..." is too new`. We
      // derive that ceiling from the version string we already
      // probed, which avoids a second subprocess and avoids relying
      // on workerd's own error message format. When the version
      // doesn't parse into a recognisable build date (custom builds,
      // `--version` output we don't yet understand) we leave the
      // operator's choice alone and let workerd's own boot error
      // surface if it's wrong.
      const ceiling = workerdVersion
        ? maxCompatDateFromVersion(workerdVersion)
        : null;
      let effectiveCompatDate = opts.compatibilityDate;
      if (ceiling) {
        const requested = opts.compatibilityDate;
        if (requested && !isCompatDateAtMost(requested, ceiling)) {
          console.warn(
            `[1tube] workerd v${workerdVersion} accepts compatibility dates up to ` +
              `${ceiling}; clamping requested ${requested} down to ${ceiling}.`,
          );
          effectiveCompatDate = ceiling;
        } else if (!requested) {
          // No explicit override — clamp the implicit default if the
          // binary is older than today's date. This is the common
          // path for users on a pinned-but-not-bleeding-edge build.
          effectiveCompatDate = ceiling;
        }
      }

      // Resolve the gateway-wide env policy. Workerd gets live secrets
      // plus the operator's explicit allowlist. We deliberately do not
      // infer source usage here: dynamic access is common, and secrets
      // are runtime configuration.
      const hasConfiguredEnvPolicy = (opts.envAllowlist?.length ?? 0) > 0 ||
        ((Deno.env.get("1TUBE_WORKERD_ENV") ?? "").trim().length > 0);
      const secretNames = runtimeSecretNames();
      const {
        resolved: configuredEnvBindings,
        missing: missingEnv,
        mode: configuredEnvMode,
      } = resolveEnvAllowlist(opts.envAllowlist);
      const gatewayEnvBindings = [...new Set([
        ...secretNames,
        ...(hasConfiguredEnvPolicy ? configuredEnvBindings : []),
      ])].sort();
      if (missingEnv.length > 0) {
        console.warn(
          `[1tube] workerd env allowlist references vars not present in the gateway env: ` +
            `${missingEnv.join(", ")} — these will be unavailable to functions. ` +
            `Set them before starting the gateway, or remove them from the allowlist.`,
        );
      }
      if (hasConfiguredEnvPolicy && configuredEnvBindings.length > 0) {
        if (configuredEnvMode === "all") {
          console.log(
            `[1tube] forwarding all ${configuredEnvBindings.length} env var(s) to workerd ` +
              `plus ${secretNames.length} runtime secret name(s) (explicit '*')`,
          );
        } else {
          console.log(
            `[1tube] forwarding ${gatewayEnvBindings.length} env var(s) to workerd ` +
              `(${secretNames.length} secret(s), ${configuredEnvBindings.length} explicit): ${gatewayEnvBindings.join(", ")}`,
          );
        }
      } else if (secretNames.length > 0) {
        console.log(`[1tube] forwarding ${secretNames.length} runtime secret env var(s) to workerd: ${secretNames.join(", ")}`);
      }

      // Load each function's 1tube.json. Missing files yield
      // defaultManifest() so per-function knobs (timeoutMs, rpm,
      // permissions.env, recycle) are always available downstream
      // even when the operator hasn't authored a manifest. Always
      // re-read on reload — a manifest-only edit ships through the
      // hot reloader as a non-bundle change, so the JSON has to be
      // re-parsed even when no bundle is rebuilt.
      //
      // Prebuilt mode short-circuits the disk read: each manifest is
      // already inline in the artifact's index, and the source tree
      // is not assumed to exist on the serve box.
      const newManifests = new Map<string, FunctionManifest>();
      if (prebuiltDir !== null && prebuiltManifest) {
        for (const e of prebuiltManifest.functions) {
          newManifests.set(e.name, e.manifest);
        }
      } else {
        await Promise.all(
          bundleResults.map(async (r) => {
            const m = await loadManifest(resolvedFunctionsDir, r.name);
            newManifests.set(r.name, m);
          }),
        );
      }

      // Mirror the Deno backend's two-mode env story:
      //   - Default: every function sees the full gateway allowlist.
      //     Manifest `permissions.env` is documentation only.
      //   - `1TUBE_ENFORCE_MANIFEST=1`: each function only sees its
      //     declared subset (intersection with the gateway list).
      //     `permissions.env: ["*"]` opts back into "everything".
      // This keeps a single env-policy switch across both backends,
      // and avoids surprising operators who flip enforcement on after
      // shipping for a while.
      const enforceManifest = (Deno.env.get("1TUBE_ENFORCE_MANIFEST") ?? "") === "1";
      const prebuiltBundleFiles = prebuiltManifest
        ? new Map(prebuiltManifest.functions.map((e) => [e.name, e.bundleFile]))
        : null;
      const prebuiltModuleFiles = prebuiltManifest
        ? new Map(prebuiltManifest.functions.map((e) => [e.name, e.moduleFiles]))
        : null;
      if (!sharedRuntime && sharedModules.length > 0) {
        sharedRuntime = await startWorkerdSharedRuntime(sharedModules);
      }
      const internalEnvBindings = sharedRuntime
        ? [SHARED_RUNTIME_URL_ENV, SHARED_RUNTIME_TOKEN_ENV]
        : [];
      const capnpInputs = bundleResults.map((r) => {
        const m = newManifests.get(r.name)!;
        const bundleEmbedPath = prebuiltBundleFiles?.get(r.name) ??
          r.bundlePath.split(/[\\/]/).pop()!;
        const fnEnvBindings = intersectEnvForFunction(gatewayEnvBindings, m.permissions.env, enforceManifest);
        for (const internalName of internalEnvBindings) {
          if (!fnEnvBindings.includes(internalName)) fnEnvBindings.push(internalName);
        }
        return {
          name: r.name,
          // Live mode writes capnp next to the bundles, so basename is
          // enough. Prebuilt artifacts keep bundles under dist/functions/
          // and capnp is written at dist/, so use the manifest-relative
          // path ("functions/<fn>.js") or workerd cannot resolve embeds.
          bundleBasename: bundleEmbedPath,
          moduleFiles: prebuiltModuleFiles?.get(r.name),
          envBindings: fnEnvBindings,
        };
      });

      // Shift the basePort by an even/odd slot so a reload's new
      // process never collides with the still-serving old one. Two
      // slots is enough — we only ever overlap during the swap.
      // 500 ports of headroom per slot is plenty for any realistic
      // function count (basePort default is 8800; 8800..9300 even,
      // 9300..9800 odd).
      const slot = args.gen % 2;
      const shiftedBasePort = (opts.basePort ?? 8800) + slot * 500;

      const capnp = generateCapnp(capnpInputs, {
        bindAddress: opts.bindAddress,
        basePort: shiftedBasePort,
        compatibilityDate: effectiveCompatDate,
        compatibilityFlags: opts.compatibilityFlags,
        allowLocalOutbound: sharedRuntime !== null,
      });
      // Per-generation capnp filename so a crashed reload can't leave
      // an old process pointed at a half-written config.
      const capnpPath = join(cacheDir, `config.gen-${slot}.capnp`);
      await Deno.writeTextFile(capnpPath, capnp.text);

      const newRoutesByName = new Map(capnp.routes.map((r) => [r.name, r]));
      const newNames = capnp.routes.map((r) => r.name).sort();
      if (args.gen === 0) {
        const ports = capnp.routes.map((r) => r.port);
        const minPort = Math.min(...ports);
        const maxPort = Math.max(...ports);
        const totalEnvBindings = capnpInputs.reduce((sum, input) => sum + (input.envBindings?.length ?? 0), 0);
        const maxEnvBindings = capnpInputs.reduce((max, input) => Math.max(max, input.envBindings?.length ?? 0), 0);
        console.log(
          `[1tube] workerd config: path=${capnpPath} services=${capnp.routes.length} ` +
            `ports=${minPort}${minPort === maxPort ? "" : `-${maxPort}`} ` +
            `compat=${effectiveCompatDate ?? "default"} ` +
            `flags=${(opts.compatibilityFlags ?? ["default"]).join(",")} ` +
            `envMode=${hasConfiguredEnvPolicy ? configuredEnvMode : "secrets"} ` +
            `envBindingsTotal=${totalEnvBindings} envBindingsMaxPerFn=${maxEnvBindings}`,
        );
      }

      // Preflight: refuse to spawn workerd against ports that are
      // already in use. Without this, a leftover workerd from a
      // previous run silently steals our traffic and the failure
      // surfaces only as wrong-looking response bodies. See
      // `probeSocketsFree` doc comment for the full rationale.
      // We skip the check on reload because the still-serving old
      // generation occupies the OTHER slot's ports by design — the
      // even/odd `slot` shift above guarantees no overlap, and
      // probing here would race against that intentional overlap.
      if (args.gen === 0) {
        let conflicts = probeSocketsFree(capnp.routes);
        if (conflicts.length > 0 && opts.killStaleWorkerd) {
          console.log(
            `[1tube] port preflight found ${conflicts.length} conflict(s); ` +
              `--kill-stale-workerd is set, attempting cleanup...`,
          );

          // First try the precise fix: resolve the conflicted port(s)
          // to their owning PID(s), and kill only owners named workerd.
          // That is the behavior we want during firmware flashing:
          // remove the stale candidate that owns 8800, but never kill
          // a random non-workerd process that happens to be there.
          const targeted = await killWorkerdOwnersOfPorts(conflicts);
          if (targeted.attempted) {
            if (targeted.code === 0) {
              const details = targeted.stdout?.trim();
              console.log(
                `[1tube] targeted stale-workerd cleanup by port complete` +
                  (details ? ` (${details})` : "") +
                  `; re-probing...`,
              );
            } else {
              console.warn(
                `[1tube] targeted stale-workerd cleanup exited ${targeted.code}` +
                  (targeted.stderr ? `: ${targeted.stderr.trim()}` : ""),
              );
            }
            await new Promise((r) => setTimeout(r, 250));
            conflicts = probeSocketsFree(capnp.routes);
          }

          // If targeted cleanup did not exist on this platform, or it
          // found no matching workerd owner, fall back to the old typed
          // process-name cleanup.
          const result = conflicts.length > 0 ? await killStaleWorkerd() : null;
          if (result === null) {
            // Already clear.
          } else
          if (result.attempted) {
            // taskkill returns 128 when no matching image is running —
            // that's not an error in our context (means the offender
            // wasn't workerd, which is fine; preflight will catch it).
            // pkill returns 1 in the same case.
            const noMatch = (Deno.build.os === "windows" && result.code === 128) ||
              (Deno.build.os !== "windows" && result.code === 1);
            if (result.code === 0) {
              console.log(`[1tube] killed leftover workerd process(es); re-probing...`);
            } else if (noMatch) {
              console.log(
                `[1tube] no leftover workerd processes found; the conflict is held ` +
                  `by something else (re-probing to confirm)...`,
              );
            } else {
              console.warn(
                `[1tube] ${result.command?.join(" ")} exited ${result.code}` +
                  (result.stderr ? `: ${result.stderr.trim()}` : ""),
              );
            }
            // Brief settle time: Windows TCP sockets in CLOSE_WAIT can
            // hold the port for a fraction of a second after the owner
            // process is killed. 250ms is empirically enough on the
            // dev boxes we've tested without making the boot path feel
            // sluggish.
            await new Promise((r) => setTimeout(r, 250));
            conflicts = probeSocketsFree(capnp.routes);
          } else {
            console.warn(
              `[1tube] could not run ${result.command?.join(" ")}: ` +
                `${result.stderr ?? "unknown error"}`,
            );
          }
        }
        if (conflicts.length > 0) {
          throw new Error(formatPortConflictError(conflicts));
        }
      }

      const inspectorArgs = buildInspectorExtraArgs(opts.inspectorAddr, slot);
      if (inspectorArgs.length > 0) {
        // One log per spawn so operators can see exactly which port
        // the new generation listens on after an HMR reload.
        console.log(
          `[1tube] workerd V8 inspector: ${inspectorArgs[0].replace(/^--inspector-addr=/, "")} ` +
            `(gen=${args.gen}) — open chrome://inspect to attach`,
        );
      }

      const maxHeapArgs = buildMaxHeapExtraArgs(opts.maxHeapMB);
      const extraArgs = [...inspectorArgs, ...maxHeapArgs];
      const verboseWorkerd = (Deno.env.get("1TUBE_WORKERD_VERBOSE") ?? "") === "1";
      if (verboseWorkerd) {
        console.log(`[1tube] workerd verbose logging enabled (1TUBE_WORKERD_VERBOSE=1)`);
      }

      const newProcess = createWorkerdProcess({
        binary: workerdBin,
        capnpPath,
        routes: capnp.routes,
        ...(verboseWorkerd ? { globalArgs: ["-v"] } : {}),
        extraArgs,
        env: sharedRuntime
          ? {
            ...Deno.env.toObject(),
            [SHARED_RUNTIME_URL_ENV]: sharedRuntime.url,
            [SHARED_RUNTIME_TOKEN_ENV]: sharedRuntime.token,
          }
          : undefined,
        logLineSink: opts.logLineSink,
      });
      try {
        await newProcess.start();
      } catch (err) {
        // Boot failed. On initial start the caller will dispose the
        // bundler. On reload we leave the bundler alive so subsequent
        // saves can retry quickly.
        throw err;
      }

      return {
        process: newProcess,
        routesByName: newRoutesByName,
        names: newNames,
        manifests: newManifests,
        rebundled: rebundledNames,
        bundleResults,
      };
  }

  // Crash-restart bookkeeping. We allow up to MAX_CRASHES inside
  // CRASH_WINDOW_MS before giving up — repeatedly looping on a
  // permanently-broken bundle would saturate the host with workerd
  // spawn attempts otherwise. After we give up, the backend stays
  // in a degraded state where the gateway 502s every dispatch but
  // the next manual reload (e.g. an HMR save) clears the counter
  // and resumes recovery.
  const MAX_CRASHES = 5;
  const CRASH_WINDOW_MS = 30_000;
  const crashTimestamps: number[] = [];

  /**
   * Wire the per-process onExit handler that turns an unexpected
   * workerd death into an auto-recycle. Called once per successful
   * boot (initial + every reload) on the *fresh* process.
   *
   * The handler captures `proc` in its closure and only acts if it
   * matches the *current* `process` reference — that way an
   * already-swapped-out process (e.g. the predecessor we just
   * stopped after a reload) firing late doesn't trigger a spurious
   * recycle.
   */
  function wireCrashHandler(proc: WorkerdProcess) {
    proc.onExit((code, expected) => {
      if (stopping) return;
      if (process !== proc) return; // we already moved on
      // Drop the now-dead process reference so dispatch fast-fails
      // with 502 during the recovery gap (instead of forwarding to
      // a closed socket, which stalls).
      process = null;

      if (expected) return; // graceful stop in flight elsewhere

      const now = performance.now();
      // Slide the crash window so old crashes age out.
      while (
        crashTimestamps.length > 0 &&
        now - crashTimestamps[0] > CRASH_WINDOW_MS
      ) {
        crashTimestamps.shift();
      }
      crashTimestamps.push(now);
      const expectedRetry = crashTimestamps.length <= MAX_CRASHES;

      console.error(
        `[1tube] workerd crashed (gen=${generation}, code=${code}, ` +
          `crashes=${crashTimestamps.length}/${MAX_CRASHES} in ${(CRASH_WINDOW_MS / 1000).toFixed(0)}s)` +
          (expectedRetry ? " — auto-recycling..." : " — GIVING UP, manual restart required."),
      );

      try {
        opts.onUnexpectedExit?.({
          code,
          generation,
          crashCount: crashTimestamps.length,
          expectedRetry,
        });
      } catch (err) {
        console.warn("[1tube] onUnexpectedExit callback threw:", err);
      }

      if (!expectedRetry) return;

      // Fire-and-forget reload via the same path the public API uses.
      // reloadInFlight serialises any concurrent caller (e.g. a
      // save during recovery), so two recycles can't race.
      doReload("all").catch((err) => {
        console.error("[1tube] crash-recovery reload failed:", err);
      });
    });
  }

  /**
   * Internal worker that the public `reload()` method delegates to,
   * and that the crash handler also calls directly. Lives outside
   * the returned object so it can be invoked from anywhere in the
   * closure (inside `wireCrashHandler`'s arrow callbacks in
   * particular, where `this` doesn't refer to the backend).
   */
  function doReload(
    changed?: ReadonlySet<string> | "all",
  ): Promise<WorkerdReloadResult> {
    if (!started) {
      return Promise.reject(new Error("workerd backend not started; cannot reload"));
    }
    if (stopping) {
      return Promise.reject(new Error("workerd backend is stopping; reload denied"));
    }
    // `process == null` is allowed here: it's exactly the state we
    // land in after a crash (onExit fired and cleared `process`) or
    // after a watchdog hard-recycle. The swap loop's `if (oldProcess)`
    // guard skips the predecessor-stop in that case.
    //
    // Coalesce concurrent callers onto the in-flight reload. The hot
    // reloader serialises debounced bursts upstream, but a
    // simultaneous external `reload()` (test harness, crash handler
    // racing the watchdog) must never spawn a second new workerd
    // while the previous one is still booting — that's how port
    // collisions happen.
    if (reloadInFlight) return reloadInFlight;

    const startedAt = performance.now();
    const oldNames = new Set(names);
    const wantFull = changed === undefined || changed === "all";
    // Even on "rebundle this subset", the boot pipeline still runs
    // discovery to detect added/removed functions. The subset only
    // controls which existing functions we *re-bundle* for speed.
    const rebundleOnly = wantFull ? undefined : new Set(changed as ReadonlySet<string>);

    reloadInFlight = (async (): Promise<WorkerdReloadResult> => {
      const nextGen = generation + 1;
      const result = await boot({ gen: nextGen, rebundleOnly });

      // Atomic swap. Updating these references is what flips every
      // NEW dispatch from the old workerd to the new one.
      // Already-issued forwardToWorkerd() calls keep their captured
      // `route.origin` URL and complete against the old socket.
      const oldProcess = process;
      process = result.process;
      routesByName = result.routesByName;
      names = result.names;
      manifests.clear();
      for (const [k, v] of result.manifests) manifests.set(k, v);
      generation = nextGen;

      // Subscribe to the new process's onExit AFTER it's installed
      // so the crash handler's `process !== proc` guard sees a
      // consistent state. (Empty-mode reload is a contradiction in
      // terms — reload presupposes a previous non-empty boot — but
      // we null-guard anyway for symmetry with start().)
      if (result.process) wireCrashHandler(result.process);

      const newSet = new Set(result.names);
      const added = result.names.filter((n) => !oldNames.has(n));
      const removed = [...oldNames].filter((n) => !newSet.has(n)).sort();

      // Stop the old workerd AFTER the swap so in-flight requests
      // it's still serving complete naturally. process.stop() is
      // graceful (SIGTERM-then-kill) so this is bounded. When the
      // predecessor already crashed (oldProcess === null), skip.
      if (oldProcess) {
        await oldProcess.stop().catch((err) => {
          console.warn(`[1tube] error stopping previous workerd:`, err);
        });
      }

      // Refresh bundle-bytes for the rebundled set. Passthrough
      // functions keep whatever entry they had pre-reload — the
      // on-disk file is unchanged, and the byteLength we got from
      // boot() for those is a stub 0 we explicitly skip here.
      for (const r of result.bundleResults) {
        if (r.byteLength > 0) bundleBytes.set(r.name, r.byteLength);
      }
      // Drop entries for removed functions so the gauge doesn't keep
      // ghost rows.
      for (const old of removed) bundleBytes.delete(old);

      const reloadResult: WorkerdReloadResult = {
        durationMs: performance.now() - startedAt,
        added,
        removed,
        rebundled: result.rebundled,
        generation: nextGen,
      };
      lastReloadDurationMs = reloadResult.durationMs;
      if (opts.onReloaded) {
        try {
          opts.onReloaded(manifests, reloadResult);
        } catch (err) {
          console.warn("[1tube] onReloaded callback threw:", err);
        }
      }
      return reloadResult;
    })();

    // Always clear the in-flight slot whether we succeed or fail —
    // a failed reload leaves the OLD process running and the next
    // attempt should start fresh.
    reloadInFlight.finally(() => {
      reloadInFlight = null;
    }).catch(() => {});

    return reloadInFlight;
  }

  return {
    get pid() {
      return process?.pid ?? null;
    },
    get generation() {
      return generation;
    },
    get functionNames() {
      return names;
    },
    get workerdVersion() {
      return workerdVersion;
    },
    get manifests(): ReadonlyMap<string, FunctionManifest> {
      return manifests;
    },
    get bundleBytes(): ReadonlyMap<string, number> {
      return bundleBytes;
    },
    get lastReloadDurationMs() {
      return lastReloadDurationMs;
    },

    async start() {
      if (started) throw new Error("workerd backend already started");
      started = true;

      // Load + verify the prebuilt manifest BEFORE probing workerd, so
      // a stale / tampered artifact fails with a clear error before we
      // commit to a workerd subprocess. The verification step (sha-256
      // per bundle) is what makes prebuilt mode safe to run on a box
      // that doesn't have the source tree — operators can be confident
      // they're running the artifact CI built, byte for byte.
      if (prebuiltDir !== null) {
        const manifestPath = join(prebuiltDir, "manifest.json");
        let raw: string;
        try {
          raw = await Deno.readTextFile(manifestPath);
        } catch (err) {
          started = false;
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `workerd backend cannot start: prebuilt manifest at ${manifestPath} is unreadable (${msg}). ` +
              `Re-run \`1tube build --out ${prebuiltDir}\` to regenerate it.`,
          );
        }
        try {
          prebuiltManifest = parsePrebuiltManifest(JSON.parse(raw));
        } catch (err) {
          started = false;
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`workerd backend cannot start: ${msg}`);
        }
        // Verify each bundle's bytes against the recorded sha-256.
        // We do this serially to keep memory pressure low — bundles
        // can be tens of MB and parallelising the read+digest would
        // briefly hold all of them in RAM.
        for (const e of prebuiltManifest.functions) {
          const bundlePath = join(prebuiltDir, e.bundleFile);
          let bytes: Uint8Array;
          try {
            bytes = await Deno.readFile(bundlePath);
          } catch (err) {
            started = false;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `workerd backend cannot start: prebuilt bundle ${bundlePath} unreadable (${msg}). ` +
                `Re-run \`1tube build\`.`,
            );
          }
          const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
          const view = new Uint8Array(digest);
          let got = "";
          for (let i = 0; i < view.length; i++) got += view[i].toString(16).padStart(2, "0");
          if (got !== e.bundleSha256) {
            started = false;
            throw new Error(
              `workerd backend cannot start: prebuilt bundle "${e.name}" failed integrity check ` +
                `(expected ${e.bundleSha256}, got ${got}). Bundle has been modified or is corrupt.`,
            );
          }
        }
        for (const e of prebuiltManifest.chunks) {
          const chunkPath = join(prebuiltDir, e.file);
          let bytes: Uint8Array;
          try {
            bytes = await Deno.readFile(chunkPath);
          } catch (err) {
            started = false;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`prebuilt chunk ${chunkPath} unreadable (${msg})`);
          }
          const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
          const hex = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
          if (hex !== e.sha256) {
            started = false;
            throw new Error(
              `prebuilt chunk hash mismatch for ${e.file}: ` +
                `manifest=${e.sha256} actual=${hex}`,
            );
          }
        }
        for (const e of prebuiltManifest.sharedModules) {
          const bundlePath = join(prebuiltDir, e.bundleFile);
          let bytes: Uint8Array;
          try {
            bytes = await Deno.readFile(bundlePath);
          } catch (err) {
            started = false;
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `workerd backend cannot start: prebuilt shared module ${bundlePath} unreadable (${msg}). ` +
                `Re-run \`1tube build\`.`,
            );
          }
          const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
          const view = new Uint8Array(digest);
          let got = "";
          for (let i = 0; i < view.length; i++) got += view[i].toString(16).padStart(2, "0");
          if (got !== e.bundleSha256) {
            started = false;
            throw new Error(
              `workerd backend cannot start: prebuilt shared module "${e.id}" failed integrity check ` +
                `(expected ${e.bundleSha256}, got ${got}). Bundle has been modified or is corrupt.`,
            );
          }
        }
        console.log(
          `[1tube] prebuilt artifact: ${prebuiltManifest.functions.length} function(s), ` +
            `${prebuiltManifest.builtBy}, built ${prebuiltManifest.builtAt} (schema ${prebuiltManifest.schema})`,
        );
      }

      // Probe the workerd version up-front. If the binary is missing
      // or broken, fail fast with a clear error before doing the (much
      // more expensive) bundling work.
      try {
        const info = await probeVersion(workerdBin);
        workerdVersion = info.version;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `workerd backend cannot start: ${msg}\n` +
            `Set 1TUBE_WORKERD_BIN to override the binary path, ` +
            `or remove --backend=workerd to fall back to the Deno backend.`,
        );
      }

      try {
        const result = await boot({ gen: 0 });
        process = result.process;
        routesByName = result.routesByName;
        names = result.names;
        manifests.clear();
        for (const [k, v] of result.manifests) manifests.set(k, v);
        // Seed bundle-bytes from the initial boot. Every entry has
        // a real byteLength here (no passthroughs yet).
        bundleBytes.clear();
        for (const r of result.bundleResults) {
          bundleBytes.set(r.name, r.byteLength);
        }
        generation = 0;
        // `result.process` is null on the "empty functions dir" boot
        // path; nothing to crash, nothing to wire.
        if (result.process) wireCrashHandler(result.process);
      } catch (err) {
        // Initial boot failed — we never reached a started state, so
        // tear down whatever we did create (the bundler) and rethrow.
        if (bundler) {
          await bundler.dispose().catch(() => {});
          bundler = null;
        }
        if (sharedRuntime) {
          await sharedRuntime.stop().catch(() => {});
          sharedRuntime = null;
        }
        process = null;
        started = false;
        throw err;
      }
    },

    reload(changed) {
      // Prebuilt artifacts are sealed — block every public reload
      // request. Crash-recovery still works because the internal
      // crash handler calls `doReload` directly (re-spawning workerd
      // against the same on-disk bundles is legitimate; only
      // re-bundling is forbidden).
      if (prebuiltDir !== null) {
        return Promise.reject(
          new Error(
            "workerd backend is in prebuilt mode; reload is not supported. " +
              "Re-run `1tube build` and restart the gateway to pick up changes.",
          ),
        );
      }
      return doReload(changed);
    },

    async dispatch(req, fnName, auth, signal) {
      if (!process) {
        // Empty-mode: gateway started without a workerd subprocess
        // because the functions dir was empty. Tell the caller that
        // the surface is not yet provisioned — distinct from a
        // routing 404 (function genuinely doesn't exist) so the
        // operator can see the difference in logs.
        return new Response(
          JSON.stringify({
            error:
              "1tube: no functions are currently loaded. Upload a firmware artifact via /1tube/api/firmware/upload to provision the gateway.",
          }),
          {
            status: 503,
            headers: {
              "content-type": "application/json",
              "retry-after": "30",
            },
          },
        );
      }
      const route = routesByName.get(fnName);
      if (!route) {
        // Gateway should have rejected with 404 before reaching us;
        // throwing here surfaces the routing bug instead of returning
        // a confusing 502 from the proxy layer.
        throw new Error(`unknown function for workerd backend: ${fnName}`);
      }
      try {
        return await forwardToWorkerd(req, route.origin, auth, signal);
      } catch (err) {
        // Workerd unreachable (crash mid-request, port collision, etc.).
        // Surface as 502 so the gateway can log and respond cleanly.
        const msg = err instanceof Error ? err.message : String(err);
        return new Response(
          JSON.stringify({ error: `workerd backend error: ${msg}` }),
          { status: 502, headers: { "content-type": "application/json" } },
        );
      }
    },

    async stop() {
      if (stopping) return;
      stopping = true;
      try {
        if (process) await process.stop();
      } finally {
        if (sharedRuntime) {
          await sharedRuntime.stop().catch(() => {});
        }
        if (bundler) {
          await bundler.dispose().catch(() => {});
        }
        sharedRuntime = null;
        bundler = null;
        process = null;
        manifests.clear();
      }
    },
  };
}

/**
 * Re-export the path utility so tests and the gateway can compute the
 * default cache dir without duplicating the logic. Kept module-private
 * via a function rather than re-exporting the whole helper to keep the
 * public surface tight.
 */
export async function resolveDefaultCacheDir(cwd: string = Deno.cwd()): Promise<string> {
  return await defaultCacheDir(cwd);
}
