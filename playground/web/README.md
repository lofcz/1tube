# 1tube playground · web

A tiny BYOK chat frontend that lives next to the playground edge functions.
Vite + React + React Router 7 SPA. The browser **does not** call provider APIs
directly — every chat turn streams through the 1tube `chat` edge function, which
holds the AI SDK 6 dependency and forwards your API key (passed in via header)
to the chosen provider.

```
browser (5173)
    │  fetch  /functions/v1/chat
    │  body:  { provider, model, apiKey, messages }
    ▼
1tube gateway (3199)
    │
    ▼
playground/chat  ──streamText──►  Anthropic / OpenAI / Google
    │
    ▼
text/plain stream  ──►  browser progressively renders
```

## Run

You need both processes:

```bash
# terminal 1 — gateway with playground functions (incl. chat)
deno task play

# terminal 2 — frontend
cd playground/web
bun install        # or: npm install / pnpm install
bun run dev        # vite on http://localhost:5173
```

Then open <http://localhost:5173>, paste an API key in **Settings**, and go to
**Chat**. The gateway must be reachable from the browser; by default the
frontend calls `http://localhost:3199`. Override with `VITE_GATEWAY_URL` if you
run the gateway on a different host/port.

## Routes

- `/` — landing page
- `/chat` — streaming chat with provider + model selector
- `/settings` — API keys (masked, eye-icon toggle, stored in `localStorage`)

## Providers / models (latest as of 2026-04-25)

Edit `src/lib/providers.ts` whenever a provider ships something new — the UI
just renders whatever's in those arrays.

| Provider  | Models                                                        |
| --------- | ------------------------------------------------------------- |
| Anthropic | claude-opus-4-7 · claude-sonnet-4-6 · claude-haiku-4-5        |
| OpenAI    | gpt-5.5 · gpt-5.5-pro · gpt-5.4 · gpt-5.4-mini · gpt-5.4-nano |
| Google    | gemini-3.1-pro · gemini-3-flash · gemini-3.1-flash-lite       |

## How it streams

`src/lib/stream.ts` POSTs `{provider, model, apiKey, messages}` to
`/functions/v1/chat`. Yes, the key rides in the body — that's deliberately ugly
for a BYOK demo (it sidesteps the gateway's CORS header allowlist), and would
never ship in a real product. The edge function (`playground/chat/index.ts`)
does the AI SDK 6 work — `streamText` against the chosen provider — and pipes
the `textStream` async iterable into a plain `text/plain` ReadableStream. The
frontend reads the response body chunk by chunk via `getReader()` and appends
each chunk to the assistant turn. Stop button aborts via `AbortController`,
which both cancels the browser → gateway connection and propagates upstream via
`req.signal` inside the function.

## Security note

API keys live only in `localStorage` and only travel to the gateway as a JSON
body field (one hop, localhost). The gateway forwards them to the provider and
does not log message bodies. This is fine for local development and BYOK demos.
For a hosted deployment you'd want to:

- terminate the user-provided keys at the gateway (or replace BYOK with a
  server-side key + your own auth),
- enable TLS,
- consider adding a per-IP rate limit on the `chat` function via its
  `1tube.json`.

## Build / typecheck

```bash
bun run typecheck
bun run build      # outputs dist/
bun run preview
```
