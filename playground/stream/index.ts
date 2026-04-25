/**
 * Public NDJSON streaming endpoint used by the workerd backend's M2 e2e test.
 *
 * Emits `?n=N` JSON objects (default 5), one per line, separated by
 * 50ms gaps. The e2e test reads chunks incrementally and asserts each
 * one arrives well before the total stream duration would be hit if
 * the proxy were buffering the whole response.
 *
 * The handler uses `ReadableStream` directly (rather than relying on
 * a polyfill) because workerd's runtime supports the spec natively and
 * Deno does too — keeping the code identical between backends is the
 * point of the workerd integration.
 */

import { serve } from "../_shared/handler.ts";

serve(
  (req) => {
    const url = new URL(req.url);
    const n = Math.min(50, Math.max(1, Number(url.searchParams.get("n") ?? "5")));
    const gapMs = Math.min(500, Math.max(0, Number(url.searchParams.get("gap") ?? "50")));

    const enc = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        if (i >= n) {
          ctrl.close();
          return;
        }
        const line = JSON.stringify({ i, ts: Date.now() }) + "\n";
        ctrl.enqueue(enc.encode(line));
        i++;
        if (i < n && gapMs > 0) {
          await new Promise((r) => setTimeout(r, gapMs));
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "application/x-ndjson",
        // Some intermediaries buffer chunked responses unless told not
        // to; X-Accel-Buffering is a Nginx convention but harmless to
        // emit even when the gateway is the only hop.
        "x-accel-buffering": "no",
        "cache-control": "no-store",
      },
    });
  },
  { public: true },
);
