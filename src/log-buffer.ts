/**
 * Tiny, dependency-free buffered line writer.
 *
 * Why: per-request `console.log` is surprisingly expensive (~10–30µs each)
 * because every call goes through Deno's logger formatting, encodes a
 * separate UTF-8 buffer, and issues a `write(2)` to the host. Under load
 * that's 10–30% of a single-process gateway's CPU budget.
 *
 * This buffers lines into a single `Uint8Array` and flushes on either:
 *   - `flushIntervalMs` elapsed since the first buffered line, OR
 *   - `flushThreshold` lines accumulated, OR
 *   - explicit `flush()` (used by graceful-shutdown), OR
 *   - explicit `flushNow()` (used by tests).
 *
 * stdout and stderr each get their own buffer so error lines don't get
 * stuck behind successful traffic and vice versa.
 *
 * Set `flushIntervalMs: 0` to make the buffer behave like raw `console.log`
 * (every write flushes immediately) — useful for `--dev` so log output is
 * always live in the terminal.
 */

const encoder = new TextEncoder();

export interface LogBufferConfig {
  flushIntervalMs: number;
  flushThreshold: number;
  /** When true, every write flushes immediately (overrides interval/threshold). */
  syncMode?: boolean;
}

class StreamBuffer {
  private buf: string[] = [];
  private timer: number | undefined;
  private bytesPending = 0;

  constructor(
    private readonly stream: { writeSync(p: Uint8Array): number },
    private readonly cfg: LogBufferConfig,
  ) {}

  write(line: string): void {
    if (this.cfg.syncMode || this.cfg.flushIntervalMs <= 0) {
      this.writeOne(line);
      return;
    }
    this.buf.push(line);
    this.bytesPending += line.length + 1;
    if (this.buf.length >= this.cfg.flushThreshold) {
      this.flushNow();
      return;
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flushNow(), this.cfg.flushIntervalMs);
      // Don't keep the event loop alive just for a pending log flush.
      // Deno's setTimeout returns a number; unref via the symbol if available.
      const t = this.timer as unknown as { unref?: () => void };
      if (typeof t?.unref === "function") t.unref();
    }
  }

  /** Flush synchronously. Safe to call even when the buffer is empty. */
  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.buf.length === 0) return;
    const joined = this.buf.join("\n") + "\n";
    this.buf.length = 0;
    this.bytesPending = 0;
    try {
      const bytes = encoder.encode(joined);
      let off = 0;
      while (off < bytes.length) {
        const n = this.stream.writeSync(bytes.subarray(off));
        if (n <= 0) break;
        off += n;
      }
    } catch {
      // If stdout is closed (e.g. piped consumer exited) there's nowhere to
      // recover to — just drop the lines.
    }
  }

  private writeOne(line: string): void {
    try {
      this.stream.writeSync(encoder.encode(line + "\n"));
    } catch {
      // Same as above.
    }
  }

  get pending(): number {
    return this.buf.length;
  }
}

const defaultCfg = (): LogBufferConfig => {
  const dev = (Deno.env.get("1TUBE_DEV") || "") === "1";
  const envInterval = Number(Deno.env.get("1TUBE_LOG_BUFFER_MS"));
  const envThreshold = Number(Deno.env.get("1TUBE_LOG_BUFFER_LINES"));
  const flushIntervalMs = Number.isFinite(envInterval) && envInterval >= 0
    ? envInterval
    : (dev ? 0 : 50);
  const flushThreshold = Number.isFinite(envThreshold) && envThreshold > 0
    ? Math.floor(envThreshold)
    : 100;
  return { flushIntervalMs, flushThreshold };
};

let cfg: LogBufferConfig = defaultCfg();
let stdoutBuf = new StreamBuffer(Deno.stdout, cfg);
let stderrBuf = new StreamBuffer(Deno.stderr, cfg);

export function logInfo(line: string): void {
  stdoutBuf.write(line);
}

export function logError(line: string): void {
  stderrBuf.write(line);
}

/** Flush both streams synchronously — used by graceful shutdown. */
export function flushLogs(): void {
  stdoutBuf.flushNow();
  stderrBuf.flushNow();
}

/** Test-only: replace the runtime config. */
export function _configureLogBufferForTests(
  next: Partial<LogBufferConfig> & {
    stdout?: { writeSync(p: Uint8Array): number };
    stderr?: { writeSync(p: Uint8Array): number };
  } = {},
): void {
  cfg = {
    flushIntervalMs: next.flushIntervalMs ?? 0,
    flushThreshold: next.flushThreshold ?? 100,
    syncMode: next.syncMode,
  };
  stdoutBuf = new StreamBuffer(next.stdout ?? Deno.stdout, cfg);
  stderrBuf = new StreamBuffer(next.stderr ?? Deno.stderr, cfg);
}

/** Test-only: reset config back to env-derived defaults. */
export function _resetLogBufferForTests(): void {
  cfg = defaultCfg();
  stdoutBuf = new StreamBuffer(Deno.stdout, cfg);
  stderrBuf = new StreamBuffer(Deno.stderr, cfg);
}

export function _logBufferStatsForTests(): { stdoutPending: number; stderrPending: number } {
  return { stdoutPending: stdoutBuf.pending, stderrPending: stderrBuf.pending };
}
