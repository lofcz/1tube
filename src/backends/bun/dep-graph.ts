/**
 * Per-function dependency graph for the Bun backend.
 *
 * Two jobs:
 *
 *   1. HMR precision. A file change maps to exactly the functions that
 *      transitively import it, so touching `_shared/x.ts` reloads only its
 *      importers instead of everything.
 *   2. Dependency pre-install. While walking, every `npm:` / `jsr:` request
 *      reachable from a function's local files is collected, so the host can
 *      install them in one batch BEFORE importing (the compat plugin's
 *      resolver is synchronous and would otherwise block per package).
 *
 * Only local files are walked. Imports are discovered with
 * `Bun.Transpiler#scanImports` (the same scanner Bun's bundler uses), and
 * resolved with Bun's resolver after import-map rewriting. Anything under
 * `node_modules`, `node:`/`bun:` builtins and remote URLs is a leaf: none of
 * them can fire a local fs event.
 *
 * Parsed imports are cached per file keyed by mtime + size, so building
 * graphs for 100 functions that share `_shared/*` parses each shared file
 * once, and an HMR refresh only re-reads what changed.
 */

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ImportMap, resolveImportMap } from "../../compat/import-map.ts";
import {
  isRemoteSpecifier,
  type PackageRequest,
  packageKey,
  parsePackageSpecifier,
} from "../../compat/specifiers.ts";

export { fileURLToPath, pathToFileURL };

export interface DepGraphOptions {
  /** The project's deno.json import map, if any. */
  importMap?: ImportMap;
}

export interface DepGraph {
  /**
   * Build (or rebuild) the graph for one function entry (path or file URL).
   * Unreadable / half-written files are tolerated: they become leaves.
   */
  refresh(name: string, entry: string): Promise<void>;
  /** {@link refresh} for many entries, sharing the parse cache. */
  refreshMany(entries: Iterable<{ name: string; entry: string }>): Promise<void>;
  /** Drop a function's graph (its entry was deleted). */
  forget(name: string): void;
  /** Names whose graph contains any of `changedFiles` (paths or file URLs). */
  affected(changedFiles: Iterable<string>): Set<string>;
  /** Absolute paths of every local file in `name`'s graph, entry included. */
  filesFor(name: string): readonly string[];
  /** `npm:`/`jsr:` requests reachable from `name`'s local files. */
  packagesFor(name: string): readonly PackageRequest[];
  /** Remote (`https:`) modules imported directly from local files. */
  remotesFor(name: string): readonly string[];
  /** Total number of distinct local files tracked. */
  readonly size: number;
}

interface ParsedFile {
  mtimeMs: number;
  size: number;
  /** Resolved local dependency paths. */
  files: string[];
  packages: PackageRequest[];
  remotes: string[];
}

interface FunctionGraph {
  files: Set<string>;
  packages: Map<string, PackageRequest>;
  remotes: Set<string>;
}

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

const transpilers = new Map<string, Bun.Transpiler>();
function transpilerFor(path: string): Bun.Transpiler | null {
  const loader = LOADERS[extname(path).toLowerCase()];
  if (!loader) return null;
  let t = transpilers.get(loader);
  if (!t) {
    t = new Bun.Transpiler({ loader });
    transpilers.set(loader, t);
  }
  return t;
}

function toPath(pathOrUrl: string): string {
  if (pathOrUrl.startsWith("file://")) return fileURLToPath(pathOrUrl);
  return pathOrUrl;
}

/**
 * Reverse-index key. Watcher paths and resolver output can disagree on
 * case and separators on Windows; elsewhere paths are compared verbatim.
 */
const fileKey = process.platform === "win32"
  ? (p: string) => p.replace(/\\/g, "/").toLowerCase()
  : (p: string) => p;

function isDependencyPath(p: string): boolean {
  return /[\\/]node_modules[\\/]/.test(p);
}

export function createDepGraph(options: DepGraphOptions = {}): DepGraph {
  const perName = new Map<string, FunctionGraph>();
  const reverse = new Map<string, Set<string>>();
  const parsed = new Map<string, ParsedFile>();

  /** Classify + resolve one specifier imported from `importer`. */
  function classify(
    spec: string,
    importer: string,
    out: { files: string[]; packages: PackageRequest[]; remotes: string[] },
    depth = 0,
  ): void {
    if (depth > 4) return;
    if (spec.startsWith("node:") || spec.startsWith("bun:")) return;
    const pkg = parsePackageSpecifier(spec);
    if (pkg) {
      out.packages.push(pkg);
      return;
    }
    if (isRemoteSpecifier(spec)) {
      out.remotes.push(spec);
      return;
    }
    if (spec.startsWith("file://")) {
      out.files.push(fileURLToPath(spec));
      return;
    }
    const pathLike = spec.startsWith("./") || spec.startsWith("../") ||
      spec.startsWith("/");
    if (!pathLike) {
      const mapped = resolveImportMap(
        spec,
        pathToFileURL(importer).href,
        options.importMap,
      );
      if (mapped !== null) {
        classify(mapped, importer, out, depth + 1);
        return;
      }
    }
    try {
      const resolved = Bun.resolveSync(spec, dirname(importer));
      if (!isDependencyPath(resolved)) out.files.push(resolved);
    } catch {
      // Bare package or a not-yet-written file: a leaf either way. A file
      // that appears later is picked up by the next refresh.
      if (pathLike) {
        out.files.push(fileURLToPath(new URL(spec, pathToFileURL(importer))));
      }
    }
  }

  async function parseFile(path: string): Promise<ParsedFile | null> {
    let st;
    try {
      st = statSync(path);
    } catch {
      parsed.delete(path);
      return null;
    }
    const cached = parsed.get(path);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached;
    }
    const transpiler = transpilerFor(path);
    const entry: ParsedFile = {
      mtimeMs: st.mtimeMs,
      size: st.size,
      files: [],
      packages: [],
      remotes: [],
    };
    if (transpiler) {
      try {
        const code = await readFile(path, "utf8");
        for (const imp of transpiler.scanImports(code)) {
          classify(imp.path, path, entry);
        }
      } catch {
        // Syntax error mid-edit: no edges until the next clean save.
      }
    }
    parsed.set(path, entry);
    return entry;
  }

  /**
   * Per-refresh memo: within one refresh every file is stat-validated (and,
   * on a miss, parsed) once, however many functions share it. Without it a
   * 200-function project with a common `_shared` tree pays one stat per
   * file per function — tens of seconds on a slow disk.
   */
  type Batch = Map<string, Promise<ParsedFile | null>>;

  function parseOnce(batch: Batch, path: string): Promise<ParsedFile | null> {
    let p = batch.get(path);
    if (!p) batch.set(path, p = parseFile(path));
    return p;
  }

  async function walk(entry: string, batch: Batch = new Map()): Promise<FunctionGraph> {
    const g: FunctionGraph = {
      files: new Set([entry]),
      packages: new Map(),
      remotes: new Set(),
    };
    let frontier = [entry];
    while (frontier.length > 0) {
      const results = await Promise.all(frontier.map((f) => parseOnce(batch, f)));
      const next: string[] = [];
      for (const r of results) {
        if (!r) continue;
        for (const pkg of r.packages) g.packages.set(packageKey(pkg), pkg);
        for (const url of r.remotes) g.remotes.add(url);
        for (const f of r.files) {
          if (g.files.has(f)) continue;
          g.files.add(f);
          next.push(f);
        }
      }
      frontier = next;
    }
    return g;
  }

  function indexAdd(name: string, file: string): void {
    const k = fileKey(file);
    let set = reverse.get(k);
    if (!set) reverse.set(k, set = new Set());
    set.add(name);
  }

  function indexRemove(name: string, file: string): void {
    const k = fileKey(file);
    const set = reverse.get(k);
    if (!set) return;
    set.delete(name);
    if (set.size === 0) reverse.delete(k);
  }

  function replace(name: string, fresh: FunctionGraph): void {
    const old = perName.get(name);
    if (old) {
      for (const f of old.files) if (!fresh.files.has(f)) indexRemove(name, f);
    }
    for (const f of fresh.files) {
      if (!old || !old.files.has(f)) indexAdd(name, f);
    }
    perName.set(name, fresh);
  }

  return {
    async refresh(name, entry) {
      replace(name, await walk(toPath(entry)));
    },
    async refreshMany(entries) {
      const batch: Batch = new Map();
      await Promise.all(
        [...entries].map(async (e) => replace(e.name, await walk(toPath(e.entry), batch))),
      );
    },
    forget(name) {
      const old = perName.get(name);
      if (!old) return;
      for (const f of old.files) indexRemove(name, f);
      perName.delete(name);
    },
    affected(changedFiles) {
      const out = new Set<string>();
      for (const raw of changedFiles) {
        const owners = reverse.get(fileKey(toPath(raw)));
        if (!owners) continue;
        for (const n of owners) out.add(n);
      }
      return out;
    },
    filesFor(name) {
      return [...(perName.get(name)?.files ?? [])];
    },
    packagesFor(name) {
      return [...(perName.get(name)?.packages.values() ?? [])];
    },
    remotesFor(name) {
      return [...(perName.get(name)?.remotes ?? [])];
    },
    get size() {
      return reverse.size;
    },
  };
}
