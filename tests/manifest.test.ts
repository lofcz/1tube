/**
 * Tests for src/manifest.ts.
 */

import { assertEquals, assert } from "@std/assert";
import { join } from "@std/path";
import {
  defaultManifest,
  loadManifest,
  parseManifest,
  MANIFEST_FILENAME,
} from "../src/manifest.ts";

Deno.test("manifest: defaults are conservative (deny-everything)", () => {
  const m = defaultManifest();
  assertEquals(m.permissions, { net: [], env: [], read: [], write: [] });
  assertEquals(m.timeoutMs, undefined);
  assertEquals(m.rpm, undefined);
  assertEquals(m.fromFile, false);
  assertEquals(m.recycle.maxRequests, 0);
  assert(m.recycle.errorWindow > 0);
  assert(m.recycle.cooldownMs > 0);
});

Deno.test("manifest: parses a fully-populated object", () => {
  const m = parseManifest({
    permissions: {
      net: ["api.example.com"],
      env: ["FOO", "BAR"],
      read: ["/tmp"],
      write: ["/tmp/cache"],
    },
    timeoutMs: 5000,
    rpm: 30,
    memoryMB: 64,
    warm: true,
    min_replicas: 2,
    recycle: {
      maxRequests: 1000,
      errorRate: 0.25,
      errorWindow: 50,
      cooldownMs: 5000,
    },
  });
  assertEquals(m.permissions.net, ["api.example.com"]);
  assertEquals(m.permissions.env, ["FOO", "BAR"]);
  assertEquals(m.timeoutMs, 5000);
  assertEquals(m.rpm, 30);
  assertEquals(m.memoryMB, 64);
  assertEquals(m.warm, true);
  assertEquals(m.min_replicas, 2);
  assertEquals(m.recycle.maxRequests, 1000);
  assertEquals(m.recycle.errorRate, 0.25);
});

Deno.test("manifest: clamps invalid numeric inputs", () => {
  const m = parseManifest({
    timeoutMs: -10,
    rpm: 0,
    memoryMB: "garbage",
    recycle: { errorRate: 5, errorWindow: -1 },
  });
  assertEquals(m.timeoutMs, undefined);
  assertEquals(m.rpm, undefined);
  assertEquals(m.memoryMB, undefined);
  // errorRate clamps to [0,1]
  assertEquals(m.recycle.errorRate, 1);
  // errorWindow falls back to default when invalid
  assert(m.recycle.errorWindow > 0);
});

Deno.test("manifest: ignores non-string entries in permission arrays", () => {
  const m = parseManifest({
    permissions: { net: ["ok", 123, null, ""], env: "not-an-array" },
  });
  assertEquals(m.permissions.net, ["ok"]);
  assertEquals(m.permissions.env, []);
});

Deno.test("manifest: parses non-object input as defaults", () => {
  const m = parseManifest("nope");
  assertEquals(m, { ...defaultManifest(), fromFile: true });
});

Deno.test("manifest: loadManifest returns defaults when file is missing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "fn"));
    const m = await loadManifest(dir, "fn");
    assertEquals(m.fromFile, false);
    assertEquals(m.permissions.net, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("manifest: loadManifest reads + parses a real file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "fn"));
    await Deno.writeTextFile(
      join(dir, "fn", MANIFEST_FILENAME),
      JSON.stringify({ timeoutMs: 1234, rpm: 7, permissions: { net: ["x.com"] } }),
    );
    const m = await loadManifest(dir, "fn");
    assertEquals(m.fromFile, true);
    assertEquals(m.timeoutMs, 1234);
    assertEquals(m.rpm, 7);
    assertEquals(m.permissions.net, ["x.com"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("manifest: loadManifest tolerates malformed JSON without throwing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "fn"));
    await Deno.writeTextFile(join(dir, "fn", MANIFEST_FILENAME), "{not-json");
    // Silence the warning the loader will emit.
    const orig = console.warn;
    console.warn = () => {};
    try {
      const m = await loadManifest(dir, "fn");
      assertEquals(m.fromFile, false);
    } finally {
      console.warn = orig;
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
