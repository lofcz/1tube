/**
 * Vercel (Node / Fluid) bundle profile.
 *
 * Owns every Vercel-specific bundling decision the target-agnostic bundler core
 * consumes through a {@link BundleProfile}:
 *
 *  - the Node req/res ↔ Web fetch banner/footer (see `./wrapper.ts`);
 *  - `node` platform + conditions, so packages resolve their Node build and the
 *    host runtime supplies the builtins;
 *  - a resolver plugin that externalises Node builtins (the Node runtime owns
 *    them — don't bundle Deno's polyfills);
 *  - the small set of optional native deps libraries `require()` behind a
 *    try/catch, kept external so esbuild's `__require` shim throws at the call
 *    site and the library falls back to its pure-JS path.
 *
 * Keeping all of this here is the point of the profile split: the bundler core
 * and the workerd backend never reference Vercel.
 */

import * as esbuild from "npm:esbuild@^0.28.1";
import type { BundleProfile } from "../../bundler/profile.ts";
import {
  NODE_BUILTIN_MODULES,
  VERCEL_BANNER,
  VERCEL_FOOTER,
  VERCEL_REQUIRE_SHIM,
} from "./wrapper.ts";

const NODE_BUILTIN_SET = new Set<string>(NODE_BUILTIN_MODULES);

function isNodeBuiltinBare(spec: string): boolean {
  const slash = spec.indexOf("/");
  const head = slash === -1 ? spec : spec.slice(0, slash);
  return NODE_BUILTIN_SET.has(head);
}

/**
 * Leave Node builtins to the host runtime instead of bundling Deno's polyfills.
 * `node:`-prefixed specifiers are always external; bare builtins (`crypto`,
 * `stream`, `stream/web`, …) are rewritten to their `node:` form and
 * externalised. Non-builtins fall through to the Deno loader for npm/jsr
 * resolution. Registered before the Deno loader so it wins for these specifiers.
 */
function nodeBuiltinsExternalPlugin(): esbuild.Plugin {
  return {
    name: "1tube-node-builtins-external",
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path,
        external: true,
      }));
      build.onResolve({ filter: /^[A-Za-z][A-Za-z0-9._/-]*$/ }, (args) => {
        if (isNodeBuiltinBare(args.path)) {
          return { path: `node:${args.path}`, external: true };
        }
        return null;
      });
    },
  };
}

/**
 * Externalise bare specifiers that nothing in the toolchain can resolve,
 * instead of failing the whole bundle.
 *
 * The motivating case: popular Node libraries `require()` an optional
 * native/peer package behind a `try/catch` as an opt-in speedup, degrading to
 * a pure-JS path when it's absent (`ws` → `bufferutil`/`utf-8-validate`,
 * `debug` → `supports-color`, `chokidar` → `fsevents`, and so on). Those are
 * uninstalled `optionalDependencies`, so the Deno loader can't resolve them
 * when the `node` build is selected and esbuild aborts the entire bundle.
 *
 * A hand-curated allowlist of such packages can never be exhaustive — the next
 * dependency that optionally `require()`s a native addon breaks the build. So
 * rather than enumerate them, we let esbuild attempt resolution and act ONLY on
 * failure: re-probe the specifier with `build.resolve()` and, if every
 * resolver (node-builtins plugin + Deno loader) gives up, mark it external.
 * esbuild then emits its `__require` shim, which throws at the call site —
 * exactly what the library's `catch` expects.
 *
 * Scope/guards:
 *  - The `filter` excludes relative specifiers (`./`, `../`).
 *  - Specifiers containing `:` are skipped, which covers every scheme/internal
 *    form (`node:`, `npm:`, `jsr:`, `http(s):`, `data:`, the `1tube-entry-proxy:`
 *    entry stand-in, and Windows drive paths). Only colon-free bare package
 *    specifiers (`debug`, `@scope/pkg`, `ws/lib/x.js`) are probed.
 *  - A `pluginData` flag breaks the recursion when our own `build.resolve()`
 *    re-enters this callback, so the Deno loader does the real resolution.
 *
 * Every externalised specifier is reported once at build end. A genuinely
 * REQUIRED-but-missing dependency therefore surfaces in the build log (and
 * throws when first called) instead of silently disappearing — that visibility
 * is what keeps "externalise on failure" honest rather than a foot-gun.
 *
 * The workerd profile never needs this: its `browser`/`worker` conditions
 * resolve the dependency-free browser builds that don't reach for native addons.
 */
function optionalDependencyExternalPlugin(): esbuild.Plugin {
  return {
    name: "1tube-optional-dependency-external",
    setup(build) {
      const externalised = new Set<string>();
      build.onResolve({ filter: /^[^.]/ }, async (args) => {
        // Skip absolute paths and every scheme/internal specifier (all of
        // which carry a colon). Leaves only bare npm package specifiers.
        if (args.path.startsWith("/") || args.path.includes(":")) return null;
        // Re-entrant hit from the build.resolve() probe below — defer to the
        // node-builtins resolver and the Deno loader.
        const data = args.pluginData as { probe?: boolean } | undefined;
        if (data?.probe) return null;

        const probe = await build.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          namespace: args.namespace,
          pluginData: { probe: true },
        });
        if (probe.errors.length === 0) return probe;

        externalised.add(args.path);
        return { path: args.path, external: true };
      });

      build.onEnd(() => {
        if (externalised.size === 0) return;
        console.warn(
          `[1tube vercel-build] externalised ${externalised.size} unresolvable ` +
            `bare specifier(s) as optional dependencies: ${
              [...externalised].sort().join(", ")
            }.\n  These are presumed optional (require()d behind try/catch) and ` +
            `will throw at the call site if actually invoked. If any is a REQUIRED ` +
            `dependency, install it or add it to your import map.`,
        );
      });
    },
  };
}

/**
 * Bundle profile for the Vercel Node target. Each function is bundled fully
 * standalone (no gateway shared runtime), as a Vercel Node Function whose
 * handler bridges Node req/res to the captured Web fetch handler.
 */
export const VERCEL_PROFILE: BundleProfile = {
  id: "vercel",
  platform: "node",
  conditions: ["node", "import", "default"],
  mainFields: ["module", "main"],
  banner: VERCEL_BANNER,
  footer: VERCEL_FOOTER,
  outputPreamble: VERCEL_REQUIRE_SHIM,
  resolverPlugins: [
    // node-builtins first so `crypto`/`stream`/… short-circuit to `node:` and
    // never reach the optional-dependency probe.
    nodeBuiltinsExternalPlugin(),
    optionalDependencyExternalPlugin(),
  ],
};
