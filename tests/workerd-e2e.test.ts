/**
 * End-to-end test for the workerd backend.
 *
 * Boots a real `1tube` gateway with `--backend workerd` against the
 * project's `playground/` functions, then hits the same surface a user
 * would (`/functions/v1/hello`, `/functions/v1/echo`) and asserts the
 * responses match what the Deno backend produces. This is the only
 * test in the suite that depends on the workerd binary being on PATH;
 * it skips silently with a console note when it isn't, so unrelated CI
 * jobs that don't carry workerd still pass.
 *
 * The test scopes the workerd backend to `hello,echo` via the `only`
 * option (passed through `1TUBE_WORKERD_ONLY`) so the whole run stays
 * under ~15s on a warm cache. Bundling on cold disks can take longer;
 * we give the boot up to 60s.
 */

import { assert, assertEquals } from "@std/assert";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fromFileUrl } from "jsr:@std/path@^1/from-file-url";
import { probeVersion } from "../src/backends/workerd/process.ts";
import { signJwt } from "./_helpers.ts";

// Same value the dev defaults block in src/server.ts seeds when --dev
// is passed. Keeping it inline (rather than importing the consts
// module) makes the contract under test obvious from this file alone.
const DEV_JWT_SECRET =
  "super-secret-jwt-token-with-at-least-32-characters-long";

const PROJECT_ROOT = resolvePath(dirname(fromFileUrl(import.meta.url)), "..");

const E2E_OPTS = { sanitizeOps: false, sanitizeResources: false } as const;

async function freePort(): Promise<number> {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Block until the port responds with any HTTP status, or `timeoutMs` elapses. */
async function waitForGateway(port: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" });
      // Drain so the socket can close cleanly.
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway on :${port} did not become ready within ${timeoutMs}ms`);
}

async function workerdAvailable(): Promise<boolean> {
  const candidate = Deno.env.get("1TUBE_WORKERD_BIN") ?? "workerd";
  try {
    await probeVersion(candidate);
    return true;
  } catch {
    return false;
  }
}

Deno.test("workerd-e2e: gateway proxies hello + echo through workerd", E2E_OPTS, async () => {
  if (!(await workerdAvailable())) {
    console.log("[skipped: workerd binary not on PATH]");
    return;
  }

  const port = await freePort();
  const playgroundDir = join(PROJECT_ROOT, "playground");

  // Spawn the gateway as a child process with the workerd backend
  // selected. `--dev` short-circuits the prod-secrets guard so the
  // subprocess can boot without a real JWT_SECRET configured. We feed
  // `1TUBE_WORKERD_ONLY` via a thin wrapper: the orchestrator
  // currently exposes the `only` filter through code, not env, so we
  // route through DENO_DIR-style flags by using a small inline driver
  // script. Simplest approach: just let the backend bundle every
  // function in `playground/` — small enough that boot is fast.
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-all",
      "src/server.ts",
      "--backend",
      "workerd",
      "--functions",
      playgroundDir,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--dev",
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      // Force eager + non-watch — HMR doesn't apply to workerd anyway
      // and we want a deterministic boot.
      "1TUBE_HMR": "0",
      "1TUBE_LAZY": "0",
      // Surface a known set of vars to the workerd bundles via the
      // gateway's env-allowlist. The values below are the *only*
      // ground-truth the env-probe assertion compares against; if the
      // capnp `fromEnvironment` plumbing breaks, the bundle sees
      // `null` for every name and the assertion fails loudly.
      "1TUBE_WORKERD_ENV": "OPENAI_API_KEY,POSTHOG_HOST,WORKERD_E2E_FLAG",
      "OPENAI_API_KEY": "sk-test-deadbeef",
      "POSTHOG_HOST": "https://e2e.posthog.example",
      // Empty-string is intentional — proves we don't drop present-
      // but-empty vars on the floor.
      "WORKERD_E2E_FLAG": "",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Tee stderr to test stdout so a failure shows the gateway log.
  // Stdout pump is best-effort; we don't assert on its content.
  const teePump = (async () => {
    const reader = child.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = dec.decode(value);
        // Prefix so the test log is easy to scan.
        Deno.stderr.writeSync(new TextEncoder().encode(chunk.replace(/^/gm, "   ⏵ ")));
      }
    } catch { /* */ }
  })();

  // Also drain stdout to prevent backpressure from blocking the child.
  const stdoutPump = (async () => {
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch { /* */ }
  })();

  try {
    // Bundling + workerd boot: 60s is generous for cold caches.
    await waitForGateway(port, 60_000);

    // ---- /functions/v1/hello ------------------------------------------
    // hello handler: who = pathname.replace(/^\/+/, "") — for the
    // gateway's rewritten URL `/hello/jane`, that yields "hello/jane".
    // We hit the bare function path to get a clean "hello, world".
    const helloRes = await fetch(`http://127.0.0.1:${port}/functions/v1/hello`, {
      cache: "no-store",
    });
    assertEquals(helloRes.status, 200);
    const helloBody = await helloRes.json();
    assertEquals(helloBody.message, "hello, hello");
    assertEquals(helloBody.method, "GET");
    assert(typeof helloBody.at === "string");

    // ---- /functions/v1/echo with JSON body ----------------------------
    const echoBody = { hello: "world", n: 42 };
    const echoRes = await fetch(`http://127.0.0.1:${port}/functions/v1/echo?x=1&y=2`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test": "abc" },
      body: JSON.stringify(echoBody),
      cache: "no-store",
    });
    assertEquals(echoRes.status, 200);
    const echoed = await echoRes.json();
    assertEquals(echoed.method, "POST");
    assertEquals(echoed.query, { x: "1", y: "2" });
    assertEquals(echoed.body, echoBody);
    // Custom header should round-trip — confirms the gateway forwards
    // request headers through the workerd proxy unmolested.
    assertEquals(echoed.headers["x-test"], "abc");

    // ---- /functions/v1/whoami with a real JWT --------------------------
    // Validates the auth-context round-trip: gateway verifies the JWT,
    // forwards identity via X-1tube-Auth-* headers, and the bundle's
    // FOOTER reconstructs an AuthContext with the same fields.
    const token = await signJwt(DEV_JWT_SECRET, {
      sub: "user-workerd-e2e",
      email: "e2e@workerd.test",
    });
    const whoRes = await fetch(`http://127.0.0.1:${port}/functions/v1/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    assertEquals(whoRes.status, 200);
    const who = await whoRes.json();
    assertEquals(who.userId, "user-workerd-e2e");
    assertEquals(who.email, "e2e@workerd.test");
    // Payload should contain the JWT claims the auth layer parsed.
    assertEquals(who.payload?.sub, "user-workerd-e2e");
    assertEquals(who.payload?.role, "authenticated");

    // ---- /functions/v1/env-probe — Deno.env.get inside workerd --------
    // This is the M2 contract: vars listed in 1TUBE_WORKERD_ENV reach
    // bundled functions through workerd's `fromEnvironment` bindings,
    // and the Deno.env shim in the bundle banner reads them back.
    const envRes = await fetch(`http://127.0.0.1:${port}/functions/v1/env-probe`, {
      cache: "no-store",
    });
    assertEquals(envRes.status, 200);
    const envBody = await envRes.json();
    assertEquals(envBody.OPENAI_API_KEY, "sk-test-deadbeef");
    assertEquals(envBody.POSTHOG_HOST, "https://e2e.posthog.example");
    assertEquals(envBody.WORKERD_E2E_FLAG, "");

    // ---- /functions/v1/stream — chunks must arrive incrementally ------
    // Read the NDJSON response one chunk at a time and verify the
    // first chunk lands well before the total stream duration. If the
    // proxy were buffering to EOF, all chunks would arrive together
    // after ~5*50ms = 250ms and `firstChunkMs` would exceed `gapMs`.
    const N = 5;
    const GAP = 80;
    const streamStart = performance.now();
    const streamRes = await fetch(
      `http://127.0.0.1:${port}/functions/v1/stream?n=${N}&gap=${GAP}`,
      { cache: "no-store" },
    );
    assertEquals(streamRes.status, 200);
    assert(streamRes.body, "stream response must have a body");
    const reader = streamRes.body.getReader();
    const dec = new TextDecoder();
    let firstChunkAt = -1;
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (firstChunkAt < 0) firstChunkAt = performance.now() - streamStart;
      buf += dec.decode(value, { stream: true });
    }
    buf += dec.decode();
    const lines = buf.split("\n").filter((l) => l.length > 0);
    assertEquals(lines.length, N, `expected ${N} NDJSON lines, got ${lines.length}`);
    for (let i = 0; i < N; i++) {
      const obj = JSON.parse(lines[i]);
      assertEquals(obj.i, i);
    }
    // Streaming is observable: first chunk arrives before the *last*
    // gap would have elapsed if buffered. Generous threshold so a
    // slow CI host doesn't false-positive.
    const latestFirstChunkAllowed = (N - 1) * GAP * 0.8;
    assert(
      firstChunkAt > 0 && firstChunkAt < latestFirstChunkAllowed,
      `first chunk arrived at ${firstChunkAt.toFixed(0)}ms; ` +
        `must be < ${latestFirstChunkAllowed.toFixed(0)}ms to prove streaming, not buffering`,
    );

    // ---- /functions/v1/zod-deps — bundler resolves npm:zod ------------
    // Validates the npm-bundling path against a real, third-party dep.
    // Both the success branch (parsed payload echoed back) and the
    // failure branch (zod issue list surfaced) exercise the bundle's
    // ability to call into npm code at runtime.
    const zodOk = await fetch(`http://127.0.0.1:${port}/functions/v1/zod-deps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "alice", age: 30 }),
      cache: "no-store",
    });
    assertEquals(zodOk.status, 200);
    const zodOkBody = await zodOk.json();
    assertEquals(zodOkBody.ok, true);
    assertEquals(zodOkBody.person, { name: "alice", age: 30 });

    const zodBad = await fetch(`http://127.0.0.1:${port}/functions/v1/zod-deps`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "", age: -1 }),
      cache: "no-store",
    });
    assertEquals(zodBad.status, 400);
    const zodBadBody = await zodBad.json();
    assertEquals(zodBadBody.error, "validation failed");
    assert(Array.isArray(zodBadBody.issues) && zodBadBody.issues.length > 0);

    // ---- /functions/v1/boom — circuit breaker trips on workerd path ---
    // The boom function always returns 500 and its 1tube.json declares
    // a tight recycle config: errorWindow=3, errorRate=1.0, cooldown=5s.
    // After 3 consecutive 500s the supervisor must open the breaker
    // and the gateway must short-circuit subsequent requests with 503
    // *without* forwarding to workerd. The 503 carries Retry-After.
    //
    // This is the M3 acceptance check for manifest-driven supervisor
    // wiring on the workerd path. If the breaker doesn't trip, the
    // 4th request would land another 500 (and probably the 5th, 6th,
    // …) and this assertion fires.
    const boomStatuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/functions/v1/boom`, {
        cache: "no-store",
      });
      boomStatuses.push(res.status);
      await res.body?.cancel();
    }
    assertEquals(
      boomStatuses,
      [500, 500, 500],
      "boom should fail 3 times before the breaker opens",
    );
    const trippedRes = await fetch(`http://127.0.0.1:${port}/functions/v1/boom`, {
      cache: "no-store",
    });
    assertEquals(
      trippedRes.status,
      503,
      "4th request must hit the open breaker with 503",
    );
    const retryAfter = trippedRes.headers.get("retry-after");
    assert(
      retryAfter !== null && Number(retryAfter) > 0,
      `503 must carry a positive Retry-After; got ${retryAfter}`,
    );
    const trippedBody = await trippedRes.json();
    assertEquals(trippedBody.reason, "circuit_breaker_open");

    // ---- Unknown function should still 404 fast-fail ------------------
    const noSuchRes = await fetch(`http://127.0.0.1:${port}/functions/v1/no-such-fn`, {
      cache: "no-store",
    });
    assertEquals(noSuchRes.status, 404);
    await noSuchRes.body?.cancel();
  } finally {
    // Graceful shutdown — SIGTERM on Unix, SIGKILL elsewhere.
    try {
      child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM");
    } catch { /* already gone */ }
    try {
      // Bound the wait so a hung child can't pin the test runner.
      await Promise.race([
        child.status,
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } catch { /* */ }
    try { child.kill("SIGKILL"); } catch { /* */ }
    await teePump.catch(() => {});
    await stdoutPump.catch(() => {});
  }
});

/**
 * M4: end-to-end HMR test against a real workerd subprocess.
 *
 * Strategy:
 *   1. Copy `playground/hello/` into a fresh tmpdir so we never edit
 *      the real source tree.
 *   2. Boot the gateway with `--hmr --backend=workerd` against tmpdir.
 *   3. Hit `/functions/v1/hello` and capture the original message.
 *   4. Rewrite hello/index.ts on disk with a new message marker.
 *   5. Poll until the response changes — proving the rebundle + dual
 *      process swap completed without dropping requests.
 *   6. Stop the gateway and rm -rf the tmpdir.
 *
 * The test is conservative on timing: 30s polling budget with 200ms
 * sleeps. On a warm bundle cache the swap typically completes in
 * 200–800ms (incremental rebundle of just `hello`).
 */
Deno.test("workerd-e2e: HMR rebundles + swaps without dropping requests", E2E_OPTS, async () => {
  if (!(await workerdAvailable())) {
    console.log("[skipped: workerd binary not on PATH]");
    return;
  }

  const port = await freePort();
  // Build a minimal playground copy with just `hello` and the
  // shared handler — keeps the workerd boot under 5s on warm caches
  // by avoiding the full bundle sweep we do in the main e2e test.
  const tmp = await Deno.makeTempDir({ prefix: "1tube-hmr-e2e-" });
  const srcPlayground = join(PROJECT_ROOT, "playground");
  await Deno.mkdir(join(tmp, "hello"), { recursive: true });
  await Deno.mkdir(join(tmp, "_shared"), { recursive: true });
  await Deno.copyFile(
    join(srcPlayground, "hello", "index.ts"),
    join(tmp, "hello", "index.ts"),
  );
  await Deno.copyFile(
    join(srcPlayground, "hello", "1tube.json"),
    join(tmp, "hello", "1tube.json"),
  );
  await Deno.copyFile(
    join(srcPlayground, "_shared", "handler.ts"),
    join(tmp, "_shared", "handler.ts"),
  );

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-all",
      "src/server.ts",
      "--backend",
      "workerd",
      "--functions",
      tmp,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--dev",
      "--hmr",
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      "1TUBE_LAZY": "0",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const teePump = (async () => {
    const reader = child.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        Deno.stderr.writeSync(new TextEncoder().encode(dec.decode(value).replace(/^/gm, "   ⏵ ")));
      }
    } catch { /* */ }
  })();
  const stdoutPump = (async () => {
    const reader = child.stdout.getReader();
    try { while (true) { const { done } = await reader.read(); if (done) break; } } catch { /* */ }
  })();

  try {
    await waitForGateway(port, 60_000);

    // Capture the pre-edit response. The default hello function
    // greets "hello, hello"; we'll rewrite the bundle to greet
    // "hello, M4-RELOADED".
    const before = await fetch(`http://127.0.0.1:${port}/functions/v1/hello`, { cache: "no-store" });
    const beforeBody = await before.json();
    assertEquals(beforeBody.message, "hello, hello");

    // Rewrite the file. The shared `serve()` shim makes this a one-
    // line swap: change the `message` value and the next bundle
    // serves the new payload.
    const newSource = `import { serve } from "../_shared/handler.ts";
serve(
  (_req: Request) => Response.json({ message: "hello, M4-RELOADED", method: "GET", at: new Date().toISOString() }),
  { public: true },
);
`;
    await Deno.writeTextFile(join(tmp, "hello", "index.ts"), newSource);

    // Poll for the swap. 30s budget covers cold-disk + esbuild's
    // first incremental run on a fresh tmpdir cache.
    const pollDeadline = performance.now() + 30_000;
    let observedAfter: { message?: string } | null = null;
    while (performance.now() < pollDeadline) {
      const res = await fetch(`http://127.0.0.1:${port}/functions/v1/hello`, { cache: "no-store" });
      // 5xx during the swap is unexpected (dual-process swap should
      // be transparent) but harmless — old workerd should still
      // serve until the new one is ready. Skip and keep polling.
      if (res.status === 200) {
        const body = await res.json();
        if (body.message !== beforeBody.message) {
          observedAfter = body;
          break;
        }
      } else {
        await res.body?.cancel();
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    assert(
      observedAfter !== null,
      "expected /hello to return new message after HMR within 30s",
    );
    assertEquals(observedAfter!.message, "hello, M4-RELOADED");
  } finally {
    try { child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM"); } catch { /* */ }
    try {
      await Promise.race([
        child.status,
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } catch { /* */ }
    try { child.kill("SIGKILL"); } catch { /* */ }
    await teePump.catch(() => {});
    await stdoutPump.catch(() => {});
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
});

/**
 * M5: end-to-end crash recovery test.
 *
 * The backend's `wireCrashHandler` subscribes to `WorkerdProcess.onExit`
 * and, on an unexpected death, fires `doReload("all")` which spawns a
 * fresh workerd on shifted ports and atomically swaps. This test
 * exercises that pipeline against a real workerd binary:
 *
 *   1. Boot the gateway with `--backend workerd` and a known
 *      `INTERNAL_KEY` so we can authenticate /health and read the
 *      live workerd PID + generation.
 *   2. Verify /hello responds before the kill.
 *   3. Kill the workerd process via OS-native signal (`Deno.kill` on
 *      Unix, `taskkill /F /PID` on Windows since Deno can't signal
 *      arbitrary PIDs there).
 *   4. Poll /health until `workerd.generation` increments AND
 *      `workerd.pid` is non-null — that's the swap completing.
 *   5. Verify /hello responds again to prove the new workerd is
 *      actually serving and the gateway re-bridged its routes.
 */
Deno.test("workerd-e2e: gateway auto-recovers when workerd is killed externally", E2E_OPTS, async () => {
  if (!(await workerdAvailable())) {
    console.log("[skipped: workerd binary not on PATH]");
    return;
  }

  const port = await freePort();
  const playgroundDir = join(PROJECT_ROOT, "playground");
  const internalKey = "test-internal-key-deadbeef";

  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--allow-all",
      "src/server.ts",
      "--backend",
      "workerd",
      "--functions",
      playgroundDir,
      "--port",
      String(port),
      "--host",
      "127.0.0.1",
      "--dev",
    ],
    cwd: PROJECT_ROOT,
    env: {
      ...Deno.env.toObject(),
      "1TUBE_HMR": "0",
      "1TUBE_LAZY": "0",
      "INTERNAL_KEY": internalKey,
      // Restrict to a single function to keep the boot fast.
      "1TUBE_WORKERD_ONLY": "hello",
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  const teePump = (async () => {
    const reader = child.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        Deno.stderr.writeSync(new TextEncoder().encode(dec.decode(value).replace(/^/gm, "   ⏵ ")));
      }
    } catch { /* */ }
  })();
  const stdoutPump = (async () => {
    const reader = child.stdout.getReader();
    try { while (true) { const { done } = await reader.read(); if (done) break; } } catch { /* */ }
  })();

  try {
    await waitForGateway(port, 60_000);

    // Hit /health to grab the workerd pid + generation.
    const healthBefore = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${internalKey}` },
      cache: "no-store",
    });
    const beforeBody = await healthBefore.json() as {
      workerd?: { pid: number | null; generation: number; recycles: number };
    };
    assert(beforeBody.workerd, "/health must include workerd block when backend is active");
    const pidBefore = beforeBody.workerd!.pid;
    const genBefore = beforeBody.workerd!.generation;
    assert(pidBefore !== null && pidBefore > 0, "expected a live workerd pid");
    assertEquals(genBefore, 0, "fresh boot should be at generation 0");

    // Sanity: /hello works.
    const helloBefore = await fetch(`http://127.0.0.1:${port}/functions/v1/hello`, { cache: "no-store" });
    assertEquals(helloBefore.status, 200);
    await helloBefore.body?.cancel();

    // Kill workerd. On Windows, Deno only allows signalling its own
    // direct children; the workerd subprocess is a grandchild so we
    // shell out to taskkill.
    if (Deno.build.os === "windows") {
      const kill = new Deno.Command("taskkill", {
        args: ["/F", "/PID", String(pidBefore)],
        stdout: "null",
        stderr: "null",
      });
      const out = await kill.output();
      assert(out.success, `taskkill failed for pid ${pidBefore}`);
    } else {
      // Unix: SIGKILL bypasses any graceful-shutdown logic so the
      // backend definitively observes an unexpected exit.
      Deno.kill(pidBefore, "SIGKILL");
    }

    // Poll /health until generation increments AND pid is live again.
    // 30s budget covers re-bundle + new workerd cold start.
    const deadline = performance.now() + 30_000;
    let recovered = false;
    while (performance.now() < deadline) {
      const r = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${internalKey}` },
        cache: "no-store",
      });
      const body = await r.json() as {
        workerd?: { pid: number | null; generation: number };
      };
      if (
        body.workerd &&
        body.workerd.generation > genBefore &&
        body.workerd.pid !== null &&
        body.workerd.pid !== pidBefore
      ) {
        recovered = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert(recovered, "expected workerd backend to auto-recover after SIGKILL within 30s");

    // Final sanity: /hello must serve again post-recovery, proving
    // routes were re-bridged through the new workerd's port.
    const helloAfter = await fetch(`http://127.0.0.1:${port}/functions/v1/hello`, { cache: "no-store" });
    assertEquals(helloAfter.status, 200);
    const afterBody = await helloAfter.json();
    assertEquals(afterBody.message, "hello, hello");

    // ---- M6: /health workerd block reports new fields ------------------
    // last_reload_duration_ms must be a positive number (the recovery
    // reload is what populated it) and bundle_bytes must contain the
    // single function we restricted the backend to.
    const healthAfter = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: `Bearer ${internalKey}` },
      cache: "no-store",
    });
    const healthAfterBody = await healthAfter.json() as {
      workerd?: {
        pid: number | null;
        generation: number;
        last_reload_duration_ms: number | null;
        bundle_bytes: Record<string, number>;
      };
    };
    assert(healthAfterBody.workerd, "expected workerd block on /health");
    assert(
      typeof healthAfterBody.workerd!.last_reload_duration_ms === "number" &&
        healthAfterBody.workerd!.last_reload_duration_ms! > 0,
      `expected last_reload_duration_ms > 0, got ${healthAfterBody.workerd!.last_reload_duration_ms}`,
    );
    assert(
      typeof healthAfterBody.workerd!.bundle_bytes.hello === "number" &&
        healthAfterBody.workerd!.bundle_bytes.hello > 0,
      `expected bundle_bytes.hello > 0, got ${JSON.stringify(healthAfterBody.workerd!.bundle_bytes)}`,
    );

    // ---- M6: /metrics surfaces workerd_ + breaker_ gauges -------------
    // The crash-recovery flow has bumped the generation counter
    // exactly once, so the gauge value is observable without flakiness.
    const metricsRes = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { Authorization: `Bearer ${internalKey}` },
      cache: "no-store",
    });
    assertEquals(metricsRes.status, 200);
    const metricsText = await metricsRes.text();
    assert(
      /^onetube_workerd_up 1$/m.test(metricsText),
      `expected onetube_workerd_up 1 in /metrics output; got:\n${metricsText.slice(0, 500)}`,
    );
    assert(
      /^onetube_workerd_generation \d+$/m.test(metricsText),
      "expected onetube_workerd_generation gauge",
    );
    assert(
      /^onetube_workerd_last_reload_duration_ms [\d.]+$/m.test(metricsText),
      "expected onetube_workerd_last_reload_duration_ms gauge",
    );
    assert(
      /^onetube_workerd_bundle_bytes\{function="hello"\} \d+$/m.test(metricsText),
      "expected onetube_workerd_bundle_bytes{function=\"hello\"} gauge",
    );
  } finally {
    try { child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM"); } catch { /* */ }
    try {
      await Promise.race([
        child.status,
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } catch { /* */ }
    try { child.kill("SIGKILL"); } catch { /* */ }
    await teePump.catch(() => {});
    await stdoutPump.catch(() => {});
  }
});
