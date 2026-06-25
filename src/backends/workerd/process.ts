/**
 * Workerd process lifecycle manager.
 *
 * Wraps a single `workerd serve <capnp>` child process with the surface
 * 1tube actually needs:
 *
 *   - {@link createWorkerdProcess} spawns the binary, pipes its stdout
 *     and stderr through a `[workerd]`-prefixed line writer, and
 *     exposes a `start()` that resolves only once every advertised
 *     socket is reachable via TCP — the most reliable
 *     listening-confirmation signal across workerd versions.
 *
 *   - `stop()` sends a graceful `SIGTERM` (or `taskkill /T` on Windows
 *     where Deno still doesn't support sending arbitrary signals),
 *     waits up to a configurable timeout, then escalates by killing
 *     the process via Deno's `kill()`. Idempotent — calling twice is
 *     safe.
 *
 *   - `onExit(cb)` lets the orchestrator hook unexpected termination
 *     (the workerd backend's restart-on-crash policy lives there, not
 *     here, so this manager stays single-purpose).
 *
 *   - {@link probeVersion} runs `workerd --version` and parses the
 *     output. Independent function (no shared state with the process
 *     manager) so the boot banner can call it cheaply on its own.
 *
 *   - {@link waitForPorts} is the TCP-readiness helper exported on its
 *     own because it's the only piece of this module worth unit-testing
 *     in isolation; the rest is orchestration over child processes,
 *     which the test suite covers via a fake "workerd-like" binary.
 *
 * The platform abstraction is intentionally thin. `Deno.Command` is the
 * only system surface we touch; this module makes no assumptions about
 * the workerd binary's exact path or version, in line with the project
 * decision to let operators ship whatever workerd they want via PATH or
 * the `1TUBE_WORKERD_BIN` env var.
 */

import type { CapnpRoute } from "./capnp.ts";

/** Default timeout for the readiness probe — generous enough for cold starts on slow disks. */
const DEFAULT_READY_TIMEOUT_MS = 15_000;
/** Default per-attempt connect timeout when probing a TCP port. */
const DEFAULT_PROBE_INTERVAL_MS = 50;
/** Default grace period before escalating from SIGTERM to SIGKILL. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
/** Bounded child-output tail attached to startup failures. */
const OUTPUT_TAIL_LINES = 800;

export interface WorkerdProcessOptions {
  /** Absolute or PATH-resolvable path to the `workerd` binary. */
  binary: string;
  /** Path to the capnp file written by the capnp generator. */
  capnpPath: string;
  /**
   * Routes the workerd config exposes — one per function. The process
   * manager probes each route's port for TCP readiness before resolving
   * `start()`.
   */
  routes: readonly CapnpRoute[];
  /**
   * Extra arguments inserted **before** `serve <capnpPath>` in argv.
   * Workerd treats these as global flags (e.g. `-v` for verbose). Also
   * useful as a test seam — passing a `deno`-binary plus
   * `["run", ..., script.ts, "--"]` here lets a Deno script stand in
   * for the workerd binary in unit tests.
   */
  globalArgs?: readonly string[];
  /**
   * Extra arguments appended **after** `serve <capnpPath>`. Workerd
   * treats these as serve-subcommand flags (e.g. `--inspector-addr`).
   */
  extraArgs?: readonly string[];
  /**
   * Working directory for the child. Defaults to the directory of
   * `capnpPath` so workerd can resolve `embed "<basename>"` relative
   * to the capnp file.
   */
  cwd?: string;
  /**
   * Environment variables to pass through to workerd. Workerd doesn't
   * read its own env meaningfully (env bindings come from capnp), but
   * Node-shimmed code under nodejs_compat reads `process.env`, which
   * workerd populates from the inherited environment. Defaults to the
   * full parent env so dev experience matches plain `deno run`.
   */
  env?: Record<string, string>;
  /**
   * Sink for `[workerd]`-prefixed log lines. Defaults to writing to
   * `Deno.stderr` synchronously so workerd output interleaves with
   * 1tube's startup banner without buffering.
   */
  logLineSink?: (line: string) => void;
  /** TCP-readiness probe total timeout. Defaults to 15s. */
  readyTimeoutMs?: number;
  /** Sleep between TCP probe attempts. Defaults to 50ms. */
  probeIntervalMs?: number;
  /** SIGTERM → SIGKILL grace period on stop(). Defaults to 5s. */
  shutdownTimeoutMs?: number;
}

export interface WorkerdProcess {
  /**
   * Spawn the binary and wait until every route's socket is accepting
   * TCP connections. Throws if the process exits before readiness or
   * the timeout elapses. Calling twice is an error.
   */
  start(): Promise<void>;
  /**
   * Stop the child process (graceful then forceful). Idempotent.
   */
  stop(): Promise<void>;
  /** Child PID once `start()` has been called. `null` before/after. */
  readonly pid: number | null;
  /**
   * Register a one-shot exit listener. Fires exactly once with the
   * child's exit code (`null` if killed by signal). Useful for
   * orchestrator-level restart-on-crash logic.
   */
  onExit(cb: (code: number | null, expected: boolean) => void): void;
}

export interface VersionInfo {
  /** Parsed semver-ish version (e.g. `"1.2025.04.10"`). */
  version: string;
  /** Full untrimmed stdout from `workerd --version`, for diagnostics. */
  raw: string;
}

/**
 * Parse the stdout of `workerd --version`.
 *
 * The format has been stable for years: a single line of the form
 *   `workerd <version-string>`
 * possibly with trailing build metadata. We accept anything that
 * matches that prefix and treat the first whitespace-delimited token
 * after `workerd` as the version. The full raw string is preserved so
 * the operator can see build metadata in the boot log even if our
 * parser misclassifies the version field.
 *
 * Exported separately from {@link probeVersion} because the parsing is
 * the only part worth unit-testing — the spawn-and-await is just I/O.
 */
export function parseVersionOutput(stdout: string): VersionInfo {
  const trimmed = stdout.trim();
  const m = /^workerd\s+(\S+)/i.exec(trimmed);
  if (!m) {
    throw new Error(
      `unable to parse workerd version from output: ${JSON.stringify(trimmed)}`,
    );
  }
  return { version: m[1], raw: trimmed };
}

/**
 * Derive the maximum `compatibilityDate` a workerd binary will accept
 * from its version string.
 *
 * Workerd's version format is `MAJOR.YYYYMMDD.PATCH` — the middle
 * component is the build date in compact ISO. Workerd refuses any
 * `compatibilityDate` strictly greater than its build date, with an
 * error like `compatibility date "2099-01-01" is too new`, so the
 * build date is the ceiling for safe configs.
 *
 * Returns the derived date in canonical `YYYY-MM-DD` form. Returns
 * `null` when the version string doesn't fit the canonical shape (e.g.
 * a custom build like `1.0-dev` or `0.0.0-foo`) — callers should treat
 * that as "ceiling unknown, trust the operator's configured date" and
 * surface workerd's own error if it complains at boot.
 *
 * This avoids spawning an extra workerd process just to discover the
 * ceiling: the version probe is already on the boot critical path, so
 * we get the ceiling for free.
 */
export function maxCompatDateFromVersion(version: string): string | null {
  const parts = version.split(".");
  if (parts.length < 2) return null;
  const dateToken = parts[1];
  if (!/^\d{8}$/.test(dateToken)) return null;
  const y = dateToken.slice(0, 4);
  const m = dateToken.slice(4, 6);
  const d = dateToken.slice(6, 8);
  // Sanity-check the components — `1.20260000.0` is technically valid
  // version syntax but not a real date. Reject obviously bad values
  // rather than emit a malformed compat date that workerd would also
  // reject.
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${m}-${d}`;
}

/**
 * Compare two ISO `YYYY-MM-DD` dates lexicographically. The component
 * widths are fixed so plain string comparison is correct and avoids
 * pulling in a Date parser (which would silently accept timezone-
 * shifted inputs and is overkill for an admin-supplied config field).
 */
export function isCompatDateAtMost(date: string, ceiling: string): boolean {
  return date <= ceiling;
}

/**
 * Run `workerd --version` and return the parsed result.
 *
 * Has a hard 5-second timeout so a hung binary doesn't block boot.
 * Throws on any failure — the orchestrator decides whether to fall
 * back to the Deno backend or surface to the operator.
 */
export async function probeVersion(binary: string): Promise<VersionInfo> {
  const cmd = new Deno.Command(binary, {
    args: ["--version"],
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, 5_000);
  try {
    const { code, stdout, stderr } = await child.output();
    if (code !== 0) {
      const err = new TextDecoder().decode(stderr).trim();
      throw new Error(`workerd --version exited with code ${code}: ${err}`);
    }
    return parseVersionOutput(new TextDecoder().decode(stdout));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a single TCP endpoint by attempting to open a connection.
 * Resolves true on the first successful connect, false if `signal` is
 * aborted before any attempt succeeds. Internal helper — not exported
 * because the public surface is `waitForPorts`.
 */
async function probeOnce(hostname: string, port: number): Promise<boolean> {
  try {
    const conn = await Deno.connect({ hostname, port });
    conn.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait until every supplied `host:port` pair accepts TCP connections.
 *
 * Polls each endpoint in parallel with `intervalMs` between attempts on
 * each individual endpoint. Resolves once all endpoints have succeeded
 * at least once. Rejects if `timeoutMs` elapses with any endpoint
 * still unreachable, or if `abortSignal` fires (typically because the
 * spawned process exited early).
 *
 * Exported and tested independently — useful enough that callers
 * outside this module (e.g. integration tests booting the backend in
 * an unusual configuration) can reuse it.
 */
export async function waitForPorts(
  endpoints: readonly { host: string; port: number }[],
  opts: { timeoutMs?: number; intervalMs?: number; abortSignal?: AbortSignal } =
    {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const deadline = performance.now() + timeoutMs;

  const sleep = (ms: number) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      };
      if (opts.abortSignal?.aborted) {
        onAbort();
        return;
      }
      opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
    });

  const probeUntilReady = async (ep: { host: string; port: number }) => {
    while (true) {
      if (opts.abortSignal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      if (performance.now() >= deadline) {
        throw new Error(
          `port ${ep.host}:${ep.port} not reachable after ${timeoutMs}ms`,
        );
      }
      if (await probeOnce(ep.host, ep.port)) return;
      await sleep(intervalMs);
    }
  };

  await Promise.all(endpoints.map(probeUntilReady));
}

/** Default `[workerd]`-prefixed line writer. Unbuffered. */
function defaultLogLineSink(line: string): void {
  // Single writeSync keeps line atomicity even when 1tube's own logger
  // is concurrently writing — the OS guarantees pipe writes <= PIPE_BUF
  // are atomic. Workerd lines are typically well under that limit.
  try {
    Deno.stderr.writeSync(new TextEncoder().encode(`[workerd] ${line}\n`));
  } catch {
    // stderr unavailable (test sandbox / closed handle). Drop silently
    // — losing log lines is preferable to crashing the process manager.
  }
}

/**
 * Pipe a `ReadableStream<Uint8Array>` into a line-oriented sink.
 *
 * Workerd flushes log lines individually but TCPdumps and other tools
 * sometimes coalesce them into multi-line chunks. We split on `\n` and
 * carry partial trailing data across reads so a sink-per-line contract
 * is preserved regardless of buffering behaviour upstream. Exits when
 * the source closes; no error path other than abort.
 */
async function pumpLines(
  stream: ReadableStream<Uint8Array>,
  sink: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        if (line.length > 0) sink(line);
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
    }
    // Flush any trailing partial line so a forgotten newline at EOF
    // doesn't swallow the last log line — common for processes that
    // exit without flushing.
    const tail = buf.replace(/\r$/, "");
    if (tail.length > 0) sink(tail);
  } finally {
    reader.releaseLock();
  }
}

/**
 * Try to terminate a child process gracefully on every supported
 * platform. Deno on Windows still rejects `SIGTERM`, so on `windows`
 * we go straight to `SIGKILL` (which Deno emulates as `TerminateProcess`).
 * Returns true if the kill request was accepted by the OS, false if
 * the process was already gone.
 */
function bestEffortKill(
  child: Deno.ChildProcess,
  signal: Deno.Signal,
): boolean {
  try {
    child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function summarizeRoutes(routes: readonly CapnpRoute[]): string {
  if (routes.length === 0) return "routes=0";
  const ports = routes.map((r) => r.port);
  const min = Math.min(...ports);
  const max = Math.max(...ports);
  const hosts = [...new Set(routes.map((r) => r.address))].join(",");
  return `routes=${routes.length} hosts=${hosts} ports=${min}${
    min === max ? "" : `-${max}`
  }`;
}

function formatStartupFailure(opts: {
  command: readonly string[];
  cwd: string;
  capnpPath: string;
  routes: readonly CapnpRoute[];
  exitCode: number | null | undefined;
  outputTail: readonly string[];
  cause: unknown;
}): string {
  const lines = [
    "workerd exited before sockets became ready",
    `  exitCode=${opts.exitCode ?? "<unknown>"}`,
    `  command=${opts.command.map(quoteArg).join(" ")}`,
    `  cwd=${opts.cwd}`,
    `  capnp=${opts.capnpPath}`,
    `  ${summarizeRoutes(opts.routes)}`,
  ];
  if (opts.cause instanceof Error) {
    lines.push(`  readiness=${opts.cause.message}`);
  }
  if (opts.outputTail.length > 0) {
    lines.push(`  -- last ${opts.outputTail.length} workerd output line(s) --`);
    for (const line of opts.outputTail) lines.push(`  | ${line}`);
  }
  return lines.join("\n");
}

/** Build the manager. Stateful — caller owns lifecycle. */
export function createWorkerdProcess(
  opts: WorkerdProcessOptions,
): WorkerdProcess {
  const sink = opts.logLineSink ?? defaultLogLineSink;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const shutdownTimeoutMs = opts.shutdownTimeoutMs ??
    DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const exitListeners = new Set<
    (code: number | null, expected: boolean) => void
  >();

  let child: Deno.ChildProcess | null = null;
  let started = false;
  let stopRequested = false;
  let exited = false;
  let pumpsDone: Promise<void> | null = null;

  const fireExit = (code: number | null, expected: boolean) => {
    if (exited) return;
    exited = true;
    for (const cb of exitListeners) {
      try {
        cb(code, expected);
      } catch { /* listener errors must never crash the manager */ }
    }
  };

  return {
    get pid() {
      return child?.pid ?? null;
    },
    onExit(cb) {
      exitListeners.add(cb);
    },
    async start() {
      if (started) {
        throw new Error("workerd process already started");
      }
      started = true;

      // Default cwd to the directory of the capnp file so `embed`
      // basenames resolve correctly. Using node:path here would force
      // a transitive node-path dependency on this module; the inline
      // separator-aware split is enough for our purposes.
      const cwd = opts.cwd ?? opts.capnpPath.replace(/[\\/][^\\/]+$/, "");
      const args = [
        ...(opts.globalArgs ?? []),
        "serve",
        opts.capnpPath,
        ...(opts.extraArgs ?? []),
      ];
      const command = [opts.binary, ...args];
      const outputTail: string[] = [];
      let exitCode: number | null | undefined;
      const captureLine = (line: string) => {
        outputTail.push(line);
        while (outputTail.length > OUTPUT_TAIL_LINES) outputTail.shift();
        sink(line);
      };

      const cmd = new Deno.Command(opts.binary, {
        args,
        cwd,
        env: opts.env,
        stdout: "piped",
        stderr: "piped",
      });

      child = cmd.spawn();

      // Pump stdout + stderr into the sink. Both pumps are awaited at
      // shutdown so the consumer can be sure no lines are lost.
      pumpsDone = Promise.all([
        pumpLines(child.stdout, captureLine),
        pumpLines(child.stderr, captureLine),
      ]).then(() => {});

      // Watch for early exit so a workerd that crashes during boot
      // (bad capnp, port collision, missing binary feature) cancels
      // the readiness wait instead of hanging until the timeout.
      const exitAbort = new AbortController();
      const exitWatch = child.status.then((status) => {
        exitCode = status.code;
        const expected = stopRequested;
        if (!expected) {
          // Crash before ready or during runtime. Abort the readiness
          // probe so start() can throw a meaningful error, then notify
          // any registered listeners.
          exitAbort.abort();
        }
        fireExit(status.code, expected);
        return status;
      });

      try {
        await waitForPorts(
          opts.routes.map((r) => ({ host: r.address, port: r.port })),
          {
            timeoutMs: readyTimeoutMs,
            intervalMs: probeIntervalMs,
            abortSignal: exitAbort.signal,
          },
        );
      } catch (err) {
        // Best-effort kill in case the process is up but not listening
        // (extremely rare with workerd, but defence in depth).
        if (child) bestEffortKill(child, "SIGKILL");
        await exitWatch.catch(() => {}); // swallow — already in failure path
        if (pumpsDone) await pumpsDone.catch(() => {});
        if (exitAbort.signal.aborted) {
          throw new Error(formatStartupFailure({
            command,
            cwd,
            capnpPath: opts.capnpPath,
            routes: opts.routes,
            exitCode,
            outputTail,
            cause: err,
          }));
        }
        throw err;
      }
    },

    async stop() {
      if (!child || exited) return;
      stopRequested = true;

      // Try graceful first. `SIGTERM` works on Linux/macOS; on Windows
      // Deno only supports `SIGKILL` so we go straight to that.
      const isWindows = Deno.build.os === "windows";
      bestEffortKill(child, isWindows ? "SIGKILL" : "SIGTERM");

      const status = child.status;
      const escalator = setTimeout(() => {
        if (child) bestEffortKill(child, "SIGKILL");
      }, shutdownTimeoutMs);

      try {
        await status;
      } finally {
        clearTimeout(escalator);
        // Wait for log pumps to drain so any final lines flush before
        // the caller's process exits. They terminate naturally when
        // the child closes its stdio handles.
        if (pumpsDone) {
          await pumpsDone.catch(() => {});
        }
      }
    },
  };
}
