# 1tube playground

A minimal `supabase/functions`-shaped tree for poking at 1tube without needing a
real Supabase project. The layout mirrors what 1tube discovers in production:

```
playground/
  _shared/handler.ts   # the serve() shim — copy this into your real project
  hello/index.ts       # public GET, simple JSON
  echo/index.ts        # public, mirrors method/headers/query/body
  whoami/index.ts      # authenticated, requires a valid Supabase JWT
  slow/index.ts        # public, exercises the per-function timeout
  chat/index.ts        # public, BYOK chat — streams from Anthropic/OpenAI/Google
  web/                 # frontend SPA (React Router 7) that drives /chat
```

The [`chat/`](./chat/index.ts) function holds the AI SDK 6 dependency and
streams provider tokens back to the browser. The user's API key arrives in
the `x-api-key` header — no server-side keys are stored.

The [`web/`](./web/README.md) folder is a Vite app whose `/chat` route POSTs
to `chat/` through the gateway. Run them together:

```bash
deno task play                     # terminal 1: gateway on :3199
cd playground/web && bun run dev   # terminal 2: frontend on :5173
```

## Run

From the repo root:

```bash
deno task play
```

The `play` task implies `--dev --hmr`. Without `--dev`, the gateway will refuse to start since neither `JWT_SECRET` nor `SUPABASE_SERVICE_ROLE_KEY` is set in the environment (Phase 0 hardening).

## Per-function manifests

`hello/1tube.json` and `slow/1tube.json` show the optional manifest schema:

- scoped `permissions.env` (enforced when `1TUBE_ENFORCE_MANIFEST=1`); `net`/`read`/`write` are recorded as advisory metadata
- `timeoutMs` overriding the global default (enforced)
- `rpm` per-function rate limit (enforced)
- `warm: true` opts the function out of lazy loading (loaded at boot)
- `recycle.{maxRequests,errorRate,errorWindow,cooldownMs}` drives the in-process circuit breaker

See the top-level [`README.md`](../README.md#per-function-manifest-functionsdirname1tubejson) for the full field reference.

The TS runtime ignores these fields, so adding manifests today is forward-compatible.

That's `deno task dev` pointed at `./playground` on port `3199` (so it doesn't
clash with a real project running on the default `3100`). HMR is on — edits to
any function reload only that function.

## Try it

```bash
# Public
curl http://localhost:3199/functions/v1/hello
curl -X POST http://localhost:3199/functions/v1/echo?x=1 \
     -H 'content-type: application/json' -d '{"hi":1}'

# Timeout (slow has timeoutMs: 2000)
curl 'http://localhost:3199/functions/v1/slow?ms=500'
curl 'http://localhost:3199/functions/v1/slow?ms=5000'   # -> 504

# Auth — needs a JWT signed with $JWT_SECRET (the dev default is set
# automatically by 1tube). Mint one with any Supabase tooling, or sign by hand
# with HS256 + the JWT_SECRET shown in src/server.ts.
curl http://localhost:3199/functions/v1/whoami \
     -H "Authorization: Bearer $TOKEN"
```

## Standalone mode

Each function still works without 1tube — the shim falls back to `Deno.serve()`
when `globalThis.__edgeFunctionRegistry` is absent. Useful for quick isolation
tests:

```bash
deno run --allow-net --allow-env playground/hello/index.ts
```

The auth context in standalone mode is a fake `anon` user (no JWT validation).
