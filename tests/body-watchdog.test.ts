/**
 * Tests for src/gateway/body-watchdog.ts — the slow-loris guard.
 *
 * Covers: pass-through when disabled, normal fast body, slow-but-progressing
 * body that stays under the idle threshold, fully stalled body that trips the
 * watchdog, propagation of the abort signal to consumers (`req.text()` rejects
 * with AbortError), early consumer cancel, and that the watchdog never fires
 * after the source has cleanly closed.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { watchdogBody } from "../src/gateway/body-watchdog.ts";

const enc = new TextEncoder();

/**
 * Build a ReadableStream that emits N chunks with a configurable per-chunk
 * delay. `endless: true` keeps the stream open indefinitely after the last
 * chunk (simulates a slow-loris that stops sending bytes).
 */
function makeChunkedStream(opts: {
  chunks: Uint8Array[];
  gapMs: number;
  endless?: boolean;
}): ReadableStream<Uint8Array> {
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveLast: (() => void) | undefined;

  const clearAll = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    // If we're cancelled mid-pull (endless: true case especially), the
    // pending pull's resolver must run or the stream's internal queue stays
    // pinned and Deno's leak detector trips on the dangling timer.
    if (resolveLast) {
      resolveLast();
      resolveLast = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>((resolve) => {
        resolveLast = resolve;
        timer = setTimeout(() => {
          timer = undefined;
          resolveLast = undefined;
          if (i < opts.chunks.length) {
            controller.enqueue(opts.chunks[i++]);
            resolve();
          } else if (opts.endless) {
            // Resolve the pull but never enqueue/close — simulates a
            // slow-loris that's stopped sending bytes entirely. The next
            // pull() will arm a new timer that also goes nowhere; the
            // watchdog is what tears the stream down.
            resolve();
          } else {
            controller.close();
            resolve();
          }
        }, opts.gapMs);
      });
    },
    cancel() {
      clearAll();
    },
  });
}

async function drainToString(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(out);
}

Deno.test("body-watchdog: idleMs <= 0 is a pass-through (returns the same stream)", async () => {
  const src = makeChunkedStream({ chunks: [enc.encode("hi")], gapMs: 0 });
  const abort = new AbortController();
  const w = watchdogBody(src, 0, abort);
  assertEquals(
    w.body,
    src,
    "expected the original stream when watchdog is off",
  );
  assertEquals(w.stalled(), false);
  // Drain so the source's internal pull-queue doesn't leak its setTimeout
  // past the test boundary (Deno default highWaterMark eagerly pulls one).
  await src.cancel();
});

Deno.test("body-watchdog: a fast normal body passes through unmodified", async () => {
  const src = makeChunkedStream({
    chunks: [enc.encode("hello "), enc.encode("world")],
    gapMs: 5,
  });
  const abort = new AbortController();
  const w = watchdogBody(src, 200, abort);

  const out = await drainToString(w.body);
  assertEquals(out, "hello world");
  assertEquals(w.stalled(), false);
  assertEquals(abort.signal.aborted, false);
});

Deno.test("body-watchdog: slow-but-progressing body (gap < idle) is allowed", async () => {
  // Each chunk takes 30ms; idle threshold is 100ms — well under.
  const src = makeChunkedStream({
    chunks: [
      enc.encode("a"),
      enc.encode("b"),
      enc.encode("c"),
      enc.encode("d"),
    ],
    gapMs: 30,
  });
  const abort = new AbortController();
  const w = watchdogBody(src, 100, abort);

  const out = await drainToString(w.body);
  assertEquals(out, "abcd");
  assertEquals(w.stalled(), false);
  assertEquals(abort.signal.aborted, false);
});

Deno.test("body-watchdog: fully stalled body trips the watchdog and aborts", async () => {
  const src = makeChunkedStream({
    chunks: [enc.encode("first ")],
    gapMs: 5,
    endless: true,
  });
  const abort = new AbortController();
  const stallEvents: number[] = [];
  const w = watchdogBody(src, 50, abort, (idle) => stallEvents.push(idle));

  // Consume the body; should fail when the stall fires.
  await assertRejects(
    () => drainToString(w.body),
    Error,
  );

  assertEquals(w.stalled(), true);
  assertEquals(abort.signal.aborted, true);
  assertEquals(
    stallEvents,
    [50],
    "onStall should fire exactly once with the configured idleMs",
  );
  assert(abort.signal.reason instanceof DOMException);
  assertEquals((abort.signal.reason as DOMException).name, "AbortError");
});

Deno.test("body-watchdog: stall propagates as AbortError into req.text() consumers", async () => {
  const src = makeChunkedStream({
    chunks: [enc.encode("partial")],
    gapMs: 0,
    endless: true,
  });
  const abort = new AbortController();
  const w = watchdogBody(src, 30, abort);

  // Build a real Request from the wrapped body — exactly the shape the
  // dispatch path hands to a function handler. `req.text()` should reject
  // because our watchdog aborts the underlying stream mid-read.
  const req = new Request("http://x/", {
    method: "POST",
    body: w.body,
    signal: abort.signal,
    // @ts-ignore -- Deno supports `duplex` on Request
    duplex: "half",
  });

  await assertRejects(
    () => req.text(),
    Error,
  );
  assertEquals(w.stalled(), true);
});

Deno.test("body-watchdog: consumer cancel cancels the source and never trips", async () => {
  let sourceCancelled = false;
  // Hanging source: never enqueues, never closes — pull returns a Promise
  // that resolves only when the source is cancelled. No setTimeout needed,
  // which keeps the test's own bookkeeping leak-free.
  let resolvePull: (() => void) | undefined;
  const src = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>((r) => (resolvePull = r));
    },
    cancel() {
      sourceCancelled = true;
      resolvePull?.();
    },
  });

  const abort = new AbortController();
  // Idle threshold larger than anything we wait for in this test, so the
  // watchdog never fires of its own accord — only the consumer's cancel
  // tears the stream down.
  const w = watchdogBody(src, 1_000, abort);

  const reader = w.body.getReader();
  const readPromise = reader.read();
  // Let the consumer's read() reach our pull() and arm its watchdog timer
  // before we cancel — this is the realistic ordering.
  await new Promise((r) => setTimeout(r, 5));
  await reader.cancel("consumer changed mind");

  const r = await readPromise;
  assertEquals(r.done, true);

  assertEquals(sourceCancelled, true, "wrapped cancel must reach the source");
  assertEquals(w.stalled(), false);
  assertEquals(abort.signal.aborted, false);

  // Wait past the watchdog's 1s threshold — it must NOT trip after consumer
  // cancel because clear() ran in our wrapped cancel().
  await new Promise((r) => setTimeout(r, 30));
  assertEquals(w.stalled(), false);
});

Deno.test("body-watchdog: clean source close does not arm a stale timer", async () => {
  const src = makeChunkedStream({
    chunks: [enc.encode("ok")],
    gapMs: 5,
  });
  const abort = new AbortController();
  const w = watchdogBody(src, 30, abort);

  await drainToString(w.body);
  assertEquals(w.stalled(), false);

  // Wait well past the idle threshold — must NOT fire after EOF.
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(w.stalled(), false);
  assertEquals(abort.signal.aborted, false);
});

Deno.test("body-watchdog: idle timer resets on every chunk (delivery cadence ≈ 2× idle)", async () => {
  // Source delivers 5 chunks, each 40ms apart. Idle threshold is 60ms — never
  // exceeded between chunks, so the watchdog must NOT fire even though the
  // total body-read time (200ms) is more than 3× the idle threshold.
  const src = makeChunkedStream({
    chunks: ["a", "b", "c", "d", "e"].map((s) => enc.encode(s)),
    gapMs: 40,
  });
  const abort = new AbortController();
  const w = watchdogBody(src, 60, abort);

  const out = await drainToString(w.body);
  assertEquals(out, "abcde");
  assertEquals(w.stalled(), false);
});

Deno.test("body-watchdog: aborting via the external controller short-circuits the next read", async () => {
  const src = makeChunkedStream({
    chunks: [enc.encode("x")],
    gapMs: 0,
    endless: true,
  });
  const abort = new AbortController();
  const w = watchdogBody(src, 5_000, abort);

  const reader = w.body.getReader();
  await reader.read(); // get the first chunk
  // External actor (e.g. function timeout) trips the abort.
  abort.abort(new DOMException("external", "AbortError"));

  // The next read may resolve done or reject — either is fine, but it must
  // NOT hang. We bound it with a short timer to be sure the test fails fast
  // if a regression makes it block.
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error("read() hung after external abort")),
      500,
    );
  });
  try {
    await Promise.race([reader.read().catch(() => undefined), watchdog]);
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
  // (No assertion on the read outcome — only that we didn't hang.)
});
