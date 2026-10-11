/**
 * One place that assembles the Deno-compat environment — dependency store,
 * remote module cache, import map — from options and the env vars the
 * launcher sets. The gateway runtime and the bundlers (`1tube build`, the
 * workerd backend) both use it, so `npm:zod@^3` resolves to the same files
 * whether a function runs locally or ships in a bundle.
 *
 *   1TUBE_DEPS_DIR                 managed store (default <cwd>/.1tube/deps)
 *   1TUBE_IMPORT_MAP               explicit import map (legacy name: 1TUBE_DENO_CONFIG)
 *   1TUBE_DEPS_ISOLATED=1          ignore host node_modules
 *   1TUBE_MINIMUM_DEPENDENCY_AGE   min release age for managed installs
 *   1TUBE_RELOAD_REMOTE=1          re-download cached https: modules
 */

import { dirname, join, resolve } from "node:path";
import { createDependencyManager, type DependencyManager, parseReleaseAge } from "./deps.ts";
import { findDenoConfig, type ImportMap, readImportMap } from "./import-map.ts";
import { createRemoteModuleCache, type RemoteModuleCache } from "./remote.ts";

export interface CompatEnvironment {
  deps: DependencyManager;
  remote: RemoteModuleCache;
  importMap?: ImportMap;
  /** The deno config the import map came from, if any. */
  configPath?: string;
}

export interface CompatEnvironmentOptions {
  cwd?: string;
  /** Functions root; its deno.json is a conventional import-map location. */
  functionsDir?: string;
  /** Explicit deno.json[c]. Wins over discovery. */
  configPath?: string;
  depsDir?: string;
  minimumReleaseAgeSeconds?: number;
  isolated?: boolean;
  log?: (line: string) => void;
}

export function createCompatEnvironment(
  opts: CompatEnvironmentOptions = {},
): CompatEnvironment {
  const cwd = opts.cwd ?? process.cwd();
  const depsDir = resolve(
    cwd,
    opts.depsDir ?? process.env["1TUBE_DEPS_DIR"] ?? join(".1tube", "deps"),
  );
  const configPath = opts.configPath ?? process.env["1TUBE_IMPORT_MAP"] ??
    process.env["1TUBE_DENO_CONFIG"] ??
    findDenoConfig(cwd, opts.functionsDir);
  return {
    deps: createDependencyManager({
      dir: depsDir,
      minimumReleaseAgeSeconds: opts.minimumReleaseAgeSeconds ??
        parseReleaseAge(process.env["1TUBE_MINIMUM_DEPENDENCY_AGE"]),
      isolated: opts.isolated ?? process.env["1TUBE_DEPS_ISOLATED"] === "1",
      log: opts.log,
    }),
    remote: createRemoteModuleCache({
      dir: join(dirname(depsDir), "remote"),
      reload: process.env["1TUBE_RELOAD_REMOTE"] === "1",
    }),
    importMap: readImportMap(configPath),
    configPath,
  };
}
