/**
 * Memory watchdog for the workerd subprocess.
 *
 * Workerd does NOT expose per-isolate memory limits in its open-source
 * capnp schema (that's a Cloudflare-platform feature). The closest
 * thing 1tube can offer is a process-level resident-set-size budget:
 * we poll the workerd PID's RSS, and when it exceeds the configured
 * budget for `hysteresisSamples` consecutive checks, we recycle the
 * whole process via the backend's existing dual-process swap.
 *
 * Important caveats — make sure the README repeats them:
 *
 *   - Recycle is **process-wide**. Every isolate hosted by the
 *     current workerd is restarted, even the ones that were
 *     well-behaved. There is no in-process attribution; if you
 *     need per-function isolation, run one workerd per function
 *     (not yet supported).
 *
 *   - The watchdog cannot prevent a runaway allocation that takes
 *     the gateway over budget *between samples*. The poll interval
 *     trades polling overhead against recovery latency; defaults
 *     to 5s.
 *
 *   - Cross-platform RSS reporting is approximate. Linux's `VmRSS`,
 *     macOS's `ps rss`, and Windows's `tasklist Mem Usage` all
 *     mean slightly different things (working set vs resident vs
 *     including shared pages). Use the budget as a rough cap; not
 *     a precise quota.
 *
 * Tests inject `getRss` and a fake clock so the entire watchdog can
 * be exercised without real workerd processes or real timers.
 */

import { pidRss } from "./proc-stats.ts";
import type { WorkerdBackend } from "./backend.ts";

/** Minimal subset of the backend the watchdog needs. */
export interface WatchdogBackend {
  /** PID of the live workerd, or null mid-recycle / before start. */
  readonly pid: number | null;
  /** Trigger a full process recycle. */
  reload(changed?: ReadonlySet<string> | "all"): Promise<unknown>;
}

export interface WorkerdWatchdogOptions {
  backend: WatchdogBackend;
  /** Hard RSS cap, in bytes. Once we cross this for a sustained window we recycle. */
  budgetBytes: number;
  /** How often to poll RSS, in ms. Defaults to 5000. */
  intervalMs?: number;
  /**
   * Number of consecutive over-budget samples required before
   * triggering a recycle. Defaults to 3 — a single spike (e.g. a
   * GC pause that briefly inflates RSS, or a transient large
   * request body) doesn't count.
   */
  hysteresisSamples?: number;
  /**
   * After a recycle, suppress checks for this many ms. Lets the
   * new workerd settle (initial heap growth + warmup) before the
   * watchdog starts taking samples again. Defaults to 10000.
   */
  cooldownMs?: number;
  /**
   * Override the RSS reader. Defaults to `pidRss` from `proc-stats.ts`.
   * Tests inject a synthetic series.
   */
  getRss?: (pid: number) => Promise<number | null>;
  /**
   * Override the clock used for poll scheduling. Tests inject a
   * fake setInterval/clearInterval. Note: we use setInterval not
   * a self-rescheduling setTimeout because the latter doesn't pause
   * during `await`s, leading to overlapping samples on slow `ps`
   * calls. setInterval naturally drops fires that overlap an
   * in-flight sample (we guard with `inFlight`).
   */
  setTimer?: (cb: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
  /**
   * Override `performance.now()` used for cooldown timing. Tests
   * inject a fake clock so cooldown windows aren't tied to real
   * wall-clock time.
   */
  now?: () => number;
  /** Override log function (defaults to console). Tests assert output. */
  log?: (line: string) => void;
}

export interface WorkerdWatchdog {
  /** Begin polling. Idempotent. */
  start(): void;
  /** Stop polling, drop pending timer. Idempotent. */
  stop(): void;
  /**
   * Run a single sample synchronously (still async to await the
   * RSS reader). Test seam — production code only schedules via
   * the timer.
   */
  sample(): Promise<void>;
  /** Diagnostic counters — read by tests + `/metrics` if we add one. */
  readonly stats: Readonly<WatchdogStats>;
}

export interface WatchdogStats {
  samples: number;
  overBudgetStreak: number;
  recycles: number;
  lastRssBytes: number | null;
  lastSampleAt: number | null;
  /** Configured budget — surfaced so /health can echo it back. */
  budgetBytes: number;
}

export function createWorkerdWatchdog(
  opts: WorkerdWatchdogOptions,
): WorkerdWatchdog {
  const interval = opts.intervalMs ?? 5_000;
  const hyst = opts.hysteresisSamples ?? 3;
  const cooldown = opts.cooldownMs ?? 10_000;
  const setTimer = opts.setTimer ??
    ((cb, ms) => setInterval(cb, ms) as unknown as number);
  const clearTimer = opts.clearTimer ?? ((id) => clearInterval(id));
  const now = opts.now ?? (() => performance.now());
  const log = opts.log ?? ((l) => console.warn(l));
  const getRss = opts.getRss ?? ((pid) => pidRss(pid));

  const stats: WatchdogStats = {
    samples: 0,
    overBudgetStreak: 0,
    recycles: 0,
    lastRssBytes: null,
    lastSampleAt: null,
    budgetBytes: opts.budgetBytes,
  };

  let timerId: number | null = null;
  let stopped = false;
  let inFlight = false;
  // Wall-clock (per `now()`) at which the cooldown window expires.
  // Set to `now()+cooldownMs` after each recycle; samples taken
  // before that point reset the streak counter and return early.
  let cooldownUntil = 0;

  const sample = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return; // skip overlapping sample
    inFlight = true;
    try {
      const t = now();
      stats.lastSampleAt = t;

      if (t < cooldownUntil) {
        // Still within the post-recycle quiet window. Reset the
        // streak so a sample taken right at the edge of cooldown
        // doesn't carry over a stale over-budget count.
        stats.overBudgetStreak = 0;
        return;
      }

      const pid = opts.backend.pid;
      if (pid === null) {
        // Backend mid-recycle or stopped. Don't count this against
        // the streak (the process simply isn't there to measure).
        stats.lastRssBytes = null;
        stats.overBudgetStreak = 0;
        return;
      }

      const rss = await getRss(pid);
      stats.samples++;
      stats.lastRssBytes = rss;

      if (rss === null) {
        // RSS reader returned null (process exited between getPid
        // and the syscall, or `tasklist` was missing). Treat as
        // "skip this sample" — neither over nor under budget.
        return;
      }

      if (rss <= opts.budgetBytes) {
        if (stats.overBudgetStreak > 0) {
          // RSS came back under budget; clear the streak so we don't
          // recycle on a flapping value.
          stats.overBudgetStreak = 0;
        }
        return;
      }

      stats.overBudgetStreak++;
      log(
        `[1tube] watchdog: workerd RSS ${(rss / 1024 / 1024).toFixed(1)}MB ` +
          `> budget ${(opts.budgetBytes / 1024 / 1024).toFixed(0)}MB ` +
          `(streak ${stats.overBudgetStreak}/${hyst})`,
      );

      if (stats.overBudgetStreak < hyst) return;

      // Trip. Trigger a recycle and start the cooldown clock so the
      // post-recycle bootstrap RSS doesn't immediately re-trigger.
      log(
        `[1tube] watchdog: recycling workerd — ${stats.overBudgetStreak} ` +
          `consecutive over-budget samples`,
      );
      stats.overBudgetStreak = 0;
      stats.recycles++;
      cooldownUntil = t + cooldown;
      try {
        await opts.backend.reload("all");
      } catch (err) {
        log(`[1tube] watchdog: recycle reload() failed: ${err}`);
      }
    } finally {
      inFlight = false;
    }
  };

  return {
    start() {
      if (timerId !== null || stopped) return;
      timerId = setTimer(() => {
        sample().catch((err) => log(`[1tube] watchdog sample error: ${err}`));
      }, interval);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      if (timerId !== null) {
        clearTimer(timerId);
        timerId = null;
      }
    },
    sample,
    get stats() {
      return stats;
    },
  };
}

/**
 * Compute a recommended budget from per-function manifests.
 *
 * The workerd process has fixed per-isolate overhead (V8 startup
 * heap, the worker runtime itself, JIT code) on top of the user
 * code's working set. We approximate as
 *
 *     sum(manifest.memoryMB) * SAFETY + BASE_OVERHEAD_MB
 *
 * with conservative defaults: SAFETY=1.5 (50% headroom for GC) and
 * BASE_OVERHEAD_MB=64 (a freshly-booted workerd with no functions
 * sits around 35-50MB on Linux). Operators who set
 * `1TUBE_WORKERD_MAX_RSS_MB` explicitly always win — this number is
 * only used when no explicit cap is configured.
 *
 * Returns a value in **bytes** so it composes with the watchdog API.
 * Returns null when there are no manifests with a `memoryMB` set —
 * that signals "no automatic budget; only enforce if operator
 * configures one".
 *
 * Exported for tests.
 */
export function recommendedBudgetBytes(
  manifests: ReadonlyMap<string, { memoryMB?: number }>,
  opts?: { safety?: number; baseOverheadMB?: number },
): number | null {
  const safety = opts?.safety ?? 1.5;
  const baseOverheadMB = opts?.baseOverheadMB ?? 64;
  let total = 0;
  let any = false;
  for (const m of manifests.values()) {
    if (typeof m.memoryMB === "number" && m.memoryMB > 0) {
      total += m.memoryMB;
      any = true;
    }
  }
  if (!any) return null;
  const mb = total * safety + baseOverheadMB;
  return Math.ceil(mb) * 1024 * 1024;
}

// Re-export for tests / consumers that already have a fully-typed
// backend reference and want compile-time checks.
export type _BackendShape = WorkerdBackend;
