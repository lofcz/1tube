/**
 * Discovers and loads edge function modules from the filesystem.
 *
 * Scans `functionsDir` for subdirectories containing an `index.ts`.
 * Skips directories starting with `_` or ending with `_shared`.
 * Each discovered module is dynamically imported — the top-level `serve()` call
 * in the module registers the handler via the global FunctionRegistry.
 */

import { join, toFileUrl } from "jsr:@std/path@^1";
import type { FunctionRegistry } from "./registry.ts";

export async function discoverAndLoad(
  functionsDir: string,
  registry: FunctionRegistry,
  options?: { cacheBust?: string },
): Promise<{ loaded: string[]; skipped: string[]; errors: Array<{ name: string; error: string }> }> {
  const loaded: string[] = [];
  const skipped: string[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  const resolvedDir = await Deno.realPath(functionsDir);

  const entries: string[] = [];
  for await (const entry of Deno.readDir(resolvedDir)) {
    if (!entry.isDirectory) continue;
    if (entry.name.startsWith("_") || entry.name.endsWith("_shared")) {
      skipped.push(entry.name);
      continue;
    }
    entries.push(entry.name);
  }

  entries.sort();

  for (const name of entries) {
    const indexPath = join(resolvedDir, name, "index.ts");

    try {
      await Deno.stat(indexPath);
    } catch {
      skipped.push(name);
      continue;
    }

    registry.setCurrentFunction(name);

    try {
      const moduleUrl = toFileUrl(indexPath);
      if (options?.cacheBust) {
        moduleUrl.searchParams.set("v", options.cacheBust);
      }
      await import(moduleUrl.href);
      loaded.push(name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push({ name, error: msg });

      const isEnvIssue =
        msg.includes("is required") ||
        msg.includes("must be set") ||
        msg.includes("API key") ||
        msg.includes("undefined");

      if (isEnvIssue) {
        console.error(`[1tube] Failed to load "${name}" (missing env var): ${msg}`);
      } else {
        console.error(`[1tube] Failed to load "${name}": ${msg}`);
      }
    }
  }

  return { loaded, skipped, errors };
}
