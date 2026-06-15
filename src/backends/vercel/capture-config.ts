/**
 * Build-time capture of each function's declared `serve()` options for the
 * Vercel target.
 *
 * On Vercel each function runs standalone, so `_shared/handler.ts` takes the
 * `getStandaloneServe()` path and the gateway registry is never installed —
 * which means a `serve({ timeoutMs })` value would otherwise be invisible to the
 * static build that bakes `maxDuration` into `.vc-config.json`.
 *
 * Rather than parse source or require a side-car `1tube.json`, we read the value
 * the function ACTUALLY declares, through the same contract the runtime uses:
 * `_shared/handler.ts` calls `globalThis.__edgeFunctionRegistry.register(handler,
 * { public, timeoutMs })` at import time whenever that global exists. We install
 * a capturing stub, import each entrypoint once, and record what it registered.
 *
 * Cost & safety:
 *   - Runs ONLY at build time — the deployed function pays nothing.
 *   - Imports each entrypoint a single time; Deno caches the shared module graph
 *     (`handler.ts`, providers, …) across functions, so the marginal cost per
 *     function is just its own top-level `serve(...)` call.
 *   - The registry path returns before binding any server, so importing does not
 *     start listeners or do per-request work.
 *   - Resilient: a function that throws at import (e.g. a stray top-level env
 *     read) is skipped with a warning; the caller falls back to its manifest /
 *     the global default.
 */

import { pathToFileURL } from "node:url";
import type { BundleInput } from "../../bundler/core.ts";

/** What a function declared on its `serve({ ... })` call. */
export interface DeclaredServeConfig {
  public: boolean;
  /** Per-function wall-clock budget (ms). Undefined = no explicit timeout. */
  timeoutMs?: number;
}

interface RegistryStub {
  register(
    handler: unknown,
    opts?: { public?: boolean; timeoutMs?: number },
  ): void;
}

const REGISTRY_KEY = "__edgeFunctionRegistry";

/**
 * Minimal stand-in for `Deno.serve`'s return value so importing an entrypoint
 * that calls `Deno.serve` directly (instead of the registry `serve()` wrapper)
 * does not bind a real port during the build.
 */
function fakeHttpServer(): unknown {
  return {
    finished: Promise.resolve(),
    shutdown: () => Promise.resolve(),
    ref() {},
    unref() {},
    addr: { transport: "tcp", hostname: "0.0.0.0", port: 0 },
  };
}

/**
 * Import every entrypoint with a stub registry installed and collect the
 * `serve()` options each one registers. Returns a `name → config` map; functions
 * that don't register (or fail to import) are simply absent.
 */
export async function captureDeclaredServeConfigs(
  inputs: readonly BundleInput[],
  onWarn: (message: string) => void = (m) => console.warn(m),
): Promise<Map<string, DeclaredServeConfig>> {
  const out = new Map<string, DeclaredServeConfig>();
  if (inputs.length === 0) return out;

  const globalAny = globalThis as Record<string, unknown>;
  const previousRegistry = globalAny[REGISTRY_KEY];

  let current: DeclaredServeConfig | undefined;
  const stub: RegistryStub = {
    register(_handler, opts) {
      current = { public: !!opts?.public, timeoutMs: opts?.timeoutMs };
    },
  };
  globalAny[REGISTRY_KEY] = stub;

  // The registry path never calls Deno.serve, but neutralise it anyway so a raw
  // `Deno.serve(...)` entrypoint can't bind a port (or leak a listener) during
  // the sweep. Snapshot/restore around the whole pass.
  const denoNs = (globalThis as { Deno?: { serve?: unknown } }).Deno;
  const hadServe = !!denoNs && "serve" in denoNs;
  const previousServe = denoNs?.serve;
  if (denoNs) denoNs.serve = fakeHttpServer as unknown as typeof denoNs.serve;

  try {
    for (const input of inputs) {
      current = undefined;
      try {
        await import(pathToFileURL(input.entrypoint).href);
      } catch (err) {
        onWarn(
          `could not load ${input.name} to read its serve() timeout; ` +
            `falling back to manifest/default (${
              err instanceof Error ? err.message : String(err)
            })`,
        );
        continue;
      }
      if (current) out.set(input.name, current);
    }
  } finally {
    if (previousRegistry === undefined) delete globalAny[REGISTRY_KEY];
    else globalAny[REGISTRY_KEY] = previousRegistry;
    if (denoNs) {
      if (hadServe) {
        denoNs.serve = previousServe as typeof denoNs.serve;
      } else {
        delete denoNs.serve;
      }
    }
  }

  return out;
}
