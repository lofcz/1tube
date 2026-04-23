/**
 * Public hello endpoint.
 *   curl http://localhost:3100/functions/v1/hello
 *   curl http://localhost:3100/functions/v1/hello/world
 */

import { serve } from "../_shared/handler.ts";

serve(
  (req) => {
    const url = new URL(req.url);
    const who = url.pathname.replace(/^\/+/, "") || "world";
    return Response.json({
      message: `hello, ${who}`,
      method: req.method,
      at: new Date().toISOString(),
    });
  },
  { public: true },
);
