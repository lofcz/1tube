/**
 * Public always-errors function used by the workerd backend's M3 e2e
 * test to verify the FunctionSupervisor + circuit-breaker plumbing.
 *
 * Returns HTTP 500 on every request. The accompanying `1tube.json`
 * sets a tiny `recycle.errorWindow` and `errorRate=1.0` so 3
 * consecutive failures trip the breaker; the test then asserts the
 * 4th request returns 503 (with `Retry-After`) without ever reaching
 * the workerd subprocess.
 */

import { serve } from "../_shared/handler.ts";

serve(
  () => Response.json({ error: "boom" }, { status: 500 }),
  { public: true },
);
