/**
 * Tests for the workerd memory watchdog and the proc-stats helpers.
 *
 * The watchdog itself is tested with full fakes (no real workerd, no
 * real fs, no real timers): we drive `sample()` directly and inject
 * a fake clock + a synthetic RSS series. That gives deterministic
 * coverage of the hysteresis, cooldown, and recycle paths without
 * the flake of a polling-based test.
 *
 * `pidRss()` is exercised end-to-end against the test process's own
 * PID — every supported platform should return a sensible non-zero
 * RSS for a running Deno process, so this is the most direct
 * cross-platform smoke check we can afford in CI.
 */

import { assert, assertEquals, assertGreater } from "@std/assert";
import {
  createWorkerdWatchdog,
  recommendedBudgetBytes,
  type WatchdogBackend,
} from "../src/backends/workerd/watchdog.ts";
import {
  parseLinuxStatus,
  parsePsOutput,
  parseTasklistCsv,
  pidRss,
} from "../src/backends/workerd/proc-stats.ts";

// ---------------------------------------------------------------------------
// proc-stats parsers
// ---------------------------------------------------------------------------

Deno.test("parseLinuxStatus: extracts VmRSS in bytes", () => {
  // Real /proc/{pid}/status sample (truncated) — kernel 6.x format
  // mixes tabs/spaces; the regex must handle both.
  const status = `Name:\tworkerd
Umask:\t0022
State:\tS (sleeping)
VmRSS:\t   12345 kB
VmHWM:\t   23456 kB
`;
  assertEquals(parseLinuxStatus(status), 12345 * 1024);
});

Deno.test("parseLinuxStatus: returns null when VmRSS is missing", () => {
  assertEquals(parseLinuxStatus("Name: workerd\nState: R\n"), null);
});

Deno.test("parsePsOutput: handles whitespace + leading-zero variants", () => {
  // `ps -o rss=` emits just the numeric value, possibly with leading
  // padding. Some busybox-like ps implementations tack on the column
  // header even with `=`; the parser must strip non-digits.
  assertEquals(parsePsOutput("12345\n"), 12345 * 1024);
  assertEquals(parsePsOutput("   42\n"), 42 * 1024);
  // Some busybox-like ps prints the column header even with `=`;
  // stripping non-digits flattens "RSS\n  100" → "100" KB.
  assertEquals(parsePsOutput(" RSS\n  100\n"), 100 * 1024);
});

Deno.test("parsePsOutput: empty output returns null", () => {
  assertEquals(parsePsOutput(""), null);
  assertEquals(parsePsOutput("\n   \n"), null);
});

Deno.test("parseTasklistCsv: parses standard en-US tasklist row", () => {
  const csv = `"workerd.exe","12345","Console","1","45,678 K"`;
  assertEquals(parseTasklistCsv(csv), 45678 * 1024);
});

Deno.test("parseTasklistCsv: handles non-en locale separators", () => {
  // de-DE separates thousands with a dot; we strip everything
  // non-numeric, so it parses identically.
  const csv = `"workerd.exe","12345","Console","1","45.678 K"`;
  assertEquals(parseTasklistCsv(csv), 45678 * 1024);
});

Deno.test("parseTasklistCsv: 'no tasks' message returns null", () => {
  assertEquals(
    parseTasklistCsv(
      "INFO: No tasks are running which match the specified criteria.",
    ),
    null,
  );
});

Deno.test("pidRss: returns a positive number for the current process", async () => {
  const rss = await pidRss(Deno.pid);
  // Skip on platforms where the helper genuinely can't read RSS
  // (e.g. some sandboxed CI runners that lack /proc, ps, AND
  // tasklist). We log a clear marker so the skip is visible.
  if (rss === null) {
    console.log("[skipped: pidRss returned null on this platform]");
    return;
  }
  // A Deno test process is at least a few MB; any value much
  // smaller than that is almost certainly a parser bug. Use 1MB
  // as the floor.
  assertGreater(rss, 1 * 1024 * 1024, `expected RSS > 1MB; got ${rss}`);
});

// ---------------------------------------------------------------------------
// Watchdog: hysteresis, cooldown, recycle path
// ---------------------------------------------------------------------------

/** Stub backend honouring just the surface the watchdog touches. */
function stubBackend(initialPid: number | null = 1234): WatchdogBackend & {
  reloadCalls: number;
  setPid(p: number | null): void;
  reloadShouldFail?: boolean;
} {
  let pid = initialPid;
  let count = 0;
  const stub = {
    get pid() {
      return pid;
    },
    setPid(p: number | null) {
      pid = p;
    },
    reload(_changed?: ReadonlySet<string> | "all"): Promise<unknown> {
      count++;
      if ((stub as { reloadShouldFail?: boolean }).reloadShouldFail) {
        return Promise.reject(new Error("synthetic reload failure"));
      }
      return Promise.resolve({});
    },
    get reloadCalls() {
      return count;
    },
  };
  return stub;
}

/** Manual clock — cooldown timing depends on this rather than wall-clock. */
function manualClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

Deno.test("watchdog: under-budget RSS never triggers a recycle", async () => {
  const backend = stubBackend();
  const clock = manualClock();
  const w = createWorkerdWatchdog({
    backend,
    budgetBytes: 100 * 1024 * 1024,
    hysteresisSamples: 3,
    cooldownMs: 1000,
    getRss: () => Promise.resolve(50 * 1024 * 1024),
    now: clock.now,
    log: () => {},
  });
  for (let i = 0; i < 10; i++) {
    await w.sample();
    clock.advance(100);
  }
  assertEquals(backend.reloadCalls, 0);
  assertEquals(w.stats.overBudgetStreak, 0);
  assertEquals(w.stats.samples, 10);
});

Deno.test("watchdog: requires N consecutive over-budget samples before recycling", async () => {
  const backend = stubBackend();
  const clock = manualClock();
  const w = createWorkerdWatchdog({
    backend,
    budgetBytes: 100 * 1024 * 1024,
    hysteresisSamples: 3,
    cooldownMs: 1000,
    getRss: () => Promise.resolve(150 * 1024 * 1024),
    now: clock.now,
    log: () => {},
  });

  await w.sample();
  assertEquals(backend.reloadCalls, 0);
  assertEquals(w.stats.overBudgetStreak, 1);

  await w.sample();
  assertEquals(backend.reloadCalls, 0);
  assertEquals(w.stats.overBudgetStreak, 2);

  // Third sample crosses the threshold and recycles. The streak
  // counter resets to 0 after the recycle (so a re-trigger would
  // require N more consecutive overages — important for stability).
  await w.sample();
  assertEquals(backend.reloadCalls, 1);
  assertEquals(w.stats.overBudgetStreak, 0);
  assertEquals(w.stats.recycles, 1);
});

Deno.test("watchdog: a single under-budget sample resets the streak", async () => {
  const backend = stubBackend();
  const clock = manualClock();
  let value = 150 * 1024 * 1024;
  const w = createWorkerdWatchdog({
    backend,
    budgetBytes: 100 * 1024 * 1024,
    hysteresisSamples: 3,
    cooldownMs: 1000,
    getRss: () => Promise.resolve(value),
    now: clock.now,
    log: () => {},
  });

  await w.sample(); // over
  await w.sample(); // over
  assertEquals(w.stats.overBudgetStreak, 2);

  value = 80 * 1024 * 1024;
  await w.sample(); // under — streak resets
  assertEquals(w.stats.overBudgetStreak, 0);

  value = 150 * 1024 * 1024;
  await w.sample(); // over again
  await w.sample();
  assertEquals(w.stats.overBudgetStreak, 2);
  assertEquals(backend.reloadCalls, 0); // never crossed 3 consecutive
});

Deno.test("watchdog: cooldown suppresses checks immediately after recycle", async () => {
  const backend = stubBackend();
  const clock = manualClock();
  const w = createWorkerdWatchdog({
    backend,
    budgetBytes: 100 * 1024 * 1024,
    hysteresisSamples: 1, // recycle on first overage for brevity
    cooldownMs: 5_000,
    getRss: () => Promise.resolve(200 * 1024 * 1024),
    now: clock.now,
    log: () => {},
  });

  await w.sample();
  assertEquals(backend.reloadCalls, 1);

  // Within cooldown — must NOT recycle again, even though RSS is
  // still way over budget. Streak must stay at 0 too so a sample
  // taken at exactly the cooldown boundary doesn't carry stale
  // history.
  for (let i = 0; i < 5; i++) {
    clock.advance(100);
    await w.sample();
  }
  assertEquals(backend.reloadCalls, 1);
  assertEquals(w.stats.overBudgetStreak, 0);

  // Past cooldown — streak rebuilds, recycle fires once more.
  clock.advance(10_000);
  await w.sample();
  assertEquals(backend.reloadCalls, 2);
});

Deno.test("watchdog: pid===null skips the sample without resetting cooldown", async () => {
  const backend = stubBackend(null);
  const clock = manualClock();
  const w = createWorkerdWatchdog({
    backend,
    budgetBytes: 100 * 1024 * 1024,
    hysteresisSamples: 1,
    cooldownMs: 1000,
    getRss: () => Promise.resolve(999 * 1024 * 1024),
    now: clock.now,
    log: () => {},
  });

  // No PID → no sample taken, no reload, last RSS reads null.
  await w.sample();
  assertEquals(backend.reloadCalls, 0);
  assertEquals(w.stats.lastRssBytes, null);
  assertEquals(w.stats.samples, 0);

  // Once a PID materialises, normal hysteresis applies.
  backend.setPid(1234);
  await w.sample();
  assertEquals(backend.reloadCalls, 1);
});

Deno.test("watchdog: getRss returning null counts as 'skip', not 'over'", async () => {
  const backend = stubBackend();
  const clock = manualClock();
  let nulls = 0;
  const w = createWorkerdWatchdog({
    backend,
    budgetBytes: 100 * 1024 * 1024,
    hysteresisSamples: 2,
    cooldownMs: 1000,
    getRss: () => {
      nulls++;
      return Promise.resolve(null);
    },
    now: clock.now,
    log: () => {},
  });

  for (let i = 0; i < 5; i++) await w.sample();
  assertEquals(nulls, 5);
  assertEquals(backend.reloadCalls, 0);
  assertEquals(w.stats.overBudgetStreak, 0);
});

Deno.test("watchdog: a failed reload still updates counters and respects cooldown", async () => {
  const backend = stubBackend();
  (backend as { reloadShouldFail?: boolean }).reloadShouldFail = true;
  const clock = manualClock();
  const logs: string[] = [];
  const w = createWorkerdWatchdog({
    backend,
    budgetBytes: 100 * 1024 * 1024,
    hysteresisSamples: 1,
    cooldownMs: 5_000,
    getRss: () => Promise.resolve(200 * 1024 * 1024),
    now: clock.now,
    log: (l) => {
      logs.push(l);
    },
  });

  await w.sample();
  assertEquals(backend.reloadCalls, 1);
  assert(logs.some((l) => l.includes("recycle reload() failed")));

  // Cooldown still applies — we don't want a failed reload to spin
  // the watchdog into a hot loop calling reload over and over.
  await w.sample();
  await w.sample();
  assertEquals(backend.reloadCalls, 1);
});

// ---------------------------------------------------------------------------
// recommendedBudgetBytes
// ---------------------------------------------------------------------------

Deno.test("recommendedBudgetBytes: returns null when no manifest declares memoryMB", () => {
  const manifests = new Map<string, { memoryMB?: number }>([
    ["a", {}],
    ["b", { memoryMB: 0 }],
  ]);
  assertEquals(recommendedBudgetBytes(manifests), null);
});

Deno.test("recommendedBudgetBytes: sums declared memoryMB, applies safety + base", () => {
  const manifests = new Map<string, { memoryMB?: number }>([
    ["a", { memoryMB: 64 }],
    ["b", { memoryMB: 128 }],
    ["c", {}], // ignored
  ]);
  // Default safety=1.5, baseOverhead=64MB → (192 * 1.5 + 64) = 352MB
  assertEquals(recommendedBudgetBytes(manifests), 352 * 1024 * 1024);
});

Deno.test("recommendedBudgetBytes: honours overrides", () => {
  const manifests = new Map<string, { memoryMB?: number }>([
    ["a", { memoryMB: 100 }],
  ]);
  // safety=2, baseOverhead=10 → 100*2 + 10 = 210MB
  assertEquals(
    recommendedBudgetBytes(manifests, { safety: 2, baseOverheadMB: 10 }),
    210 * 1024 * 1024,
  );
});
