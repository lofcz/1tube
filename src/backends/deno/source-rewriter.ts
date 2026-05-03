/**
 * Source rewriter that materializes shared-module RPC stubs into a
 * function's dep graph for the Deno backend's Worker model.
 *
 * Why this file exists
 * ====================
 * The Deno backend runs each function in its own Web Worker. Each
 * Worker has its own module cache, which is what makes HMR fast and
 * safe. The downside: any module imported by the function — including
 * shared `_shared/profile-cache.ts`-style modules — is evaluated once
 * per Worker, not once per process. A module with top-level side
 * effects (e.g., a Supabase realtime subscription) ends up
 * subscribing N times, once per function, instead of once total.
 *
 * The workerd backend solves this via esbuild plugins that rewrite
 * imports of shared modules to RPC stubs at bundle time, while
 * `startWorkerdSharedRuntime` evaluates the actual code once on the
 * gateway side. We don't bundle in the Deno backend (the source is
 * imported as-is; that's how HMR can be a "terminate + spawn" with
 * zero compile cost), so we replicate the trick at the source level:
 *
 *  1. We walk every function's dep graph.
 *  2. We compute the *taint set*: files in the graph that
 *     transitively import any shared module.
 *  3. For each tainted file we materialize a rewritten copy in a
 *     gateway-owned cache directory:
 *        - imports of shared modules    → stub URLs
 *        - imports of OTHER tainted files → that file's rewritten URL
 *        - imports of non-tainted local  → absolute `file://` URLs
 *          back to the original (so deno's loader finds them again
 *          from the rewritten copy's new location)
 *        - npm:/jsr:/http: imports        → unchanged
 *  4. We expose a single stub file per shared module that re-exports
 *     each function via `globalThis.__1tube_call_shared(id, name,
 *     args)` — the worker-host hooks that global up to a postMessage
 *     RPC into the gateway-side {@link DenoSharedRuntime}.
 *
 * The Worker, on init, imports the rewritten entry URL (if the
 * function's entry was tainted) or the original (if not). Either way
 * the user's source is unchanged; the rewriting is invisible.
 *
 * HMR
 * ===
 * The dep-graph already tells the hot reloader which functions are
 * affected by a file change. The `RewriteCache` lets it call
 * `invalidate(filePath)` so the next Worker spawn regenerates only
 * the affected rewritten copies. Stub files for shared modules are
 * regenerated in two cases: the shared module's source path changed
 * (rewritten copies of stubs are tied to source URL), or the shared
 * module's export list changed (the stub re-exports those names by
 * name, so a list change means stale stubs).
 */

import { init as initLexer, parse as parseImports } from "npm:es-module-lexer@^2";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import type {
  DenoSharedRuntime,
  SharedModuleRecord,
} from "./shared-runtime.ts";

let lexerReady: Promise<void> | null = null;
function ensureLexerReady(): Promise<void> {
  if (!lexerReady) lexerReady = initLexer;
  return lexerReady;
}

export interface RewriteRequest {
  /** Absolute file path of the function's entry (`<dir>/<name>/index.ts`). */
  entryPath: string;
  /**
   * Absolute file paths of every file in the function's dep graph,
   * including the entry itself. Order doesn't matter. Non-`file:`
   * specifiers (npm:/jsr:/http:) MUST NOT be in this set; they
   * cannot be rewritten and don't need to be.
   */
  graphPaths: ReadonlyArray<string>;
}

export interface RewriteResult {
  /**
   * URL the Worker should `await import(...)` for this function. If
   * no shared modules touched the function's graph, this is just
   * `pathToFileURL(entryPath).href` (no rewriting was needed).
   */
  entryUrl: string;
  /** True when at least one file in the graph was rewritten. */
  rewritten: boolean;
  /**
   * Absolute paths of files whose rewritten copies were produced for
   * this request. Returned for tests + diagnostics.
   */
  emittedRewrites: ReadonlyArray<string>;
}

export interface RewriteCacheOptions {
  /** Directory the cache writes rewrites + stubs into. */
  cacheDir: string;
  /** Source-of-truth for what's currently shared. */
  sharedRuntime: DenoSharedRuntime;
}

export interface RewriteCache {
  /** Plan + emit rewrites for a single function. */
  rewrite(req: RewriteRequest): Promise<RewriteResult>;
  /** Drop the rewritten copy of a file (HMR: file changed on disk). */
  invalidate(absPath: string): void;
  /** Drop the cached stub for a shared module (HMR: shared file changed). */
  invalidateStub(moduleId: string): void;
  /** Test seam: list emitted rewrites + stubs. */
  inspect(): { rewrites: ReadonlyArray<string>; stubs: ReadonlyArray<string> };
  /** Best-effort cleanup of the cache directory. */
  stop(): Promise<void>;
}

/**
 * Generate the source for one shared-module stub. Re-exports every
 * function name via `globalThis.__1tube_call_shared(id, name, args)`,
 * which the Worker-host wires up to a postMessage RPC.
 *
 * Note: only `function` and `const x = (...) =>` exports survive the
 * extractor in `bundler.ts:extractExportedFunctionNames`. Class /
 * value exports are not supported as shared and would error during
 * discovery — the user gets a clean message at boot rather than a
 * confusing failure inside a stub.
 */
export function sharedModuleStubSource(record: SharedModuleRecord): string {
  const exportLines = record.exportNames.map((name) =>
    `export async function ${name}(...args) {\n` +
    `  return await call(${JSON.stringify(name)}, args);\n` +
    `}`
  ).join("\n\n");
  return [
    `// Auto-generated 1tube shared-module stub for "${record.id}".`,
    `// Calls into the gateway-side DenoSharedRuntime via the Worker host's`,
    `// postMessage RPC. Do not edit; regenerated on each gateway boot.`,
    ``,
    `const MODULE_ID = ${JSON.stringify(record.id)};`,
    ``,
    `function call(name, args) {`,
    `  const fn = (globalThis).__1tube_call_shared;`,
    `  if (typeof fn !== "function") {`,
    `    return Promise.reject(new Error(`,
    `      "1tube shared runtime is not configured (call from outside a Worker spawned by 1tube?)",`,
    `    ));`,
    `  }`,
    `  return fn(MODULE_ID, name, args);`,
    `}`,
    ``,
    exportLines,
    ``,
  ].join("\n");
}

interface PlannedFile {
  /** Absolute path of the original. */
  abs: string;
  /** Absolute path of the rewritten copy in the cache. */
  rewritePath: string;
  /** Set of absolute file paths this file depends on (file:// only). */
  fileImports: Map<string, ResolvedImport>;
  /** Source text (already read). */
  source: string;
}

interface ResolvedImport {
  /** Original import specifier as it appears in source. */
  specifier: string;
  /**
   * Resolved kind — drives rewrite decisions.
   *   "file"   - relative or absolute path to a file:// URL we can
   *              reason about.
   *   "shared" - resolves to one of the shared modules' source paths.
   *   "external" - npm:/jsr:/http(s):/data: — leave alone.
   *   "unknown" - couldn't be parsed; left alone.
   */
  kind: "file" | "shared" | "external" | "unknown";
  /** Absolute file path when `kind === "file" | "shared"`. */
  absPath?: string;
  /** Position [start, end) in source — used by string splicer. */
  start: number;
  end: number;
}

const REWRITE_DIR = "rewrites";
const STUBS_DIR = "stubs";

export function createRewriteCache(opts: RewriteCacheOptions): RewriteCache {
  const cacheDir = opts.cacheDir;
  const rewriteDir = join(cacheDir, REWRITE_DIR);
  const stubsDir = join(cacheDir, STUBS_DIR);

  // Dirs are created lazily on first emit so an unused cache (no
  // shared modules in the project) costs zero IO.
  let dirsReady = false;
  async function ensureDirs(): Promise<void> {
    if (dirsReady) return;
    await Deno.mkdir(rewriteDir, { recursive: true });
    await Deno.mkdir(stubsDir, { recursive: true });
    dirsReady = true;
  }

  /** Map<absPath, rewritePath> — what's currently materialized on disk. */
  const emittedRewrites = new Map<string, string>();
  /** Map<moduleId, stubPath> — same, for stubs. */
  const emittedStubs = new Map<string, string>();

  function pathHash(absPath: string): string {
    // Stable, filesystem-safe slug. We don't need cryptographic
    // strength — just collision-avoidance across distinct paths in
    // the same cache run. Hex of FNV-1a 64-bit is plenty.
    let h1 = 0x811c9dc5n;
    const prime = 0x01000193n;
    const bytes = new TextEncoder().encode(absPath);
    for (const b of bytes) {
      h1 = (h1 ^ BigInt(b)) * prime & 0xffffffffffffffffn;
    }
    return h1.toString(16).padStart(16, "0");
  }

  function rewritePathFor(absPath: string): string {
    // Keep a hint of the original filename so cache entries are
    // recognisable when a developer pokes around. The hash makes it
    // unique even across two files with the same basename.
    const base = absPath.split(/[\\/]/).pop() ?? "f";
    const safe = base.replace(/[^A-Za-z0-9_.-]/g, "_");
    return join(rewriteDir, `${pathHash(absPath)}.${safe}`);
  }

  function stubPathFor(moduleId: string): string {
    const safe = moduleId.replace(/[^A-Za-z0-9_-]/g, "_");
    return join(stubsDir, `${safe}.js`);
  }

  async function ensureStub(record: SharedModuleRecord): Promise<string> {
    const cached = emittedStubs.get(record.id);
    if (cached) return cached;
    await ensureDirs();
    const out = stubPathFor(record.id);
    await Deno.writeTextFile(out, sharedModuleStubSource(record));
    emittedStubs.set(record.id, out);
    return out;
  }

  async function readResolvedImports(
    absPath: string,
  ): Promise<{ source: string; imports: ResolvedImport[] }> {
    await ensureLexerReady();
    const source = await Deno.readTextFile(absPath);
    const [imports] = parseImports(source);
    const dirAbs = dirname(absPath);
    const out: ResolvedImport[] = [];
    for (const imp of imports) {
      // s/e are the byte positions of the SPECIFIER (without quotes
      // for static imports). `n` is the parsed value when the
      // specifier is a string literal (i.e. always for static
      // imports; null only for `import("dynamic" + var)` which we
      // don't try to rewrite).
      const specifier = imp.n;
      if (typeof specifier !== "string") continue;
      const start = imp.s;
      const end = imp.e;
      out.push(classifyImport(specifier, dirAbs, start, end));
    }
    return { source, imports: out };
  }

  function classifyImport(
    specifier: string,
    importerDir: string,
    start: number,
    end: number,
  ): ResolvedImport {
    if (
      /^[a-z][a-z0-9+.-]*:/i.test(specifier) &&
      !specifier.startsWith("file:")
    ) {
      return { specifier, kind: "external", start, end };
    }
    let absPath: string;
    if (specifier.startsWith("file:")) {
      try {
        absPath = fileURLToPath(specifier);
      } catch {
        return { specifier, kind: "unknown", start, end };
      }
    } else if (
      specifier.startsWith("./") || specifier.startsWith("../") ||
      specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier)
    ) {
      try {
        absPath = fileURLToPath(
          new URL(specifier, pathToFileURL(importerDir + "/").href).href,
        );
      } catch {
        return { specifier, kind: "unknown", start, end };
      }
    } else {
      // Bare specifier with no scheme — handled by the host's import
      // map, which we don't reproduce here. Treat as external.
      return { specifier, kind: "external", start, end };
    }
    const sharedRecord = opts.sharedRuntime.bySourcePath(absPath);
    if (sharedRecord) {
      return { specifier, kind: "shared", absPath, start, end };
    }
    return { specifier, kind: "file", absPath, start, end };
  }

  async function rewrite(req: RewriteRequest): Promise<RewriteResult> {
    if (opts.sharedRuntime.list().length === 0) {
      return {
        entryUrl: pathToFileURL(req.entryPath).href,
        rewritten: false,
        emittedRewrites: [],
      };
    }

    // Phase 1: read + resolve imports for every file in the graph.
    const planned = new Map<string, PlannedFile>();
    for (const abs of req.graphPaths) {
      const { source, imports } = await readResolvedImports(abs);
      const fileImports = new Map<string, ResolvedImport>();
      for (const r of imports) {
        if ((r.kind === "file" || r.kind === "shared") && r.absPath) {
          fileImports.set(r.absPath, r);
        }
      }
      planned.set(abs, {
        abs,
        rewritePath: rewritePathFor(abs),
        fileImports,
        source,
      });
    }

    // Phase 2: compute the taint set. Initial = files importing a
    // shared module directly. Then iterate: any file that imports a
    // tainted file is itself tainted (it'd otherwise still resolve
    // its `./dep.ts` to the un-rewritten dep, missing the
    // interception). Fixpoint terminates in O(graph) since taint
    // only grows.
    const tainted = new Set<string>();
    for (const [abs, p] of planned) {
      for (const imp of p.fileImports.values()) {
        if (imp.kind === "shared") {
          tainted.add(abs);
          break;
        }
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [abs, p] of planned) {
        if (tainted.has(abs)) continue;
        for (const importedAbs of p.fileImports.keys()) {
          if (tainted.has(importedAbs)) {
            tainted.add(abs);
            changed = true;
            break;
          }
        }
      }
    }

    if (!tainted.has(req.entryPath)) {
      // No shared imports anywhere on the path from entry to leaves;
      // keep the original.
      return {
        entryUrl: pathToFileURL(req.entryPath).href,
        rewritten: false,
        emittedRewrites: [],
      };
    }

    // Phase 3: emit rewritten copies for every tainted file.
    await ensureDirs();
    const emittedNow: string[] = [];
    for (const abs of tainted) {
      const plan = planned.get(abs);
      if (!plan) continue;
      // Skip if a previous rewrite of this file is still valid; the
      // hot reloader calls `invalidate(abs)` when the file changes.
      if (emittedRewrites.has(abs)) continue;
      const rewrittenSource = await renderRewrite(plan, planned, tainted);
      await Deno.writeTextFile(plan.rewritePath, rewrittenSource);
      emittedRewrites.set(abs, plan.rewritePath);
      emittedNow.push(plan.rewritePath);
    }

    const entryPlan = planned.get(req.entryPath);
    if (!entryPlan) {
      throw new Error(`entry not in graphPaths: ${req.entryPath}`);
    }
    return {
      entryUrl: pathToFileURL(entryPlan.rewritePath).href,
      rewritten: true,
      emittedRewrites: emittedNow,
    };
  }

  async function renderRewrite(
    plan: PlannedFile,
    planned: Map<string, PlannedFile>,
    tainted: Set<string>,
  ): Promise<string> {
    // String-splice: walk imports in source order and replace the
    // specifier substring. Lex output is sorted by position by
    // construction, so a single forward pass with a running offset
    // works.
    const { source } = plan;
    const replacements: Array<{ start: number; end: number; with: string }> =
      [];
    // Re-resolve imports against this file's source — same data we
    // captured in `fileImports` but with the original positions.
    const dirAbs = dirname(plan.abs);
    const [parsed] = parseImports(source);
    for (const imp of parsed) {
      const specifier = imp.n;
      if (typeof specifier !== "string") continue;
      const r = classifyImport(specifier, dirAbs, imp.s, imp.e);
      let replacement: string | null = null;
      if (r.kind === "shared" && r.absPath) {
        const record = opts.sharedRuntime.bySourcePath(r.absPath);
        if (record) {
          const stubPath = await ensureStub(record);
          replacement = pathToFileURL(stubPath).href;
        }
      } else if (r.kind === "file" && r.absPath) {
        if (tainted.has(r.absPath)) {
          const dep = planned.get(r.absPath);
          if (dep) replacement = pathToFileURL(dep.rewritePath).href;
        } else {
          // Non-tainted: turn into an absolute file:// URL so the
          // rewritten file (in the cache dir) can still resolve it.
          replacement = pathToFileURL(r.absPath).href;
        }
      }
      // external / unknown: leave specifier alone.
      if (replacement !== null) {
        // For static imports (`import x from "spec"`) the lexer
        // reports [s, e) over just the specifier text (no quotes),
        // so writing the bare URL is correct. For dynamic imports
        // (`await import("spec")`) the slice covers the entire
        // argument expression including the quotes, so we must
        // re-quote the replacement or we'd produce
        // `import(file:///...)` — a parse error. Same goes for
        // template literals; we normalise to a plain string since
        // the URL never contains characters that would need
        // escaping in a JSON string. Detect by sniffing the first
        // char of the slice.
        const first = source.charAt(r.start);
        const isQuoted = first === '"' || first === "'" || first === "`";
        replacements.push({
          start: r.start,
          end: r.end,
          with: isQuoted ? JSON.stringify(replacement) : replacement,
        });
      }
    }

    if (replacements.length === 0) return source;
    let out = "";
    let cursor = 0;
    for (const r of replacements) {
      out += source.slice(cursor, r.start);
      out += r.with;
      cursor = r.end;
    }
    out += source.slice(cursor);
    return out;
  }

  return {
    rewrite,
    invalidate(absPath) {
      const out = emittedRewrites.get(absPath);
      if (!out) return;
      emittedRewrites.delete(absPath);
      Deno.remove(out).catch(() => {});
    },
    invalidateStub(moduleId) {
      const out = emittedStubs.get(moduleId);
      if (!out) return;
      emittedStubs.delete(moduleId);
      Deno.remove(out).catch(() => {});
      // Stubs are referenced by tainted rewrites; invalidate every
      // rewrite too so they're regenerated against the new stub
      // (path may be the same, but content/exports may have changed).
      for (const [abs, p] of [...emittedRewrites]) {
        emittedRewrites.delete(abs);
        Deno.remove(p).catch(() => {});
      }
    },
    inspect() {
      return {
        rewrites: [...emittedRewrites.values()],
        stubs: [...emittedStubs.values()],
      };
    },
    async stop() {
      try {
        await Deno.remove(cacheDir, { recursive: true });
      } catch { /* */ }
    },
  };
}
