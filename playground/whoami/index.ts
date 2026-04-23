/**
 * Authenticated endpoint — returns the JWT-derived identity.
 *   TOKEN=$(...your supabase access token...)
 *   curl http://localhost:3100/functions/v1/whoami -H "Authorization: Bearer $TOKEN"
 *
 * Without a valid Bearer token the gateway responds 401 before this handler
 * ever runs.
 */

import { serve } from "../_shared/handler.ts";

serve((_req, auth) => {
  return Response.json({
    userId: auth.userId,
    email: auth.email,
    payload: auth.payload,
  });
});
