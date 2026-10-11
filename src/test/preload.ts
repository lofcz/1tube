/**
 * `bun test --preload` hook installed by `1tube test`.
 *
 * Gives test files the gateway's module resolution: the project's import
 * map, `npm:` / `jsr:` / `https:` specifiers, and the managed dependency
 * store, applied to everything under the functions dir. Tests then import
 * function code exactly as the gateway would load it.
 */

import { dirname, resolve } from "node:path";
import { createCompatEnvironment } from "../compat/environment.ts";
import { configureCompat } from "../compat/plugin.ts";

const functionsDir = resolve(process.env["1TUBE_FUNCTIONS_DIR"] ?? ".");
const { deps, remote, importMap } = createCompatEnvironment({ functionsDir });

configureCompat({
  deps,
  remote,
  importMap,
  functionsDir,
  functionRoots: [functionsDir, ...(importMap ? [dirname(importMap.base)] : [])],
});
