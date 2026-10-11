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
 *   - Imports each entrypoint a single time; Bun caches the shared module graph
 *     (`handler.ts`, providers, …) across functions, so the marginal cost per
 *     function is just its own top-level `serve(...)` call.
 *   - Entrypoints load through the Deno-compat runtime plugin (npm:/jsr:/https:
 *     specifiers, import map), with every package they reach installed in one
 *     batch first. A temporary `Deno` / `EdgeRuntime` global stands in for the
 *     host's while the sweep runs, so top-level `Deno.env.get(...)` reads work.
 *   - The registry path returns before binding any server, so importing does not
 *     start listeners or do per-request work.
 *   - Resilient: a function that throws at import (e.g. a stray top-level env
 *     read) is skipped with a warning; the caller falls back to its manifest /
 *     the global default.
 */

import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { BundleInput } from "../../bundler/core.ts";
import { createDenoNamespace, createEdgeRuntime } from "../../compat/deno-shim.ts";
import { createCompatEnvironment } from "../../compat/environment.ts";
import { prepareBundleDependencies } from "../../compat/esbuild-plugin.ts";
import { readImportMap } from "../../compat/import-map.ts";
import { compatState, configureCompat } from "../../compat/plugin.ts";

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

export interface CaptureOptions {
  /**
   * deno.json[c] whose import map the entrypoints resolve against — the same
   * one the bundle was built with. Omitted = no import map.
   */
  configPath?: string;
  /** Functions root, so `_shared/*` files get import-map rewriting too. */
  functionsDir?: string;
}

/**
 * Point the process-global compat plugin at a dependency store + import map
 * and install every npm:/jsr: package the entrypoints reach in one batch.
 * A host that already configured the plugin (a running gateway) keeps its
 * own store; only the import-map roots are added.
 */
async function prepareCompat(
  inputs: readonly BundleInput[],
  opts: CaptureOptions,
): Promise<void> {
  const configPath = opts.configPath && existsSync(opts.configPath)
    ? opts.configPath
    : undefined;
  const importMap = readImportMap(configPath);
  const state = compatState();
  if (!state.deps || !state.remote) {
    const { deps, remote } = createCompatEnvironment({ configPath });
    configureCompat({ deps, remote, importMap });
  }
  if (importMap && opts.functionsDir) {
    configureCompat({ importMap, functionRoots: [opts.functionsDir] });
  }
  await prepareBundleDependencies(inputs, {
    deps: compatState().deps!,
    importMap,
  });
}

function processEnv() {
  return {
    get: (k: string) => process.env[k],
    set: (k: string, v: string) => {
      process.env[k] = v;
    },
    delete: (k: string) => {
      delete process.env[k];
    },
    has: (k: string) => k in process.env,
    toObject: () => ({ ...process.env }) as Record<string, string>,
  };
}

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
  opts: CaptureOptions = {},
): Promise<Map<string, DeclaredServeConfig>> {
  const out = new Map<string, DeclaredServeConfig>();
  if (inputs.length === 0) return out;

  try {
    await prepareCompat(inputs, opts);
  } catch (err) {
    // A failed install surfaces per function below as an import error.
    onWarn(
      `could not pre-install dependencies for the serve() capture (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  }

  const globalAny = globalThis as Record<string, unknown>;
  const previousRegistry = globalAny[REGISTRY_KEY];

  let current: DeclaredServeConfig | undefined;
  const stub: RegistryStub = {
    register(_handler, opts) {
      current = { public: !!opts?.public, timeoutMs: opts?.timeoutMs };
    },
  };
  globalAny[REGISTRY_KEY] = stub;

  // Bun has no `Deno` global, so install a temporary shim for the sweep; its
  // `serve()` only records the handler. If the realm already has a `Deno`
  // (a Deno host), neutralise its `serve` instead so a raw `Deno.serve(...)`
  // entrypoint can't bind a port (or leak a listener). The registry path
  // never calls Deno.serve either way. Snapshot/restore around the pass.
  const hadDeno = "Deno" in globalAny;
  const hadEdgeRuntime = "EdgeRuntime" in globalAny;
  if (!hadDeno) {
    globalAny.Deno = createDenoNamespace({
      functionName: "<capture>",
      env: processEnv(),
      onServe: () => {},
    });
  }
  if (!hadEdgeRuntime) globalAny.EdgeRuntime = createEdgeRuntime({});
  const denoNs = hadDeno
    ? (globalAny.Deno as { serve?: unknown } | undefined)
    : undefined;
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
    if (!hadDeno) delete globalAny.Deno;
    if (!hadEdgeRuntime) delete globalAny.EdgeRuntime;
  }

  return out;
}
