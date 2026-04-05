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
| `POST /functions/v1/:name` | Invoke an edge function |
| `GET /health` | Health check + loaded function list |
| `GET /metrics` | Prometheus-compatible metrics |

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
