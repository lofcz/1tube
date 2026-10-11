/**
 * Tests for the prod-mode bootstrap guard in src/server.ts.
 *
 * We can't import server.ts directly (it would bind a port), so each case
 * spawns `bun` against a tiny driver script that re-uses the gateway's
 * `enforceProdSecrets` / `applyDevDefaults` logic by importing only the
 * bootstrap-affecting bits. Since those helpers are inlined inside server.ts
 * we instead spawn the real server with a deliberately-bad secret + an
 * unused port and assert the process exits with code 1 before binding.
 *
 * The server prints to stderr and calls process.exit(1) before reaching the
 * Bun.serve() call, so we never actually open a socket.
 */

import { test } from "bun:test";
import { assert, assertEquals } from "./_assert.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "src",
  "server.ts",
);

/**
 * `bun <server.ts>` argv prefix. `--no-env-file` keeps Bun from auto-loading
 * a `.env` in the cwd, so only the env we pass reaches the guard (Deno never
 * auto-loaded one either).
 */
const BUN_ARGS = [process.execPath, "--no-env-file", SERVER];

/** Parent env + overrides, like Deno.Command's default (non-clearEnv) merge. */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return { ...env, ...overrides };
}
const LEAKED_JWT = "super-secret-jwt-token-with-at-least-32-characters-long";
const LEAKED_SR =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

async function runServer(
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number; stderr: string; stdout: string }> {
  // We pass a closed-on-purpose port (0) and a non-existent functions dir; the
  // guard runs before either is touched in the failure cases. For the
  // "should run" sanity check, we still time out within a few hundred ms so
  // the test doesn't hang.
  // Once past the secret guard the gateway opens its invocation-log DB
  // (default `<cwd>/.1tube/logs.db`) before failing on the functions dir;
  // point it at a throwaway dir so test runs don't litter the cwd.
  const logDir = await mkdtemp(join(tmpdir(), "1tube-dev-guard-logs-"));
  const child = Bun.spawn([...BUN_ARGS, ...args], {
    env: childEnv({
      "1TUBE_LOG_DB": join(logDir, "logs.db"),
      // Strip inherited 1TUBE_* / SUPABASE_* so the parent env doesn't bleed
      // through. Setting to "" still counts as "set" in some shells, so we
      // explicitly override the keys the guard inspects.
      "1TUBE_DEV": "",
      JWT_SECRET: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_URL: "",
      ...env,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, 5000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  await rm(logDir, { recursive: true, force: true });
  return { code, stdout, stderr };
}

test("dev-guard: prod start without JWT_SECRET exits 1 before binding", async () => {
  const { code, stderr } = await runServer({});
  assert(code !== 0, `expected non-zero exit, got ${code}\n${stderr}`);
  assert(
    stderr.includes("FATAL") && stderr.toLowerCase().includes("not set"),
    `expected fatal-not-set message, got: ${stderr}`,
  );
});

test("dev-guard: prod start allows local default JWT_SECRET", async () => {
  const { code, stderr } = await runServer({
    JWT_SECRET: LEAKED_JWT,
    SUPABASE_SERVICE_ROLE_KEY: "anything-not-the-leaked-one-here-please",
  });
  assert(code !== 0, `expected non-zero exit, got ${code}\n${stderr}`);
  assert(
    stderr.includes("functions directory not found"),
    `expected startup to proceed past secret guard and fail on missing functions dir, got: ${stderr}`,
  );
  assert(
    !stderr.includes("well-known dev default"),
    `local Supabase default should no longer be rejected, got: ${stderr}`,
  );
});

test("dev-guard: prod start ignores local default SUPABASE_SERVICE_ROLE_KEY", async () => {
  const { code, stderr } = await runServer({
    JWT_SECRET: "a-fresh-and-long-enough-jwt-secret-not-the-default",
    SUPABASE_SERVICE_ROLE_KEY: LEAKED_SR,
  });
  assert(code !== 0, `expected non-zero exit, got ${code}\n${stderr}`);
  assert(
    stderr.includes("functions directory not found"),
    `expected startup to proceed past secret guard and fail on missing functions dir, got: ${stderr}`,
  );
  assert(
    !stderr.includes("well-known dev default"),
    `local Supabase service key should no longer be rejected, got: ${stderr}`,
  );
});

test("dev-guard: --dev mode boots even without secrets (applies dev defaults)", async () => {
  // Use a bogus functions dir + ephemeral port; the boot still proceeds past
  // the guard, and we kill it once it starts serving. We assert the dev-defaults log
  // appeared and the process did NOT exit with the guard's code 1.
  // Provide anon/service keys so this case does not depend on a live local
  // Supabase stack (or wait on status retries).
  const tmp = await mkdtemp(join(tmpdir(), "1tube-dev-guard-"));
  try {
    const child = Bun.spawn(
      [
        ...BUN_ARGS,
        "--dev",
        "--port",
        "0",
        "--functions",
        tmp,
        "--host",
        "127.0.0.1",
      ],
      {
        env: childEnv({
          "1TUBE_DEV": "",
          "1TUBE_DEV_SKIP_SUPABASE_STATUS": "1",
          // Keep the invocation-log DB in the temp dir instead of
          // `<cwd>/.1tube/logs.db`.
          "1TUBE_LOG_DB": join(tmp, "logs.db"),
          JWT_SECRET: "",
          SUPABASE_ANON_KEY: "test-anon-key",
          SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key",
        }),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let stdout = "";
    let stderr = "";
    const drain = async (
      stream: ReadableStream<Uint8Array>,
      append: (s: string) => void,
    ) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) append(dec.decode(chunk, { stream: true }));
    };
    const drained = Promise.all([
      drain(child.stdout, (s) => (stdout += s)),
      drain(child.stderr, (s) => (stderr += s)),
    ]);
    // Give the gateway time to apply dev defaults and start serving before we
    // terminate it: wait until it reports it is starting (i.e. it got past
    // the guard), it exits on its own, or 10s elapse.
    const deadline = Date.now() + 10000;
    while (
      Date.now() < deadline &&
      child.exitCode === null &&
      !(stdout + stderr).includes("Starting on")
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // Small grace window so a late FATAL after binding would still be seen.
    await new Promise((r) => setTimeout(r, 500));
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    await child.exited;
    await drained;
    const combined = stdout + "\n" + stderr;
    assert(
      combined.includes("Applied") && combined.includes("dev default"),
      `expected dev defaults log, got:\n${combined}`,
    );
    // The guard would have produced a "FATAL" line; in dev mode we must not.
    assert(
      !combined.includes("FATAL"),
      `dev mode should not emit FATAL, got:\n${combined}`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test("dev-guard: --dev mode fatals cleanly when anon/service keys stay unresolved", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "1tube-dev-guard-"));
  try {
    const { code, stderr, stdout } = await runServer(
      {
        "1TUBE_DEV": "",
        "1TUBE_DEV_SKIP_SUPABASE_STATUS": "1",
        "1TUBE_DEV_STATUS_ATTEMPTS": "1",
        JWT_SECRET: "",
        SUPABASE_ANON_KEY: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
        SUPABASE_PUBLISHABLE_KEY: "",
        SUPABASE_SECRET_KEY: "",
        VITE_SUPABASE_PUBLISHABLE_KEY: "",
      },
      [
        "--dev",
        "--port",
        "0",
        "--functions",
        tmp,
        "--host",
        "127.0.0.1",
      ],
    );
    const combined = `${stdout}\n${stderr}`;
    assertEquals(code, 78, `expected CONFIG exit 78, got ${code}\n${combined}`);
    assert(
      combined.includes("FATAL") &&
        combined.includes("SUPABASE_ANON_KEY") &&
        combined.includes("could not resolve"),
      `expected clean missing-key FATAL, got:\n${combined}`,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
