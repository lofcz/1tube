/**
 * Public echo endpoint — bounces request method, headers, query, and body back.
 *   curl -X POST http://localhost:3100/functions/v1/echo?x=1 \
 *        -H 'content-type: application/json' \
 *        -d '{"hello":"world"}'
 */

import { serve } from "../_shared/handler.ts";

serve(
  async (req) => {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of req.headers) headers[k] = v;

    let body: unknown = null;
    if (req.body) {
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
    }

    return Response.json({
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers,
      body,
    });
  },
  { public: true },
);
