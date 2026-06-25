/**
 * Tests for the prod-mode bootstrap guard in src/server.ts.
 *
 * We can't import server.ts directly (it would bind a port), so each case
 * spawns `deno run` against a tiny driver script that re-uses the gateway's
 * `enforceProdSecrets` / `applyDevDefaults` logic by importing only the
 * bootstrap-affecting bits. Since those helpers are inlined inside server.ts
 * we instead spawn the real server with a deliberately-bad secret + an
 * unused port and assert the process exits with code 1 before binding.
 *
 * The server prints to stderr and calls Deno.exit(1) before reaching the
 * Deno.serve() call, so we never actually open a socket.
 */

import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

const SERVER = join(
  fromFileUrl(new URL(".", import.meta.url)),
  "..",
  "src",
  "server.ts",
);
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
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-all", SERVER, ...args],
    env: {
      // Strip inherited 1TUBE_* / SUPABASE_* so the parent env doesn't bleed
      // through. Setting to "" still counts as "set" in some shells, so we
      // explicitly override the keys the guard inspects.
      "1TUBE_DEV": "",
      JWT_SECRET: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      SUPABASE_URL: "",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const child = cmd.spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }, 5000);
  const output = await child.output();
  clearTimeout(timer);
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test({
  name: "dev-guard: prod start without JWT_SECRET exits 1 before binding",
  // We need subprocess + net + read; --allow-all on the spawned process is
  // fine, but the test itself only needs run+read.
  permissions: { run: true, read: true, env: true },
}, async () => {
  const { code, stderr } = await runServer({});
  assert(code !== 0, `expected non-zero exit, got ${code}\n${stderr}`);
  assert(
    stderr.includes("FATAL") && stderr.toLowerCase().includes("not set"),
    `expected fatal-not-set message, got: ${stderr}`,
  );
});

Deno.test({
  name: "dev-guard: prod start allows local default JWT_SECRET",
  permissions: { run: true, read: true, env: true },
}, async () => {
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

Deno.test({
  name: "dev-guard: prod start ignores local default SUPABASE_SERVICE_ROLE_KEY",
  permissions: { run: true, read: true, env: true },
}, async () => {
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

Deno.test({
  name:
    "dev-guard: --dev mode boots even without secrets (applies dev defaults)",
  permissions: { run: true, read: true, write: true, env: true },
}, async () => {
  // Use a bogus functions dir + ephemeral port; the boot still proceeds past
  // the guard, and we kill it after 1.5s. We assert the dev-defaults log
  // appeared and the process did NOT exit with the guard's code 1.
  const tmp = await Deno.makeTempDir();
  try {
    const cmd = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        SERVER,
        "--dev",
        "--port",
        "0",
        "--functions",
        tmp,
        "--host",
        "127.0.0.1",
      ],
      env: {
        "1TUBE_DEV": "",
        JWT_SECRET: "",
        SUPABASE_SERVICE_ROLE_KEY: "",
      },
      stdout: "piped",
      stderr: "piped",
    });
    const child = cmd.spawn();
    // Give cold Deno runs enough time to type-check imports (incl. the
    // deno_graph WASM module), apply dev defaults, and start serving
    // before we terminate the child.
    await new Promise((r) => setTimeout(r, 10000));
    try {
      child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
    const out = await child.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);
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
    await Deno.remove(tmp, { recursive: true });
  }
});
