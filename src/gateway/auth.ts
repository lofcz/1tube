/**
 * JWT authentication for the gateway.
 *
 * Validates HMAC-SHA256 JWTs using the same secret as Supabase,
 * producing tokens fully compatible with Supabase RLS policies.
 */

import type { AuthContext, JWTPayload } from "../registry.ts";

const JWT_SECRET = Deno.env.get("JWT_SECRET") || "";
if (!JWT_SECRET) {
  console.warn("[1tube] JWT_SECRET not set — authenticated endpoints will reject all requests");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let _cachedKey: CryptoKey | null = null;

async function getKey(): Promise<CryptoKey> {
  if (_cachedKey) return _cachedKey;
  _cachedKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return _cachedKey;
}

function base64UrlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;
    const key = await getKey();
    const sigBytes = base64UrlDecode(signatureB64);

    const isValid = await crypto.subtle.verify(
      "HMAC",
      key,
      sigBytes.buffer as ArrayBuffer,
      encoder.encode(`${headerB64}.${payloadB64}`),
    );
    if (!isValid) return null;

    const payload = JSON.parse(decoder.decode(base64UrlDecode(payloadB64))) as JWTPayload;

    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

/**
 * Validate the Authorization header and return an AuthContext, or null if invalid.
 */
export async function validateRequest(req: Request): Promise<AuthContext | null> {
  const token = parseBearer(req.headers.get("Authorization"));
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  return {
    userId: payload.sub,
    email: payload.email,
    payload,
    rawToken: token,
  };
}
