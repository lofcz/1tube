/**
 * Frontend helper for 1tube's deferred-boot warming contract.
 *
 * When the gateway boots with `--defer-boot` (default in dev/HMR mode),
 * a request for a function whose Worker isn't ready yet returns:
 *
 *     503 Service Unavailable
 *     X-1tube-Warming: 1
 *     Retry-After: 1
 *     { "error": "Backend is warming up", "reason": "function_warming", ... }
 *
 * The gateway simultaneously bumps that function to the front of its
 * boot queue, so retrying soon usually succeeds. This module wraps
 * `fetch` so the warming state is surfaced to the UI (show a
 * "Backend is warming up" overlay) instead of looking like real latency.
 *
 * Usage:
 *
 *     import { createWarmupFetch } from "1tube/warmup-client";
 *
 *     const warmFetch = createWarmupFetch({
 *       onWarmingChange: (warming) => overlay.toggle(warming),
 *     });
 *     const resp = await warmFetch("/functions/v1/hello", { method: "POST" });
 */

/** Response header the gateway sets on warming 503s. */
export const WARMING_HEADER = "x-1tube-warming";

/** True when `resp` is the gateway's "function is warming up" response. */
export function isWarmingResponse(resp: Response): boolean {
  return resp.status === 503 && resp.headers.get(WARMING_HEADER) === "1";
}

export interface WarmupInfo {
  /** 1-based count of attempts made so far (including the initial one). */
  attempt: number;
  /** Milliseconds elapsed since the first attempt. */
  elapsedMs: number;
}

export interface WarmupFetchOptions {
  /** Underlying fetch implementation. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /**
   * Give up after this long and return the last warming response as-is.
   * Defaults to 120 000 ms. Set 0 to disable retrying entirely (the
   * warming response is returned immediately; `onWarmingChange` still
   * fires so the overlay can be driven manually).
   */
  maxWaitMs?: number;
  /**
   * Delay between retries, in ms. Defaults to 400. The warming 503's
   * `Retry-After` header is deliberately ignored here — it has seconds
   * granularity, far too coarse for warm-up polling (functions usually
   * become ready within a few hundred ms of being prioritized).
   */
  retryDelayMs?: number;
  /**
   * Fired with `true` when the first warming response is seen and with
   * `false` once a non-warming response arrives (or retrying stops).
   * Wire this to your "Backend is warming up" overlay.
   */
  onWarmingChange?: (warming: boolean, info: WarmupInfo) => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wrap `fetch` so warming 503s are retried transparently while the UI is
 * informed via `onWarmingChange`. The returned function is a drop-in
 * `fetch` replacement for calls into the 1tube gateway.
 *
 * Note on request bodies: retrying re-sends `init.body`. Strings, Blobs,
 * ArrayBuffers, FormData and URLSearchParams are safely re-sendable; a
 * `ReadableStream` body is consumed by the first attempt, so streaming
 * requests are returned without retrying (the overlay callback still
 * fires).
 */
export function createWarmupFetch(
  options: WarmupFetchOptions = {},
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const fetchImpl = options.fetch ?? fetch;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const retryDelayMs = options.retryDelayMs ?? 400;

  return async (input, init) => {
    const startedAt = Date.now();
    let attempt = 0;
    let warming = false;

    const info = (): WarmupInfo => ({
      attempt,
      elapsedMs: Date.now() - startedAt,
    });
    const setWarming = (next: boolean) => {
      if (warming === next) return;
      warming = next;
      options.onWarmingChange?.(next, info());
    };

    try {
      while (true) {
        attempt++;
        const resp = await fetchImpl(input, init);
        if (!isWarmingResponse(resp)) {
          setWarming(false);
          return resp;
        }

        setWarming(true);

        const bodyNotReplayable = typeof ReadableStream !== "undefined" &&
          init?.body instanceof ReadableStream;
        const elapsed = Date.now() - startedAt;
        if (bodyNotReplayable || elapsed + retryDelayMs > maxWaitMs) {
          return resp;
        }
        await sleep(retryDelayMs);
      }
    } finally {
      // Covers thrown fetch errors and the give-up paths above: never
      // leave the overlay stuck on.
      setWarming(false);
    }
  };
}

export interface WarmupStatus {
  backend: string;
  /** True once every discovered function finished booting. */
  ready: boolean;
  total: number;
  loaded: number;
  loading: string[];
  queued: string[];
  failed: Array<{ name: string; error: string }>;
}

/**
 * Fetch the gateway's boot status from `GET /1tube/warmup`. Useful for a
 * progress bar inside the overlay ("12/53 functions ready").
 *
 * @param baseUrl Gateway origin, e.g. `http://localhost:3100`.
 */
export async function fetchWarmupStatus(
  baseUrl: string,
  init?: { fetch?: typeof fetch; signal?: AbortSignal },
): Promise<WarmupStatus> {
  const fetchImpl = init?.fetch ?? fetch;
  const resp = await fetchImpl(
    `${baseUrl.replace(/\/+$/, "")}/1tube/warmup`,
    init?.signal ? { signal: init.signal } : undefined,
  );
  if (!resp.ok) {
    throw new Error(`warmup status request failed: HTTP ${resp.status}`);
  }
  return await resp.json() as WarmupStatus;
}
