/**
 * Tests for src/boot-progress.ts — the live boot spinner.
 *
 * The renderer has two paths (TTY / non-TTY) and we exercise both via a
 * fake sink that lets us flip `isTerminal` and capture every byte written.
 * We don't assert exact frame timing — the spinner ticks on a 100 ms
 * interval which would make tests flaky — but we do verify that the public
 * contract holds: completion lines appear, the live line is erased on
 * stop, and non-TTY mode emits a "compiling" announcement per start.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createBootProgress } from "../src/boot-progress.ts";

class FakeSink {
  private chunks: string[] = [];
  private dec = new TextDecoder();
  constructor(public tty: boolean) {}
  isTerminal() {
    return this.tty;
  }
  writeSync(chunk: Uint8Array): number {
    this.chunks.push(this.dec.decode(chunk));
    return chunk.length;
  }
  text(): string {
    return this.chunks.join("");
  }
  /** All emitted lines, with ANSI escape sequences stripped. */
  cleanLines(): string[] {
    const stripped = this.text().replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
    return stripped.split("\n");
  }
  reset() {
    this.chunks = [];
  }
}

Deno.test("boot-progress: TTY mode prints completion lines and erases the live line on stop", () => {
  const sink = new FakeSink(true);
  const p = createBootProgress(sink);
  p.start(3);
  p.onStart("alpha");
  p.onStart("beta");
  p.onFinish("[1tube] [1/3] ✓ alpha (12ms)", "alpha");
  p.onStart("gamma");
  p.onFinish("[1tube] [2/3] ✓ beta (15ms)", "beta");
  p.onFinish("[1tube] [3/3] ✓ gamma (20ms)", "gamma");
  p.stop();

  const text = sink.text();
  // Completion lines made it through verbatim (modulo trailing newline).
  assertStringIncludes(text, "[1tube] [1/3] ✓ alpha (12ms)");
  assertStringIncludes(text, "[1tube] [2/3] ✓ beta (15ms)");
  assertStringIncludes(text, "[1tube] [3/3] ✓ gamma (20ms)");
  // Stop must end with a clear-line escape so the spinner doesn't survive.
  assert(
    text.endsWith("\r\x1b[K") || !text.includes("in progress"),
    "live line must be erased after stop()",
  );
});

Deno.test("boot-progress: TTY mode draws an initial spinner before any onStart", () => {
  const sink = new FakeSink(true);
  const p = createBootProgress(sink);
  p.start(5);
  // Right after start() with total > 0, the live line should already be on
  // screen — that's the whole point of the change (no silent gap).
  const after = sink.cleanLines().join(" ");
  assertStringIncludes(after, "0/5 loaded");
  assertStringIncludes(after, "in progress: waiting");
  p.stop();
});

Deno.test("boot-progress: non-TTY emits 'compiling' lines per onStart and never draws a spinner", () => {
  const sink = new FakeSink(false);
  const p = createBootProgress(sink);
  p.start(2);
  p.onStart("alpha");
  p.onStart("beta");
  p.onFinish("[1tube] [1/2] ✓ alpha (10ms)", "alpha");
  p.onFinish("[1tube] [2/2] ✓ beta (10ms)", "beta");
  p.stop();

  const text = sink.text();
  // Non-TTY announcement appears for each start.
  assertStringIncludes(text, "→ compiling alpha");
  assertStringIncludes(text, "→ compiling beta");
  // Completion lines still print.
  assertStringIncludes(text, "[1tube] [1/2] ✓ alpha");
  assertStringIncludes(text, "[1tube] [2/2] ✓ beta");
  // No cursor-rewrite escapes in non-TTY mode (would garble log files).
  assertEquals(text.includes("\r\x1b[K"), false);
});

Deno.test("boot-progress: non-TTY caps 'compiling' announcements when many starts arrive at once", () => {
  // 10 simultaneous starts shouldn't produce 10 lines of noise — the
  // renderer caps the announcement to the first 4 in-flight items.
  const sink = new FakeSink(false);
  const p = createBootProgress(sink);
  p.start(10);
  for (let i = 0; i < 10; i++) p.onStart(`fn-${i}`);

  const compileLines = sink.text().match(/→ compiling/g) ?? [];
  assert(
    compileLines.length <= 4,
    `expected at most 4 compile announcements, got ${compileLines.length}`,
  );
  p.stop();
});

Deno.test("boot-progress: TTY live line shows running totals and truncates a long in-flight list", () => {
  const sink = new FakeSink(true);
  const p = createBootProgress(sink);
  p.start(20);
  // Use short names so the line doesn't hit the column-width truncation
  // before we get a chance to see the "+N more" suffix (the latter is the
  // contract under test).
  for (let i = 0; i < 12; i++) p.onStart(`f${i}`);
  // Close one to drive the counter past zero.
  p.onFinish("[1tube] [1/20] ✓ f0 (30ms)", "f0");

  // Bold/dim ANSI escapes split substrings like "1/20" and "loaded" — strip
  // them before asserting on human-readable content.
  const clean = sink.cleanLines().join("\n");
  assertStringIncludes(clean, "1/20 loaded");
  // The renderer caps the inline name list at 4 visible + "+N more".
  // After one finished, 11 remain → 4 visible + "+7 more".
  assertStringIncludes(clean, "+7 more");
  p.stop();
});

Deno.test("boot-progress: stop() is idempotent and survives repeated calls", () => {
  const sink = new FakeSink(true);
  const p = createBootProgress(sink);
  p.start(1);
  p.onStart("only");
  p.onFinish("[1tube] [1/1] ✓ only (5ms)", "only");
  p.stop();
  // Second stop() must not throw or write anything that resembles a frame.
  const before = sink.text().length;
  p.stop();
  const after = sink.text().length;
  assertEquals(before, after, "stop() should not write on repeated calls");
});

Deno.test("boot-progress: write errors on the sink don't crash the renderer", () => {
  // Simulate a closed pipe — sink throws on writeSync. The renderer must
  // swallow the error so a broken stdout never takes the gateway down.
  const broken = {
    isTerminal: () => true,
    writeSync(_chunk: Uint8Array): number {
      throw new Error("EPIPE");
    },
  };
  const p = createBootProgress(broken);
  // None of these should throw.
  p.start(2);
  p.onStart("alpha");
  p.onFinish("[1tube] [1/2] ✓ alpha (1ms)", "alpha");
  p.stop();
});
