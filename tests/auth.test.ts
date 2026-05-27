/**
 * Tests for src/gateway/auth.ts.
 *
 * Verifies HS256 verification, lazy secret reload, expiry, and tampered
 * signatures. The auth module reads JWT_SECRET lazily on every call so the
 * tests can swap secrets between assertions without re-importing the module.
 */

import { assertEquals, assertExists } from "@std/assert";
import { validateRequest } from "../src/gateway/auth.ts";
import { resetTubeEnv, signJwt } from "./_helpers.ts";

const SECRET = "test-secret-which-is-long-enough-for-hmac-sha256";

function reqWith(token: string | null): Request {
  const headers: Record<string, string> = {};
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  return new Request("http://localhost/functions/v1/x", {
    method: "POST",
    headers,
  });
}

Deno.test("auth: returns null without an Authorization header", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  const auth = await validateRequest(reqWith(null));
  assertEquals(auth, null);
});

Deno.test("auth: validates a freshly signed token and exposes the user id", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  const token = await signJwt(SECRET, { sub: "user-abc", email: "abc@example.com" });
  const auth = await validateRequest(reqWith(token));
  assertExists(auth);
  assertEquals(auth.userId, "user-abc");
  assertEquals(auth.email, "abc@example.com");
  assertEquals(auth.rawToken, token);
});

Deno.test("auth: rejects a token signed with a different secret", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  const token = await signJwt("a-different-secret-also-long-enough-for-hs256");
  const auth = await validateRequest(reqWith(token));
  assertEquals(auth, null);
});

Deno.test("auth: rejects an expired token", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  const token = await signJwt(SECRET, { expIn: -10 });
  const auth = await validateRequest(reqWith(token));
  assertEquals(auth, null);
});

Deno.test("auth: rejects a token whose payload was tampered with", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  const token = await signJwt(SECRET, { sub: "user-1" });
  const [h, _p, s] = token.split(".");
  const forged = btoa(JSON.stringify({ sub: "admin", exp: 9999999999 }))
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const auth = await validateRequest(reqWith(`${h}.${forged}.${s}`));
  assertEquals(auth, null);
});

Deno.test("auth: rejects a malformed token (not three segments)", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  const auth = await validateRequest(reqWith("not.a.jwt.really"));
  assertEquals(auth, null);
});

Deno.test("auth: rejects when JWT_SECRET is unset", async () => {
  resetTubeEnv();
  // Sign with one value but never expose it to the gateway.
  const token = await signJwt(SECRET);
  const auth = await validateRequest(reqWith(token));
  assertEquals(auth, null);
});

Deno.test("auth: accepts a token matching SUPABASE_SERVICE_ROLE_KEY as service role", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_test_opaque_key_123");

  const auth = await validateRequest(reqWith("sb_secret_test_opaque_key_123"));
  assertExists(auth);
  assertEquals(auth.userId, "");
  assertEquals(auth.payload.role, "service_role");
  assertEquals(auth.rawToken, "sb_secret_test_opaque_key_123");

  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
});

Deno.test("auth: rejects opaque tokens that do not match SUPABASE_SERVICE_ROLE_KEY", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "sb_secret_expected");

  const auth = await validateRequest(reqWith("sb_secret_attacker_value"));
  assertEquals(auth, null);

  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
});

Deno.test("auth: does not accept arbitrary tokens when SUPABASE_SERVICE_ROLE_KEY is unset", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");

  const auth = await validateRequest(reqWith("sb_secret_anything"));
  assertEquals(auth, null);
});

Deno.test("auth: picks up a secret rotation between calls (lazy read)", async () => {
  resetTubeEnv();
  Deno.env.set("JWT_SECRET", SECRET);
  const token1 = await signJwt(SECRET, { sub: "old" });
  assertExists(await validateRequest(reqWith(token1)));

  // Rotate the secret. The next call must reject the old token AND accept a
  // newly-signed one without requiring a re-import.
  const NEW_SECRET = "rotated-secret-also-long-enough-for-hmac-sha256";
  Deno.env.set("JWT_SECRET", NEW_SECRET);
  const auth1 = await validateRequest(reqWith(token1));
  assertEquals(auth1, null);

  const token2 = await signJwt(NEW_SECRET, { sub: "new" });
  const auth2 = await validateRequest(reqWith(token2));
  assertExists(auth2);
  assertEquals(auth2.userId, "new");
});
