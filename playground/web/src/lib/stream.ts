import type { ProviderId } from "./providers";

// AI SDK message shape we send to the edge function. Mirrors `ModelMessage`
// from `ai@6` but kept inline here so the browser bundle doesn't need to
// import the AI SDK at all — all model work happens server-side.
export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface StreamArgs {
  provider: ProviderId;
  model: string;
  apiKey: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export interface StreamResult {
  textStream: AsyncIterable<string>;
  cancel: () => void;
}

const GATEWAY_URL =
  (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.replace(/\/+$/, "") ||
  "http://localhost:3199";

export function streamChat(args: StreamArgs): StreamResult {
  if (!args.apiKey) throw new Error(`no API key configured for ${args.provider}`);

  const controller = new AbortController();
  const signal = mergeSignals(args.signal, controller.signal);

  const fetchPromise = fetch(`${GATEWAY_URL}/functions/v1/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      provider: args.provider,
      model: args.model,
      apiKey: args.apiKey,
      messages: args.messages,
    }),
    signal,
  });

  const decoder = new TextDecoder();

  async function* iterate(): AsyncIterable<string> {
    const res = await fetchPromise;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`gateway ${res.status}: ${text || res.statusText}`);
    }
    if (!res.body) {
      throw new Error("gateway returned no body");
    }
    const reader = res.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          yield decoder.decode(value, { stream: true });
        }
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      reader.releaseLock();
    }
  }

  return {
    textStream: iterate(),
    cancel: () => controller.abort(),
  };
}

function mergeSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (a.aborted) ctrl.abort();
  if (b.aborted) ctrl.abort();
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return ctrl.signal;
}
