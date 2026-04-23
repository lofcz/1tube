/**
 * Public sleep endpoint — useful for exercising the per-function timeout.
 *   curl 'http://localhost:3100/functions/v1/slow?ms=500'    # ok
 *   curl 'http://localhost:3100/functions/v1/slow?ms=5000'   # 504, gateway aborts
 *
 * Configured with a 2s wall-clock timeout that overrides the gateway default.
 */

import { serve } from "../_shared/handler.ts";

serve(
  async (req) => {
    const url = new URL(req.url);
    const ms = Math.max(0, parseInt(url.searchParams.get("ms") ?? "100", 10));
    await new Promise((resolve) => setTimeout(resolve, ms));
    return Response.json({ slept: ms });
  },
  { public: true, timeoutMs: 2000 },
);
