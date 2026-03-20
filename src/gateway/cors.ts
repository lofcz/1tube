/**
 * CORS handling for the gateway.
 * Mirrors the Supabase Edge Functions CORS behavior.
 */

import type { Context, Next } from "npm:hono@4";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-application-name, user-agent",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS, PUT, PATCH, DELETE",
};

export async function corsMiddleware(c: Context, next: Next) {
  if (c.req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  await next();

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    c.res.headers.set(key, value);
  }
}
