/**
 * Public schema-validation endpoint used by the workerd backend's M2 e2e test.
 *
 * Imports zod from npm to verify the bundler resolves real-world npm
 * packages under workerd's `nodejs_compat` shim. zod is the smallest
 * dep representative of sciobot-next's stack — if zod bundles and runs,
 * the AI SDK / PostHog path almost certainly will too (they have
 * larger surface area but no exotic native bindings).
 *
 *   POST /functions/v1/zod-deps  body: {"name":"alice","age":30}
 *
 * Returns the parsed object on success, a structured 400 with the zod
 * issue list on schema failure.
 */

import { z } from "npm:zod@^3.23";
import { serve } from "../_shared/handler.ts";

const personSchema = z.object({
  name: z.string().min(1),
  age: z.number().int().nonnegative(),
});

serve(
  async (req) => {
    if (req.method !== "POST") {
      return Response.json({ error: "POST only" }, { status: 405 });
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    const parsed = personSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json(
        { error: "validation failed", issues: parsed.error.issues },
        { status: 400 },
      );
    }
    return Response.json({ ok: true, person: parsed.data });
  },
  { public: true },
);
