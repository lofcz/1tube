/**
 * esbuild plugin with the same Deno-compat resolution the Bun runtime uses.
 *
 * The workerd and Vercel bundlers previously delegated to
 * `@deno/esbuild-plugin`, which resolves through Deno's own cache and
 * lockfile. Under Bun the dependency store is `.1tube/deps` (see
 * `deps.ts`), so bundles and the local runtime must resolve identically:
 *
 *   npm: / jsr:      → host node_modules or the managed store
 *   https: / http:   → the remote module cache (namespace `1tube-remote`)
 *   import-map keys  → deno.json `imports` / `scopes`
 *
 * Everything else (relative paths, bare packages, `node:` builtins) is left
 * to esbuild's native resolver, which walks `node_modules` from the
 * resolved file — so a package's own internal imports work unchanged.
 *
 * Call {@link prepareBundleDependencies} first: it installs every
 * `npm:`/`jsr:` request reachable from the entries in one `bun install`
 * instead of one blocking install per package during the build.
 */

import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as esbuild from "esbuild";
import { createDepGraph } from "../backends/bun/dep-graph.ts";
import type { DependencyManager } from "./deps.ts";
import { type ImportMap, resolveImportMap } from "./import-map.ts";
import type { RemoteModuleCache } from "./remote.ts";
import { isRemoteSpecifier, parsePackageSpecifier } from "./specifiers.ts";

const REMOTE_NS = "1tube-remote";

export interface CompatEsbuildOptions {
  deps: DependencyManager;
  remote: RemoteModuleCache;
  importMap?: ImportMap;
}

function isDependencyPath(p: string): boolean {
  return /[\\/]node_modules[\\/]/.test(p);
}

export function compatEsbuildPlugin(opts: CompatEsbuildOptions): esbuild.Plugin {
  return {
    name: "1tube-deno-compat",
    setup(build) {
      const resolveTarget = (
        target: string,
        importer: string,
        resolveDir: string,
        kind: esbuild.ImportKind,
      ): Promise<esbuild.OnResolveResult | undefined> | esbuild.OnResolveResult | undefined => {
        const pkg = parsePackageSpecifier(target);
        if (pkg) return { path: opts.deps.resolveSync(pkg, importer || undefined) };
        if (isRemoteSpecifier(target)) return { path: target, namespace: REMOTE_NS };
        if (target.startsWith("file://")) return { path: fileURLToPath(target) };
        if (target.startsWith("node:")) return undefined;
        // Bare → bare remap: let esbuild resolve the rewritten name.
        return build.resolve(target, { kind, resolveDir, importer }).then((r) =>
          r.errors.length > 0 ? undefined : { path: r.path, external: r.external, namespace: r.namespace }
        );
      };

      build.onResolve({ filter: /^(npm|jsr):/ }, (args) => {
        const req = parsePackageSpecifier(args.path);
        if (!req) {
          return { errors: [{ text: `Invalid specifier "${args.path}"` }] };
        }
        try {
          return { path: opts.deps.resolveSync(req, args.importer || undefined) };
        } catch (err) {
          return { errors: [{ text: err instanceof Error ? err.message : String(err) }] };
        }
      });

      build.onResolve({ filter: /^https?:\/\// }, (args) => ({
        path: args.path,
        namespace: REMOTE_NS,
      }));

      build.onLoad({ filter: /.*/, namespace: REMOTE_NS }, async (args) => {
        const mod = await opts.remote.load(args.path);
        return { contents: mod.code, loader: "js" };
      });

      if (opts.importMap) {
        const map = opts.importMap;
        build.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.namespace !== "file" || !args.importer) return undefined;
          if (isDependencyPath(args.importer)) return undefined;
          const mapped = resolveImportMap(args.path, pathToFileURL(args.importer).href, map);
          if (mapped === null) return undefined;
          return resolveTarget(mapped, args.importer, args.resolveDir || dirname(args.importer), args.kind);
        });
      }
    },
  };
}

/** Install every npm:/jsr: request reachable from `entries` in one batch. */
export async function prepareBundleDependencies(
  entries: ReadonlyArray<{ name: string; entrypoint: string }>,
  opts: { deps: DependencyManager; importMap?: ImportMap },
): Promise<void> {
  const graph = createDepGraph({ importMap: opts.importMap });
  await graph.refreshMany(entries.map((e) => ({ name: e.name, entry: e.entrypoint })));
  const reqs = entries.flatMap((e) => graph.packagesFor(e.name));
  if (reqs.length > 0) await opts.deps.ensure(reqs, entries[0].entrypoint);
}
