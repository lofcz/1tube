![NPM Version](https://img.shields.io/npm/v/1tube)
![NuGet Version](https://img.shields.io/nuget/v/OneTube?v=2&icon=nuget)

# 1tube

Self-hosted Supabase Edge Functions gateway. Runs your Deno edge functions
locally or behind a .NET host with zero-copy YARP proxying — no cold starts, no
version lock, no Supabase compute dependency.

## How it works

1tube discovers edge function modules from a `supabase/functions/` directory and
hosts them in a single Deno HTTP server. Each function's `serve()` call
registers a handler in a global registry instead of starting a separate
`Deno.serve()`. The gateway then routes requests, handles JWT auth, CORS, rate
limiting, and structured logging.

Individual edge functions require **zero changes** — only the shared
`_shared/handler.ts` wrapper needs a small shim (4 lines) to detect the 1tube
registry.

## Quick start (local dev)

```bash
# Install dependencies
bun install

# Copy and fill in env vars
cp .env.example .env

# Start with auto-restart on file changes
bun run dev -- --functions ../sciobot-next/supabase/functions
```

The gateway starts on `http://localhost:3100`. Functions are available at
`http://localhost:3100/functions/v1/<name>`.

In dev mode, 1tube also watches the functions directory and reloads handlers
in-process on filesystem changes (including newly created function folders).

## npm CLI

The published npm package exposes a `1tube` binary. It is a tiny Node shim that
launches this repo's Deno CLI, so machines using it need Deno on `PATH`.

```bash
# Build and sign a firmware payload in one command
npx 1tube package --functions supabase/functions --out fw.1tube --sign-key "$1TUBE_PACKAGE_SIGN_KEY"

# Keep/update the intermediate dist/ artifact as well
npx 1tube package --functions supabase/functions --in dist --out fw.1tube --sign-key "$1TUBE_PACKAGE_SIGN_KEY"
```

This replaces local-source invocations such as
`deno run -A ../1tube/src/cli.ts ...` in downstream CI pipelines.

### Deno npm lifecycle scripts

Deno does not run npm `postinstall` / build scripts unless you allow them.
`deno.lock` may still list transitive packages such as `protobufjs`; the `check`
script uses `--allow-scripts=npm:protobufjs` so `bun run check` / `npm publish`
(via `prepublishOnly`) stays warning-free. That script is only needed for
dependency install — **1tube’s runtime graph is just Hono + JSR std**.

## Endpoints

| Path                       | Description                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /`                    | Liveness probe (`{"status":"ok"}`) — intentionally minimal so unauthenticated callers don't see the function map.   |
| `POST /functions/v1/:name` | Invoke an edge function                                                                                             |
| `GET /health`              | Auth-gated health (`Authorization: Bearer $INTERNAL_KEY`); without auth returns the same minimal `{"status":"ok"}`. |
| `GET /metrics`             | Auth-gated Prometheus exposition (same scheme).                                                                     |

## Configuration

All knobs default to safe-but-backwards-compatible values. The TS gateway
(`src/server.ts`) reads:

| Env / flag                                                  | Default                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--port` / `PORT`                                           | `3100`                 | Listen port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--host` / `1TUBE_HOST`                                     | `127.0.0.1`            | Loopback by default — pass `--host 0.0.0.0` to expose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--functions` / `FUNCTIONS_PATH`                            | `./supabase/functions` | Functions root                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--timeout` / `FUNCTION_TIMEOUT_MS`                         | `150000`               | Per-request wall-clock cap (also overridable per function)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `--dev` / `1TUBE_DEV`                                       | off                    | Applies the well-known local Supabase JWT/secrets. **Refuses to start in prod when JWT_SECRET / SUPABASE_SERVICE_ROLE_KEY are missing or are the public dev defaults.**                                                                                                                                                                                                                                                                                                                                                          |
| `--hmr` / `1TUBE_HMR`                                       | off                    | File-watch + per-function reload (dev only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `1TUBE_BODY_LIMIT_MB`                                       | `30`                   | Hono `bodyLimit`; matches Supabase. Returns 413 before the handler runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `1TUBE_BODY_READ_MS`                                        | `30000`                | Slow-loris guard. Max idle gap (ms) between body chunks before the request is aborted with **408**. NOT a total body-read deadline — large but fast uploads pass through. Set `0` to disable.                                                                                                                                                                                                                                                                                                                                    |
| `1TUBE_CORS_ORIGIN`                                         | `*` (dev only)         | Comma-separated allowlist or `*`. In prod, leaving unset disables CORS.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `1TUBE_TRUSTED_PROXIES`                                     | empty                  | Comma-separated list of remote IPs whose `X-Forwarded-For` is honored. Anything else uses the raw socket address — XFF spoofing no longer mints fresh rate-limit buckets.                                                                                                                                                                                                                                                                                                                                                        |
| `1TUBE_SHUTDOWN_GRACE_MS`                                   | `10000`                | SIGINT/SIGTERM drain budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `INTERNAL_KEY`                                              | unset                  | Required to read detailed `/health` and `/metrics`. Header-only: `Authorization: Bearer $INTERNAL_KEY`.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `--backend` / `1TUBE_BACKEND`                               | `deno`                 | Function execution engine. `deno` (default) imports each function as a module in this process — same as 1tube has always done. `workerd` bundles each function and serves it from a Cloudflare-style workerd subprocess for hard isolation. See [Workerd backend](#workerd-backend) below.                                                                                                                                                                                                                                       |
| `--workerd-bin` / `1TUBE_WORKERD_BIN`                       | `workerd` (PATH)       | Path to the workerd binary. Only consulted with `--backend workerd`.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `--workerd-env` / `1TUBE_WORKERD_ENV`                       | unset (= forward all)  | Comma-separated allowlist of env var names to forward to bundled functions under `--backend workerd`. Each name reaches the bundle via `Deno.env.get(name)` and the worker's `env` binding. Values stay in the gateway's process env — they are NEVER written into `config.capnp`. **When unset (or `*`), every env var the gateway can see is forwarded** — bundled functions inherit their parent's environment like a regular `deno run` child. Pass an explicit list to narrow the surface for shared/multi-tenant workerds. |
| `--kill-stale-workerd` / `1TUBE_KILL_STALE_WORKERD`         | off                    | When the boot-time port preflight finds one of workerd's socket ports already busy, automatically run `taskkill /F /IM workerd.exe` (Windows) or `pkill -9 -x workerd` (Unix), wait briefly, and re-probe. Only ever targets processes named `workerd` — non-workerd processes holding the port still surface the normal preflight error. Off by default; recommended for dev where leftover workerds from prior runs are the common cause of flaky boots.                                                                       |
| `--inspector` / `--inspector-addr=ADDR` / `1TUBE_INSPECTOR` | off                    | Launch workerd with the V8 inspector bound to `ADDR` (default `127.0.0.1:9229` when `--inspector` has no value). Lets Chrome DevTools / Node-style debuggers attach for breakpoints inside bundled functions. **Local dev only** — opens an unauthenticated debug port. See [V8 inspector / debugger access](#v8-inspector--debugger-access) below.                                                                                                                                                                              |
| `1TUBE_SHUTDOWN_GRACE_MS`                                   | `10000`                | Total wall-clock budget (ms) for shutdown, split between (1) draining gateway in-flight requests and (2) tearing down the workerd subprocess. See [Graceful shutdown](#graceful-shutdown) below.                                                                                                                                                                                                                                                                                                                                 |
| `1TUBE_DEFAULT_RPM`                                         | `120`                  | Override the gateway-wide default rate limit (requests per minute, per IP, per function). Per-function `1tube.json#rpm` still wins.                                                                                                                                                                                                                                                                                                                                                                                              |
| `1TUBE_DISABLE_RATE_LIMIT`                                  | unset                  | Set to `1` to bypass rate limiting entirely. **Load-test / dev only** — production deployments must keep the limiter on. The gateway prints a clear warning at boot when this is enabled.                                                                                                                                                                                                                                                                                                                                        |

````
## Workerd backend

1tube can optionally run each function inside a [workerd](https://github.com/cloudflare/workerd) subprocess instead of importing it directly into the gateway. This gives:

- **Hard isolation** between functions and the gateway — a runaway function cannot wedge the gateway, leak memory into peer functions, or read peer functions' globals.
- **Cloudflare-Workers-style runtime** — `nodejs_compat`, `process.env`, `node:fs`/`node:os`/`node:http`, `AsyncLocalStorage`, the modern `fetch`/`Streams`/`URL` spec fixes, etc.
- **Zero changes to function code** — the same `serve(handler, { public: ... })` shim works on both backends. `Deno.env.get(...)` still works (we shim it onto the `env` binding). The bundler resolves `npm:`, `jsr:`, `https:`, and `file:` specifiers via Deno's own loader.

Per-function manifests, the circuit breaker, and per-function timeouts apply on the workerd path too — see [Per-function manifests](#per-function-manifests-on-workerd) below. Live HMR (`--hmr`) also works: a save triggers a re-bundle of just the changed function, a *new* workerd is spawned on shifted ports, the gateway atomically swaps to it, and the old workerd is torn down — all without dropping in-flight requests. See [HMR on workerd](#hmr-on-workerd) below for details and limits.

### Run it

```bash
# Make sure workerd is on PATH, or set 1TUBE_WORKERD_BIN.
workerd --version

# Boot 1tube with the workerd backend pointed at the playground.
deno run --allow-all src/server.ts \
  --backend workerd \
  --functions ./playground \
  --port 3100 \
  --dev
````

You should see something like:

```
[1tube] mode=dev hmr=off lazy=off backend=workerd ...
[1tube] Bundling functions from: ./playground
[1tube] workerd backend ready (v1.20260415.0) · 3 function(s) in 740ms
[1tube] Functions: echo, hello, whoami
```

Then verify end-to-end:

```bash
# Public hello
curl http://127.0.0.1:3100/functions/v1/hello
# → {"message":"hello, hello",...}

# Public echo with body + query + custom header
curl -X POST 'http://127.0.0.1:3100/functions/v1/echo?x=1' \
  -H 'content-type: application/json' \
  -H 'x-test: abc' \
  -d '{"hello":"world"}'

# Unknown function fast-fails before auth/rate-limit
curl -i http://127.0.0.1:3100/functions/v1/no-such-fn
# → HTTP/1.1 404 Not Found
```

The full e2e test (`tests/workerd-e2e.test.ts`) automates exactly the same
checks against a real workerd subprocess; run
`deno test --allow-all tests/workerd-e2e.test.ts` for one-shot verification.

### Compatibility date

Workerd applies a `compatibilityDate` to enable behaviour-change opt-ins. 1tube
defaults to today's date, then **clamps it down** to whatever the installed
workerd binary actually accepts — derived from the binary's version string
(`1.YYYYMMDD.N`), since workerd refuses dates later than its build date. You
only see a clamp warning if you explicitly pinned a date the binary can't
honour.

### Forwarding env vars (secrets, API keys)

**Default: every env var the gateway sees is forwarded.** Bundled functions
inherit their parent's environment the same way a
`deno run ./functions/foo/index.ts` child would — so
`Deno.env.get("OPENAI_API_KEY")` Just Works without any extra wiring. This is
the developer-friendly default; use it for solo projects and trusted code.

Pass an explicit allowlist when you care about isolation (shared multi-tenant
workerds, reproducible build artifacts, etc.):

```bash
# CLI flag — narrows to exactly these names
deno run --allow-all src/server.ts \
  --backend workerd --functions ./functions \
  --workerd-env=OPENAI_API_KEY,POSTHOG_HOST,STRIPE_SECRET_KEY

# Env var (handy when 1tube is launched by a process manager)
1TUBE_WORKERD_ENV=OPENAI_API_KEY,POSTHOG_HOST,STRIPE_SECRET_KEY \
  deno run --allow-all src/server.ts --backend workerd --functions ./functions

# `*` is the explicit form of the default (forward everything)
--workerd-env=*
```

Each listed name becomes a `(name = X, fromEnvironment = X)` binding in the
generated `config.capnp`. Workerd reads the **value** from its own process env
at boot; the on-disk capnp file contains nothing but the var names. This means:

- Operators can rotate secrets by restarting the gateway with new env values; no
  cache rebuild needed.
- A leaked `config.capnp` cannot leak secrets — it never had them.
- Vars listed but absent from the gateway env get a single grouped warning at
  boot, then are simply not exposed (workerd would otherwise refuse to start).

> **A note on the default.** Earlier versions of 1tube defaulted to _deny-all_
> and required explicit opt-in. That was friction for the 90%-case (single-app
> deploys where the gateway and the functions trust each other) and surprised
> people whose `.env` already worked everywhere else. The deny-all stance is
> still one keystroke away — `--workerd-env=A,B,C` — and the per-function
> `permissions.env` manifest knob still narrows further under
> `1TUBE_ENFORCE_MANIFEST=1`.

### Bundle sizes at boot

Workerd boot prints a sorted table so unintended npm bloat is visible
immediately:

```
[1tube] workerd bundle sizes (sorted, largest first):
  zod-deps    443.4KB  (612ms)
  stream       12.0KB  (89ms)
  echo          9.9KB  (74ms)
  ...
  total       492.6KB  (1131ms across 7 fns)
```

If a bundle is much bigger than expected (50MB+), look for an unintended deep
import — `nodejs_compat` shims most of `node:*` automatically and you rarely
need to import a "browser polyfill" version of an npm package.

### Compatibility date

Workerd applies a `compatibilityDate` to enable behaviour-change opt-ins. 1tube
defaults to today's date, then **clamps it down** to whatever the installed
workerd binary actually accepts — derived from the binary's version string
(`1.YYYYMMDD.N`), since workerd refuses dates later than its build date. You
only see a clamp warning if you explicitly pinned a date the binary can't
honour.

### Per-function manifests on workerd

Each `<function>/1tube.json` is loaded at workerd boot and applied the same way
the Deno backend uses it:

- **`timeoutMs`** — per-function dispatch timeout. The gateway aborts the
  request and returns 504 if the bundled handler doesn't respond within this
  window. Falls back to `--timeout` when unset.
- **`rpm`** — per-function rate limit. The gateway-wide rate limiter consults
  the workerd manifest the same way it consults Deno-side ones; manifest values
  override `1TUBE_DEFAULT_RPM`.
- **`recycle`** — circuit breaker. After `errorWindow` requests with at least
  `errorRate` of them returning 5xx (or aborting), the breaker opens for
  `cooldownMs`. While open, requests short-circuit with
  `503 Retry-After: <seconds>` and a `{"reason": "circuit_breaker_open"}` body —
  workerd is never touched. The breaker half-opens automatically once the
  cool-down elapses.
- **`permissions.env`** — per-function env scoping. Default behaviour: every
  function sees the full `--workerd-env` allowlist (manifest entries are
  documentation only). Set `1TUBE_ENFORCE_MANIFEST=1` to switch to strict mode,
  where each function only sees the _intersection_ of the gateway allowlist and
  its declared `permissions.env`. Use `["*"]` to opt back into the full surface
  under enforcement.

Functions without a `1tube.json` get the defaults from `defaultManifest()` —
wide-open env, gateway-default timeout/rpm, errorRate=0.5 over a 20-request
window with a 30s cool-down.

#### Example — tight breaker

```json
// playground/boom/1tube.json
{
  "permissions": { "net": [], "env": [], "read": [], "write": [] },
  "timeoutMs": 5000,
  "recycle": { "errorRate": 1.0, "errorWindow": 3, "cooldownMs": 5000 }
}
```

Three consecutive 500s trip the breaker; the gateway logs:

```
[1tube] Circuit breaker OPEN for "boom" (workerd) — refusing requests for 5000ms (errorRate >= 1).
```

The 4th request returns 503 with `Retry-After: 5` without ever reaching the
workerd subprocess. Verified end-to-end in `tests/workerd-e2e.test.ts`.

### HMR on workerd

`--hmr` (or `1TUBE_HMR=1`) enables live reload on the workerd backend. The
gateway watches the functions directory and on each save:

1. Classifies the changed path. A change inside a function dir (e.g.
   `playground/hello/index.ts` or `playground/hello/1tube.json`) only re-bundles
   that one function; a change to anything starting with `_` (`_shared/`,
   `_internal/`, etc.) triggers a full re-bundle since shared code may be
   imported by any function.
2. Coalesces a 200ms burst of save events (editor format-on-save typically
   writes the file 2–3 times within ~50ms).
3. Re-bundles the affected function(s) using the long-lived esbuild worker.
   Bundles for unchanged functions stay on disk.
4. Generates a fresh `config.gen-{0|1}.capnp` on shifted ports (alternating
   between `basePort` and `basePort+500`) so the new workerd never collides with
   the still-serving old one.
5. Spawns the new workerd, waits for TCP readiness, then atomically swaps the
   gateway's route table.
6. Stops the old workerd. In-flight requests against the old process keep their
   captured origin URL and complete naturally; only NEW requests go to the new
   workerd. There is no request-drop window.

A typical incremental swap completes in **200–800ms** on a warm cache
(single-function rebundle + workerd cold start). Manifests (`1tube.json`) are
re-read on every reload and propagated into the registry / supervisor before the
new workerd starts serving, so an `rpm` or `timeoutMs` edit applies to the very
first post-reload request.

Failures are non-fatal: a syntax error in your source code aborts the swap, the
old workerd keeps serving, and the next save retries. The reloader logs:

```
[1tube] HMR 1 function(s) changed: hello
[1tube] HMR reload ok in 412ms (gen=3; rebundled=hello)
```

or, on failure:

```
[1tube] HMR reload FAILED — keeping previous workerd alive. Error: …
```

End-to-end coverage in `tests/workerd-e2e.test.ts`
(`HMR rebundles + swaps without dropping requests`).

### Memory enforcement & crash recovery

**The honest version up front**: workerd's open-source binary does **not**
support per-isolate memory limits in its capnp schema — that's a
Cloudflare-platform feature, not something the OSS runtime exposes. So 1tube
cannot kill an individual misbehaving function; it can only recycle the whole
workerd process. Two mechanisms keep things stable:

1. **Memory watchdog** — periodically reads the workerd PID's resident set size
   (RSS) and recycles the entire process when it stays over budget for `N`
   consecutive samples.
2. **Crash auto-recovery** — if workerd dies unexpectedly (OOM, SIGKILL,
   segfault), the gateway re-bundles and respawns it automatically.

Both reuse the M4 dual-process swap, so recovery is non-disruptive: in-flight
requests against the old workerd complete on their existing socket, the gateway
atomically points new requests at the new process, and only then is the
dead/over-budget process torn down.

#### Watchdog

Opt-in via `1TUBE_WORKERD_MAX_RSS_MB` (an absolute cap in MB). When unset, the
gateway derives a recommended budget from `sum(manifest.memoryMB) × 1.5 + 64MB`
and uses that automatically. If no manifest declares `memoryMB` either, the
watchdog stays off — no surprises for existing deployments.

| Env var                         | Default | Notes               |
| ------------------------------- | ------- | ------------------- |
| `1TUBE_WORKERD_MAX_RSS_MB`      | unset   | Hard RSS cap in MB. |
| `1TUBE_WORKERD_RSS_INTERVAL_MS` | `5000`  | Poll interval.      |

Hysteresis is fixed at **3 consecutive over-budget samples** before tripping (a
single GC pause spike won't recycle), and a **10-second cooldown** runs after
each recycle to let the new process settle. Watchdog stats (last RSS, configured
budget, total recycles, current generation) are surfaced on the authenticated
`/health` endpoint under a `workerd` block:

```json
{
  "status": "ok",
  "workerd": {
    "pid": 1234,
    "generation": 2,
    "recycles": 1,
    "rss_bytes": 134217728,
    "budget_bytes": 268435456
  }
}
```

RSS reading is cross-platform: Linux reads `/proc/{pid}/status`, macOS shells
out to `ps`, Windows to `tasklist`. The numbers approximate (working set vs
resident vs incl. shared pages differ by platform) — treat the budget as a rough
cap, not a precise quota.

#### Crash recovery

`WorkerdProcess.onExit` is wired to trigger an automatic recycle. A bounded
retry budget — **5 crashes in 30 seconds** — protects against hot-looping on a
fundamentally broken bundle:

```
[1tube] workerd crashed (gen=2, code=137, crashes=1/5 in 30s) — auto-recycling...
[1tube] workerd crashed (gen=3, code=137, crashes=2/5 in 30s) — auto-recycling...
…
[1tube] workerd crashed (gen=6, code=137, crashes=6/5 in 30s) — GIVING UP, manual restart required.
```

After the budget is exhausted the gateway returns `502 workerd backend error`
for every request until the operator restarts it (or, in dev, an HMR save which
clears the counter and resumes recovery). End-to-end coverage in
`tests/workerd-e2e.test.ts`
(`gateway auto-recovers when workerd is killed externally`).

### Observability on workerd

Both `/health` (JSON) and `/metrics` (Prometheus exposition) report
workerd-specific state when the backend is active. Both endpoints require
`Authorization: Bearer $INTERNAL_KEY`.

`/health` adds a `workerd` block:

```json
{
  "workerd": {
    "pid": 4242,
    "generation": 3,
    "recycles": 0,
    "rss_bytes": 134217728,
    "budget_bytes": 268435456,
    "last_reload_duration_ms": 412.5,
    "bundle_bytes": { "hello": 1024, "echo": 998 }
  }
}
```

`/metrics` exposes the same data as scrapeable gauges, plus per-function
circuit-breaker view that mirrors `supervisor.allStats()`:

| Gauge                                                  | Meaning                                                                                   |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `onetube_workerd_up`                                   | `1` if workerd is currently running, `0` between processes (mid-recycle, post-crash gap). |
| `onetube_workerd_pid`                                  | PID of the live workerd, `0` when not running.                                            |
| `onetube_workerd_generation`                           | Increments on every reload (HMR / watchdog / crash recovery).                             |
| `onetube_workerd_recycles_total`                       | Number of memory-watchdog-triggered recycles.                                             |
| `onetube_workerd_rss_bytes`                            | Most recent RSS sample.                                                                   |
| `onetube_workerd_budget_bytes`                         | RSS budget enforced by the watchdog (when set).                                           |
| `onetube_workerd_last_reload_duration_ms`              | Wall-clock duration of the most recent successful reload.                                 |
| `onetube_workerd_bundle_bytes{function="..."}`         | esbuild output size per function.                                                         |
| `onetube_function_breaker_open{function="..."}`        | `1` while the supervisor's breaker is open for this function.                             |
| `onetube_function_error_rate{function="..."}`          | Rolling error rate inside the supervisor's window (0..1).                                 |
| `onetube_function_recycle_recommended{function="..."}` | `1` once `recycle.maxRequests` has been reached.                                          |

The breaker gauges work on the Deno backend too — the supervisor is shared
between paths.

### V8 inspector / debugger access

Pass `--inspector` (or `--inspector-addr=host:port`, `1TUBE_INSPECTOR=1`) to
launch workerd with `--inspector-addr=...`. Default address is `127.0.0.1:9229`:

```bash
deno run --allow-all src/server.ts --backend workerd --inspector
# → [1tube] workerd V8 inspector enabled at 127.0.0.1:9229 (open chrome://inspect or attach via DevTools)
```

Then open `chrome://inspect` in a Chromium browser; the workerd target appears
under "Remote Target" once a function is invoked. Set breakpoints, step through
bundled code, inspect locals — everything you'd expect from V8.

Caveats:

- **Unauthenticated debug port.** `--inspector` opens an unauthenticated V8
  protocol port. The gateway warns loudly when the bind address is non-loopback.
  Don't enable in production.
- **HMR port shift.** When `--hmr` is also enabled, every reload spawns a _new_
  workerd on the next port slot. The inspector port shifts by one (`9229` →
  `9230` → `9229` → …) to avoid colliding with the still-listening predecessor.
  The boot log calls out the actual port for each generation.
- **Workerd-only.** The flag is a no-op on `--backend deno`; debug Deno-side
  functions with the standard `--inspect` Deno flag instead.

### Graceful shutdown

On `SIGINT` / `SIGTERM` the gateway runs a three-phase shutdown bounded by
`1TUBE_SHUTDOWN_GRACE_MS` (default `10000`):

1. **Stop watchers** — memory watchdog, hot reloader. Prevents a poll racing the
   shutdown from triggering a doomed recycle.
2. **Drain the listener** — `Deno.serve`'s abort signal stops accepting new TCP
   connections. Already-accepted requests keep running against the still-live
   workerd until they complete or grace expires.
3. **Stop workerd** — only after the drain has finished (or grace expired).
   Workerd's own SIGTERM-then-SIGKILL ladder gets the larger of
   `(remaining_grace, 1000ms)` so its log pumps can flush a final line.

Previous releases fired-and-forgot `workerd.stop()` in parallel with the drain,
which killed workerd while requests were still forwarding through it (502s on
the way out). The current ordering ensures in-flight requests keep their
original socket until they complete naturally — same property HMR's dual-process
swap relies on.

If grace is too tight (rare), bump `1TUBE_SHUTDOWN_GRACE_MS=30000`. The boot log
records the actual drain + workerd-stop durations so you can size it from real
numbers.

### Prebuilt artifacts (`1tube build` + `--prebuilt`)

For prod deploys you usually don't want esbuild on the box. `1tube build`
produces a sealed artifact directory that `1tube serve --prebuilt` can boot with
**zero bundling on the critical path** — just load, sha-256-verify, hand to
workerd.

```bash
# Build in CI (or locally)
deno task build --functions ./supabase/functions --out ./dist
# → dist/manifest.json + hello.js + echo.js + ... + .gitignore

# Ship `dist/` and the workerd binary to prod, then:
deno run --allow-all src/cli.ts --backend workerd --prebuilt ./dist
```

Build flags worth knowing:

| Flag                       | Default                | Purpose                                                                                                                    |
| -------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `--functions <path>`       | `./supabase/functions` | Source dir to bundle.                                                                                                      |
| `--out <path>`             | `./dist`               | Output artifact directory.                                                                                                 |
| `--only A,B,C`             | all                    | Build a subset (smoke tests, partial deploys).                                                                             |
| `--sourcemap MODE`         | `linked`               | `none` / `linked` / `inline`.                                                                                              |
| `--minify`                 | off                    | Minify output.                                                                                                             |
| `--compat-date YYYY-MM-DD` | (workerd's default)    | Bake a workerd compatibility date into the manifest.                                                                       |
| `--compat-flag FLAG`       | `nodejs_compat`        | Repeatable; appends a workerd compatibility flag.                                                                          |
| `--workerd-env A,B,C`      | empty                  | Bake env-var allowlist into the manifest. Values are still read from process env at serve time — only names are persisted. |

`dist/manifest.json` carries:

- Schema version (`schema: 1`) — serve refuses newer schemas instead of
  mis-parsing.
- 1tube version + ISO build timestamp (diagnostic).
- Per-function `bundleFile` + `bundleBytes` + `bundleSha256` (lower-case hex).
  The serve loader recomputes the digest at boot and **fails fast** if a bundle
  has been modified or corrupted.
- Per-function `1tube.json` parsed in-line, so a prebuilt deploy doesn't need
  the source tree at all.

Prebuilt-mode behaviour at serve time:

- `--functions` is ignored (warned about). `1TUBE_PREBUILT=path` works as an env
  var equivalent.
- `--prebuilt` implies `--backend workerd`; coerced with a warning if you
  forget.
- `--hmr` is rejected with a one-line warning — sealed artifacts can't reload.
  Re-run `1tube build` and restart.
- `backend.reload()` is rejected. Crash-recovery (re-spawning workerd against
  the same on-disk bundles) still works — it doesn't need to re-bundle.
- The artifact directory must be **writable at boot** because workerd's
  generated `config.gen-*.capnp` is written next to the bundles. If your prod
  filesystem is read-only, `cp -r dist /tmp/dist-rw && --prebuilt /tmp/dist-rw`.
  (Capnp generation is microseconds; we don't bake it at build time so `--port`,
  `--host`, and `--workerd-env` overrides keep working at serve.)

What you gain by separating build and serve:

- Reproducible deploys — the artifact is byte-identical for fixed inputs
  (esbuild output is deterministic; manifest sorts by function name).
- Tamper-evident — sha-256 verification at boot catches both corruption and
  silent edits.
- No esbuild / `@deno/esbuild-plugin` / npm fetch on the prod box.
- Faster boot — esbuild (the slow part) runs once in CI, not once per restart.

### Cache layout

Bundles, sourcemaps, and the generated `config.gen-{0,1}.capnp` files live in
`node_modules/.cache/1tube-workerd/` (or `.1tube-cache/workerd/` if there's no
`node_modules/`). The directory is auto-gitignored. Safe to delete; it gets
rebuilt on next boot.

### Benchmarking

A self-contained bench script under `scripts/bench.ts` boots a gateway with each
backend, hammers `/functions/v1/hello` (GET) and `/functions/v1/echo` (POST with
a 256-byte body), and reports `RPS / p50 / p95 / p99` per (backend, route) pair.
It auto-disables rate limiting via `1TUBE_DISABLE_RATE_LIMIT=1` so per-function
manifest caps don't skew the numbers.

```bash
# Default sweep (5000 reqs at 64 concurrency, both backends, ~30s).
deno run --allow-all scripts/bench.ts

# Single backend + heavier load.
deno run --allow-all scripts/bench.ts --backend workerd -n 20000 -c 128

# Quick smoke (won't catch tail latency but boots fast).
deno run --allow-all scripts/bench.ts -n 500 -c 16 --warmup 50
```

Order-of-magnitude numbers on a recent laptop, loopback, both backends warm:

| Backend | Route     |  RPS |    p50 |    p95 |    p99 |
| ------- | --------- | ---: | -----: | -----: | -----: |
| Deno    | GET hello | 3180 |  8.8ms | 16.7ms | 26.0ms |
| Deno    | POST echo | 1819 | 16.4ms | 27.2ms | 36.3ms |
| Workerd | GET hello | 1377 | 22.6ms | 32.9ms | 38.0ms |
| Workerd | POST echo | 1034 | 29.7ms | 47.2ms | 57.2ms |

Workerd costs roughly 2× the latency of in-process Deno calls because every
request takes one extra HTTP hop (gateway → workerd loopback socket). For
LLM/streaming workloads where the upstream call dwarfs proxy overhead, that
delta is invisible.

## .NET integration

Add the `OneTube` NuGet package to your ASP.NET project:

```csharp
services.AddOneTube(options =>
{
    // Path to the edge functions directory. Absolute, or relative
    // to AppContext.BaseDirectory (the host's bin/).
    options.FunctionsPath = "supabase/functions";

    // Binaries — absolute, relative to AppContext.BaseDirectory,
    // or bare names (PATH lookup). On servers, drop deno/workerd
    // next to the published host and use relative paths so the
    // deploy is reproducible.
    options.DenoBinary = "onetube-bin/deno.exe";
    options.WorkerdBinary = "onetube-bin/workerd.exe";

    options.Port = 3100;
    options.EnvVars = new()
    {
        ["SUPABASE_URL"] = "...",
        ["JWT_SECRET"] = "...",
    };
});

// In the pipeline, after UseRouting:
app.MapOneTube(port: 3100);
```

The OneTube package ships the gateway TypeScript sources alongside the DLL
(under `OneTubeGateway/` in the host's output directory), so you do **not** need
a 1tube checkout on the production host — only the `deno` and `workerd` binaries
you point at via `DenoBinary` / `WorkerdBinary`.

This spawns the Deno gateway as a managed child process with health monitoring
and auto-restart, and forwards `/functions/v1/*` via YARP zero-copy proxying.
