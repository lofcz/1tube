/**
 * Workerd-vs-Deno backend benchmark.
 *
 * Boots a `1tube` gateway with each backend (one at a time, sequentially)
 * and hammers `/functions/v1/hello` (GET, cheap) and `/functions/v1/echo`
 * (POST with JSON body, exercises the proxy more). Reports p50/p95/p99
 * + RPS for each (backend, route) pair so the operator has concrete
 * numbers when deciding whether the workerd backend is fast enough for
 * their workload.
 *
 * Usage:
 *   deno run --allow-all scripts/bench.ts                   # default 5000 reqs, 64 concurrency
 *   deno run --allow-all scripts/bench.ts -n 20000 -c 128   # heavier sweep
 *   deno run --allow-all scripts/bench.ts --backend workerd # single backend
 *
 * Notes on methodology:
 *   - Each backend gets a fresh gateway (workerd backend pre-bundles on
 *     boot, so the first sweep already runs against warm bundles).
 *   - 200 warmup requests run before timing starts to avoid measuring
 *     V8 JIT warmup or first-request connection setup.
 *   - Concurrency is enforced by a fixed worker pool that pulls from a
 *     shared counter — closed-loop, not Poisson — which is the simplest
 *     way to get stable RPS for a single-host comparison.
 *   - This script intentionally does NOT call out to wrk/oha/k6 because
 *     adding a binary dep would defeat the "deno run and go" UX. For
 *     formal benchmarking against external clients, use those tools.
 */

import { dirname, join, resolve as resolvePath } from "node:path";
import { fromFileUrl } from "jsr:@std/path@^1/from-file-url";

const SCRIPT_DIR = resolvePath(dirname(fromFileUrl(import.meta.url)), "..");

interface BenchOpts {
  total: number;
  concurrency: number;
  backends: ("deno" | "workerd")[];
  warmup: number;
}

function parseArgs(): BenchOpts {
  const args = Deno.args;
  let total = 5000;
  let concurrency = 64;
  let backends: ("deno" | "workerd")[] = ["deno", "workerd"];
  let warmup = 200;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-n" || a === "--total") && args[i + 1]) total = parseInt(args[++i], 10);
    else if ((a === "-c" || a === "--concurrency") && args[i + 1]) concurrency = parseInt(args[++i], 10);
    else if (a === "--warmup" && args[i + 1]) warmup = parseInt(args[++i], 10);
    else if (a === "--backend" && args[i + 1]) {
      const v = args[++i];
      if (v !== "deno" && v !== "workerd") {
        console.error(`--backend must be 'deno' or 'workerd'`);
        Deno.exit(2);
      }
      backends = [v];
    }
  }
  return { total, concurrency, backends, warmup };
}

async function freePort(): Promise<number> {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitForGateway(port: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { cache: "no-store" });
      await res.body?.cancel();
      if (res.status > 0) return;
    } catch {
      // not yet listening
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`gateway on :${port} did not become ready within ${timeoutMs}ms`);
}

interface RunResult {
  /** Latency samples in milliseconds, in completion order. */
  samples: number[];
  /** Number of non-2xx responses (counted but not timed). */
  errors: number;
  /** Wall-clock duration of the timed portion in ms. */
  durationMs: number;
  /** First non-2xx status seen, for diagnostics. */
  firstBadStatus: number | null;
}

async function runOne(
  url: string,
  init: RequestInit,
  total: number,
  concurrency: number,
): Promise<RunResult> {
  const samples = new Array<number>(total);
  let errors = 0;
  let firstBadStatus: number | null = null;
  let next = 0;
  const start = performance.now();

  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const t0 = performance.now();
      try {
        const res = await fetch(url, init);
        // Drain so the connection can be reused (Deno's fetch reuses
        // the underlying connection only when the body is consumed).
        await res.arrayBuffer();
        if (res.status >= 400 || res.status === 0) {
          errors++;
          if (firstBadStatus === null) firstBadStatus = res.status;
        }
      } catch {
        errors++;
        if (firstBadStatus === null) firstBadStatus = -1;
      }
      samples[i] = performance.now() - t0;
    }
  });
  await Promise.all(workers);

  return { samples, errors, durationMs: performance.now() - start, firstBadStatus };
}

function pct(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  // `samples` is in completion order; sort a *copy* so we don't perturb
  // any caller that wanted the original order for charting later.
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank percentile — same definition wrk and oha use, which
  // makes our output directly comparable to those tools' reports.
  const rank = Math.min(sorted.length - 1, Math.ceil((q / 100) * sorted.length) - 1);
  return sorted[Math.max(0, rank)];
}

function fmtMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  return `${ms.toFixed(1)}ms`;
}

async function spawnGateway(
  backend: "deno" | "workerd",
  port: number,
): Promise<{ child: Deno.ChildProcess; teardown: () => Promise<void> }> {
  const playgroundDir = join(SCRIPT_DIR, "playground");
  const args = [
    "run",
    "--quiet",
    "--allow-all",
    "src/server.ts",
    "--backend",
    backend,
    "--functions",
    playgroundDir,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    "--dev",
  ];
  const child = new Deno.Command(Deno.execPath(), {
    args,
    cwd: SCRIPT_DIR,
    env: {
      ...Deno.env.toObject(),
      "1TUBE_HMR": "0",
      "1TUBE_LAZY": "0",
      // The gateway's default rate limit (120 rpm = 2 rps) is meant
      // for the public internet, not a closed-loop loopback bench.
      // Crank it to ~1M rpm so the limiter never trips and we measure
      // the actual proxy cost. Operators benchmarking *with* rate
      // limiting in scope can override via 1TUBE_DEFAULT_RPM directly.
      // Disable rate-limit entirely so per-function manifest caps
      // (e.g. hello's rpm=60) don't ruin the timing data. The
      // gateway prints a clear warning at boot when this is on.
      "1TUBE_DISABLE_RATE_LIMIT": "1",
      // Bench output is the deliverable; silence the gateway's own
      // boot table to keep the report uncluttered. Boot logs still
      // reach stderr for debugging if needed.
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();

  // Drain stdout/stderr so the child doesn't block on backpressure.
  // Stderr is the gateway's banner + warnings (we want to see them
  // when something is misconfigured), stdout is mostly noise so we
  // discard it silently.
  const dec = new TextDecoder();
  const drainErr = (async () => {
    const reader = child.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value);
        // Surface only the lines an operator would care about — the
        // gateway prints `[1tube]` banners + workerd's own logs.
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          if (line.includes("[1tube]") || line.includes("[workerd]") || line.includes("[rate-debug]")) {
            console.log(`   ⏵ ${line}`);
          }
        }
      }
    } catch { /* */ }
  })();
  const drainOut = (async () => {
    const reader = child.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value);
        for (const line of text.split(/\r?\n/)) {
          if (!line) continue;
          if (line.includes("[1tube]") || line.includes("[workerd]") || line.includes("[rate-debug]")) {
            console.log(`   ⏵ ${line}`);
          }
        }
      }
    } catch { /* */ }
  })();
  const drain = Promise.all([drainErr, drainOut]);

  const teardown = async () => {
    try { child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM"); } catch { /* */ }
    try {
      await Promise.race([
        child.status,
        new Promise((r) => setTimeout(r, 5_000)),
      ]);
    } catch { /* */ }
    try { child.kill("SIGKILL"); } catch { /* */ }
    await drain.catch(() => {});
  };

  return { child, teardown };
}

interface RouteSpec {
  label: string;
  build(port: number): { url: string; init: RequestInit };
}

const ROUTES: RouteSpec[] = [
  {
    label: "GET  /functions/v1/hello",
    build(port) {
      return {
        url: `http://127.0.0.1:${port}/functions/v1/hello`,
        init: { method: "GET", cache: "no-store" },
      };
    },
  },
  {
    label: "POST /functions/v1/echo  (256B body)",
    build(port) {
      // A small but realistic body — sciobot-next's chat endpoints
      // typically post sub-KB JSON envelopes.
      const body = JSON.stringify({
        msg: "x".repeat(200),
        ts: Date.now(),
        n: 1,
      });
      return {
        url: `http://127.0.0.1:${port}/functions/v1/echo`,
        init: {
          method: "POST",
          cache: "no-store",
          headers: { "content-type": "application/json" },
          body,
        },
      };
    },
  },
];

async function benchBackend(
  backend: "deno" | "workerd",
  opts: BenchOpts,
): Promise<void> {
  const port = await freePort();
  console.log(`\n=== ${backend.toUpperCase()} backend ===`);
  console.log(`spawning gateway on :${port}...`);
  const { teardown } = await spawnGateway(backend, port);
  try {
    // Workerd needs longer to boot because it bundles every fixture.
    await waitForGateway(port, backend === "workerd" ? 60_000 : 15_000);
    console.log(`ready · warmup=${opts.warmup} timed=${opts.total} concurrency=${opts.concurrency}`);

    for (const route of ROUTES) {
      const { url, init } = route.build(port);
      // Warmup — discarded.
      await runOne(url, init, opts.warmup, opts.concurrency);
      // Timed sweep.
      const r = await runOne(url, init, opts.total, opts.concurrency);
      const rps = (opts.total / (r.durationMs / 1000));
      console.log(
        `  ${route.label.padEnd(38)}  ` +
          `RPS ${rps.toFixed(0).padStart(6)}  ` +
          `p50 ${fmtMs(pct(r.samples, 50)).padStart(8)}  ` +
          `p95 ${fmtMs(pct(r.samples, 95)).padStart(8)}  ` +
          `p99 ${fmtMs(pct(r.samples, 99)).padStart(8)}  ` +
          `errors ${r.errors}${r.firstBadStatus !== null ? `(first=${r.firstBadStatus})` : ""}`,
      );
    }
  } finally {
    await teardown();
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  console.log(
    `# 1tube backend bench · total=${opts.total} concurrency=${opts.concurrency} ` +
      `warmup=${opts.warmup} backends=${opts.backends.join(",")}`,
  );
  for (const backend of opts.backends) {
    await benchBackend(backend, opts);
  }
}

if (import.meta.main) {
  await main();
}
