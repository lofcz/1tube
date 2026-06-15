/**
 * A `BundleProfile` describes how a given backend wants its edge functions
 * bundled. It is the seam that keeps the bundler core (`src/bundler/core.ts`)
 * target-agnostic: the core orchestrates esbuild + the Deno loader and injects
 * a banner/footer, but every backend-specific decision — which runtime globals
 * to shim, which esbuild conditions/platform to resolve under, which specifiers
 * to keep external — lives in a profile owned by that backend.
 *
 * Backends own their profile:
 *   - workerd → `src/backends/workerd/bundle-profile.ts` (`WORKERD_PROFILE`)
 *   - vercel  → `src/backends/vercel/bundle-profile.ts`  (`VERCEL_PROFILE`)
 *
 * The core never imports a backend; callers pass the profile in. This is what
 * lets the workerd backend stay ignorant of Vercel (and vice-versa) instead of
 * branching on a target inside shared bundler code.
 */

import type * as esbuild from "npm:esbuild@^0.28.1";

export interface BundleProfile {
  /** Stable identifier used in diagnostics/error messages, e.g. `"workerd"`. */
  readonly id: string;
  /**
   * esbuild `platform`. `"neutral"` for workerd (a bare V8 isolate with no Node
   * host), `"node"` for Vercel Node Functions (the real Node runtime provides
   * the builtins).
   */
  readonly platform: esbuild.Platform;
  /**
   * esbuild `conditions` for package export resolution. workerd prefers the
   * leaner `worker`/`browser` builds; Vercel resolves the `node` build.
   */
  readonly conditions: readonly string[];
  /** esbuild `mainFields`. Usually `["module", "main"]`. */
  readonly mainFields: readonly string[];
  /**
   * JS banner injected at the top of every bundle — runs before the user
   * entrypoint import so runtime shims (`Deno.env`, `Deno.serve`, …) are in
   * place before any top-level user code executes.
   */
  readonly banner: string;
  /**
   * JS footer injected at the bottom of every bundle — exports the backend's
   * runtime entry handler that dispatches into whatever the user registered.
   */
  readonly footer: string;
  /**
   * Bare specifiers to keep external. The Deno loader honours esbuild's
   * `external`, so these are short-circuited before resolution — used for
   * optional native deps a library `require()`s behind a try/catch.
   */
  readonly external?: readonly string[];
  /**
   * esbuild plugins registered BEFORE the Deno loader, so they win for the
   * specifiers they claim (e.g. externalising Node builtins for the Node
   * target). Most profiles need none.
   */
  readonly resolverPlugins?: readonly esbuild.Plugin[];
  /**
   * Source prepended to EVERY emitted output file (entry points AND
   * code-split chunks) before the final minify pass. Unlike {@link banner},
   * which esbuild only injects into entry points, this reaches chunks too.
   *
   * Needed when a runtime shim must be present in the chunk that esbuild
   * happens to hoist a helper into — e.g. the Node target injects a
   * `createRequire(import.meta.url)`-backed `require` so esbuild's `__require`
   * shim (emitted into a shared chunk for CJS deps that `require()` at module
   * init) works instead of throwing "Dynamic require of … is not supported".
   *
   * It is prepended to every file (the per-file minify pass keeps it even where
   * unused, since it can't prove the initializer is side-effect-free — a few
   * harmless bytes per chunk). In the chunk that defines the helper, esbuild's
   * minifier rewrites the helper's `typeof require` checks to the injected
   * binding, so the shim wires up automatically.
   */
  readonly outputPreamble?: string;
}
