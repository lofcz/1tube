/**
 * JWT verify LRU cache.
 *
 * Validates the single biggest single-process throughput win: that the second
 * (and Nth) verify of a given token skips SubtleCrypto entirely while still
 * honouring the token's `exp` and the JWT_SECRET rotation contract.
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  _resetAuthForTests,
  _setVerifyCacheMaxForTests,
  getVerifyCacheStats,
  validateRequest,
} from "../src/gateway/auth.ts";
import { resetTubeEnv, signJwt } from "./_helpers.ts";

const SECRET_A = "test-secret-a-at-least-32-characters-please-ok";
const SECRET_B = "test-secret-b-at-least-32-characters-please-ok";

function reqWith(token: string): Request {
  return new Request("http://x/", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function setup(secret = SECRET_A) {
  resetTubeEnv();
  _resetAuthForTests();
  Deno.env.set("JWT_SECRET", secret);
}

Deno.test("jwt-cache: second verify is a hit (skips SubtleCrypto)", async () => {
  setup();
  const token = await signJwt(SECRET_A);

  const before = getVerifyCacheStats();
  assertEquals(before.size, 0);
  assertEquals(before.hits, 0);
  assertEquals(before.misses, 0);

  const a = await validateRequest(reqWith(token));
  assert(a, "first call should validate");
  const afterFirst = getVerifyCacheStats();
  assertEquals(afterFirst.misses, 1, "first call is a miss");
  assertEquals(afterFirst.hits, 0);
  assertEquals(afterFirst.size, 1);

  const b = await validateRequest(reqWith(token));
  assert(b, "second call should validate");
  const afterSecond = getVerifyCacheStats();
  assertEquals(afterSecond.misses, 1, "no extra misses");
  assertEquals(afterSecond.hits, 1, "second call is a hit");
  assertEquals(b.userId, a.userId);
});

Deno.test("jwt-cache: many calls only miss once per distinct token", async () => {
  setup();
  const token = await signJwt(SECRET_A);

  for (let i = 0; i < 25; i++) {
    const a = await validateRequest(reqWith(token));
    assert(a);
  }

  const stats = getVerifyCacheStats();
  assertEquals(stats.misses, 1);
  assertEquals(stats.hits, 24);
  assertEquals(stats.size, 1);
});

Deno.test("jwt-cache: tampered tokens never enter the cache", async () => {
  setup();
  const good = await signJwt(SECRET_A);
  const parts = good.split(".");
  // Flip a char in the MIDDLE of the signature, not at the end. For an
  // HMAC-SHA256 JWT the signature is 32 bytes → 43 base64-url chars, and
  // the LAST char only encodes 4 meaningful bits (trailing 2 bits are
  // padding the decoder discards). Flipping just the last char can leave
  // the decoded signature bytes unchanged, so verification still succeeds
  // and the test produces a false negative for the cache check.
  const sig = parts[2];
  const mid = Math.floor(sig.length / 2);
  const midChar = sig[mid];
  // Map any base64url char to a different one in the same alphabet.
  const flipped = midChar === "A" ? "B" : "A";
  const tampered = `${parts[0]}.${parts[1]}.${sig.slice(0, mid)}${flipped}${
    sig.slice(mid + 1)
  }`;
  // Sanity: make sure we actually mutated the string.
  assert(
    tampered !== good,
    "test setup: tampered token must differ from original",
  );

  const result = await validateRequest(reqWith(tampered));
  assertEquals(result, null);

  const stats = getVerifyCacheStats();
  assertEquals(stats.size, 0, "invalid token must not be cached");
  assertEquals(stats.hits, 0);
});

Deno.test("jwt-cache: expired entry is evicted on hit (returns null + cleans)", async () => {
  setup();

  const shortLived = await signJwt(SECRET_A, { expIn: 1 });
  // Prime: cache the entry.
  const primed = await validateRequest(reqWith(shortLived));
  assert(primed);
  assertEquals(getVerifyCacheStats().size, 1);

  // Wait WELL past the second boundary so signed_at_floor + 1 < now_floor
  // regardless of when in the second we started. 2.1s is enough for any
  // sub-second offset.
  await new Promise((r) => setTimeout(r, 2100));

  const stale = await validateRequest(reqWith(shortLived));
  assertEquals(stale, null, "expired token must not validate even from cache");
  assertEquals(getVerifyCacheStats().size, 0, "expired entry must be evicted");
});

Deno.test("jwt-cache: rotating JWT_SECRET invalidates the cache", async () => {
  setup(SECRET_A);
  const tokenA = await signJwt(SECRET_A);

  const ok1 = await validateRequest(reqWith(tokenA));
  assert(ok1);
  assertEquals(getVerifyCacheStats().size, 1);

  // Rotate the secret. The next call should clear the cache and reject the
  // old token (since it was signed with the previous key).
  Deno.env.set("JWT_SECRET", SECRET_B);
  const ok2 = await validateRequest(reqWith(tokenA));
  assertEquals(
    ok2,
    null,
    "token signed with rotated-out secret must be rejected",
  );

  const stats = getVerifyCacheStats();
  assertEquals(stats.size, 0, "rotation must clear all cached entries");
});

Deno.test("jwt-cache: bounded eviction keeps cache at capacity", async () => {
  setup();
  _setVerifyCacheMaxForTests(3);

  const t1 = await signJwt(SECRET_A, { sub: "u1" });
  const t2 = await signJwt(SECRET_A, { sub: "u2" });
  const t3 = await signJwt(SECRET_A, { sub: "u3" });
  const t4 = await signJwt(SECRET_A, { sub: "u4" });

  await validateRequest(reqWith(t1));
  await validateRequest(reqWith(t2));
  await validateRequest(reqWith(t3));
  assertEquals(getVerifyCacheStats().size, 3);

  // 4th distinct token evicts the oldest (t1). Cache stays at 3.
  await validateRequest(reqWith(t4));
  assertEquals(getVerifyCacheStats().size, 3);

  // t1 should now be a miss (re-verified from scratch).
  const beforeMisses = getVerifyCacheStats().misses;
  await validateRequest(reqWith(t1));
  const afterMisses = getVerifyCacheStats().misses;
  assertEquals(afterMisses, beforeMisses + 1, "evicted token must miss again");
});

Deno.test("jwt-cache: LRU bump — recent hits survive eviction", async () => {
  setup();
  _setVerifyCacheMaxForTests(3);

  const t1 = await signJwt(SECRET_A, { sub: "u1" });
  const t2 = await signJwt(SECRET_A, { sub: "u2" });
  const t3 = await signJwt(SECRET_A, { sub: "u3" });
  const t4 = await signJwt(SECRET_A, { sub: "u4" });

  await validateRequest(reqWith(t1));
  await validateRequest(reqWith(t2));
  await validateRequest(reqWith(t3));

  // Touch t1 — it should now be the most-recently-used.
  await validateRequest(reqWith(t1));

  // Insert t4 — should evict t2 (the oldest now), not t1.
  await validateRequest(reqWith(t4));

  const beforeT1 = getVerifyCacheStats().misses;
  await validateRequest(reqWith(t1));
  assertEquals(
    getVerifyCacheStats().misses,
    beforeT1,
    "t1 must still be a hit",
  );

  const beforeT2 = getVerifyCacheStats().misses;
  await validateRequest(reqWith(t2));
  assertEquals(
    getVerifyCacheStats().misses,
    beforeT2 + 1,
    "t2 must have been evicted",
  );
});

Deno.test("jwt-cache: empty/missing Authorization never touches the cache", async () => {
  setup();
  const a = await validateRequest(new Request("http://x/"));
  assertEquals(a, null);
  const stats = getVerifyCacheStats();
  assertEquals(stats.size, 0);
  assertEquals(stats.hits, 0);
  assertEquals(stats.misses, 0);
});

Deno.test("jwt-cache: stats counters distinguish hits from misses correctly", async () => {
  setup();
  const t1 = await signJwt(SECRET_A, { sub: "u1" });
  const t2 = await signJwt(SECRET_A, { sub: "u2" });

  await validateRequest(reqWith(t1));
  await validateRequest(reqWith(t1));
  await validateRequest(reqWith(t2));
  await validateRequest(reqWith(t1));
  await validateRequest(reqWith(t2));

  const s = getVerifyCacheStats();
  assertEquals(s.misses, 2);
  assertEquals(s.hits, 3);
  assertNotEquals(s.size, 0);
});
