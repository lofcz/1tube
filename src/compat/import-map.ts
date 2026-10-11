/**
 * Deno import-map support (`imports` + `scopes` from deno.json[c]).
 *
 * Supabase projects keep their aliases in `supabase/functions/deno.json`
 * (or a repo-root deno.json). Bun has no notion of that file, so the compat
 * plugin and the HMR dep-graph both resolve aliases through this module —
 * the Deno CLI's algorithm reduced to its essentials: exact match first,
 * otherwise the longest trailing-slash prefix, with the most specific
 * matching scope consulted before the top-level map.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ImportMap {
  imports?: Readonly<Record<string, string>>;
  scopes?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Absolute path of the config file the map came from. */
  base: string;
}

/** Strip comments and trailing commas so deno.jsonc parses as JSON. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/**
 * Conventional deno.json locations for a functions project, most specific
 * last-checked: cwd first (repo-root config), then the functions dir
 * (Supabase's `supabase/functions/deno.json`).
 */
export function findDenoConfig(
  cwd: string,
  functionsDir?: string,
): string | undefined {
  const candidates = [join(cwd, "deno.json"), join(cwd, "deno.jsonc")];
  if (functionsDir) {
    candidates.push(join(functionsDir, "deno.json"));
    candidates.push(join(functionsDir, "deno.jsonc"));
  }
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c;
    } catch {
      // next
    }
  }
  return undefined;
}

/** Read `imports`/`scopes` from a deno config. Undefined when absent/invalid. */
export function readImportMap(configPath: string | undefined): ImportMap | undefined {
  if (!configPath || !existsSync(configPath)) return undefined;
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(configPath, "utf8"))) as {
      imports?: Record<string, string>;
      scopes?: Record<string, Record<string, string>>;
      importMap?: string;
    };
    // `"importMap": "./import_map.json"` points at a standalone map.
    if (!parsed.imports && !parsed.scopes && typeof parsed.importMap === "string") {
      return readImportMap(join(dirname(configPath), parsed.importMap));
    }
    const out: ImportMap = { base: configPath };
    if (parsed.imports && typeof parsed.imports === "object") {
      out.imports = parsed.imports;
    }
    if (parsed.scopes && typeof parsed.scopes === "object") {
      out.scopes = parsed.scopes;
    }
    return out.imports || out.scopes ? out : undefined;
  } catch (err) {
    console.warn(
      `[1tube] Could not read import map from ${configPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }
}

/**
 * Resolve an import-map target. URL-ish targets (`npm:`, `jsr:`,
 * `https:`, `file:`) pass through; relative paths resolve against the
 * config file's directory.
 */
function resolveAgainst(target: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const baseUrl = base.startsWith("file://") ? base : pathToFileURL(base).href;
  return new URL(target, baseUrl).href;
}

function applyMap(
  specifier: string,
  map: Readonly<Record<string, string>>,
  base: string,
): string | null {
  const exact = map[specifier];
  if (exact !== undefined) return resolveAgainst(exact, base);
  let bestKey: string | null = null;
  for (const key of Object.keys(map)) {
    if (!key.endsWith("/")) continue;
    if (!specifier.startsWith(key)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  if (bestKey === null) return null;
  return resolveAgainst(map[bestKey] + specifier.slice(bestKey.length), base);
}

/**
 * Resolve `specifier` imported from `referrer` (a `file://` URL) through
 * the map. Returns the mapped target (a `file://` URL or an `npm:`/`jsr:`/
 * `https:` specifier) or null when nothing matches.
 */
export function resolveImportMap(
  specifier: string,
  referrer: string,
  map: ImportMap | undefined,
): string | null {
  if (!map) return null;
  if (map.scopes) {
    let best: { url: string; key: string } | null = null;
    for (const rawScope of Object.keys(map.scopes)) {
      const scopeUrl = resolveAgainst(rawScope, map.base);
      if (!referrer.startsWith(scopeUrl)) continue;
      if (best === null || scopeUrl.length > best.url.length) {
        best = { url: scopeUrl, key: rawScope };
      }
    }
    if (best) {
      const scoped = applyMap(specifier, map.scopes[best.key], map.base);
      if (scoped !== null) return scoped;
    }
  }
  return map.imports ? applyMap(specifier, map.imports, map.base) : null;
}

/**
 * Every key the map can rewrite, for building a cheap plugin pre-filter.
 * Prefix keys keep their trailing slash.
 */
export function importMapKeys(map: ImportMap | undefined): string[] {
  if (!map) return [];
  const keys = new Set<string>(Object.keys(map.imports ?? {}));
  for (const scoped of Object.values(map.scopes ?? {})) {
    for (const k of Object.keys(scoped)) keys.add(k);
  }
  return [...keys];
}
