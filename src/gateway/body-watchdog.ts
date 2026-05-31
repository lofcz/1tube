/**
 * Slow-loris / stalled-body protection.
 *
 * `Deno.serve` does not enforce a per-request body-read timeout. A client that
 * dribbles bytes at a few per second can occupy a request slot for the full
 * `FUNCTION_TIMEOUT_MS` (default 150 s), starving real traffic. We don't want
 * to *cap total body read time* — large but fast uploads are fine — we want
 * to detect *stalled progress*: too long a gap between consecutive chunks.
 *
 * Strategy: wrap the original `ReadableStream<Uint8Array>` body in a passthrough
 * stream that arms a `setTimeout(idleMs)` before each `read()` and clears it
 * when the source delivers a chunk. If the timer fires, we abort the request's
 * `AbortController` (same one wired to the rewritten `Request.signal`), which
 * propagates into any in-flight `req.json()` / `req.text()` / `req.arrayBuffer()`
 * the handler is awaiting and frees the request slot immediately.
 *
 * `idleMs <= 0` returns the body unchanged (feature off — useful in tests
 * and for explicit opt-out via `1TUBE_BODY_READ_MS=0`).
 *
 * Body-less requests (GET / HEAD / DELETE without a body) skip the watchdog
 * because there's nothing to read; this is enforced by the caller checking
 * for a non-null `body` before wrapping.
 */

export interface BodyWatchdogResult {
  /** New body stream that aborts on stall. */
  body: ReadableStream<Uint8Array>;
  /** Resolves when the wrapped stream is fully drained or torn down. */
  done: Promise<void>;
  /** Test-visible: did the watchdog fire on this body? */
  stalled: () => boolean;
}

/**
 * Wrap a request body with a stall-detector. Returns the original stream
 * unchanged when `idleMs <= 0`.
 */
export function watchdogBody(
  source: ReadableStream<Uint8Array>,
  idleMs: number,
  abort: AbortController,
  onStall?: (idleMs: number) => void,
): BodyWatchdogResult {
  if (idleMs <= 0) {
    return {
      body: source,
      done: Promise.resolve(),
      stalled: () => false,
    };
  }

  const reader = source.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didStall = false;
  /** Set by the timer callback so the in-flight pull() can surface it as an
   *  error to the consumer instead of treating the cancel-induced EOF as a
   *  clean close. */
  let stallReason: DOMException | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  // When *external* code aborts the request signal (e.g. the function-level
  // wall-clock timeout in server.ts, or the connection drops), we still need
  // to unblock our in-flight pull(). Without this, `await reader.read()`
  // could hang on a source that doesn't honour any signal of its own.
  const onExternalAbort = () => {
    const reason = abort.signal.reason instanceof Error
      ? abort.signal.reason
      : new DOMException("Request aborted", "AbortError");
    reader.cancel(reason).catch(() => {});
  };
  if (abort.signal.aborted) {
    queueMicrotask(onExternalAbort);
  } else {
    abort.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  const arm = () => {
    clear();
    timer = setTimeout(() => {
      didStall = true;
      const reason = new DOMException(
        `Body read stalled (${idleMs}ms)`,
        "AbortError",
      );
      stallReason = reason;
      onStall?.(idleMs);
      // Abort the request signal so the handler's `req.json()` / consumers
      // observe the same AbortError they'd see for any other client cancel.
      try {
        abort.abort(reason);
      } catch {
        // already aborted
      }
      // Cancel the underlying source reader. Without this the in-flight
      // `reader.read()` we're awaiting in `pull()` would never resolve —
      // the source stream is the one that's stalled, and aborting our
      // request signal alone doesn't propagate into it. After cancel() the
      // pending read resolves with {done: true}; pull() reads `stallReason`
      // and surfaces it as an error to the consumer instead of a clean EOF.
      reader.cancel(reason).catch(() => {});
    }, idleMs);
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      arm();
      try {
        const { value, done: srcDone } = await reader.read();
        clear();
        if (srcDone) {
          if (stallReason) {
            // EOF was synthesised by our own reader.cancel() in the timer
            // — translate it back into the stall error for the consumer.
            controller.error(stallReason);
          } else {
            controller.close();
          }
          resolveDone();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        clear();
        // If the source rejected (rather than cleanly closing after our
        // cancel), prefer the stall reason for clarity in logs / responses.
        controller.error(stallReason ?? err);
        resolveDone();
      }
    },
    async cancel(reason) {
      clear();
      try {
        await reader.cancel(reason);
      } finally {
        resolveDone();
      }
    },
  });

  return {
    body: wrapped,
    done,
    stalled: () => didStall,
  };
}
