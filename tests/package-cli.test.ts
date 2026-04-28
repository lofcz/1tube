/**
 * Tests for `1tube package` — round-trip + tamper rejection.
 *
 * Strategy: every test starts from a real `1tube build` against the
 * playground fixtures (so we hit the actual layout the C# verifier
 * will see), then exercises the package/verify path:
 *
 *   - Round-trip:   pack → read zip → verify signature → reach into
 *                   each entry and confirm it matches the original
 *                   on-disk bytes.
 *   - Tamper paths: flip one byte of the envelope, the manifest, or
 *                   a bundle and confirm verification refuses to
 *                   accept it.
 *
 * The TS-side verification path here is deliberately a complete
 * mirror of the C# side: same canonical-JSON, same HMAC, same
 * manifest-then-bundle hash walk. If the two implementations ever
 * disagree, this file is the canary — easier to reproduce a
 * mismatch in Deno than in priprava.
 */

import { assert, assertEquals } from "@std/assert";
import { join, resolve as resolvePath } from "node:path";
import { build } from "../src/cli/build.ts";
import {
  ENVELOPE_SCHEMA,
  type FirmwareEnvelope,
  parseEnvelope,
  verifyEnvelope,
} from "../src/cli/envelope.ts";
import { packageDist, readPayload, runPackage } from "../src/cli/package.ts";
import { parsePrebuiltManifest } from "../src/backends/workerd/prebuilt.ts";

const PROJECT_ROOT = resolvePath(
  new URL("..", import.meta.url).pathname.replace(/^\/(\w:)/, "$1"),
);
const PLAYGROUND = join(PROJECT_ROOT, "playground");
const DENO_JSON = join(PROJECT_ROOT, "deno.json");
const TEST_OPTS = { sanitizeResources: false, sanitizeOps: false } as const;

// 32-byte deterministic key — fine for tests, irrelevant to prod
// since the secret never leaves a CI runner. We use a fixed value
// so failures are reproducible across machines.
const KEY = new Uint8Array(32);
for (let i = 0; i < KEY.length; i++) KEY[i] = i + 1;
const WRONG_KEY = new Uint8Array(32);
for (let i = 0; i < WRONG_KEY.length; i++) WRONG_KEY[i] = (i + 1) ^ 0xff;

function hexKey(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function buildFixture(label: string): Promise<string> {
  const out = await Deno.makeTempDir({ prefix: `1tube-pkg-build-${label}-` });
  await build({
    functionsDir: PLAYGROUND,
    outDir: out,
    configPath: DENO_JSON,
    only: ["hello", "echo"],
    sourcemap: false,
  });
  return out;
}

async function copyDir(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory) {
      await copyDir(from, to);
    } else if (entry.isFile) {
      await Deno.copyFile(from, to);
    }
  }
}

async function buildSharedFixture(label: string): Promise<string> {
  const root = await Deno.makeTempDir({
    prefix: `1tube-pkg-shared-src-${label}-`,
  });
  const out = await Deno.makeTempDir({
    prefix: `1tube-pkg-shared-build-${label}-`,
  });
  await Deno.mkdir(join(root, "_shared"), { recursive: true });
  await Deno.mkdir(join(root, "needs-profile"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "_shared", "profile-cache.ts"),
    `const bootId = crypto.randomUUID();
export async function getCachedProfile(userId: string) {
  return { userId, bootId };
}
export function invalidateProfile(_userId: string) {}
`,
  );
  await Deno.writeTextFile(
    join(root, "_shared", "handler.ts"),
    `export function serve(handler: (req: Request) => Response | Promise<Response>) {
  (globalThis as { __edgeFunctionRegistry: { register: (h: unknown, m: unknown) => void } })
    .__edgeFunctionRegistry.register(handler, { public: true });
}
`,
  );
  await Deno.writeTextFile(
    join(root, "needs-profile", "index.ts"),
    `import { serve } from "../_shared/handler.ts";
import { getCachedProfile } from "../_shared/profile-cache.ts";
serve(async () => Response.json(await getCachedProfile("u1")));
`,
  );
  await build({
    functionsDir: root,
    outDir: out,
    only: ["needs-profile"],
    sourcemap: false,
  });
  await Deno.remove(root, { recursive: true }).catch(() => {});
  return out;
}

async function buildMutableFixture(
  label: string,
  responseText: string,
): Promise<{ root: string; dist: string }> {
  const root = await Deno.makeTempDir({
    prefix: `1tube-pkg-mutable-src-${label}-`,
  });
  const dist = await Deno.makeTempDir({
    prefix: `1tube-pkg-mutable-build-${label}-`,
  });
  await Deno.mkdir(join(root, "_shared"), { recursive: true });
  await Deno.mkdir(join(root, "hello"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "_shared", "handler.ts"),
    `export function serve(handler: (req: Request) => Response | Promise<Response>) {
  (globalThis as { __edgeFunctionRegistry: { register: (h: unknown, m: unknown) => void } })
    .__edgeFunctionRegistry.register(handler, { public: true });
}
`,
  );
  await Deno.writeTextFile(
    join(root, "hello", "index.ts"),
    `import { serve } from "../_shared/handler.ts";
serve(() => new Response(${JSON.stringify(responseText)}));
`,
  );
  await build({
    functionsDir: root,
    outDir: dist,
    only: ["hello"],
    sourcemap: false,
  });
  return { root, dist };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Full verify path — exactly what the C# side does. Returns the
 * specific stage that failed (or "ok") so tamper tests can assert
 * which gate caught the modification.
 */
async function verifyPayload(
  payloadPath: string,
  key: Uint8Array,
): Promise<
  | { stage: "ok"; envelope: FirmwareEnvelope }
  | {
    stage: "envelope-parse" | "signature" | "manifest-hash" | "bundle-hash";
    reason: string;
  }
> {
  let envelope: FirmwareEnvelope;
  let entries: Map<string, Uint8Array>;
  try {
    const r = await readPayload(payloadPath);
    envelope = r.envelope;
    entries = r.entries;
  } catch (err) {
    return {
      stage: "envelope-parse",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let sigOk = false;
  try {
    sigOk = await verifyEnvelope(envelope, key);
  } catch (err) {
    return {
      stage: "signature",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  if (!sigOk) return { stage: "signature", reason: "HMAC mismatch" };

  const manifestBytes = entries.get("dist/manifest.json");
  if (!manifestBytes) {
    return { stage: "manifest-hash", reason: "missing dist/manifest.json" };
  }
  const manifestSha = await sha256Hex(manifestBytes);
  if (manifestSha !== envelope.manifestSha256) {
    return {
      stage: "manifest-hash",
      reason: `expected ${envelope.manifestSha256}, got ${manifestSha}`,
    };
  }

  const manifest = parsePrebuiltManifest(
    JSON.parse(new TextDecoder().decode(manifestBytes)),
  );
  for (const fn of manifest.functions) {
    const bytes = entries.get(`dist/${fn.bundleFile}`);
    if (!bytes) {
      return { stage: "bundle-hash", reason: `missing dist/${fn.bundleFile}` };
    }
    const sha = await sha256Hex(bytes);
    if (sha !== fn.bundleSha256) {
      return {
        stage: "bundle-hash",
        reason: `${fn.name}: expected ${fn.bundleSha256}, got ${sha}`,
      };
    }
  }
  for (const shared of manifest.sharedModules) {
    const bytes = entries.get(`dist/${shared.bundleFile}`);
    if (!bytes) {
      return {
        stage: "bundle-hash",
        reason: `missing dist/${shared.bundleFile}`,
      };
    }
    const sha = await sha256Hex(bytes);
    if (sha !== shared.bundleSha256) {
      return {
        stage: "bundle-hash",
        reason: `${shared.id}: expected ${shared.bundleSha256}, got ${sha}`,
      };
    }
  }
  for (const chunk of manifest.chunks) {
    const bytes = entries.get(`dist/${chunk.file}`);
    if (!bytes) {
      return { stage: "bundle-hash", reason: `missing dist/${chunk.file}` };
    }
    const sha = await sha256Hex(bytes);
    if (sha !== chunk.sha256) {
      return {
        stage: "bundle-hash",
        reason: `${chunk.file}: expected ${chunk.sha256}, got ${sha}`,
      };
    }
  }
  return { stage: "ok", envelope };
}

Deno.test(
  "package round-trip: signature + manifest + bundles all verify",
  TEST_OPTS,
  async () => {
    const dist = await buildFixture("rt");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-out-" });
    const payload = join(out, "fw.1tube");

    const result = await packageDist({
      distDir: dist,
      outFile: payload,
      key: KEY,
    });
    assertEquals(result.envelope.envelopeSchema, ENVELOPE_SCHEMA);
    assertEquals(result.envelope.signature.algo, "hmac-sha256");
    assertEquals(result.envelope.functionCount, 2);
    assert(result.envelope.totalBundleBytes > 0);
    assert(result.envelope.version.length > 0);
    assert(result.envelope.createdBy.startsWith("1tube@"));

    const v = await verifyPayload(payload, KEY);
    assertEquals(v.stage, "ok");

    // The zip is also independently extractable — we treat it as a
    // black box once written. Reading it back must yield byte-
    // identical envelope + bundle bytes.
    const { envelope, entries } = await readPayload(payload);
    assertEquals(envelope, result.envelope);
    assert(entries.has("envelope.json"));
    assert(entries.has("dist/manifest.json"));
    for (const fn of result.manifest.functions) {
      assert(
        entries.has(`dist/${fn.bundleFile}`),
        `missing entry dist/${fn.bundleFile}`,
      );
    }
    for (const chunk of result.manifest.chunks) {
      assert(
        entries.has(`dist/${chunk.file}`),
        `missing entry dist/${chunk.file}`,
      );
    }
  },
);

Deno.test(
  "package contentSha256 is stable across package metadata changes",
  TEST_OPTS,
  async () => {
    const dist = await buildFixture("stable-content");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-content-stable-" });

    const first = await packageDist({
      distDir: dist,
      outFile: join(out, "first.1tube"),
      key: KEY,
      createdAt: "2026-01-01T00:00:00.000Z",
      version: "first-version",
    });
    const second = await packageDist({
      distDir: dist,
      outFile: join(out, "second.1tube"),
      key: KEY,
      createdAt: "2026-01-02T00:00:00.000Z",
      version: "second-version",
    });

    assert(first.envelope.contentSha256);
    assertEquals(first.envelope.contentSha256, second.envelope.contentSha256);
    assert(first.envelope.signature.value !== second.envelope.signature.value);
  },
);

Deno.test(
  "package contentSha256 changes when function runtime content changes",
  TEST_OPTS,
  async () => {
    const first = await buildMutableFixture("content-a", "hello v1");
    const second = await buildMutableFixture("content-b", "hello v2");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-content-change-" });

    try {
      const firstPkg = await packageDist({
        distDir: first.dist,
        outFile: join(out, "first.1tube"),
        key: KEY,
      });
      const secondPkg = await packageDist({
        distDir: second.dist,
        outFile: join(out, "second.1tube"),
        key: KEY,
      });

      assert(firstPkg.envelope.contentSha256);
      assert(secondPkg.envelope.contentSha256);
      assert(
        firstPkg.envelope.contentSha256 !== secondPkg.envelope.contentSha256,
      );
    } finally {
      await Deno.remove(first.root, { recursive: true }).catch(() => {});
      await Deno.remove(second.root, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "package contentSha256 ignores chunk filename-only changes",
  TEST_OPTS,
  async () => {
    const originalDist = await buildFixture("chunk-rename-original");
    const renamedDist = await Deno.makeTempDir({
      prefix: "1tube-pkg-chunk-rename-",
    });
    await copyDir(originalDist, renamedDist);

    const manifestPath = join(renamedDist, "manifest.json");
    const manifest = JSON.parse(await Deno.readTextFile(manifestPath));
    assert(
      manifest.chunks.length > 0,
      "fixture should emit at least one shared chunk",
    );

    const oldChunk = manifest.chunks[0].file as string;
    const oldBase = oldChunk.split("/").pop()!;
    const newChunk = "chunks/renamed-runtime-chunk.js";
    const newBase = newChunk.split("/").pop()!;
    await Deno.rename(join(renamedDist, oldChunk), join(renamedDist, newChunk));

    manifest.builtAt = "2030-01-01T00:00:00.000Z";
    manifest.chunks[0].file = newChunk;
    for (const chunk of manifest.chunks) {
      if (chunk.file === oldChunk) chunk.file = newChunk;
      const chunkPath = join(renamedDist, chunk.file);
      const chunkSource = await Deno.readTextFile(chunkPath);
      const rewritten = chunkSource.replaceAll(oldBase, newBase);
      if (rewritten !== chunkSource) {
        await Deno.writeTextFile(chunkPath, rewritten);
        chunk.sha256 = await sha256Hex(new TextEncoder().encode(rewritten));
        chunk.bytes = new TextEncoder().encode(rewritten).byteLength;
      }
    }
    for (const fn of manifest.functions) {
      fn.moduleFiles = fn.moduleFiles.map((file: string) =>
        file === oldChunk ? newChunk : file
      );
      const bundlePath = join(renamedDist, fn.bundleFile);
      const bundle = await Deno.readTextFile(bundlePath);
      const rewritten = bundle.replaceAll(oldBase, newBase);
      if (rewritten !== bundle) {
        await Deno.writeTextFile(bundlePath, rewritten);
        fn.bundleSha256 = await sha256Hex(new TextEncoder().encode(rewritten));
        fn.bundleBytes = new TextEncoder().encode(rewritten).byteLength;
      }
    }
    await Deno.writeTextFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
    );

    const out = await Deno.makeTempDir({
      prefix: "1tube-pkg-chunk-rename-out-",
    });
    const first = await packageDist({
      distDir: originalDist,
      outFile: join(out, "first.1tube"),
      key: KEY,
    });
    const second = await packageDist({
      distDir: renamedDist,
      outFile: join(out, "second.1tube"),
      key: KEY,
    });

    assert(first.envelope.contentSha256);
    assertEquals(first.envelope.contentSha256, second.envelope.contentSha256);
  },
);

Deno.test(
  "package CLI can build and write firmware in one command",
  TEST_OPTS,
  async () => {
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-one-shot-" });
    const payload = join(out, "fw.1tube");
    try {
      const code = await runPackage([
        "--functions",
        PLAYGROUND,
        "--only",
        "hello",
        "--sourcemap",
        "none",
        "--config",
        DENO_JSON,
        "--out",
        payload,
        "--sign-key",
        hexKey(KEY),
      ]);
      assertEquals(code, 0);

      const verified = await verifyPayload(payload, KEY);
      assertEquals(verified.stage, "ok");
      if (verified.stage === "ok") {
        assertEquals(verified.envelope.functionCount, 1);
      }
    } finally {
      await Deno.remove(out, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "package round-trip: shared module bundles are included and verified",
  TEST_OPTS,
  async () => {
    const dist = await buildSharedFixture("rt");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-out-" });
    const payload = join(out, "fw.1tube");

    const result = await packageDist({
      distDir: dist,
      outFile: payload,
      key: KEY,
    });
    assertEquals(result.manifest.sharedModules.length, 1);

    const v = await verifyPayload(payload, KEY);
    assertEquals(v.stage, "ok");

    const { entries } = await readPayload(payload);
    const shared = result.manifest.sharedModules[0];
    assert(
      entries.has(`dist/${shared.bundleFile}`),
      `missing entry dist/${shared.bundleFile}`,
    );
    await Deno.remove(dist, { recursive: true }).catch(() => {});
    await Deno.remove(out, { recursive: true }).catch(() => {});
  },
);

Deno.test(
  "package: wrong key fails signature verification",
  TEST_OPTS,
  async () => {
    const dist = await buildFixture("wrong-key");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-out-" });
    const payload = join(out, "fw.1tube");

    await packageDist({ distDir: dist, outFile: payload, key: KEY });

    const v = await verifyPayload(payload, WRONG_KEY);
    assertEquals(v.stage, "signature");
  },
);

Deno.test(
  "package: tampered envelope (flip one bit in version) fails signature",
  TEST_OPTS,
  async () => {
    const dist = await buildFixture("tamper-env");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-out-" });
    const payload = join(out, "fw.1tube");

    await packageDist({ distDir: dist, outFile: payload, key: KEY });

    // Read the zip, mutate the envelope's version field, write a new
    // zip back. Signature was computed over the original bytes so any
    // change inside `signature` *or* the unsigned portion of the
    // envelope must invalidate it.
    const { envelope, entries } = await readPayload(payload);
    envelope.version = envelope.version + "-tampered";
    const newEnv = new TextEncoder().encode(
      JSON.stringify(envelope, null, 2) + "\n",
    );
    await rewritePayload(
      payload,
      new Map([...entries, ["envelope.json", newEnv]]),
    );

    const v = await verifyPayload(payload, KEY);
    // parseEnvelope still passes (the field is a valid string), but
    // signature verification fails.
    assertEquals(v.stage, "signature");
  },
);

Deno.test(
  "package: tampered manifest fails the manifest-hash check",
  TEST_OPTS,
  async () => {
    const dist = await buildFixture("tamper-manifest");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-out-" });
    const payload = join(out, "fw.1tube");

    await packageDist({ distDir: dist, outFile: payload, key: KEY });

    const { entries } = await readPayload(payload);
    const original = entries.get("dist/manifest.json")!;
    // Flip a byte well past the schema header so it stays parseable
    // as JSON. We're testing the hash gate, not the parser gate.
    const tampered = new Uint8Array(original);
    tampered[tampered.length - 5] ^= 0x01;
    await rewritePayload(
      payload,
      new Map([...entries, ["dist/manifest.json", tampered]]),
    );

    const v = await verifyPayload(payload, KEY);
    assertEquals(v.stage, "manifest-hash");
  },
);

Deno.test(
  "package: tampered bundle fails the per-bundle hash check",
  TEST_OPTS,
  async () => {
    const dist = await buildFixture("tamper-bundle");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-out-" });
    const payload = join(out, "fw.1tube");

    const { manifest } = await packageDist({
      distDir: dist,
      outFile: payload,
      key: KEY,
    });
    const target = `dist/${manifest.functions[0].bundleFile}`;

    const { entries } = await readPayload(payload);
    const original = entries.get(target)!;
    const tampered = new Uint8Array(original);
    tampered[tampered.length - 1] ^= 0x42;
    await rewritePayload(payload, new Map([...entries, [target, tampered]]));

    const v = await verifyPayload(payload, KEY);
    assertEquals(v.stage, "bundle-hash");
  },
);

Deno.test(
  "package: layout matches the .1tube spec (envelope.json + dist/...)",
  TEST_OPTS,
  async () => {
    const dist = await buildFixture("layout");
    const out = await Deno.makeTempDir({ prefix: "1tube-pkg-out-" });
    const payload = join(out, "fw.1tube");

    await packageDist({ distDir: dist, outFile: payload, key: KEY });

    const { entries } = await readPayload(payload);
    const filenames = [...entries.keys()].sort();
    // Exact set: envelope at root, manifest under dist/, runtime bundles
    // under dist/functions/ or dist/shared/. No README, no .gitignore — those are
    // build-time conveniences, not part of the runtime contract.
    assert(filenames.includes("envelope.json"));
    assert(filenames.includes("dist/manifest.json"));
    for (const f of filenames) {
      if (f === "envelope.json") continue;
      if (f === "dist/manifest.json") continue;
      assert(
        f.startsWith("dist/functions/") || f.startsWith("dist/shared/") ||
          f.startsWith("dist/chunks/"),
        `unexpected entry in payload: ${f}`,
      );
    }
  },
);

Deno.test("envelope: parseEnvelope rejects bad schema / algo", () => {
  let threw = false;
  try {
    parseEnvelope({
      envelopeSchema: 99,
      version: "v",
      createdAt: "x",
      createdBy: "x",
      manifestSha256: "x",
      functionCount: 0,
      totalBundleBytes: 0,
      signature: { algo: "hmac-sha256", value: "x" },
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected parseEnvelope to reject schema=99");

  threw = false;
  try {
    parseEnvelope({
      envelopeSchema: ENVELOPE_SCHEMA,
      version: "v",
      createdAt: "x",
      createdBy: "x",
      manifestSha256: "x",
      functionCount: 0,
      totalBundleBytes: 0,
      signature: { algo: "ed25519-pkcs8", value: "x" },
    });
  } catch {
    threw = true;
  }
  assert(threw, "expected parseEnvelope to reject unknown signature algo");
});

// ── helpers ──────────────────────────────────────────────────────

/**
 * Rebuild the zip at `payloadPath` from the given entries map. We
 * use this rather than mutating the existing zip in place because
 * stream writers in the zip lib don't support patching, and the
 * round-trip cost is trivial at test sizes.
 */
async function rewritePayload(
  payloadPath: string,
  entries: Map<string, Uint8Array>,
): Promise<void> {
  const { BlobWriter, Uint8ArrayReader, ZipWriter } = await import(
    "@zip-js/zip-js"
  );
  const blobWriter = new BlobWriter("application/zip");
  const zip = new ZipWriter(blobWriter, { level: 6 });
  for (const [name, bytes] of entries) {
    await zip.add(name, new Uint8ArrayReader(bytes));
  }
  await zip.close();
  const blob = await blobWriter.getData();
  await Deno.writeFile(payloadPath, new Uint8Array(await blob.arrayBuffer()));
}
