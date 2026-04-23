/**
 * In-process supervisor for registered functions.
 *
 * Tracks per-function invocation/error counts over a sliding window and trips
 * a circuit breaker when the manifest's `recycle.errorRate` is exceeded. While
 * the breaker is open, the dispatcher returns 503 immediately (cool-down
 * derived from `recycle.cooldownMs`). The supervisor also signals "recycle
 * recommended" once `recycle.maxRequests` is reached — without per-isolate
 * tear-down (we share one V8 with the gateway), we surface the recommendation
 * on `/health` and bump a counter so operators can wire HMR / a process
 * restart to it if desired.
 *
 * Memory cap is intentionally NOT tracked here — V8 doesn't expose per-handler
 * memory accounting and any per-process number would mislead. Use the host's
 * cgroup / job-object limit instead (surfaced on `/health` via
 * `memory.limit_mb`); the manifest's `memoryMB` field is recorded for
 * operator documentation only.
 */

import type { FunctionManifest } from "./manifest.ts";

export interface SupervisorState {
  invocations: number;
  errors: number;
  /** Sliding window of recent results (1 = error, 0 = ok). */
  window: number[];
  recycleRecommended: boolean;
  /** Epoch ms when the breaker tripped; 0 when closed. */
  breakerOpenedAt: number;
}

export interface AdmitDecision {
  /** True = caller may proceed. */
  ok: boolean;
  /** Populated when ok=false; HTTP status to return. */
  status?: number;
  reason?: string;
  /** Seconds the caller should wait before retrying. */
  retryAfter?: number;
}

export interface SupervisorStats {
  invocations: number;
  errors: number;
  errorRate: number;
  windowSize: number;
  breakerOpen: boolean;
  breakerOpenedAt: number;
  recycleRecommended: boolean;
}

export class FunctionSupervisor {
  private states = new Map<string, SupervisorState>();
  private manifests = new Map<string, FunctionManifest>();

  setManifest(name: string, manifest: FunctionManifest) {
    this.manifests.set(name, manifest);
  }

  /** Drop all state for a function (used on HMR / module removal). */
  forget(name: string) {
    this.states.delete(name);
    this.manifests.delete(name);
  }

  reset(name: string) {
    this.states.delete(name);
  }

  private getState(name: string): SupervisorState {
    let s = this.states.get(name);
    if (!s) {
      s = {
        invocations: 0,
        errors: 0,
        window: [],
        recycleRecommended: false,
        breakerOpenedAt: 0,
      };
      this.states.set(name, s);
    }
    return s;
  }

  /**
   * Decide whether a request to `name` should be admitted right now. Call
   * before dispatching to the handler.
   */
  admit(name: string, now = Date.now()): AdmitDecision {
    const manifest = this.manifests.get(name);
    if (!manifest) return { ok: true };
    const s = this.getState(name);

    if (s.breakerOpenedAt > 0) {
      const age = now - s.breakerOpenedAt;
      if (age < manifest.recycle.cooldownMs) {
        return {
          ok: false,
          status: 503,
          reason: "circuit_breaker_open",
          retryAfter: Math.ceil((manifest.recycle.cooldownMs - age) / 1000),
        };
      }
      // Cool-down elapsed — half-open the breaker by clearing state and
      // letting the next request through.
      s.breakerOpenedAt = 0;
      s.window.length = 0;
    }

    return { ok: true };
  }

  /**
   * Record the outcome of a dispatched request. `error=true` for any 5xx /
   * timeout / thrown exception. Returns the post-record state so callers can
   * emit a one-shot warning when the breaker trips or recycle is recommended.
   */
  record(name: string, error: boolean, now = Date.now()): {
    breakerJustTripped: boolean;
    recycleJustRecommended: boolean;
  } {
    const manifest = this.manifests.get(name);
    const s = this.getState(name);
    s.invocations++;
    if (error) s.errors++;

    let breakerJustTripped = false;
    let recycleJustRecommended = false;

    if (manifest) {
      const win = manifest.recycle.errorWindow;
      s.window.push(error ? 1 : 0);
      if (s.window.length > win) {
        s.window.splice(0, s.window.length - win);
      }

      if (
        s.breakerOpenedAt === 0 &&
        s.window.length >= win &&
        manifest.recycle.errorRate > 0
      ) {
        const errs = s.window.reduce((a, b) => a + b, 0);
        const rate = errs / s.window.length;
        if (rate >= manifest.recycle.errorRate) {
          s.breakerOpenedAt = now;
          breakerJustTripped = true;
        }
      }

      if (
        !s.recycleRecommended &&
        manifest.recycle.maxRequests > 0 &&
        s.invocations >= manifest.recycle.maxRequests
      ) {
        s.recycleRecommended = true;
        recycleJustRecommended = true;
      }
    }

    return { breakerJustTripped, recycleJustRecommended };
  }

  stats(name: string): SupervisorStats {
    const s = this.getState(name);
    const errs = s.window.reduce((a, b) => a + b, 0);
    return {
      invocations: s.invocations,
      errors: s.errors,
      errorRate: s.window.length > 0 ? errs / s.window.length : 0,
      windowSize: s.window.length,
      breakerOpen: s.breakerOpenedAt > 0,
      breakerOpenedAt: s.breakerOpenedAt,
      recycleRecommended: s.recycleRecommended,
    };
  }

  allStats(): Record<string, SupervisorStats> {
    const out: Record<string, SupervisorStats> = {};
    for (const name of this.states.keys()) {
      out[name] = this.stats(name);
    }
    return out;
  }
}
