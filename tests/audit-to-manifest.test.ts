/**
 * Pure-logic tests for scripts/audit-to-manifest.ts.
 *
 * Covers stack-frame parsing, function attribution, permission aggregation,
 * shared-record fan-out, manifest merging, and unknown-permission triage.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type AuditRecord,
  buildPermissionMap,
  extractPathsFromStack,
  functionForPath,
  ownerForRecord,
  parseAuditLine,
  permissionsToManifest,
} from "../scripts/audit-to-manifest.ts";
import { defaultManifest } from "../src/manifest.ts";

// We work entirely with POSIX-style absolute strings. `functionForPath` is a
// pure string-comparison: no real filesystem touched, no `resolve()` needed.
const FNS_DIR = "/tmp/sciobot/supabase/functions";

function fnPath(name: string, ...rest: string[]): string {
  return [FNS_DIR, name, ...rest].join("/");
}

function rec(
  permission: string,
  value: string | undefined,
  framesUnder: string[],
): AuditRecord {
  // Synthesise a stack-trace string the way Deno + V8 print them. Each frame
  // becomes "    at fnN (file:///<path>:line:col)" — the same shape Deno
  // emits. We strip the leading "/" inside the file:/// prefix because that's
  // exactly what real Deno stacks look like ("file:///tmp/x" not "file:////tmp/x").
  const stack =
    "Error\n" +
    framesUnder
      .map((p, i) => `    at fn${i} (file://${p}:10:5)`)
      .join("\n");
  return { permission, value, stack };
}

Deno.test("audit: extractPathsFromStack pulls out file paths from a typical Deno stack", () => {
  const stack = `Error: nope
    at validateRequest (file:///c:/proj/1tube/src/gateway/auth.ts:55:10)
    at handler (file:///c:/proj/sciobot/supabase/functions/ai-chat/index.ts:412:7)
    at <anonymous>:1:1`;
  const paths = extractPathsFromStack(stack);
  assertEquals(paths.length, 2);
  assert(paths[0].endsWith("auth.ts"));
  assert(paths[1].endsWith("index.ts"));
});

Deno.test("audit: functionForPath identifies the owning function under functionsDir", () => {
  assertEquals(functionForPath(fnPath("ai-chat", "helpers", "x.ts"), FNS_DIR), "ai-chat");
  assertEquals(functionForPath(fnPath("_shared", "db.ts"), FNS_DIR), null);
  assertEquals(functionForPath(fnPath("_internal", "x.ts"), FNS_DIR), null);
  assertEquals(functionForPath("/somewhere/else/file.ts", FNS_DIR), null);
});

Deno.test("audit: ownerForRecord walks frames and returns the first matching function", () => {
  const r = rec("env", "OPENAI_API_KEY", [
    fnPath("_shared", "ai.ts"),
    fnPath("ai-chat", "index.ts"),
  ]);
  assertEquals(ownerForRecord(r, FNS_DIR), "ai-chat");
});

Deno.test("audit: parseAuditLine ignores blanks/comments and returns valid records", () => {
  assertEquals(parseAuditLine(""), null);
  assertEquals(parseAuditLine("   "), null);
  assertEquals(parseAuditLine("# comment"), null);
  assertEquals(parseAuditLine("not json"), null);
  assertEquals(parseAuditLine('{"foo":1}'), null, "no permission field → skip");

  const ok = parseAuditLine('{"permission":"env","value":"OPENAI_API_KEY"}');
  assertEquals(ok?.permission, "env");
  assertEquals(ok?.value, "OPENAI_API_KEY");
});

Deno.test("audit: buildPermissionMap groups by owning function across permission types", () => {
  const records: AuditRecord[] = [
    rec("env", "OPENAI_API_KEY", [fnPath("ai-chat", "index.ts")]),
    rec("env", "OPENAI_API_KEY", [fnPath("ai-chat", "index.ts")]),
    rec("env", "GEMINI_API_KEY", [fnPath("ai-chat", "index.ts")]),
    rec("net", "api.openai.com", [fnPath("ai-chat", "index.ts")]),
    rec("env", "STRIPE_KEY", [fnPath("checkout", "index.ts")]),
    rec("read", "/etc/secret", [fnPath("_shared", "lib.ts")]), // shared, dropped
  ];

  const map = buildPermissionMap(records, { functionsDir: FNS_DIR });
  assertEquals(map.size, 2);

  const ai = map.get("ai-chat");
  assert(ai);
  assertEquals([...ai.env].sort(), ["GEMINI_API_KEY", "OPENAI_API_KEY"]);
  assertEquals([...ai.net], ["api.openai.com"]);
  assertEquals([...ai.read], []);

  const ck = map.get("checkout");
  assert(ck);
  assertEquals([...ck.env], ["STRIPE_KEY"]);
});

Deno.test("audit: --include-shared fans shared records out to every known function", () => {
  const records: AuditRecord[] = [
    rec("env", "OPENAI_API_KEY", [fnPath("ai-chat", "index.ts")]),
    rec("env", "STRIPE_KEY", [fnPath("checkout", "index.ts")]),
    rec("env", "GLOBAL_LOG_LEVEL", [fnPath("_shared", "log.ts")]),
  ];

  const noShare = buildPermissionMap(records, { functionsDir: FNS_DIR });
  assertEquals(noShare.get("ai-chat")?.env.has("GLOBAL_LOG_LEVEL"), false);
  assertEquals(noShare.get("checkout")?.env.has("GLOBAL_LOG_LEVEL"), false);

  const withShare = buildPermissionMap(records, {
    functionsDir: FNS_DIR,
    includeShared: true,
  });
  assertEquals(withShare.get("ai-chat")?.env.has("GLOBAL_LOG_LEVEL"), true);
  assertEquals(withShare.get("checkout")?.env.has("GLOBAL_LOG_LEVEL"), true);
});

Deno.test("audit: unknown permission types land in the `other` bag, not the manifest", () => {
  const records: AuditRecord[] = [
    rec("env", "X", [fnPath("fn", "index.ts")]),
    rec("run", "/bin/ls", [fnPath("fn", "index.ts")]),
    rec("ffi", "lib.so", [fnPath("fn", "index.ts")]),
  ];
  const map = buildPermissionMap(records, { functionsDir: FNS_DIR });
  const fn = map.get("fn");
  assert(fn);
  assertEquals(fn.env.size, 1);
  assertEquals(fn.other.get("run")?.has("/bin/ls"), true);
  assertEquals(fn.other.get("ffi")?.has("lib.so"), true);
});

Deno.test("audit: permissionsToManifest produces sorted, deduped allowlists", () => {
  const fn = {
    env: new Set(["B", "A", "B"]),
    read: new Set<string>(),
    write: new Set<string>(),
    net: new Set(["api.b", "api.a"]),
    other: new Map(),
  };
  const m = permissionsToManifest(fn);
  assertEquals(m.permissions.env, ["A", "B"]);
  assertEquals(m.permissions.net, ["api.a", "api.b"]);
  assertEquals(m.permissions.read, []);
  assertEquals(m.permissions.write, []);
  assertEquals(m.fromFile, true);
});

Deno.test("audit: permissionsToManifest with merge keeps existing entries (widen-only)", () => {
  const existing = {
    ...defaultManifest(),
    permissions: { env: ["LEGACY"], read: ["/data"], write: [], net: [] },
    timeoutMs: 60000,
    rpm: 30,
    fromFile: true,
  };
  const fn = {
    env: new Set(["NEW"]),
    read: new Set<string>(),
    write: new Set<string>(),
    net: new Set<string>(),
    other: new Map(),
  };

  const merged = permissionsToManifest(fn, existing, true);
  assertEquals(merged.permissions.env.sort(), ["LEGACY", "NEW"]);
  // Existing fields outside permissions are preserved.
  assertEquals(merged.timeoutMs, 60000);
  assertEquals(merged.rpm, 30);
  // Existing read entry survives the merge.
  assertEquals(merged.permissions.read, ["/data"]);

  // Without merge, existing widening is ignored — only audit-derived entries.
  const replaced = permissionsToManifest(fn, existing, false);
  assertEquals(replaced.permissions.env, ["NEW"]);
  assertEquals(replaced.permissions.read, []);
});

Deno.test("audit: end-to-end JSONL → manifest map (smoke test through the public API)", () => {
  const aiPath = fnPath("ai-chat", "index.ts");
  const lines = [
    "# comment line",
    "",
    JSON.stringify({
      permission: "env",
      value: "OPENAI_API_KEY",
      stack: `at handler (file://${aiPath}:1:1)`,
    }),
    "garbage",
    JSON.stringify({
      permission: "net",
      value: "api.openai.com",
      stack: `at handler (file://${aiPath}:2:2)`,
    }),
  ];
  const records = lines.map(parseAuditLine).filter((r): r is AuditRecord => r !== null);
  assertEquals(records.length, 2);

  const map = buildPermissionMap(records, { functionsDir: FNS_DIR });
  const ai = map.get("ai-chat");
  assert(ai);
  assertEquals([...ai.env], ["OPENAI_API_KEY"]);
  assertEquals([...ai.net], ["api.openai.com"]);
});

Deno.test("audit: function names never contain a directory separator", () => {
  // Sentinel: if path normalisation ever produces "fn/sub" buckets, we want
  // this to scream loudly rather than silently mis-attribute records.
  const owner = functionForPath(fnPath("ok", "x.ts"), FNS_DIR);
  assert(owner !== null);
  assertEquals(owner.includes("/"), false);
  assertEquals(owner.includes("\\"), false);
});
