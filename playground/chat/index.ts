/**
 * Public BYOK chat endpoint used by playground/web.
 *
 *   POST /functions/v1/chat
 *     headers:
 *       content-type: application/json
 *     body:
 *       { "provider": "anthropic" | "openai" | "google",
 *         "model":    "<provider-specific model id>",
 *         "apiKey":   "<user-supplied provider key>",
 *         "messages": [{ "role": "user" | "assistant" | "system", "content": "..." }] }
 *
 * Yes, shipping the key in the body is unusual — for a BYOK playground it
 * sidesteps the gateway's CORS header allowlist (which doesn't include
 * `x-api-key`). For a real product you'd terminate keys server-side and
 * never let the browser see them at all.
 *
 * Returns a `text/plain; charset=utf-8` streaming response of raw model
 * tokens (AI SDK 6's text-stream protocol). The frontend reads chunks via
 * `Response.body.getReader()` and appends them to the assistant turn.
 *
 * The function is intentionally `public: true`. Authentication is delegated
 * to the upstream provider via the user's own key — there is no server-side
 * key, no proxying for anonymous users, and no logging of message contents.
 */

import { serve } from "../_shared/handler.ts";
import { streamText, type ModelMessage } from "npm:ai@^6";
import { createAnthropic } from "npm:@ai-sdk/anthropic@^2";
import { createOpenAI } from "npm:@ai-sdk/openai@^2";
import { createGoogleGenerativeAI } from "npm:@ai-sdk/google@^2";

type Provider = "anthropic" | "openai" | "google";

interface ChatBody {
  provider: Provider;
  model: string;
  apiKey: string;
  messages: ModelMessage[];
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function buildModel(provider: Provider, model: string, apiKey: string) {
  switch (provider) {
    case "anthropic": {
      const anthropic = createAnthropic({ apiKey });
      return anthropic(model);
    }
    case "openai": {
      const openai = createOpenAI({ apiKey });
      return openai(model);
    }
    case "google": {
      const google = createGoogleGenerativeAI({ apiKey });
      return google(model);
    }
    default:
      throw new Error(`unknown provider: ${provider as string}`);
  }
}

serve(
  async (req) => {
    if (req.method !== "POST") {
      return jsonError(405, "POST only");
    }

    let body: ChatBody;
    try {
      body = (await req.json()) as ChatBody;
    } catch {
      return jsonError(400, "invalid JSON body");
    }

    if (!body.provider || !body.model || !Array.isArray(body.messages)) {
      return jsonError(400, "expected { provider, model, apiKey, messages[] }");
    }
    if (body.provider !== "anthropic" && body.provider !== "openai" && body.provider !== "google") {
      return jsonError(400, `unsupported provider: ${body.provider}`);
    }
    const apiKey = body.apiKey?.trim();
    if (!apiKey) {
      return jsonError(401, "missing apiKey in body");
    }

    let result: ReturnType<typeof streamText>;
    try {
      const model = buildModel(body.provider, body.model, apiKey);
      result = streamText({
        model,
        messages: body.messages,
        abortSignal: req.signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonError(500, `failed to start stream: ${msg}`);
    }

    // Convert AI SDK's textStream (AsyncIterable<string>) into a byte stream.
    // We deliberately surface provider errors *inside* the stream as a final
    // text frame prefixed with `\n[error] …` rather than as an HTTP error,
    // because the response headers have already been sent by the time most
    // provider errors surface (e.g. mid-generation rate limits).
    const enc = new TextEncoder();
    const upstream = result.textStream;
    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        try {
          for await (const chunk of upstream) {
            ctrl.enqueue(enc.encode(chunk));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctrl.enqueue(enc.encode(`\n[error] ${msg}`));
        } finally {
          ctrl.close();
        }
      },
      cancel() {
        // The AbortSignal threaded into streamText handles upstream cancel.
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  },
  { public: true },
);
