/**
 * Shared deno.json resolution for the build commands.
 *
 * Under Bun a `deno.json[c]` is only an import-map source (`imports` /
 * `scopes`); the bundler's compat plugin applies it to function code. Both
 * `1tube build` (workerd) and `1tube build --target vercel` resolve it the
 * same way, in priority order:
 *
 *   1. explicit `--config <path>`  → must exist (hard error otherwise)
 *   2. explicit `--no-config`      → skip the import map entirely
 *   3. auto-detect                 → cwd/{import_map,deno}.json[c] then
 *                                    <functions-dir>/{import_map,deno}.json[c]
 *
 * The functions-dir fallback is what makes this work for hosts like
 * sciobot-next: a Vite/Bun project whose only `deno.json` lives next to the
 * edge functions (Supabase layout), not at repo root.
 */

import { stat } from "node:fs/promises";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { findDenoConfig } from "../compat/import-map.ts";

export interface ResolveDenoConfigOptions {
  /** Function source dir (absolute or relative to cwd). */
  functionsDir: string;
  /**
   * Explicit `--config` value. `undefined` = auto-detect; `""` = `--no-config`
   * (skip the import map); otherwise an explicit path that must exist.
   */
  configArg?: string | undefined;
  /** Sink for human-facing detection messages (no prefix). */
  onMessage?: (message: string) => void;
}

export interface ResolveDenoConfigResult {
  /** Resolved absolute config path, or undefined when none applies. */
  configPath?: string;
  /** Set when an explicit `--config` path was unreadable. */
  error?: string;
}

export async function resolveDenoConfigPath(
  opts: ResolveDenoConfigOptions,
): Promise<ResolveDenoConfigResult> {
  const { functionsDir, configArg, onMessage } = opts;
  const cwd = process.cwd();

  if (configArg !== undefined) {
    if (configArg === "") return {};
    const abs = isAbsolute(configArg) ? configArg : resolvePath(cwd, configArg);
    try {
      if (!(await stat(abs)).isFile()) throw new Error("not a regular file");
      return { configPath: abs };
    } catch (err) {
      return {
        error: `--config path not readable: ${abs} (${(err as Error).message})`,
      };
    }
  }

  const fnDirAbs = isAbsolute(functionsDir)
    ? functionsDir
    : resolvePath(cwd, functionsDir);
  const found = findDenoConfig(cwd, fnDirAbs);
  if (found) {
    onMessage?.(`using import map: ${found}`);
    return { configPath: found };
  }
  onMessage?.(
    `no import map at ${cwd} or ${fnDirAbs}; bare imports resolve from ` +
      `node_modules (package.json is the version source).`,
  );
  return {};
}
