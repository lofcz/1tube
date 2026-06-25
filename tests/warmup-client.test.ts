/**
 * Tests for the frontend warmup helper (`1tube/warmup-client`).
 *
 * Drives `createWarmupFetch` with a fake fetch that emits the gateway's
 * warming 503 contract and asserts retry behaviour + overlay callbacks.
 */

import { assert, assertEquals } from "@std/assert";
import {
  createWarmupFetch,
  fetchWarmupStatus,
  isWarmingResponse,
} from "../src/warmup-client.ts";

function warmingResponse(): Response {
  return new Response(
    JSON.stringify({
      error: "Backend is warming up",
      reason: "function_warming",
      function: "hello",
    }),
    {
      status: 503,
      headers: { "X-1tube-Warming": "1", "Retry-After": "1" },
    },
  );
}

Deno.test("warmup-client: isWarmingResponse only matches the gateway contract", () => {
  assert(isWarmingResponse(warmingResponse()));
  assertEquals(isWarmingResponse(new Response("ok")), false);
  assertEquals(
    isWarmingResponse(new Response("down", { status: 503 })),
    false,
    "plain 503 without the header is NOT a warming response",
  );
});

Deno.test("warmup-client: retries through warming and reports overlay transitions", async () => {
  let calls = 0;
  const fakeFetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
    calls++;
    if (calls <= 2) return Promise.resolve(warmingResponse());
    return Promise.resolve(new Response("real payload", { status: 200 }));
  }) as typeof fetch;

  const transitions: boolean[] = [];
  const warmFetch = createWarmupFetch({
    fetch: fakeFetch,
    retryDelayMs: 5,
    onWarmingChange: (warming) => transitions.push(warming),
  });

  const resp = await warmFetch("http://gw/functions/v1/hello", {
    method: "POST",
    body: JSON.stringify({ x: 1 }),
  });
  assertEquals(resp.status, 200);
  assertEquals(await resp.text(), "real payload");
  assertEquals(calls, 3);
  // Overlay shown exactly once, hidden exactly once.
  assertEquals(transitions, [true, false]);
});

Deno.test("warmup-client: no overlay callback for instant success", async () => {
  const fakeFetch =
    (() => Promise.resolve(new Response("ok"))) as unknown as typeof fetch;
  const transitions: boolean[] = [];
  const warmFetch = createWarmupFetch({
    fetch: fakeFetch,
    onWarmingChange: (warming) => transitions.push(warming),
  });
  const resp = await warmFetch("http://gw/functions/v1/hello");
  assertEquals(resp.status, 200);
  assertEquals(transitions, []);
});

Deno.test("warmup-client: gives up after maxWaitMs and returns the warming response", async () => {
  let calls = 0;
  const fakeFetch = (() => {
    calls++;
    return Promise.resolve(warmingResponse());
  }) as unknown as typeof fetch;

  const transitions: boolean[] = [];
  const warmFetch = createWarmupFetch({
    fetch: fakeFetch,
    retryDelayMs: 10,
    maxWaitMs: 25,
    onWarmingChange: (warming) => transitions.push(warming),
  });

  const resp = await warmFetch("http://gw/functions/v1/hello");
  assert(isWarmingResponse(resp), "should surface the final warming response");
  assert(calls >= 1);
  // Overlay turned on, then off when we stopped retrying.
  assertEquals(transitions[0], true);
  assertEquals(transitions[transitions.length - 1], false);
});

Deno.test("warmup-client: streaming bodies are never retried", async () => {
  let calls = 0;
  const fakeFetch = (() => {
    calls++;
    return Promise.resolve(warmingResponse());
  }) as unknown as typeof fetch;

  const warmFetch = createWarmupFetch({ fetch: fakeFetch, retryDelayMs: 1 });
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("chunk"));
      controller.close();
    },
  });
  const resp = await warmFetch("http://gw/functions/v1/upload", {
    method: "POST",
    body: stream,
  });
  assert(isWarmingResponse(resp));
  assertEquals(calls, 1, "a consumed stream body must not be re-sent");
});

Deno.test("warmup-client: fetchWarmupStatus parses the gateway payload", async () => {
  const payload = {
    backend: "deno",
    ready: false,
    total: 3,
    loaded: 1,
    loading: ["b"],
    queued: ["c"],
    failed: [],
  };
  let requestedUrl = "";
  const fakeFetch = ((input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as typeof fetch;

  const status = await fetchWarmupStatus("http://gw:3100/", {
    fetch: fakeFetch,
  });
  assertEquals(requestedUrl, "http://gw:3100/1tube/warmup");
  assertEquals(status, payload);
});
