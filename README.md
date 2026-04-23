![NPM Version](https://img.shields.io/npm/v/1tube)

# 1tube

Self-hosted Supabase Edge Functions gateway. Runs your Deno edge functions locally or behind a .NET host with zero-copy YARP proxying — no cold starts, no version lock, no Supabase compute dependency.

## How it works

1tube discovers edge function modules from a `supabase/functions/` directory and hosts them in a single Deno HTTP server. Each function's `serve()` call registers a handler in a global registry instead of starting a separate `Deno.serve()`. The gateway then routes requests, handles JWT auth, CORS, rate limiting, and structured logging.

Individual edge functions require **zero changes** — only the shared `_shared/handler.ts` wrapper needs a small shim (4 lines) to detect the 1tube registry.

## Quick start (local dev)

```bash
# Install dependencies
bun install

# Copy and fill in env vars
cp .env.example .env

# Start with auto-restart on file changes
bun run dev -- --functions ../sciobot-next/supabase/functions
```

The gateway starts on `http://localhost:3100`. Functions are available at `http://localhost:3100/functions/v1/<name>`.

In dev mode, 1tube also watches the functions directory and reloads handlers in-process on filesystem changes (including newly created function folders).

### Deno npm lifecycle scripts

Deno does not run npm `postinstall` / build scripts unless you allow them. `deno.lock` may still list transitive packages such as `protobufjs`; the `check` script uses `--allow-scripts=npm:protobufjs` so `bun run check` / `npm publish` (via `prepublishOnly`) stays warning-free. That script is only needed for dependency install — **1tube’s runtime graph is just Hono + JSR std**.

## Endpoints

| Path | Description |
|---|---|
| `GET /` | Liveness probe (`{"status":"ok"}`) — intentionally minimal so unauthenticated callers don't see the function map. |
| `POST /functions/v1/:name` | Invoke an edge function |
| `GET /health` | Auth-gated health (`Authorization: Bearer $INTERNAL_KEY`); without auth returns the same minimal `{"status":"ok"}`. |
| `GET /metrics` | Auth-gated Prometheus exposition (same scheme). |

## Configuration

All knobs default to safe-but-backwards-compatible values. The TS gateway (`src/server.ts`) reads:

| Env / flag | Default | Notes |
|---|---|---|
| `--port` / `PORT` | `3100` | Listen port |
| `--host` / `1TUBE_HOST` | `127.0.0.1` | Loopback by default — pass `--host 0.0.0.0` to expose. |
| `--functions` / `FUNCTIONS_PATH` | `./supabase/functions` | Functions root |
| `--timeout` / `FUNCTION_TIMEOUT_MS` | `150000` | Per-request wall-clock cap (also overridable per function) |
| `--dev` / `1TUBE_DEV` | off | Applies the well-known local Supabase JWT/secrets. **Refuses to start in prod when JWT_SECRET / SUPABASE_SERVICE_ROLE_KEY are missing or are the public dev defaults.** |
| `--hmr` / `1TUBE_HMR` | off | File-watch + per-function reload (dev only). |
| `1TUBE_BODY_LIMIT_MB` | `30` | Hono `bodyLimit`; matches Supabase. Returns 413 before the handler runs. |
| `1TUBE_BODY_READ_MS` | `30000` | Slow-loris guard. Max idle gap (ms) between body chunks before the request is aborted with **408**. NOT a total body-read deadline — large but fast uploads pass through. Set `0` to disable. |
| `1TUBE_CORS_ORIGIN` | `*` (dev only) | Comma-separated allowlist or `*`. In prod, leaving unset disables CORS. |
| `1TUBE_TRUSTED_PROXIES` | empty | Comma-separated list of remote IPs whose `X-Forwarded-For` is honored. Anything else uses the raw socket address — XFF spoofing no longer mints fresh rate-limit buckets. |
| `1TUBE_SHUTDOWN_GRACE_MS` | `10000` | SIGINT/SIGTERM drain budget. |
| `INTERNAL_KEY` | unset | Required to read detailed `/health` and `/metrics`. Header-only: `Authorization: Bearer $INTERNAL_KEY`. |
```

## .NET integration

Add the `OneTube` NuGet package to your ASP.NET project:

```csharp
services.AddOneTube(options =>
{
    options.ProjectPath = "/path/to/1tube";
    options.FunctionsPath = "/path/to/supabase/functions";
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

This spawns the Deno gateway as a managed child process with health monitoring and auto-restart, and forwards `/functions/v1/*` via YARP zero-copy proxying.
