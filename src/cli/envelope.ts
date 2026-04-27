/**
 * Firmware envelope: signed metadata that wraps every `.1tube`
 * payload.
 *
 * The envelope is the trust root of the firmware update protocol.
 * `1tube package` writes one of these next to the bundled `dist/`
 * tree inside the zip; the C# `FirmwareSupervisor` parses it,
 * verifies the signature against a shared secret, and then walks
 * the inner `manifest.json` to verify each per-bundle hash. Two
 * properties make this scheme transitively safe with a single
 * signature:
 *
 *   1. `manifestSha256` covers the inner `manifest.json` byte-for-
 *      byte. Tamper with the manifest → signature still validates,
 *      but the recomputed `manifestSha256` won't match.
 *   2. `manifest.json` already records every per-bundle SHA-256.
 *      Tamper with a bundle → manifest hash matches, but the bundle
 *      hash check at verify-time will catch it.
 *
 * Schema versioning: `envelopeSchema` and `signature.algo` are
 * separate so the algorithm can evolve (Ed25519, X.509-signed JWT,
 * KMS-backed COSE, …) without bumping the schema version. A new
 * algo just gets a new `algo` literal here and a corresponding
 * verifier in the C# side. v1 ships HMAC-SHA256 because it's the
 * simplest thing that's actually safe for symmetric trust between
 * a CI runner and a single host.
 *
 * NOTE: HMAC-SHA256 means whoever holds the shared secret can both
 * sign AND verify. It is suitable for single-tenant deployments
 * where the CI pipeline and the runtime host share a deployment key.
 * If priprava ever needs to accept payloads from third parties, swap
 * to Ed25519 (private-key signs, public-key verifies); the envelope
 * schema is forward-compatible with that change — only the C#
 * verifier needs an additional `algo` branch.
 */

export const ENVELOPE_SCHEMA = 1;

export type EnvelopeSignatureAlgo = "hmac-sha256";

export interface FirmwareEnvelopeSignature {
  algo: EnvelopeSignatureAlgo;
  /** Lowercase hex digest. */
  value: string;
}

export interface FirmwareEnvelope {
  envelopeSchema: number;
  /** Stable version id. Conventionally `<ISO>-<8hex>` so it's sortable. */
  version: string;
  createdAt: string;
  /** Diagnostic only — `1tube@x.y.z`. */
  createdBy: string;
  /** SHA-256 of `dist/manifest.json` bytes, lowercase hex. */
  manifestSha256: string;
  /** Number of functions in the inner manifest. Diagnostic. */
  functionCount: number;
  /** Sum of every bundle's byte length. Diagnostic. */
  totalBundleBytes: number;
  signature: FirmwareEnvelopeSignature;
}

/**
 * Object passed to {@link signEnvelope} — every field of
 * `FirmwareEnvelope` minus the signature wrapper.
 */
export type UnsignedEnvelope = Omit<FirmwareEnvelope, "signature">;

/**
 * Canonical-JSON serialisation of an unsigned envelope, used as the
 * input to the signature function.
 *
 * "Canonical" here means: keys are sorted lexicographically at every
 * level, no extraneous whitespace, no trailing newline. Both the
 * signer and the verifier need to produce identical bytes for the
 * signature to validate, so the rules are deliberately strict and
 * limited to the small set of types we actually emit (object, array,
 * string, number, boolean — never null, never undefined).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("canonicalJson: non-finite numbers are not allowed");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(JSON.stringify(k) + ":" + canonicalJson(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

/**
 * Decode a hex / base64 / base64url string to bytes. Accepts the
 * three forms operators are likely to paste into a CI secret without
 * us having to be opinionated about which one is "right".
 */
export function decodeKey(input: string): Uint8Array {
  const trimmed = input.trim();
  // Hex: even length and only [0-9a-fA-F].
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    const out = new Uint8Array(trimmed.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }
  // Base64 / base64url. Convert url-safe to standard, pad as needed.
  const std = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new Error("envelope key is not valid hex/base64/base64url");
  }
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Compute HMAC-SHA256(key, canonicalJson(unsigned)) and wrap it into
 * a fully-signed {@link FirmwareEnvelope}. Pure function — does not
 * touch disk.
 */
export async function signEnvelope(
  unsigned: UnsignedEnvelope,
  key: Uint8Array,
): Promise<FirmwareEnvelope> {
  const message = new TextEncoder().encode(canonicalJson(unsigned));
  // HACK: SubtleCrypto requires non-zero-length keys. Reject empty
  // keys early with a clear message rather than letting the crypto
  // layer throw an opaque DataError.
  if (key.length === 0) {
    throw new Error("envelope signing key is empty");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, message as BufferSource);
  return {
    ...unsigned,
    signature: {
      algo: "hmac-sha256",
      value: bytesToHex(new Uint8Array(sig)),
    },
  };
}

/**
 * Verify the signature on a parsed envelope. Returns `true` on a
 * valid HMAC, `false` otherwise. Throws only on malformed input
 * (bad hex, wrong algo) — bad signatures are not exceptions, they
 * are normal "bad payload" outcomes.
 *
 * Used by the TS-side round-trip tests; the C# side has its own
 * implementation to avoid a Node bridge in priprava.
 */
export async function verifyEnvelope(
  envelope: FirmwareEnvelope,
  key: Uint8Array,
): Promise<boolean> {
  if (envelope.signature.algo !== "hmac-sha256") {
    throw new Error(
      `unsupported envelope signature algo: ${envelope.signature.algo}`,
    );
  }
  const { signature: _omit, ...unsigned } = envelope;
  const message = new TextEncoder().encode(canonicalJson(unsigned));
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  // Decode the recorded signature back to bytes.
  const sigHex = envelope.signature.value;
  if (!/^[0-9a-fA-F]+$/.test(sigHex) || sigHex.length % 2 !== 0) {
    throw new Error("envelope signature is not valid hex");
  }
  const sigBytes = new Uint8Array(sigHex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(sigHex.slice(i * 2, i * 2 + 2), 16);
  }
  return await crypto.subtle.verify(
    "HMAC",
    cryptoKey,
    sigBytes as BufferSource,
    message as BufferSource,
  );
}

/**
 * Lightweight runtime parser. Mirrors {@link parsePrebuiltManifest}
 * in its philosophy — explicit field checks, helpful errors, no
 * silent coercion. Used both by the package CLI's tests and by
 * round-trip code paths.
 */
export function parseEnvelope(raw: unknown): FirmwareEnvelope {
  if (!raw || typeof raw !== "object") {
    throw new Error("envelope is not an object");
  }
  const o = raw as Record<string, unknown>;
  const schema = typeof o.envelopeSchema === "number" ? o.envelopeSchema : -1;
  if (schema < 1 || schema > ENVELOPE_SCHEMA) {
    throw new Error(
      `envelope schema=${schema} not supported (max ${ENVELOPE_SCHEMA})`,
    );
  }
  const sig = o.signature as Record<string, unknown> | undefined;
  if (!sig || typeof sig.algo !== "string" || typeof sig.value !== "string") {
    throw new Error("envelope.signature missing/invalid");
  }
  if (sig.algo !== "hmac-sha256") {
    throw new Error(`envelope: unsupported signature algo ${sig.algo}`);
  }
  const required = [
    "version",
    "createdAt",
    "createdBy",
    "manifestSha256",
  ] as const;
  for (const k of required) {
    if (typeof o[k] !== "string" || (o[k] as string).length === 0) {
      throw new Error(`envelope.${k} missing or not a string`);
    }
  }
  if (typeof o.functionCount !== "number" || typeof o.totalBundleBytes !== "number") {
    throw new Error("envelope.functionCount / .totalBundleBytes missing");
  }
  return {
    envelopeSchema: schema,
    version: o.version as string,
    createdAt: o.createdAt as string,
    createdBy: o.createdBy as string,
    manifestSha256: o.manifestSha256 as string,
    functionCount: o.functionCount as number,
    totalBundleBytes: o.totalBundleBytes as number,
    signature: {
      algo: sig.algo,
      value: sig.value as string,
    },
  };
}
