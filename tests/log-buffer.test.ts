/**
 * Buffered log writer.
 *
 * Verifies the three flush triggers (interval, threshold, explicit), syncMode
 * pass-through, and that writes survive a closed/erroring stream.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _configureLogBufferForTests,
  _logBufferStatsForTests,
  _resetLogBufferForTests,
  flushLogs,
  logError,
  logInfo,
} from "../src/log-buffer.ts";

const decoder = new TextDecoder();

function makeSink() {
  const chunks: Uint8Array[] = [];
  let everThrew = false;
  const sink = {
    writeSync(p: Uint8Array): number {
      // Copy because the buffer module reuses subarrays.
      const c = new Uint8Array(p.length);
      c.set(p);
      chunks.push(c);
      return p.length;
    },
  };
  return {
    sink,
    text(): string {
      return chunks.map((c) => decoder.decode(c)).join("");
    },
    lines(): string[] {
      const t = chunks.map((c) => decoder.decode(c)).join("");
      return t.length === 0 ? [] : t.replace(/\n$/, "").split("\n");
    },
    writeCalls(): number {
      return chunks.length;
    },
    everThrew(): boolean {
      return everThrew;
    },
    breakAfter(_n: number): void {
      // not used here; placeholder for future tests
      everThrew = false;
    },
  };
}

function makeBrokenSink(throwOnCallNum: number) {
  let n = 0;
  return {
    writeSync(_p: Uint8Array): number {
      n++;
      if (n >= throwOnCallNum) throw new Error("pipe closed");
      return _p.length;
    },
  };
}

Deno.test("log-buffer: syncMode flushes every line immediately", () => {
  const out = makeSink();
  const err = makeSink();
  _configureLogBufferForTests({
    syncMode: true,
    flushIntervalMs: 0,
    stdout: out.sink,
    stderr: err.sink,
  });

  logInfo("one");
  logInfo("two");
  logError("oops");

  assertEquals(out.lines(), ["one", "two"]);
  assertEquals(err.lines(), ["oops"]);
  assertEquals(_logBufferStatsForTests().stdoutPending, 0);
  assertEquals(_logBufferStatsForTests().stderrPending, 0);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: flushIntervalMs=0 also flushes immediately", () => {
  const out = makeSink();
  _configureLogBufferForTests({
    flushIntervalMs: 0,
    flushThreshold: 100,
    stdout: out.sink,
    stderr: makeSink().sink,
  });

  logInfo("immediate");
  assertEquals(out.lines(), ["immediate"]);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: threshold flush — Nth line triggers a single batched write", () => {
  const out = makeSink();
  _configureLogBufferForTests({
    flushIntervalMs: 50,
    flushThreshold: 3,
    stdout: out.sink,
    stderr: makeSink().sink,
  });

  logInfo("a");
  logInfo("b");
  // Below threshold: nothing flushed yet.
  assertEquals(out.writeCalls(), 0);
  assertEquals(_logBufferStatsForTests().stdoutPending, 2);

  logInfo("c");
  // Threshold hit: exactly one writeSync call with all three lines.
  assertEquals(out.writeCalls(), 1);
  assertEquals(out.lines(), ["a", "b", "c"]);
  assertEquals(_logBufferStatsForTests().stdoutPending, 0);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: interval flush — line appears after the timer fires", async () => {
  const out = makeSink();
  _configureLogBufferForTests({
    flushIntervalMs: 30,
    flushThreshold: 1000,
    stdout: out.sink,
    stderr: makeSink().sink,
  });

  logInfo("delayed");
  // Not flushed synchronously.
  assertEquals(out.writeCalls(), 0);
  assertEquals(_logBufferStatsForTests().stdoutPending, 1);

  // Wait past the interval.
  await new Promise((r) => setTimeout(r, 80));
  assertEquals(out.writeCalls(), 1);
  assertEquals(out.lines(), ["delayed"]);
  assertEquals(_logBufferStatsForTests().stdoutPending, 0);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: explicit flush() drains both streams in one call each", () => {
  const out = makeSink();
  const err = makeSink();
  _configureLogBufferForTests({
    flushIntervalMs: 1000,
    flushThreshold: 1000,
    stdout: out.sink,
    stderr: err.sink,
  });

  logInfo("one");
  logInfo("two");
  logError("err1");
  logError("err2");
  logError("err3");

  assertEquals(out.writeCalls(), 0);
  assertEquals(err.writeCalls(), 0);

  flushLogs();

  assertEquals(out.writeCalls(), 1, "stdout drained in one writeSync");
  assertEquals(err.writeCalls(), 1, "stderr drained in one writeSync");
  assertEquals(out.lines(), ["one", "two"]);
  assertEquals(err.lines(), ["err1", "err2", "err3"]);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: stdout and stderr buffer independently", () => {
  const out = makeSink();
  const err = makeSink();
  _configureLogBufferForTests({
    flushIntervalMs: 1000,
    flushThreshold: 2,
    stdout: out.sink,
    stderr: err.sink,
  });

  logInfo("ok-1");
  logError("bad-1");
  // Neither has reached its own threshold of 2 yet.
  assertEquals(out.writeCalls(), 0);
  assertEquals(err.writeCalls(), 0);

  logInfo("ok-2");
  // Stdout has 2 → flushes; stderr still pending.
  assertEquals(out.writeCalls(), 1);
  assertEquals(out.lines(), ["ok-1", "ok-2"]);
  assertEquals(err.writeCalls(), 0);

  logError("bad-2");
  assertEquals(err.writeCalls(), 1);
  assertEquals(err.lines(), ["bad-1", "bad-2"]);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: write errors are swallowed (no crash on closed pipe)", () => {
  const broken = makeBrokenSink(1);
  _configureLogBufferForTests({
    syncMode: true,
    flushIntervalMs: 0,
    stdout: broken,
    stderr: makeSink().sink,
  });

  // This used to crash the process when stdout was closed (e.g. when the
  // user piped `1tube | head`). Must not throw.
  logInfo("first-line");
  logInfo("second-line");
  // Pass: we got here.
  assert(true);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: flush() on an empty buffer is a no-op", () => {
  const out = makeSink();
  _configureLogBufferForTests({
    flushIntervalMs: 1000,
    flushThreshold: 100,
    stdout: out.sink,
    stderr: makeSink().sink,
  });

  flushLogs();
  flushLogs();
  flushLogs();
  assertEquals(out.writeCalls(), 0);

  _resetLogBufferForTests();
});

Deno.test("log-buffer: multiple writes between threshold/interval batch into one syscall", () => {
  const out = makeSink();
  _configureLogBufferForTests({
    flushIntervalMs: 1000,
    flushThreshold: 50,
    stdout: out.sink,
    stderr: makeSink().sink,
  });

  for (let i = 0; i < 30; i++) logInfo(`line-${i}`);
  assertEquals(out.writeCalls(), 0);
  assertEquals(_logBufferStatsForTests().stdoutPending, 30);

  flushLogs();
  assertEquals(
    out.writeCalls(),
    1,
    "30 logs → 1 syscall (vs 30 with raw console.log)",
  );
  assertEquals(out.lines().length, 30);

  _resetLogBufferForTests();
});
