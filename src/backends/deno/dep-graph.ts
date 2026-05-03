/**
 * Per-function dependency graph for the Deno backend's HMR.
 *
 * Wraps `jsr:@deno/graph` (the same module-graph engine the Deno CLI uses)
 * to compute the set of `file://` URLs that each function transitively
 * imports. With those graphs in hand, a single fs change maps to the exact
 * set of functions whose Worker needs to be restarted — no more
 * "anything under `_shared/` triggers a full reload" heuristic.
 *
 * Only `file://` URLs are tracked. `npm:`, `jsr:`, `https:` and `node:`
 * deps cannot fire local fs watcher events, so they would never be
 * "changed" anyway; including them in the reverse index is wasted RAM.
 *
 * Bare specifiers from `deno.json` `imports` are resolved through a
 * tiny in-process import-map resolver (longest-prefix-wins, exact-match
 * preferred). This is the Deno CLI's own algorithm reduced to its
 * essentials — sufficient for typical edge-function projects.
 *   import "@db/util"   →  imports: { "@db/util": "./_shared/util.ts" }
 * resolves to the file URL the user actually edits, and the graph
 * tracks it correctly.
 */

// Direct `jsr:` specifier (not the `@deno/graph` import-map alias from
// our own deno.json) so this module loads cleanly when 1tube is
// consumed from a host project's node_modules — host configs do not
// mirror our import map. Same convention as every other src/ file.
import { createGraph } from "jsr:@deno/graph@^0.108";
import { fileURLToPath, pathToFileURL } from "node:url";

// Local re-export for callers that prefer std/path-style names. Underlying
// implementations come from node:url so this module loads from node_modules
// in any host project without extra import-map plumbing.
export { fileURLToPath, pathToFileURL };

export interface DepGraphOptions {
  /**
   * Parsed `imports` field from the host project's deno.json. Used to
   * resolve bare specifiers to file URLs when the user wires
   * `_shared` etc. through an import map alias. Optional; if absent,
   * only relative imports are tracked precisely.
   */
  importMap?: Readonly<Record<string, string>>;
  /**
   * Absolute path of the deno.json the import map came from. Import
   * map values are resolved relative to this. Required when
   * `importMap` is set.
   */
  importMapBase?: string;
}

export interface DepGraph {
  /**
   * Build (or rebuild) the graph for one function entry. Replaces any
   * prior graph for `name`. Resolves once the graph is ready; transient
   * graph errors (missing files mid-edit) are swallowed so a save
   * burst with a half-written file doesn't crash the watcher.
   */
  refresh(name: string, entryFileUrl: string): Promise<void>;
  /** Drop a function's graph. Used when an `index.ts` is deleted. */
  forget(name: string): void;
  /**
   * Names whose graph contains any of `changedFiles`. Inputs are
   * accepted as either absolute paths or `file://` URLs; both are
   * normalized internally.
   */
  affected(changedFiles: Iterable<string>): Set<string>;
  /**
   * Absolute file paths of every file in `name`'s graph (including
   * the entry). Returns an empty array if no graph has been built
   * for `name`. Used by the source rewriter to emit shared-module
   * stubs into a function's transitive deps.
   */
  filesFor(name: string): readonly string[];
  /** Total number of distinct file URLs currently tracked. */
  readonly size: number;
}

/**
 * Normalize a path-or-URL to a canonical `file:///...` string with
 * forward-slash separators (matches what deno_graph emits for module
 * specifiers). Falls back to the original string on parse failure so
 * non-file specifiers aren't accidentally mangled.
 */
function normalize(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("file://")) return new URL(pathOrUrl).href;
  try {
    return pathToFileURL(pathOrUrl).href;
  } catch {
    return pathOrUrl;
  }
}

/**
 * Resolve `specifier` against `importMap` using the same prefix rules
 * Deno applies. Returns the rewritten specifier or null when no entry
 * matches.
 */
function applyImportMap(
  specifier: string,
  importMap: Readonly<Record<string, string>>,
  base: string,
): string | null {
  const exact = importMap[specifier];
  if (exact !== undefined) return resolveAgainst(exact, base);
  let bestKey: string | null = null;
  for (const key of Object.keys(importMap)) {
    if (!key.endsWith("/")) continue;
    if (!specifier.startsWith(key)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  if (bestKey === null) return null;
  const target = importMap[bestKey] + specifier.slice(bestKey.length);
  return resolveAgainst(target, base);
}

function resolveAgainst(target: string, base: string): string {
  // Bare URLs (npm:/jsr:/https:/file:) pass through unchanged. Relative
  // paths get resolved against the import map's deno.json directory so
  // `./_shared/x.ts` in deno.json points where the user expects.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return target;
  const baseUrl = base.startsWith("file://") ? base : pathToFileURL(base).href;
  return new URL(target, baseUrl).href;
}

export function createDepGraph(options?: DepGraphOptions): DepGraph {
  const perName = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();

  const importMap = options?.importMap;
  const importMapBase = options?.importMapBase;

  const resolve = importMap && importMapBase
    ? (specifier: string, referrer: string): string => {
      const rewritten = applyImportMap(specifier, importMap, importMapBase);
      if (rewritten !== null) return rewritten;
      // Fall through to standard resolution against the referrer.
      try {
        return new URL(specifier, referrer).href;
      } catch {
        return specifier;
      }
    }
    : undefined;

  function indexAdd(name: string, fileUrl: string): void {
    let set = reverse.get(fileUrl);
    if (!set) {
      set = new Set();
      reverse.set(fileUrl, set);
    }
    set.add(name);
  }

  function indexRemove(name: string, fileUrl: string): void {
    const set = reverse.get(fileUrl);
    if (!set) return;
    set.delete(name);
    if (set.size === 0) reverse.delete(fileUrl);
  }

  return {
    async refresh(name, entryFileUrl) {
      const entry = normalize(entryFileUrl);
      let graph;
      try {
        graph = await createGraph([entry], resolve ? { resolve } : undefined);
      } catch {
        // A save mid-flush can leave a syntactically broken file on
        // disk; deno_graph throws. Drop the graph for `name` so the
        // affected-set reverts to "this entry only" and let the next
        // (clean) save rebuild it. Better than dying.
        const old = perName.get(name);
        if (old) {
          for (const f of old) indexRemove(name, f);
        }
        const minimal = new Set<string>([entry]);
        perName.set(name, minimal);
        indexAdd(name, entry);
        return;
      }

      const fresh = new Set<string>();
      for (const mod of graph.modules ?? []) {
        const spec: string | undefined = mod?.specifier;
        if (typeof spec !== "string") continue;
        if (!spec.startsWith("file://")) continue;
        fresh.add(spec);
      }
      // Always include the entry, even if deno_graph short-circuited
      // due to a load error on a child.
      fresh.add(entry);

      const old = perName.get(name);
      if (old) {
        for (const f of old) {
          if (!fresh.has(f)) indexRemove(name, f);
        }
      }
      for (const f of fresh) {
        if (!old || !old.has(f)) indexAdd(name, f);
      }
      perName.set(name, fresh);
    },

    filesFor(name) {
      const set = perName.get(name);
      if (!set) return [];
      const out: string[] = [];
      for (const url of set) {
        try {
          out.push(fileURLToPath(url));
        } catch { /* */ }
      }
      return out;
    },

    forget(name) {
      const old = perName.get(name);
      if (!old) return;
      for (const f of old) indexRemove(name, f);
      perName.delete(name);
    },

    affected(changedFiles) {
      const out = new Set<string>();
      for (const raw of changedFiles) {
        const url = normalize(raw);
        const owners = reverse.get(url);
        if (!owners) continue;
        for (const n of owners) out.add(n);
      }
      return out;
    },

    get size() {
      return reverse.size;
    },
  };
}

/**
 * Best-effort path resolver for paths that may have come from
 * `Deno.watchFs` (which emits OS-native paths). Exposed for tests
 * and callers that want to compare a file URL against a watched
 * path without going through the graph.
 */
export function fileUrlOrPath(input: string): string {
  if (input.startsWith("file://")) {
    try {
      return fileURLToPath(input);
    } catch {
      return input;
    }
  }
  return input;
}
