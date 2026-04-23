/**
 * Append-only boot progress reporter for function discovery.
 *
 * Why not a live in-place spinner? With many functions importing in
 * parallel, their top-level `console.log()` calls hit the same TTY as our
 * renderer. Any cursor-rewrite scheme (\r + clear-line, ANSI cursor
 * positioning, alt-screen, even Ink) corrupts the moment a foreign writer
 * lands a line — you get flicker, half-erased frames, or text glued to
 * the spinner. Below 200 ms of redraw cadence the eye also reads it as
 * blinking, which the operator perceives as "broken UI".
 *
 * So we don't redraw. We print one normal newline-terminated line every
 * `pulseMs` saying "still working, X/Y done, in progress: …". It's not
 * animated, but it's:
 *   - race-free with foreign stdout writers,
 *   - zero-cost (one syscall every couple of seconds),
 *   - safe to pipe to a file or capture in CI,
 *   - and identical between TTY and non-TTY paths (no branching).
 *
 * Pulses self-suppress when no work has changed since the previous tick,
 * so a wedged import won't spam the log either.
 */

const DEFAULT_PULSE_MS = 2000;
/** Cap inflight names rendered inline so a long list doesn't wrap. */
const MAX_INFLIGHT_RENDERED = 4;

export interface BootProgress {
  /** Reset and arm the heartbeat for a new batch of `total` items. */
  start(total: number): void;
  /** An import has begun. */
  onStart(name: string): void;
  /** Print a completion line and update internal counters. */
  onFinish(line: string, name: string): void;
  /** Stop the heartbeat. Safe to call repeatedly. */
  stop(): void;
}

interface Sink {
  writeSync(chunk: Uint8Array): number;
  // Kept in the interface for future use / fakes; renderer ignores it.
  isTerminal?(): boolean;
}

export interface BootProgressOptions {
  /** Heartbeat cadence in ms. Default 2000. Set ≤0 to disable heartbeats. */
  pulseMs?: number;
}

export function createBootProgress(
  sink: Sink = Deno.stdout,
  opts: BootProgressOptions = {},
): BootProgress {
  const enc = new TextEncoder();
  const pulseMs = opts.pulseMs ?? DEFAULT_PULSE_MS;

  const active = new Set<string>();
  let completed = 0;
  let total = 0;
  let startedAt = 0;
  let timer: number | undefined;
  // Snapshot used to suppress a heartbeat when nothing has moved since the
  // last pulse — important when a single slow import blocks the worker
  // pool and we'd otherwise emit identical lines forever.
  let lastSnapshot = "";

  const write = (s: string) => {
    try {
      sink.writeSync(enc.encode(s));
    } catch {
      // Closed pipe — never crash boot over a broken stdout.
    }
  };

  const renderInflight = (): string => {
    if (active.size === 0) return "(idle)";
    const names = [...active];
    if (names.length <= MAX_INFLIGHT_RENDERED) return names.join(", ");
    return (
      names.slice(0, MAX_INFLIGHT_RENDERED).join(", ") +
      ` +${names.length - MAX_INFLIGHT_RENDERED} more`
    );
  };

  const pulse = () => {
    if (total === 0) return;
    if (completed >= total) return;
    const snapshot = `${completed}|${[...active].sort().join(",")}`;
    if (snapshot === lastSnapshot) return;
    lastSnapshot = snapshot;
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    write(
      `[1tube]    \x1b[2m… still working: ${completed}/${total} loaded, ` +
        `${active.size} in progress (${renderInflight()}) (${elapsed}s)\x1b[0m\n`,
    );
  };

  return {
    start(t) {
      total = t;
      completed = 0;
      active.clear();
      startedAt = performance.now();
      lastSnapshot = "";
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      if (pulseMs > 0 && t > 0) {
        timer = setInterval(pulse, pulseMs) as unknown as number;
      }
    },
    onStart(name) {
      active.add(name);
    },
    onFinish(line, name) {
      active.delete(name);
      completed++;
      write(line + "\n");
      // Reset the snapshot so the next pulse always reflects the new state
      // immediately rather than waiting another `pulseMs`.
      lastSnapshot = "";
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
