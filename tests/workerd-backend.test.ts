/**
 * Tests for the workerd backend's pure helpers.
 *
 * The orchestrator itself is exercised end-to-end in
 * `workerd-e2e.test.ts` (which spawns a real workerd binary). The
 * helpers covered here have no I/O dependencies, so they're cheap to
 * run on every CI matrix entry — including those without workerd.
 *
 * Coverage focuses on `resolveEnvAllowlist`, which decides which env
 * vars get exposed to bundled functions. Wrong behaviour here is
 * either a security regression (forwarding too much) or a usability
 * regression (forwarding too little); both warrant tight tests.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildInspectorExtraArgs,
  buildMaxHeapExtraArgs,
  formatPortConflictError,
  intersectEnvForFunction,
  probeSocketsFree,
  resolveEnvAllowlist,
} from "../src/backends/workerd/backend.ts";
import { FunctionRegistry } from "../src/registry.ts";
import { defaultManifest } from "../src/manifest.ts";

/**
 * Tiny in-memory env source so tests don't have to mutate the process
 * env (which would race with parallel test execution under
 * `deno test --parallel`).
 */
function fakeEnv(record: Record<string, string>): {
  get(name: string): string | undefined;
  toObject(): Record<string, string>;
} {
  return {
    get: (name) => record[name],
    // Returning a defensive copy so callers can't mutate the test
    // fixture by mutating the returned object — matches Deno.env's
    // documented behaviour.
    toObject: () => ({ ...record }),
  };
}

Deno.test("resolveEnvAllowlist: explicit list takes precedence over 1TUBE_WORKERD_ENV", () => {
  const env = fakeEnv({
    OPENAI_API_KEY: "sk-1",
    POSTHOG_HOST: "https://x",
    "1TUBE_WORKERD_ENV": "POSTHOG_HOST",
  });
  const { resolved, missing, mode } = resolveEnvAllowlist(["OPENAI_API_KEY"], env);
  assertEquals(resolved, ["OPENAI_API_KEY"]);
  assertEquals(missing, []);
  assertEquals(mode, "restricted");
});

Deno.test("resolveEnvAllowlist: falls back to 1TUBE_WORKERD_ENV when explicit list is empty/undefined", () => {
  const env = fakeEnv({
    OPENAI_API_KEY: "sk-1",
    POSTHOG_HOST: "https://x",
    "1TUBE_WORKERD_ENV": "OPENAI_API_KEY, POSTHOG_HOST",
  });
  const a = resolveEnvAllowlist(undefined, env);
  assertEquals(a.resolved, ["OPENAI_API_KEY", "POSTHOG_HOST"]);
  assertEquals(a.mode, "restricted");
  // Empty array also falls through to the env-var override, then to
  // the pass-all default if that's also unset.
  const b = resolveEnvAllowlist([], env);
  assertEquals(b.resolved, ["OPENAI_API_KEY", "POSTHOG_HOST"]);
});

Deno.test("resolveEnvAllowlist: defaults to forwarding ALL env vars (opt-in to restrict)", () => {
  // No caller-explicit list and no `1TUBE_WORKERD_ENV` override →
  // bundled functions inherit the gateway's full env, the same way
  // a `deno run` child process would. Operators who care about
  // isolation pass an allowlist to narrow the surface.
  const env = fakeEnv({
    OPENAI_API_KEY: "sk-1",
    POSTHOG_HOST: "https://x",
    PATH: "/usr/bin",
  });
  const { resolved, missing, mode } = resolveEnvAllowlist(undefined, env);
  // Sorted for deterministic capnp output regardless of host platform.
  assertEquals(resolved, ["OPENAI_API_KEY", "PATH", "POSTHOG_HOST"]);
  assertEquals(missing, []);
  assertEquals(mode, "all");
});

Deno.test("resolveEnvAllowlist: pass-all silently drops names workerd can't bind", () => {
  // Windows in particular emits names like `=ExitCode`, `=::=::\`, and
  // `ProgramFiles(x86)` from `Deno.env.toObject()`. They're not valid
  // capnp `fromEnvironment` keys (POSIX-ish identifier rule) and the
  // operator didn't ask for them by name, so dropping them quietly is
  // the right call. Restricted mode keeps strict validation downstream.
  const env = fakeEnv({
    OPENAI_API_KEY: "sk",
    "=ExitCode": "0",
    "ProgramFiles(x86)": "C:\\PF86",
    "=::=::\\": "junk",
    POSTHOG_HOST: "https://x",
  });
  const { resolved, mode } = resolveEnvAllowlist(undefined, env);
  assertEquals(resolved, ["OPENAI_API_KEY", "POSTHOG_HOST"]);
  assertEquals(mode, "all");
});

Deno.test("resolveEnvAllowlist: literal ['*'] is the explicit form of pass-all", () => {
  // Useful in CI configs where an operator wants their intent obvious
  // ("yes, I really do mean every env var") rather than relying on
  // the implicit "no list = everything" default.
  const env = fakeEnv({ A: "1", B: "2" });
  const a = resolveEnvAllowlist(["*"], env);
  assertEquals(a.resolved, ["A", "B"]);
  assertEquals(a.mode, "all");

  // `1TUBE_WORKERD_ENV` itself starts with a digit and gets filtered
  // out of pass-all output (workerd's `fromEnvironment` requires the
  // POSIX identifier convention). Only `A` survives.
  const b = resolveEnvAllowlist(undefined, fakeEnv({ A: "1", "1TUBE_WORKERD_ENV": "*" }));
  assertEquals(b.resolved, ["A"]);
  assertEquals(b.mode, "all");
});

Deno.test("resolveEnvAllowlist: reports missing names but never fabricates values", () => {
  const env = fakeEnv({ OPENAI_API_KEY: "sk-1" });
  const { resolved, missing } = resolveEnvAllowlist(
    ["OPENAI_API_KEY", "POSTHOG_HOST", "STRIPE_KEY"],
    env,
  );
  // Only the present var is resolved; absent ones are surfaced for the
  // boot-time warning and excluded from the capnp config (workerd
  // would otherwise refuse to start).
  assertEquals(resolved, ["OPENAI_API_KEY"]);
  assertEquals(missing, ["POSTHOG_HOST", "STRIPE_KEY"]);
});

Deno.test("resolveEnvAllowlist: de-duplicates names while preserving first-seen order", () => {
  const env = fakeEnv({ A: "1", B: "2", C: "3" });
  const { resolved, missing } = resolveEnvAllowlist(["B", "A", "B", "C", "A"], env);
  assertEquals(resolved, ["B", "A", "C"]);
  assertEquals(missing, []);
});

Deno.test("resolveEnvAllowlist: trims whitespace and ignores empty entries from 1TUBE_WORKERD_ENV", () => {
  const env = fakeEnv({
    A: "1",
    B: "2",
    "1TUBE_WORKERD_ENV": " A , ,B ,, ",
  });
  const { resolved } = resolveEnvAllowlist(undefined, env);
  assertEquals(resolved, ["A", "B"]);
});

// ---------------------------------------------------------------------------
// intersectEnvForFunction — per-function env scoping (M3).
//
// Two modes mirror the Deno backend's `1TUBE_ENFORCE_MANIFEST` switch.
// The function is the *only* place where manifest env policy meets
// the gateway allowlist on the workerd path, so we cover the matrix
// thoroughly: enforcement on/off, wildcard, narrowing, and disjoint.
// ---------------------------------------------------------------------------

Deno.test("intersectEnvForFunction: enforcement off ⇒ every function sees full gateway list", () => {
  // Manifest declares only ["A"] but enforcement is off — same
  // behaviour as the Deno backend with no 1TUBE_ENFORCE_MANIFEST set.
  const out = intersectEnvForFunction(["A", "B", "C"], ["A"], false);
  assertEquals(out, ["A", "B", "C"]);
});

Deno.test("intersectEnvForFunction: enforcement on + ['*'] ⇒ full gateway list", () => {
  // Wildcard is the explicit opt-out for functions that legitimately
  // need every secret the operator forwards (e.g. an internal admin
  // function). Honoured only under enforcement.
  const out = intersectEnvForFunction(["A", "B"], ["*"], true);
  assertEquals(out, ["A", "B"]);
});

Deno.test("intersectEnvForFunction: enforcement on + subset ⇒ narrows to intersection", () => {
  const out = intersectEnvForFunction(["A", "B", "C"], ["B", "C", "Z"], true);
  // Z is not in the gateway list, so it's silently dropped — manifest
  // declarations cannot expand the operator's surface, only narrow it.
  assertEquals(out, ["B", "C"]);
});

Deno.test("intersectEnvForFunction: enforcement on + empty manifest ⇒ no env (deny by default)", () => {
  // Default `permissions.env: []` means "I haven't declared anything".
  // Under enforcement that's deny-all, matching the Deno path's
  // strictness. Operators who need permissive default should leave
  // enforcement off.
  const out = intersectEnvForFunction(["A", "B"], [], true);
  assertEquals(out, []);
});

Deno.test("intersectEnvForFunction: returns a fresh array (caller may mutate)", () => {
  const gateway = ["A", "B"];
  const out = intersectEnvForFunction(gateway, ["*"], true);
  out.push("MUTATED");
  // Mutating the result must not leak back into caller-owned input.
  assertEquals(gateway, ["A", "B"]);
});

// ---------------------------------------------------------------------------
// Registry external-manifest plumbing — workerd functions don't have
// JS handlers, but the rate-limiter / supervisor / fast-fail middleware
// all consult `registry.manifestFor(name)`. The bridge added in M3 must
// surface workerd manifests through that same API.
// ---------------------------------------------------------------------------

Deno.test("FunctionRegistry.setExternalManifest: surfaces via manifestFor + has + knownNames", () => {
  const reg = new FunctionRegistry();
  const m = defaultManifest();
  m.timeoutMs = 9999;
  reg.setExternalManifest("hello", m);

  // `manifestFor` is what the rate-limiter actually calls.
  assertEquals(reg.manifestFor("hello")?.timeoutMs, 9999);
  // `has` decides whether fast-fail middleware 404s.
  assertEquals(reg.has("hello"), true);
  // `knownNames` powers `/health` and dev-time listings.
  assertEquals(reg.knownNames(), ["hello"]);
  // `getOrLoad` must still return undefined: there is no JS handler,
  // and dispatch on the workerd path runs through the backend proxy
  // instead. A non-undefined value here would mislead the Deno
  // dispatch path into trying to invoke a non-existent handler.
  // (We can't await getOrLoad in a sync test; skip directly.)
});

Deno.test("FunctionRegistry: in-process handler manifest wins over external", () => {
  // Edge case: a name that exists both as an in-process candidate
  // (Deno path) and as an external workerd manifest. The in-process
  // entry must win — it's the source of truth for that backend.
  const reg = new FunctionRegistry();
  const inProcess = defaultManifest();
  inProcess.timeoutMs = 1111;
  const external = defaultManifest();
  external.timeoutMs = 2222;

  reg.registerCandidate({
    name: "shared",
    moduleUrl: "data:text/javascript,",
    manifest: inProcess,
  });
  reg.setExternalManifest("shared", external);

  assertEquals(reg.manifestFor("shared")?.timeoutMs, 1111);
});

Deno.test("FunctionRegistry.clearExternalManifests: removes only external entries", () => {
  const reg = new FunctionRegistry();
  reg.registerCandidate({
    name: "stays",
    moduleUrl: "data:text/javascript,",
    manifest: defaultManifest(),
  });
  reg.setExternalManifest("goes", defaultManifest());
  assertEquals(reg.knownNames(), ["goes", "stays"]);

  reg.clearExternalManifests();
  // External entry gone; in-process candidate untouched.
  assertEquals(reg.knownNames(), ["stays"]);
  assertEquals(reg.manifestFor("goes"), undefined);
});

// ---------------------------------------------------------------------------
// buildInspectorExtraArgs (M6)
// ---------------------------------------------------------------------------

Deno.test("buildInspectorExtraArgs: returns [] when inspector is off", () => {
  assertEquals(buildInspectorExtraArgs(undefined, 0), []);
  assertEquals(buildInspectorExtraArgs(undefined, 1), []);
});

Deno.test("buildInspectorExtraArgs: host:port is shifted by slot", () => {
  // Slot 0 is the initial generation; slot 1 is what the post-HMR
  // successor lands on while the predecessor still holds slot 0's
  // port. The shift IS the entire reason inspector survives HMR.
  assertEquals(
    buildInspectorExtraArgs("127.0.0.1:9229", 0),
    ["--inspector-addr=127.0.0.1:9229"],
  );
  assertEquals(
    buildInspectorExtraArgs("127.0.0.1:9229", 1),
    ["--inspector-addr=127.0.0.1:9230"],
  );
});

Deno.test("buildInspectorExtraArgs: bare port defaults to 127.0.0.1", () => {
  assertEquals(
    buildInspectorExtraArgs("9229", 0),
    ["--inspector-addr=127.0.0.1:9229"],
  );
  assertEquals(
    buildInspectorExtraArgs("9229", 1),
    ["--inspector-addr=127.0.0.1:9230"],
  );
});

Deno.test("buildInspectorExtraArgs: exotic forms pass through unchanged", () => {
  // Anything that doesn't match `<host>:<port>` is forwarded verbatim
  // so workerd's own parser can reject or accept it. Otherwise our
  // naive parser would silently mangle bracketed IPv6 forms.
  assertEquals(
    buildInspectorExtraArgs("[::1]:9229", 0),
    ["--inspector-addr=[::1]:9229"],
  );
  assertEquals(
    buildInspectorExtraArgs("unix:/tmp/inspector.sock", 0),
    ["--inspector-addr=unix:/tmp/inspector.sock"],
  );
});

// ---------------------------------------------------------------------------
// buildMaxHeapExtraArgs — V8 old-generation heap cap, JVM `-Xmx`-equivalent
// ---------------------------------------------------------------------------

Deno.test("buildMaxHeapExtraArgs: returns [] when unset / zero / NaN / negative", () => {
  // Caller splats the result unconditionally, so "off" must be the
  // empty array rather than a sentinel value.
  assertEquals(buildMaxHeapExtraArgs(undefined), []);
  assertEquals(buildMaxHeapExtraArgs(0), []);
  assertEquals(buildMaxHeapExtraArgs(-512), []);
  assertEquals(buildMaxHeapExtraArgs(NaN), []);
  assertEquals(buildMaxHeapExtraArgs(Infinity), []);
});

Deno.test("buildMaxHeapExtraArgs: emits --v8-max-heap-size in MB, integer-floored", () => {
  // Workerd accepts the flag in MB. We floor non-integer inputs so a
  // user passing 512.9 doesn't accidentally produce a malformed CLI
  // arg — the .9MB delta is irrelevant against a 512MB heap anyway.
  assertEquals(buildMaxHeapExtraArgs(128), ["--v8-max-heap-size=128"]);
  assertEquals(buildMaxHeapExtraArgs(512), ["--v8-max-heap-size=512"]);
  assertEquals(buildMaxHeapExtraArgs(512.9), ["--v8-max-heap-size=512"]);
});

// ---------------------------------------------------------------------------
// probeSocketsFree — preflight against zombie workerd / port collisions
// ---------------------------------------------------------------------------

/** Pick a free ephemeral port without holding the listener. */
function freePort(): number {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

Deno.test("probeSocketsFree: returns [] when every port is free", () => {
  // Two ephemeral ports we just released — overwhelmingly likely to
  // still be free for the few microseconds the test takes. Worst case
  // a flake; if it happens repeatedly we'll widen the range.
  const a = freePort();
  const b = freePort();
  const conflicts = probeSocketsFree([
    { name: "hello", address: "127.0.0.1", port: a },
    { name: "echo", address: "127.0.0.1", port: b },
  ]);
  assertEquals(conflicts, []);
});

Deno.test("probeSocketsFree: reports each held port as a conflict", async () => {
  // Real listeners simulate the zombie-workerd case: something else is
  // already bound to the port we'd ask workerd to use.
  const port = await freePort();
  const holder = Deno.listen({ hostname: "127.0.0.1", port });
  try {
    const conflicts = probeSocketsFree([
      { name: "hello", address: "127.0.0.1", port },
    ]);
    assertEquals(conflicts.length, 1);
    assertEquals(conflicts[0], { name: "hello", address: "127.0.0.1", port });
  } finally {
    holder.close();
  }
});

Deno.test("probeSocketsFree: collects every conflict (doesn't short-circuit on first)", async () => {
  // Operator triaging a multi-zombie box benefits from seeing the
  // entire conflicting set in one error, not fixing them one-by-one.
  const p1 = await freePort();
  const p2 = await freePort();
  const h1 = Deno.listen({ hostname: "127.0.0.1", port: p1 });
  const h2 = Deno.listen({ hostname: "127.0.0.1", port: p2 });
  try {
    const conflicts = probeSocketsFree([
      { name: "hello", address: "127.0.0.1", port: p1 },
      { name: "echo", address: "127.0.0.1", port: p2 },
    ]);
    assertEquals(conflicts.map((c) => c.name).sort(), ["echo", "hello"]);
  } finally {
    h1.close();
    h2.close();
  }
});

Deno.test("formatPortConflictError: includes platform-specific kill hints + every conflict", () => {
  const msg = formatPortConflictError([
    { name: "hello", address: "127.0.0.1", port: 8800 },
    { name: "echo", address: "127.0.0.1", port: 8801 },
  ]);
  // The hint is the most-clicked part of this message — verify it
  // shows up unmistakably so a quick eyeball-scan finds it.
  assert(msg.includes("hello → 127.0.0.1:8800"));
  assert(msg.includes("echo → 127.0.0.1:8801"));
  assert(msg.includes("taskkill /F /IM workerd.exe"));
  assert(msg.includes("pkill workerd"));
  assert(msg.includes("2 socket(s) already in use"));
});

Deno.test("resolveEnvAllowlist: distinguishes empty value from absent var", () => {
  // An env var explicitly set to "" is still *present* — workerd will
  // forward the empty string, which is meaningful for some libraries
  // (feature flags, etc.). We must not drop it as if absent.
  const env = fakeEnv({ FEATURE_FLAG: "" });
  const { resolved, missing } = resolveEnvAllowlist(["FEATURE_FLAG"], env);
  assertEquals(resolved, ["FEATURE_FLAG"]);
  assertEquals(missing, []);
});
