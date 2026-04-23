/**
 * Verifies the AsyncLocalStorage wiring that makes per-function attribution
 * possible inside the `unhandledrejection` global handler (Deno 2.7+).
 *
 * We don't spawn server.ts here — we exercise the same `currentRequestStorage`
 * + dispatch shape that src/server.ts uses, then assert:
 *   1. The store survives `await`.
 *   2. The store survives a `setTimeout` hop.
 *   3. The store survives a fire-and-forget Promise rejection observed by an
 *      `unhandledrejection` listener (the production attribution path).
 *   4. Two concurrent dispatches don't bleed contexts into each other.
 */

import { assert, assertEquals } from "@std/assert";
import { currentRequestStorage } from "../src/registry.ts";

function dispatch<T>(fnName: string, fn: () => T | Promise<T>): Promise<T> {
  // Mirrors the wrap in src/server.ts: every handler runs inside a
  // `currentRequestStorage.run({ functionName }, ...)` scope.
  return Promise.resolve(currentRequestStorage.run({ functionName: fnName }, fn));
}

Deno.test("async-context: store visible synchronously inside the handler", async () => {
  await dispatch("alpha", () => {
    assertEquals(currentRequestStorage.getStore()?.functionName, "alpha");
  });
});

Deno.test("async-context: store survives an await boundary", async () => {
  await dispatch("beta", async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 1));
    assertEquals(currentRequestStorage.getStore()?.functionName, "beta");
  });
});

Deno.test("async-context: setTimeout callback inherits the store", async () => {
  await new Promise<void>((resolve, reject) => {
    dispatch("gamma", () => {
      setTimeout(() => {
        try {
          assertEquals(currentRequestStorage.getStore()?.functionName, "gamma");
          resolve();
        } catch (err) {
          reject(err);
        }
      }, 5);
    });
  });
});

Deno.test("async-context: concurrent dispatches keep their own store (no bleed)", async () => {
  const seenA: (string | undefined)[] = [];
  const seenB: (string | undefined)[] = [];

  const a = dispatch("fn-a", async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      seenA.push(currentRequestStorage.getStore()?.functionName);
    }
  });
  const b = dispatch("fn-b", async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 1));
      seenB.push(currentRequestStorage.getStore()?.functionName);
    }
  });
  await Promise.all([a, b]);

  assertEquals(new Set(seenA), new Set(["fn-a"]));
  assertEquals(new Set(seenB), new Set(["fn-b"]));
});

Deno.test("async-context: unhandledrejection sees the originating function", async () => {
  // Install a one-shot listener that captures whatever function the dispatch
  // was running when the orphan rejection fired. This exactly mirrors what
  // src/server.ts does — except here we resolve a promise instead of feeding
  // the supervisor.
  const seen: (string | undefined)[] = [];
  const captured = new Promise<void>((resolve) => {
    const handler = (e: PromiseRejectionEvent) => {
      // Only swallow OUR sentinel rejection — leave anyone else's alone.
      if (String(e.reason) === "Error: rejection-from-delta") {
        e.preventDefault();
        seen.push(currentRequestStorage.getStore()?.functionName);
        globalThis.removeEventListener("unhandledrejection", handler);
        resolve();
      }
    };
    globalThis.addEventListener("unhandledrejection", handler);
  });

  await dispatch("delta", () => {
    // Fire and forget — no `.catch`, no `await`. The rejection should fire
    // unhandledrejection while our async context is still active.
    void Promise.resolve().then(() => {
      throw new Error("rejection-from-delta");
    });
  });

  // Wait for the listener to fire; bail loudly (but cleanly) if it never
  // does so the test fails fast rather than hanging the test runner. Note
  // we keep the timer id so we can clear it after `captured` wins the race —
  // otherwise Deno's leak detector flags the dangling setTimeout.
  let timerId = 0;
  const timeout = new Promise<void>((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error("unhandledrejection never fired")),
      1000,
    );
  });
  try {
    await Promise.race([captured, timeout]);
  } finally {
    clearTimeout(timerId);
  }

  assert(seen.length >= 1, "expected at least one rejection capture");
  assertEquals(seen[0], "delta");
});
