/**
 * Public env-probe endpoint used by the workerd backend's M2 e2e test.
 *
 * Returns the values of three well-known env vars exactly as the
 * `Deno.env.get` shim sees them inside the bundled function. The e2e
 * test sets these on the gateway process and asserts the bundle reads
 * them through workerd's `fromEnvironment` bindings.
 *
 * Distinguishing absent (`null`) from empty string (`""`) matters
 * because workerd treats them differently and so does the test.
 */

import { serve } from "../_shared/handler.ts";

serve(
  () => {
    const probe = (name: string) => {
      const v = Deno.env.get(name);
      return v === undefined ? null : v;
    };
    return Response.json({
      OPENAI_API_KEY: probe("OPENAI_API_KEY"),
      POSTHOG_HOST: probe("POSTHOG_HOST"),
      WORKERD_E2E_FLAG: probe("WORKERD_E2E_FLAG"),
    });
  },
  { public: true },
);
