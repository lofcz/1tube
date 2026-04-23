/**
 * TTY-aware live boot progress for function discovery.
 *
 * Problem: with `concurrency=8` (the discovery default), all eight imports
 * start in parallel and don't finish for several seconds. The previous
 * "print one line per completion" UI showed nothing during that window —
 * users assumed the process was hung. This module fills the gap with a
 * single in-place updated status line that shows what's currently being
 * compiled, plus elapsed time. Completed lines still print above it as
 * they finish, so scrollback is preserved.
 *
 * On non-TTY stdouts (piped output, CI logs) the spinner is silent and we
 * fall back to printing "starting" markers — same total information, no
 * cursor manipulation that would render as garbage in a log file.
 */

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const REFRESH_MS = 100;
/** Truncate the in-flight name list so the line fits a typical terminal. */
const MAX_LINE = 100;

export interface BootProgress {
  /** Initialise / reset for a new batch of `total` items. */
  start(total: number): void;
  /** An import has begun. */
  onStart(name: string): void;
  /** An item finished — print `line` (the formatted completion) above the spinner. */
  onFinish(line: string, name: string): void;
  /** Stop refreshing and clear the live line. Call from a try/finally. */
  stop(): void;
}

interface Sink {
  isTerminal(): boolean;
  writeSync(chunk: Uint8Array): number;
}

/**
 * Build a progress renderer. `sink` defaults to Deno.stdout but can be
 * overridden in tests.
 */
export function createBootProgress(sink: Sink = Deno.stdout): BootProgress {
  const enc = new TextEncoder();
  const isTty = (() => {
    try {
      return sink.isTerminal();
    } catch {
      return false;
    }
  })();

  const active = new Set<string>();
  let completed = 0;
  let total = 0;
  let startedAt = 0;
  let timer: number | undefined;
  let frame = 0;
  // Track how many cells the live line currently occupies so we can erase
  // it cleanly even if it wrapped.
  let lastDrawn = "";

  const write = (s: string) => {
    try {
      sink.writeSync(enc.encode(s));
    } catch {
      // closed pipe — give up silently rather than crash boot.
    }
  };

  const eraseLive = () => {
    if (!isTty || lastDrawn.length === 0) return;
    // CR + clear-to-end-of-line. Works in any VT100-compatible terminal.
    write("\r\x1b[K");
    lastDrawn = "";
  };

  const draw = () => {
    if (!isTty) return;
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    const spin = SPINNER[frame++ % SPINNER.length];
    const names = [...active];
    let inflight: string;
    if (names.length === 0) {
      inflight = "waiting…";
    } else if (names.length <= 4) {
      inflight = names.join(", ");
    } else {
      inflight = names.slice(0, 4).join(", ") + ` +${names.length - 4} more`;
    }
    let line =
      `\x1b[36m${spin}\x1b[0m \x1b[1m${completed}/${total}\x1b[0m loaded, ` +
      `${active.size} in progress: \x1b[2m${inflight}\x1b[0m \x1b[2m(${elapsed}s)\x1b[0m`;
    if (line.length > MAX_LINE) {
      line = line.slice(0, MAX_LINE - 1) + "…";
    }
    eraseLive();
    write(line);
    lastDrawn = line;
  };

  return {
    start(t) {
      total = t;
      completed = 0;
      active.clear();
      startedAt = performance.now();
      frame = 0;
      lastDrawn = "";
      if (isTty && t > 0) {
        timer = setInterval(draw, REFRESH_MS) as unknown as number;
        // Draw immediately so users see *something* before the first onStart.
        draw();
      }
    },
    onStart(name) {
      active.add(name);
      // Non-TTY: announce starts inline so logs still show progress between
      // completions. We rate-limit to one announcement per batch by only
      // emitting when nothing else is in-flight yet.
      if (!isTty && active.size <= 4) {
        write(`[1tube]    \x1b[2m→ compiling ${name}\x1b[0m\n`);
      }
      draw();
    },
    onFinish(line, name) {
      active.delete(name);
      completed++;
      eraseLive();
      write(line + "\n");
      draw();
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      eraseLive();
    },
  };
}
