/**
 * The Bun runtime plugin that lets unmodified Supabase/Deno edge functions
 * load under Bun.
 *
 *   npm:pkg@range/sub     → host node_modules or the managed store (deps.ts)
 *   jsr:@scope/pkg@range  → npm.jsr.io compat package in the managed store
 *   https://… / http://…  → fetched + cached + rewritten (remote.ts)
 *   import-map aliases    → deno.json `imports` / `scopes` (import-map.ts)
 *   shared modules        → the gateway-owned singleton (shared-runtime.ts)
 *   shared dependencies   → one package instance for all functions (shared-deps.ts)
 *
 * Bun consults runtime plugins' `onResolve` only for scheme-prefixed
 * specifiers (`npm:x`, `https:…`, `1tube-dep:…`) — bare and relative static
 * imports never reach a plugin. So the last three features work by
 * rewriting import specifiers in function source files as they load
 * (`onLoad`, scoped to the configured function roots): an alias becomes its
 * target, a shared module import becomes `1tube-shared:<path>`, a package
 * import becomes `1tube-dep:<specifier>`. Only the quoted specifier changes,
 * so line/column positions — and therefore stack traces — are preserved.
 *
 * `Bun.plugin()` is process-global and cannot be unregistered, so the
 * resolvers read everything from a mutable {@link CompatState}; the gateway
 * (and tests) reconfigure it via {@link configureCompat}. Every
 * `Bun.ModuleGraph` the function host creates resolves through it.
 */

import { readFileSync, statSync } from "node:fs";
import { init as initLexer, parse as parseImports } from "es-module-lexer";
import { isBuiltin } from "node:module";
import { dirname, extname, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DependencyManager } from "./deps.ts";
import { type ImportMap, resolveImportMap } from "./import-map.ts";
import type { RemoteModuleCache } from "./remote.ts";
import type { SharedDependencies } from "./shared-deps.ts";
import {
  isRemoteSpecifier,
  parseJsrSpecifier,
  parseNpmSpecifier,
  parsePackageSpecifier,
} from "./specifiers.ts";

/** Namespace for modules the remote cache serves. */
const REMOTE_NS = "1tube-remote";
/** Scheme/namespace for the re-export stubs of shared modules. */
const SHARED_NS = "1tube-shared";
/** Scheme/namespace for the re-export stubs of shared dependencies. */
const DEP_NS = "1tube-dep";

/**
 * Gateway-side registry of shared modules. Function graphs importing a
 * shared source path receive a stub that re-exports from here.
 */
export interface SharedModuleProvider {
  /** Absolute source path → module id, for paths currently loaded. */
  idForPath(absPath: string): string | undefined;
  /** Export names of a loaded module (stub generation). */
  exportNames(id: string): readonly string[];
}

export interface CompatState {
  deps: DependencyManager | null;
  remote: RemoteModuleCache | null;
  importMap: ImportMap | undefined;
  shared: SharedModuleProvider | null;
  /**
   * When set, everything a function imports from outside its own
   * directory (packages and local shared code) shares one instance.
   */
  sharedDeps: SharedDependencies | null;
  /** The functions root: decides which files are "function-own". */
  functionsDir: string | undefined;
}

const state: CompatState = {
  deps: null,
  remote: null,
  importMap: undefined,
  shared: null,
  sharedDeps: null,
  functionsDir: undefined,
};

/** Bumped on every reconfiguration; part of the rewrite cache key. */
let configVersion = 0;

/** Global handle the shared-module stubs read from. */
export const SHARED_REGISTRY_KEY = Symbol.for("1tube.sharedModules");

/** 1tube's own sources never get their imports rewritten. */
const OWN_SRC = dirname(dirname(fileURLToPath(import.meta.url))) + sep;

let installed = false;
const rewriteRoots = new Set<string>();

/**
 * Update the shared state. `functionRoots` registers directories whose
 * source files get import rewriting (import maps, shared modules, shared
 * dependencies); roots accumulate for the life of the process.
 */
export function configureCompat(
  next: Partial<CompatState> & { functionRoots?: readonly string[] },
): void {
  const { functionRoots, ...rest } = next;
  Object.assign(state, rest);
  // The first root is the functions dir unless one was given explicitly.
  if (!("functionsDir" in next) && functionRoots?.length) {
    state.functionsDir = functionRoots[0].replace(/[\\/]+$/, "");
  }
  configVersion++;
  installCompatPlugin();
  for (const root of functionRoots ?? []) installRewriter(root);
}

export function compatState(): Readonly<CompatState> {
  return state;
}

function isDependencyPath(p: string): boolean {
  return p.includes(`${sep}node_modules${sep}`) || p.includes("/node_modules/");
}

function requireDeps(): DependencyManager {
  if (!state.deps) {
    throw new Error("[1tube] npm:/jsr: specifiers need the dependency manager (configureCompat)");
  }
  return state.deps;
}

// ---------------------------------------------------------------------------
// Source rewriting
// ---------------------------------------------------------------------------

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = {
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
};

const scanners = new Map<string, Bun.Transpiler>();
function scannerFor(loader: "ts" | "tsx" | "js" | "jsx"): Bun.Transpiler {
  let t = scanners.get(loader);
  if (!t) scanners.set(loader, t = new Bun.Transpiler({ loader }));
  return t;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True for files inside a function's own directory
 * (`<functionsDir>/<name>/…`, `<name>` not `_`-prefixed / `_shared`-suffixed).
 * Everything else a function imports is shared code.
 */
export function isFunctionOwnFile(path: string): boolean {
  const root = state.functionsDir;
  if (!root || !path.startsWith(root)) return false;
  const rest = path.slice(root.length).replace(/^[\\/]+/, "");
  const slash = rest.search(/[\\/]/);
  if (slash <= 0) return false; // a file directly in the root
  const seg = rest.slice(0, slash);
  return !seg.startsWith("_") && !seg.startsWith(".") && !seg.endsWith("_shared") &&
    seg !== "node_modules";
}

function isPackageSpecifier(spec: string): boolean {
  if (parsePackageSpecifier(spec) || isRemoteSpecifier(spec)) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) return false; // node:, bun:, data:, …
  if (spec.startsWith(".") || spec.startsWith("/")) return false;
  return !isBuiltin(spec);
}

/** The specifier `spec` (imported from `file`) should load as, or null. */
function rewriteTarget(spec: string, file: string): string | null {
  const mapped = state.importMap
    ? resolveImportMap(spec, pathToFileURL(file).href, state.importMap)
    : null;
  let target = mapped ?? spec;
  if (target.startsWith("file://")) target = fileURLToPath(target);

  // Only a function's own files import through shared-dependency stubs;
  // shared code itself (evaluated once in the dependency graph) imports
  // directly, so its internal — possibly cyclic — imports stay native.
  const shareFromHere = state.sharedDeps !== null && isFunctionOwnFile(file);

  const pathLike = target.startsWith("./") || target.startsWith("../") ||
    target.startsWith("/") || /^[A-Za-z]:[\\/]/.test(target);
  if (pathLike) {
    let abs: string | null = null;
    try {
      abs = Bun.resolveSync(target, dirname(file));
    } catch {
      // Not resolvable (yet): leave it to Bun's own error.
    }
    // Shared modules import each other directly: they all live in the
    // shared runtime's one graph, so those imports are singletons already.
    if (abs && state.shared && state.shared.idForPath(file) === undefined &&
      state.shared.idForPath(abs) !== undefined) {
      return `${SHARED_NS}:${abs}`;
    }
    if (abs && shareFromHere && !isFunctionOwnFile(abs)) return `${DEP_NS}:${abs}`;
    return mapped !== null ? target : null;
  }
  if (shareFromHere && isPackageSpecifier(target)) return `${DEP_NS}:${target}`;
  return mapped !== null ? target : null;
}

/** Rewrite the import specifiers of one source file. Exposed for tests. */
export function rewriteImports(code: string, file: string): string {
  const loader = LOADERS[extname(file).toLowerCase()] ?? "ts";
  let imports: Array<{ path: string }>;
  try {
    imports = scannerFor(loader).scanImports(code);
  } catch {
    return code; // Syntax error: let Bun report it against the original.
  }
  const replacements = new Map<string, string>();
  for (const { path } of imports) {
    if (replacements.has(path)) continue;
    const next = rewriteTarget(path, file);
    if (next !== null && next !== path) replacements.set(path, next);
  }
  if (replacements.size === 0) return code;
  return replaceAtImportSites(code, replacements) ??
    replaceByPattern(code, replacements);
}

/**
 * Replace specifiers exactly where the module lexer found import sites, so
 * look-alike text in strings and comments is never touched. Returns null
 * when the lexer can't parse the source (some TS-only syntax).
 */
function replaceAtImportSites(
  code: string,
  replacements: ReadonlyMap<string, string>,
): string | null {
  let imports;
  try {
    [imports] = parseImports(code);
  } catch {
    return null;
  }
  let out = "";
  let last = 0;
  for (const imp of imports) {
    const to = imp.n !== undefined ? replacements.get(imp.n) : undefined;
    if (to === undefined) continue;
    // Static imports span the bare text; dynamic ones the quoted literal.
    // Either way the specifier is escaped: Windows paths carry backslashes.
    const quoted = imp.d > -1;
    out += code.slice(last, imp.s) + (quoted ? JSON.stringify(to) : escapeInQuotes(to));
    last = imp.e;
  }
  return out + code.slice(last);
}

/** Fallback: rewrite `from "x"` / `import "x"` / `import("x")` by pattern. */
function replaceByPattern(code: string, replacements: ReadonlyMap<string, string>): string {
  for (const [from, to] of replacements) {
    const re = new RegExp(
      `(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])${escapeRegExp(from)}\\2`,
      "g",
    );
    code = code.replace(re, (_m, lead, q) => `${lead}${q}${escapeInQuotes(to)}${q}`);
  }
  return code;
}

/** `s` escaped for use between existing quotes of a string literal. */
function escapeInQuotes(s: string): string {
  return JSON.stringify(s).slice(1, -1).replaceAll("'", "\\'");
}

/**
 * Rewritten sources by path. Every function graph loads its files afresh,
 * so without this each graph would re-read and re-scan them.
 */
const rewriteCache = new Map<string, { mtimeMs: number; size: number; version: number; code: string }>();

function loadRewritten(path: string): string {
  const st = statSync(path);
  const hit = rewriteCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.version === configVersion) {
    return hit.code;
  }
  let code = readFileSync(path, "utf8");
  if (!path.startsWith(OWN_SRC) && (state.importMap || state.shared || state.sharedDeps)) {
    code = rewriteImports(code, path);
  }
  rewriteCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, version: configVersion, code });
  return code;
}

function installRewriter(root: string): void {
  const normalized = root.replace(/[\\/]+$/, "");
  if (rewriteRoots.has(normalized)) return;
  rewriteRoots.add(normalized);
  const filter = new RegExp(
    `^${escapeRegExp(normalized)}[\\\\/](?!(?:.*[\\\\/])?node_modules[\\\\/]).*\\.(?:[cm]?[jt]sx?)$`,
  );
  Bun.plugin({
    name: `1tube-rewrite:${normalized}`,
    setup(build) {
      build.onLoad({ filter }, async (args) => {
        // The lexer's WASM must be ready before the first rewrite.
        await initLexer;
        const loader = LOADERS[extname(args.path).toLowerCase()] ?? "ts";
        return { contents: loadRewritten(args.path), loader };
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Resolvers
// ---------------------------------------------------------------------------

/** Resolve a package specifier (npm:/jsr:/https:/bare) to a load key. */
function resolvePackageKey(spec: string, importer: string): string {
  const pkg = parsePackageSpecifier(spec);
  if (pkg) return requireDeps().resolveSync(pkg, importer);
  if (isRemoteSpecifier(spec)) return spec;
  return Bun.resolveSync(spec, dirname(importer));
}

function stubSource(registryKey: string, key: string, names: readonly string[]): string {
  const k = JSON.stringify(key);
  const lines = [
    `const __m = globalThis[Symbol.for(${JSON.stringify(registryKey)})]?.get(${k});`,
    `if (!__m) throw new Error("[1tube] shared module " + ${k} + " is not loaded");`,
  ];
  // Bindings are snapshots of the singleton's exports; string export names
  // keep non-identifier names (and `default`) valid.
  names.forEach((n, i) => {
    const q = JSON.stringify(n);
    lines.push(`const __e${i} = __m[${q}];`, `export { __e${i} as ${q} };`);
  });
  return lines.join("\n");
}

/** Install the plugin once. Safe to call repeatedly. */
export function installCompatPlugin(): void {
  if (installed) return;
  installed = true;
  Bun.plugin({
    name: "1tube-deno-compat",
    setup(build) {
      build.onResolve({ filter: /.*/, namespace: "npm" }, (args) => {
        const req = parseNpmSpecifier(args.path);
        if (!req) throw new Error(`Invalid npm: specifier "npm:${args.path}"`);
        return { path: requireDeps().resolveSync(req, args.importer) };
      });

      build.onResolve({ filter: /.*/, namespace: "jsr" }, (args) => {
        const req = parseJsrSpecifier(args.path);
        if (!req) throw new Error(`Invalid jsr: specifier "jsr:${args.path}"`);
        return { path: requireDeps().resolveSync(req, args.importer) };
      });

      for (const scheme of ["https", "http"]) {
        build.onResolve({ filter: /.*/, namespace: scheme }, (args) => ({
          path: `${scheme}:${args.path}`,
          namespace: REMOTE_NS,
        }));
      }

      build.onLoad({ filter: /.*/, namespace: REMOTE_NS }, async (args) => {
        if (!state.remote) {
          throw new Error(`[1tube] remote imports are not configured (${args.path})`);
        }
        const mod = await state.remote.load(args.path);
        return { contents: mod.code, loader: "js" };
      });

      // `1tube-shared:<abs path>` → stub re-exporting the gateway singleton.
      build.onResolve({ filter: /.*/, namespace: SHARED_NS }, (args) => ({
        path: args.path,
        namespace: SHARED_NS,
      }));

      build.onLoad({ filter: /.*/, namespace: SHARED_NS }, (args) => {
        const id = state.shared?.idForPath(args.path);
        if (id === undefined) {
          throw new Error(`[1tube] shared module no longer loaded: ${args.path}`);
        }
        return {
          contents: stubSource("1tube.sharedModules", id, state.shared!.exportNames(id)),
          loader: "js",
        };
      });

      // `1tube-dep:<specifier>` → stub re-exporting the shared package instance.
      build.onResolve({ filter: /.*/, namespace: DEP_NS }, (args) => ({
        path: resolvePackageKey(args.path, args.importer),
        namespace: DEP_NS,
      }));

      build.onLoad({ filter: /.*/, namespace: DEP_NS }, async (args) => {
        if (!state.sharedDeps) {
          // Sharing was switched off after this file was rewritten: load the
          // package into the importing graph as usual.
          const p = JSON.stringify(args.path);
          return {
            contents: `import * as __m from ${p};\nexport * from ${p};\nexport default __m.default;`,
            loader: "js",
          };
        }
        const { registryKey, exportNames } = await state.sharedDeps.load(args.path);
        return {
          contents: stubSource("1tube.sharedDependencies", registryKey, exportNames),
          loader: "js",
        };
      });
    },
  });
}
