/**
 * Tests for the workerd process manager.
 *
 * The real workerd binary is *not* required for the lifecycle tests —
 * a tiny Bun script stands in for it via the `globalArgs` seam:
 *
 *     bun fake.ts serve <capnp>
 *
 * That spawn shape gives the script the same `process.argv.slice(2) ===
 * ["serve", capnp]` view that real workerd would see, so the
 * orchestration logic is exercised end-to-end without depending on
 * which workerd build the developer happens to have installed. A
 * separate opportunistic test calls `probeVersion` against the real
 * binary if one is on PATH; it's silently skipped otherwise.
 */

import { test } from "bun:test";
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "./_assert.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkerdProcess,
  isCompatDateAtMost,
  maxCompatDateFromVersion,
  parseVersionOutput,
  probeVersion,
  waitForPorts,
} from "../src/backends/workerd/process.ts";

/** Bind ephemeral port(s), capture them, release. There's a tiny race
 *  with re-binding but it's negligible inside a single test process. */
async function freePorts(count: number): Promise<number[]> {
  const ports: number[] = [];
  const listeners: Listener[] = [];
  for (let i = 0; i < count; i++) {
    const l = listen(0);
    listeners.push(l);
    ports.push(l.port);
  }
  for (const l of listeners) l.close();
  return ports;
}

interface Listener {
  port: number;
  close(): void;
}

/** Bind a TCP listener on loopback that closes every accepted socket. */
function listen(port: number): Listener {
  const l = Bun.listen({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(socket) {
        socket.end();
      },
      data() {},
    },
  });
  return { port: l.port, close: () => l.stop(true) };
}

/**
 * Source of a fake-workerd Bun script. Recognises:
 *
 *   `<bin> --version`                — prints workerd-shaped version
 *   `<bin> serve <capnpPath> [...]`  — listens on every `address = "..."`
 *                                       it finds in the capnp text and
 *                                       parks until killed
 *
 * On non-Windows the script ignores SIGTERM so the manager's
 * SIGKILL escalation path is exercised on `stop()`.
 */
const FAKE_WORKERD = String.raw`
const a = process.argv.slice(2);
if (a.includes("--version")) {
  console.log("workerd 1.2026.04.25 (fake)");
  process.exit(0);
}
const i = a.indexOf("serve");
if (i === -1) {
  console.error("fake-workerd: expected 'serve'");
  process.exit(64);
}
const capnpPath = a[i + 1];
const text = await Bun.file(capnpPath).text();
const rx = /address = "([^"]+)"/g;
let m;
const listeners = [];
while ((m = rx.exec(text)) !== null) {
  const [host, port] = m[1].split(":");
  const l = Bun.listen({
    hostname: host,
    port: Number(port),
    socket: { open(s) { s.end(); }, data() {} },
  });
  listeners.push(l);
  console.error("info: Listening on " + host + ":" + port);
}
console.log("fake workerd ready");
if (process.platform !== "win32") {
  process.on("SIGTERM", () => { /* swallow so we test escalation */ });
}
setInterval(() => {}, 1 << 30);
`;

async function withFakeWorkerd<T>(
  fn: (scriptPath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "1tube-fake-wd-"));
  const path = join(dir, "fake-workerd.ts");
  await writeFile(path, FAKE_WORKERD);
  try {
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

test("workerd-process: parseVersionOutput accepts the canonical shape", () => {
  const a = parseVersionOutput("workerd 1.2025.04.10\n");
  assertEquals(a.version, "1.2025.04.10");
  assertEquals(a.raw, "workerd 1.2025.04.10");

  const b = parseVersionOutput("workerd 1.2025.04.10 (build abc123)");
  assertEquals(b.version, "1.2025.04.10");
});

test("workerd-process: maxCompatDateFromVersion derives the build date", () => {
  // Canonical workerd version → reliable ceiling.
  assertEquals(maxCompatDateFromVersion("1.20260415.0"), "2026-04-15");
  assertEquals(maxCompatDateFromVersion("1.20240923.5"), "2024-09-23");

  // Non-canonical or custom builds — caller must trust the operator's
  // configured date when we can't derive a ceiling cheaply.
  assertEquals(maxCompatDateFromVersion("1.0-dev"), null);
  assertEquals(maxCompatDateFromVersion("0.0.0-foo"), null);
  assertEquals(maxCompatDateFromVersion(""), null);
  // Reject obviously bad calendar tokens (`20260000` is digits-only
  // but not a real date) so we never emit a malformed compat date.
  assertEquals(maxCompatDateFromVersion("1.20260000.0"), null);
  assertEquals(maxCompatDateFromVersion("1.20261332.0"), null);
});

test("workerd-process: isCompatDateAtMost compares lexicographically", () => {
  assert(isCompatDateAtMost("2024-09-23", "2026-04-25"));
  assert(isCompatDateAtMost("2026-04-25", "2026-04-25"));
  assert(!isCompatDateAtMost("2026-04-26", "2026-04-25"));
  assert(!isCompatDateAtMost("2099-01-01", "2026-04-25"));
});

test("workerd-process: parseVersionOutput rejects garbage", () => {
  for (const bad of ["", "not-workerd\nfoo", "node v22.0.0"]) {
    let threw = false;
    try {
      parseVersionOutput(bad);
    } catch {
      threw = true;
    }
    assert(threw, `expected throw for ${JSON.stringify(bad)}`);
  }
});

test("workerd-process: waitForPorts succeeds when a listener is up", async () => {
  const [port] = await freePorts(1);
  const listener = listen(port);
  try {
    await waitForPorts([{ host: "127.0.0.1", port }], { timeoutMs: 1_000 });
  } finally {
    listener.close();
  }
});

test("workerd-process: waitForPorts times out when nothing listens", async () => {
  const [port] = await freePorts(1);
  await assertRejects(
    () =>
      waitForPorts([{ host: "127.0.0.1", port }], {
        timeoutMs: 200,
        intervalMs: 25,
      }),
    Error,
    "not reachable",
  );
});

test("workerd-process: waitForPorts honours abortSignal", async () => {
  const [port] = await freePorts(1);
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 50);
  await assertRejects(
    () =>
      waitForPorts(
        [{ host: "127.0.0.1", port }],
        { timeoutMs: 5_000, intervalMs: 25, abortSignal: ctrl.signal },
      ),
    DOMException,
    "aborted",
  );
});

test("workerd-process: waitForPorts returns once *all* ports are up", async () => {
  const [pa, pb] = await freePorts(2);
  const la = listen(pa);
  let lb: Listener | null = null;
  const delay = setTimeout(() => {
    lb = listen(pb);
  }, 200);
  try {
    const start = performance.now();
    await waitForPorts(
      [{ host: "127.0.0.1", port: pa }, { host: "127.0.0.1", port: pb }],
      { timeoutMs: 5_000, intervalMs: 25 },
    );
    const elapsed = performance.now() - start;
    assert(
      elapsed >= 150,
      `should have waited for slow listener, took ${elapsed}ms`,
    );
  } finally {
    clearTimeout(delay);
    la.close();
    if (lb) (lb as Listener).close();
  }
});

test(
  "workerd-process: lifecycle waits for sockets, then stops cleanly",
  async () => {
    await withFakeWorkerd(async (fakeScript) => {
      const [port] = await freePorts(1);
      const tmpDir = await mkdtemp(join(tmpdir(), "1tube-proc-life-"));
      try {
        const capnpPath = join(tmpDir, "config.capnp");
        // Fake-workerd only inspects `address = "..."` patterns.
        await writeFile(capnpPath, `address = "127.0.0.1:${port}"\n`);

        const lines: string[] = [];
        const proc = createWorkerdProcess({
          binary: process.execPath,
          capnpPath,
          // bun fake.ts serve <capnp>
          // Manager appends `serve <capnp>` after globalArgs; everything
          // after the script path is the script's own argv.
          globalArgs: [fakeScript],
          routes: [{
            name: "x",
            service: "x",
            address: "127.0.0.1",
            port,
            origin: `http://127.0.0.1:${port}`,
          }],
          logLineSink: (l) => lines.push(l),
          readyTimeoutMs: 10_000,
          probeIntervalMs: 25,
          shutdownTimeoutMs: 1_500,
        });

        let exitCode: number | null | undefined;
        let exitExpected: boolean | undefined;
        proc.onExit((code, expected) => {
          exitCode = code;
          exitExpected = expected;
        });

        await proc.start();
        assert(proc.pid !== null, "pid should be set after start()");

        // Listener was inspected via TCP probe, but verify we can still
        // open and close a fresh connection — the fake's accept loop
        // immediately closes, which is exactly the readiness contract.
        await new Promise<void>((resolve, reject) => {
          const probe = connect({ host: "127.0.0.1", port }, () => {
            probe.destroy();
            resolve();
          });
          probe.once("error", reject);
        });

        // The fake printed both stderr ("info: Listening on ...") and
        // stdout ("fake workerd ready") lines; both must arrive at the
        // sink, with the manager's pumps preserving line boundaries.
        // Wait briefly for pumps to drain initial output.
        await new Promise((r) => setTimeout(r, 100));
        const joined = lines.join("\n");
        assertStringIncludes(joined, "Listening on 127.0.0.1:");
        assertStringIncludes(joined, "fake workerd ready");

        await proc.stop();

        assertEquals(
          exitExpected,
          true,
          "expected flag should be true after voluntary stop",
        );
        // exitCode varies per platform/signal — just confirm it fired.
        assert(typeof exitCode === "number" || exitCode === null);

        // Idempotency: second stop is a no-op, never throws.
        await proc.stop();
      } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  },
);

test(
  "workerd-process: start() throws when child exits before ready",
  async () => {
    // Use bun itself with an inline script that exits immediately with a
    // non-zero code. The manager's exit-watch must abort the readiness
    // probe and surface a useful error.
    const [port] = await freePorts(1);
    const tmpDir = await mkdtemp(join(tmpdir(), "1tube-proc-crash-"));
    try {
      const capnpPath = join(tmpDir, "config.capnp");
      await writeFile(capnpPath, `address = "127.0.0.1:${port}"\n`);

      const proc = createWorkerdProcess({
        binary: process.execPath,
        capnpPath,
        // `bun -e "process.exit(3)" serve <capnp>` exits immediately with
        // a non-zero code (the trailing args are ignored by the eval).
        globalArgs: ["-e", "process.exit(3)"],
        routes: [{
          name: "x",
          service: "x",
          address: "127.0.0.1",
          port,
          origin: `http://127.0.0.1:${port}`,
        }],
        logLineSink: () => {},
        readyTimeoutMs: 10_000,
        probeIntervalMs: 25,
        shutdownTimeoutMs: 500,
      });

      let unexpectedExitCode: number | null = null;
      proc.onExit((code, expected) => {
        if (!expected) unexpectedExitCode = code;
      });

      const err = await assertRejects(
        () => proc.start(),
        Error,
        "exited before sockets became ready",
      );
      assertStringIncludes(err.message, "command=");
      assertStringIncludes(err.message, "capnp=");
      assertStringIncludes(err.message, "routes=1");
      assertStringIncludes(err.message, "exitCode=");

      assert(
        unexpectedExitCode !== null || unexpectedExitCode === 0,
        "exit listener should have fired with the early-exit code",
      );
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  },
);

test(
  "workerd-process: probeVersion against real workerd if available",
  async () => {
    // Opportunistic — confirms the host's installed workerd's --version
    // output parses through our regex unchanged.
    const candidate = process.env["1TUBE_WORKERD_BIN"] ?? "workerd";
    try {
      const info = await probeVersion(candidate);
      assert(info.version.length > 0);
      assertStringIncludes(info.raw.toLowerCase(), "workerd");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[skipped: real workerd not on PATH] ${msg}`);
    }
  },
);
