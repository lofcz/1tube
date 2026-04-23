/**
 * Tests for src/boot-progress.ts — the append-only heartbeat reporter.
 *
 * The renderer is intentionally race-free with foreign stdout writers
 * (rogue console.log from imported function modules). It does NOT use
 * cursor escapes, so we assert their absence here as a regression guard.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "@std/assert";
import { createBootProgress } from "../src/boot-progress.ts";

class FakeSink {
  private chunks: string[] = [];
  private dec = new TextDecoder();
  isTerminal() {
    return true;
  }
  writeSync(chunk: Uint8Array): number {
    this.chunks.push(this.dec.decode(chunk));
    return chunk.length;
  }
  text(): string {
    return this.chunks.join("");
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("boot-progress: completion lines print verbatim with a trailing newline", () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 0 });
  p.start(2);
  p.onStart("alpha");
  p.onFinish("[1tube] [1/2] ✓ alpha (12ms)", "alpha");
  p.onStart("beta");
  p.onFinish("[1tube] [2/2] ✓ beta (8ms)", "beta");
  p.stop();
  assertEquals(
    sink.text(),
    "[1tube] [1/2] ✓ alpha (12ms)\n[1tube] [2/2] ✓ beta (8ms)\n",
  );
});

Deno.test("boot-progress: never emits cursor-rewrite escapes (no \\r, no clear-line)", () => {
  // The whole point of the new design — anything that overwrites in-place
  // would race with foreign console.log writers from imported modules.
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 0 });
  p.start(3);
  p.onStart("a");
  p.onStart("b");
  p.onFinish("[1tube] [1/3] ✓ a (5ms)", "a");
  p.onFinish("[1tube] [2/3] ✓ b (5ms)", "b");
  p.onStart("c");
  p.onFinish("[1tube] [3/3] ✓ c (5ms)", "c");
  p.stop();
  const text = sink.text();
  assert(!text.includes("\r"), "must not write carriage returns");
  assert(!text.includes("\x1b[K"), "must not write ANSI clear-line");
  assert(!text.includes("\x1b[2K"), "must not write ANSI clear-entire-line");
});

Deno.test("boot-progress: heartbeat fires after pulseMs and reports current state", async () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 30 });
  p.start(3);
  p.onStart("alpha");
  p.onStart("beta");
  // Wait long enough for at least one pulse.
  await wait(60);
  p.stop();
  const text = sink.text();
  assertStringIncludes(text, "still working");
  assertStringIncludes(text, "0/3 loaded");
  assertStringIncludes(text, "2 in progress");
});

Deno.test("boot-progress: heartbeat suppresses repeats when nothing changed", async () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 20 });
  p.start(2);
  p.onStart("only");
  // Three pulse intervals with no state change → only the FIRST one prints,
  // subsequent identical snapshots are suppressed so we don't spam the log.
  await wait(80);
  p.stop();
  const heartbeats = sink.text().match(/still working/g) ?? [];
  assertEquals(
    heartbeats.length,
    1,
    `expected exactly one heartbeat for an unchanging snapshot, got ${heartbeats.length}`,
  );
});

Deno.test("boot-progress: heartbeat resumes after state change (onFinish reset)", async () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 20 });
  p.start(3);
  p.onStart("a");
  p.onStart("b");
  await wait(40); // first pulse
  p.onFinish("[1tube] [1/3] ✓ a (5ms)", "a");
  await wait(40); // second pulse — different snapshot, must print
  p.stop();
  const heartbeats = sink.text().match(/still working/g) ?? [];
  assert(
    heartbeats.length >= 2,
    `expected ≥2 heartbeats across a state change, got ${heartbeats.length}`,
  );
});

Deno.test("boot-progress: no heartbeat once everything has completed", async () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 20 });
  p.start(1);
  p.onStart("only");
  p.onFinish("[1tube] [1/1] ✓ only (5ms)", "only");
  await wait(60); // multiple pulse windows after completion
  p.stop();
  const heartbeats = sink.text().match(/still working/g) ?? [];
  assertEquals(heartbeats.length, 0, "should not pulse after work is done");
});

Deno.test("boot-progress: pulseMs <= 0 disables heartbeats entirely", async () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 0 });
  p.start(2);
  p.onStart("alpha");
  await wait(40);
  p.stop();
  assertEquals(sink.text().includes("still working"), false);
});

Deno.test("boot-progress: heartbeat inflight list is capped with '+N more'", async () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 20 });
  p.start(20);
  for (let i = 0; i < 12; i++) p.onStart(`f${i}`);
  await wait(40);
  p.stop();
  const text = sink.text();
  assertStringIncludes(text, "+8 more");
});

Deno.test("boot-progress: stop() is idempotent and writes nothing on repeated calls", () => {
  const sink = new FakeSink();
  const p = createBootProgress(sink, { pulseMs: 1000 });
  p.start(1);
  p.onStart("only");
  p.onFinish("[1tube] [1/1] ✓ only (5ms)", "only");
  p.stop();
  const before = sink.text().length;
  p.stop();
  p.stop();
  assertEquals(sink.text().length, before);
});

Deno.test("boot-progress: write errors on the sink don't crash the renderer", async () => {
  // Simulate a closed pipe — every writeSync throws. The renderer must
  // swallow the error rather than take the gateway down at boot.
  const broken = {
    isTerminal: () => true,
    writeSync(_chunk: Uint8Array): number {
      throw new Error("EPIPE");
    },
  };
  const p = createBootProgress(broken, { pulseMs: 20 });
  p.start(2);
  p.onStart("alpha");
  await wait(40); // forces a pulse — writeSync throws inside it
  p.onFinish("[1tube] [1/2] ✓ alpha (5ms)", "alpha");
  p.stop();
});
