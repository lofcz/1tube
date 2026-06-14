/**
 * Shared Deno-config resolution for the build commands.
 *
 * esbuild's Deno loader needs the host project's `deno.json[c]` to apply the
 * import map. Both `1tube build` (workerd) and `1tube vercel-build` resolve it
 * the same way, in priority order:
 *
 *   1. explicit `--config <path>`  → must exist (hard error otherwise)
 *   2. explicit `--no-config`      → skip the import map entirely
 *   3. auto-detect                 → cwd/deno.json[c] then
 *                                    <functions-dir>/deno.json[c]
 *
 * The functions-dir fallback is what makes this work for hosts like
 * sciobot-next: a Vite/Bun project whose only `deno.json` lives next to the
 * edge functions (Supabase layout), not at repo root.
 */

import { isAbsolute, resolve as resolvePath } from "node:path";

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

  if (configArg !== undefined) {
    if (configArg === "") return {};
    const abs = isAbsolute(configArg)
      ? configArg
      : resolvePath(Deno.cwd(), configArg);
    try {
      const stat = await Deno.stat(abs);
      if (!stat.isFile) throw new Error("not a regular file");
      return { configPath: abs };
    } catch (err) {
      return {
        error: `--config path not readable: ${abs} (${(err as Error).message})`,
      };
    }
  }

  const fnDirAbs = isAbsolute(functionsDir)
    ? functionsDir
    : resolvePath(Deno.cwd(), functionsDir);
  const candidates = [
    `${Deno.cwd()}/deno.json`,
    `${Deno.cwd()}/deno.jsonc`,
    `${fnDirAbs}/deno.json`,
    `${fnDirAbs}/deno.jsonc`,
  ];
  for (const abs of candidates) {
    try {
      const stat = await Deno.stat(abs);
      if (stat.isFile) {
        onMessage?.(`using deno config: ${abs}`);
        return { configPath: abs };
      }
    } catch { /* not found, try next */ }
  }
  onMessage?.(
    `no deno.json / deno.jsonc at ${Deno.cwd()} or ${fnDirAbs} — bundling ` +
      `without an import map. Pass --config <path> if you want one.`,
  );
  return {};
}
