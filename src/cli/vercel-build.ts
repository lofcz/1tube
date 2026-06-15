/**
 * `1tube vercel-build` — compile edge functions into Vercel Build Output API
 * function artifacts.
 *
 * Unlike `1tube build` (which produces a workerd `dist/` + `manifest.json`),
 * this command emits one Vercel Node Function per edge function, laid out for
 * the Build Output API so `vercel deploy --prebuilt` ships them as-is:
 *
 *     .vercel/output/
 *       functions/
 *         functions/v1/<name>.func/
 *           .vc-config.json        — runtime + handler + streaming/maxDuration
 *           package.json           — { "type": "module" } so .js is treated ESM
 *           functions/<name>.js    — esbuild entry (the Vercel Node handler)
 *           chunks/<hash>.js       — shared ESM chunks (copied per function)
 *
 * A function placed at `functions/functions/v1/<name>.func` is served by Vercel
 * at the route `/functions/v1/<name>` — matching the path shape the frontend
 * already calls (see sciobot's `API_CONFIG`). No per-function source changes are
 * required: the Vercel bundle wrapper captures `Deno.serve` and bridges Node
 * req/res to the Web fetch handler (see `../backends/vercel/wrapper.ts`).
 *
 * Vercel's filesystem routing matches a `.func` only on its EXACT path, so
 * `/functions/v1/rooms/<id>` would 404. Supabase's edge-runtime instead routes
 * on the first path segment and forwards the whole request to the function, so
 * path-based routers handle their own sub-paths. To reproduce that, this command
 * also merges a per-function "main"-phase rewrite into `config.json` mapping
 * `/<prefix>/<name>/<rest>` back to the bare function path (see
 * {@link mergeSubpathRoutes}).
 *
 * This command MERGES into an existing `.vercel/output` (e.g. one produced by
 * `vercel build` for the static frontend). It only creates/replaces the
 * specific `.func` directories and additively edits `config.json`'s `routes`
 * (preserving the frontend's existing routes and static assets); it never wipes
 * the output root.
 *
 * Each function is fully standalone — there is no gateway shared runtime on
 * Vercel, so modules like `_shared/profile-cache.ts` are bundled inline rather
 * than turned into RPC stubs.
 */

import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  bundleAllChunked,
  type ChunkedBundleAllResult,
  DEFAULT_ESBUILD_TARGET,
  discoverEntrypoints,
  disposeBundlerResources,
} from "../bundler/core.ts";
import { VERCEL_PROFILE } from "../backends/vercel/bundle-profile.ts";
import { captureDeclaredServeConfigs } from "../backends/vercel/capture-config.ts";
import { loadManifest } from "../manifest.ts";
import { resolveDenoConfigPath } from "./deno-config.ts";

/** Default Vercel managed Node runtime for emitted functions. */
const DEFAULT_RUNTIME = "nodejs24.x";
/** Default route prefix; matches sciobot's `/functions/v1/<name>` calls. */
const DEFAULT_PATH_PREFIX = "functions/v1";
/**
 * Default function timeout (seconds) when a function declares no timeout via
 * `serve({ timeoutMs })` (or a `1tube.json` manifest). Defaults to the cap so
 * long-running AI pipelines aren't silently truncated unless a function opts
 * into a shorter timeout.
 */
const DEFAULT_MAX_DURATION = 800;
/** Upper bound for maxDuration (seconds). Fluid/Pro allows long durations. */
const DEFAULT_MAX_DURATION_CAP = 800;

export interface VercelBuildOptions {
  functionsDir: string;
  /** Build Output API root, typically `.vercel/output`. */
  outDir: string;
  /** Path to host project's deno.json (for esbuild's Deno loader import map). */
  configPath?: string;
  /** Restrict the build to a subset of function names. */
  only?: readonly string[];
  /** Sourcemap mode. Defaults to "linked". */
  sourcemap?: boolean | "linked" | "inline";
  /** Minify bundles. Defaults to false. */
  minify?: boolean;
  /** ECMAScript target forwarded to esbuild. Defaults to {@link DEFAULT_ESBUILD_TARGET}. */
  esbuildTarget?: string | string[];
  /** Route prefix under `functions/`. Defaults to "functions/v1". */
  pathPrefix?: string;
  /** Vercel runtime identifier. Defaults to "nodejs24.x". */
  runtime?: string;
  /**
   * Fallback maxDuration (seconds) when a function declares no `timeoutMs`
   * (via `serve({ timeoutMs })` or `1tube.json`).
   */
  defaultMaxDuration?: number;
  /** Hard cap (seconds) applied to any derived maxDuration. */
  maxDurationCap?: number;
  /** Progress callback for CLI/status reporting. */
  onProgress?: (event: VercelBuildProgress) => void;
}

export type VercelBuildProgress =
  | { phase: "bundle-start"; functions: number }
  | {
    phase: "bundle-complete";
    functions: number;
    chunks: number;
    durationMs: number;
  }
  | {
    phase: "emit-function";
    name: string;
    route: string;
    bytes: number;
    maxDuration: number;
  }
  | {
    phase: "config-merge";
    configPath: string;
    routes: number;
    created: boolean;
  }
  | { phase: "capture-warning"; message: string };

export interface VercelFunctionEntry {
  /** Logical function name. */
  name: string;
  /** Public route, e.g. `functions/v1/hello`. */
  route: string;
  /** Absolute path to the emitted `<name>.func` directory. */
  funcDir: string;
  /** Handler path relative to `funcDir` (POSIX), e.g. `functions/hello.js`. */
  handler: string;
  /** All module files copied into the func dir (POSIX, entry first). */
  moduleFiles: string[];
  /** Entry bundle byte size. */
  byteLength: number;
  /** Derived Vercel maxDuration (seconds). */
  maxDuration: number;
}

export interface VercelBuildResult {
  /** Build Output API root. */
  outDir: string;
  /** Absolute path to `<outDir>/functions/<pathPrefix>`. */
  functionsRoot: string;
  /** Runtime baked into each `.vc-config.json`. */
  runtime: string;
  /** Effective route prefix. */
  pathPrefix: string;
  /** Emitted functions, sorted by name. */
  functions: VercelFunctionEntry[];
  /** Absolute path to the Build Output API `config.json` that was merged. */
  configPath: string;
  /** Number of per-function sub-path routes written into `config.json`. */
  subpathRoutes: number;
  durationMs: number;
}

/** `.vc-config.json` shape for a Build Output API Node function. */
interface VcConfig {
  runtime: string;
  handler: string;
  launcherType: "Nodejs";
  shouldAddHelpers: boolean;
  shouldAddSourcemapSupport: boolean;
  supportsResponseStreaming: boolean;
  maxDuration: number;
}

async function removeDirIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

/**
 * Convert a per-function `timeoutMs` into a Vercel maxDuration (seconds),
 * clamped to `[1, cap]`. Falls back to `def` when no timeout is configured.
 */
function clampMaxDuration(
  timeoutMs: number | undefined,
  def: number,
  cap: number,
): number {
  const base = typeof timeoutMs === "number" && timeoutMs > 0
    ? Math.ceil(timeoutMs / 1000)
    : def;
  return Math.max(1, Math.min(cap, base));
}

function normalizePrefix(prefix: string): string {
  return prefix.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "").replace(
    /\\/g,
    "/",
  );
}

/** Escape a string for safe literal use inside a regular expression. */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Minimal shape of a Build Output API route entry we read or write. */
interface VercelRoute {
  handle?: string;
  src?: string;
  dest?: string;
  [key: string]: unknown;
}

/** Minimal shape of `.vercel/output/config.json` (Build Output API v3). */
interface VercelOutputConfig {
  version?: number;
  routes?: VercelRoute[];
  [key: string]: unknown;
}

/**
 * Add, per function, a "main"-phase rewrite mapping `/<prefix>/<name>/<rest>`
 * to the bare function path `/<prefix>/<name>` so a single Vercel Node Function
 * also serves all of its sub-paths.
 *
 * Why this is needed: Vercel's filesystem routing matches a `.func` only on its
 * exact path, so `/<prefix>/rooms/<id>` would 404. Supabase's edge-runtime
 * instead routes on the first path segment and forwards the whole request to the
 * function (`worker.fetch(req)`) — the behaviour path-based routers such as
 * sciobot's `rooms` handler rely on. A *regular* serverless function receives
 * the UNMODIFIED original URL through a rewrite (only prerender functions get
 * the rewritten path), so the function still sees the sub-path in
 * `url.pathname`.
 *
 * The routes go in the main phase (before the first `handle` marker) so each
 * rewrite is immediately followed by the filesystem lookup that resolves the
 * `.func`. The exact path (`/<prefix>/<name>`) is intentionally NOT matched — it
 * already resolves via filesystem routing — keeping the change purely additive.
 *
 * Existing routes are preserved; only this builder's own previously-written
 * sub-path routes (for the functions being built now) are replaced, so repeated
 * and `--only` builds stay idempotent.
 */
async function mergeSubpathRoutes(
  outDir: string,
  pathPrefix: string,
  functionNames: readonly string[],
): Promise<{ created: boolean; routeCount: number }> {
  const configPath = join(outDir, "config.json");

  let config: VercelOutputConfig | null = null;
  try {
    config = JSON.parse(
      await Deno.readTextFile(configPath),
    ) as VercelOutputConfig;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  const created = config === null;
  if (config === null) config = { version: 3, routes: [] };
  if (typeof config.version !== "number") config.version = 3;

  const existing = Array.isArray(config.routes) ? config.routes : [];

  const prefixRe = escapeRegExp(pathPrefix);
  const destPrefix = `/${pathPrefix}/`;
  const builtNames = new Set(functionNames);
  // The exact route a function `name` maps to. Used for BOTH emit and cleanup
  // so detection can never drift from generation (e.g. a prefix with regex
  // metacharacters is escaped identically in both).
  const routeFor = (name: string): Required<Pick<VercelRoute, "src" | "dest">> => ({
    src: `^/${prefixRe}/${escapeRegExp(name)}/.*$`,
    dest: `${destPrefix}${name}`,
  });

  // Drop our own previously-written routes for the functions being built now: a
  // route is ours iff its dest is the bare function path AND its src is exactly
  // what we would emit for that function. Gating on `builtNames` leaves routes
  // for other functions intact, so `--only` (incremental) builds are safe.
  const isOwnRoute = (r: VercelRoute): boolean => {
    if (r.handle !== undefined || typeof r.dest !== "string") return false;
    if (!r.dest.startsWith(destPrefix)) return false;
    const name = r.dest.slice(destPrefix.length);
    return builtNames.has(name) && r.src === routeFor(name).src;
  };
  const cleaned = existing.filter((r) => !isOwnRoute(r));

  const subpathRoutes: VercelRoute[] = [...builtNames]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => routeFor(name));

  // Place the routes in the main phase — before the first `handle` marker — so
  // each rewrite is immediately resolved against the filesystem (the `.func`).
  const markerIdx = cleaned.findIndex((r) => typeof r.handle === "string");
  config.routes = markerIdx === -1
    ? [...cleaned, ...subpathRoutes]
    : [
      ...cleaned.slice(0, markerIdx),
      ...subpathRoutes,
      ...cleaned.slice(markerIdx),
    ];

  await ensureDir(outDir);
  await Deno.writeTextFile(
    configPath,
    JSON.stringify(config, null, 2) + "\n",
  );
  return { created, routeCount: subpathRoutes.length };
}

async function buildVercelOnce(
  opts: VercelBuildOptions,
): Promise<VercelBuildResult> {
  const startedAt = performance.now();
  const cwd = Deno.cwd();
  const functionsDir = isAbsolute(opts.functionsDir)
    ? opts.functionsDir
    : resolvePath(cwd, opts.functionsDir);
  const outDir = isAbsolute(opts.outDir)
    ? opts.outDir
    : resolvePath(cwd, opts.outDir);
  const pathPrefix = normalizePrefix(opts.pathPrefix ?? DEFAULT_PATH_PREFIX);
  const runtime = opts.runtime ?? DEFAULT_RUNTIME;
  const sourcemap = opts.sourcemap ?? "linked";
  const defaultMaxDuration = opts.defaultMaxDuration ?? DEFAULT_MAX_DURATION;
  const maxDurationCap = opts.maxDurationCap ?? DEFAULT_MAX_DURATION_CAP;

  let inputs = await discoverEntrypoints(functionsDir);
  if (opts.only && opts.only.length > 0) {
    const allow = new Set(opts.only);
    inputs = inputs.filter((i) => allow.has(i.name));
  }
  if (inputs.length === 0) {
    throw new Error(
      `1tube vercel-build: no functions matched under ${functionsDir}` +
        (opts.only ? ` (only=${JSON.stringify(opts.only)})` : ""),
    );
  }

  // Bundle into a throwaway staging dir, then distribute each function's
  // module files into its own `.func` directory. Staging keeps the chunk
  // graph intact (shared chunks are emitted once) while letting us copy the
  // reachable set per function so each `.func` is self-contained.
  const stageDir = await Deno.makeTempDir({ prefix: "1tube-vercel-" });
  try {
    opts.onProgress?.({ phase: "bundle-start", functions: inputs.length });
    const bundleStart = performance.now();
    const chunked: ChunkedBundleAllResult = await bundleAllChunked({
      inputs,
      outDir: stageDir,
      profile: VERCEL_PROFILE,
      ...(opts.configPath ? { configPath: opts.configPath } : {}),
      sourcemap,
      minify: opts.minify ?? false,
      ...(opts.esbuildTarget ? { esbuildTarget: opts.esbuildTarget } : {}),
    });
    opts.onProgress?.({
      phase: "bundle-complete",
      functions: chunked.functions.length,
      chunks: chunked.chunks.length,
      durationMs: performance.now() - bundleStart,
    });

    // Read each function's declared `serve({ timeoutMs })` so it can drive
    // `maxDuration` without a side-car manifest. Done after bundling so the
    // entrypoints' module graph is already warm in Deno's cache; the deployed
    // function is unaffected (see capture-config.ts).
    const declaredConfigs = await captureDeclaredServeConfigs(
      inputs,
      (m) => opts.onProgress?.({ phase: "capture-warning", message: m }),
    );

    const functionsRoot = join(outDir, "functions", ...pathPrefix.split("/"));
    const entries: VercelFunctionEntry[] = [];

    for (const fn of chunked.functions) {
      const funcDir = join(functionsRoot, `${fn.name}.func`);
      // Replace any stale artifact so removed chunks don't linger.
      await removeDirIfExists(funcDir);

      for (const moduleFile of fn.moduleFiles) {
        const src = join(stageDir, moduleFile);
        const dest = join(funcDir, moduleFile);
        await ensureDir(dirname(dest));
        await Deno.copyFile(src, dest);
        if (sourcemap === "linked") {
          try {
            await Deno.copyFile(`${src}.map`, `${dest}.map`);
          } catch (err) {
            if (!(err instanceof Deno.errors.NotFound)) throw err;
          }
        }
      }

      const handler = fn.moduleFiles[0];
      const manifest = await loadManifest(functionsDir, fn.name);
      // A `serve({ timeoutMs })` declaration wins over the manifest, matching
      // the runtime precedence in `_shared/handler.ts`.
      const declaredTimeoutMs = declaredConfigs.get(fn.name)?.timeoutMs;
      const maxDuration = clampMaxDuration(
        declaredTimeoutMs ?? manifest.timeoutMs,
        defaultMaxDuration,
        maxDurationCap,
      );

      const vcConfig: VcConfig = {
        runtime,
        handler,
        launcherType: "Nodejs",
        shouldAddHelpers: false,
        shouldAddSourcemapSupport: sourcemap === "linked",
        supportsResponseStreaming: true,
        maxDuration,
      };
      await Deno.writeTextFile(
        join(funcDir, ".vc-config.json"),
        JSON.stringify(vcConfig, null, 2) + "\n",
      );
      // package.json with type:module so Vercel's Node launcher loads the
      // emitted `.js` files as ESM (esbuild output uses import/export).
      await Deno.writeTextFile(
        join(funcDir, "package.json"),
        JSON.stringify({ type: "module" }, null, 2) + "\n",
      );

      const route = `${pathPrefix}/${fn.name}`;
      entries.push({
        name: fn.name,
        route,
        funcDir,
        handler,
        moduleFiles: [...fn.moduleFiles],
        byteLength: fn.byteLength,
        maxDuration,
      });
      opts.onProgress?.({
        phase: "emit-function",
        name: fn.name,
        route,
        bytes: fn.byteLength,
        maxDuration,
      });
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Make every function also serve its sub-paths (e.g. /<prefix>/rooms/<id>),
    // matching Supabase edge-runtime's first-segment routing. Done after the
    // `.func` dirs exist so the rewrites resolve to real functions.
    const configPath = join(outDir, "config.json");
    const merge = await mergeSubpathRoutes(
      outDir,
      pathPrefix,
      entries.map((e) => e.name),
    );
    opts.onProgress?.({
      phase: "config-merge",
      configPath,
      routes: merge.routeCount,
      created: merge.created,
    });

    return {
      outDir,
      functionsRoot,
      runtime,
      pathPrefix,
      functions: entries,
      configPath,
      subpathRoutes: merge.routeCount,
      durationMs: performance.now() - startedAt,
    };
  } finally {
    await removeDirIfExists(stageDir);
  }
}

export async function buildVercel(
  opts: VercelBuildOptions,
): Promise<VercelBuildResult> {
  try {
    return await buildVercelOnce(opts);
  } finally {
    // Always release esbuild's worker subprocess — on Windows it otherwise
    // lingers and blocks deletion of the staging dir / output.
    await disposeBundlerResources().catch(() => {});
  }
}

/**
 * CLI entry point. Returns a process exit code (does not call `Deno.exit`).
 *
 * Recognised flags (all optional):
 *   --functions <path>     function source dirs (default ./supabase/functions)
 *   --out <path>           Build Output API root (default ./.vercel/output)
 *   --only A,B,C           build a subset of functions
 *   --sourcemap none|linked|inline   (default: linked)
 *   --minify               minify bundles
 *   --path-prefix <p>      route prefix under functions/ (default functions/v1)
 *   --runtime <id>         Vercel runtime (default nodejs24.x)
 *   --max-duration <s>     fallback maxDuration seconds (default 800)
 *   --max-duration-cap <s> hard cap for maxDuration (default 800)
 *   --config <path>        explicit deno.json path
 *   --no-config            skip the import map
 */
export async function runVercelBuild(args: string[]): Promise<number> {
  let functionsDir = Deno.env.get("FUNCTIONS_PATH") || "./supabase/functions";
  let outDir = "./.vercel/output";
  let only: string[] | undefined;
  let sourcemap: boolean | "linked" | "inline" = "linked";
  let minify = false;
  let esbuildTarget: string | undefined;
  let pathPrefix = DEFAULT_PATH_PREFIX;
  let runtime = DEFAULT_RUNTIME;
  let defaultMaxDuration = DEFAULT_MAX_DURATION;
  let maxDurationCap = DEFAULT_MAX_DURATION_CAP;
  let configPathArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--functions" || a === "-f") && args[i + 1]) {
      functionsDir = args[++i];
    } else if ((a === "--out" || a === "-o") && args[i + 1]) {
      outDir = args[++i];
    } else if (a === "--only" && args[i + 1]) {
      only = args[++i].split(",").map((s) => s.trim()).filter((s) =>
        s.length > 0
      );
    } else if (a === "--sourcemap" && args[i + 1]) {
      const v = args[++i];
      if (v === "none" || v === "false" || v === "off") sourcemap = false;
      else if (v === "inline") sourcemap = "inline";
      else if (v === "linked" || v === "true" || v === "on") {
        sourcemap = "linked";
      } else {
        console.error(`[1tube vercel-build] unknown --sourcemap value: ${v}`);
        return 2;
      }
    } else if (a === "--minify") {
      minify = true;
    } else if (a === "--ecma-target" && args[i + 1]) {
      esbuildTarget = args[++i];
    } else if (a.startsWith("--ecma-target=")) {
      esbuildTarget = a.slice("--ecma-target=".length);
    } else if (a === "--path-prefix" && args[i + 1]) {
      pathPrefix = args[++i];
    } else if (a.startsWith("--path-prefix=")) {
      pathPrefix = a.slice("--path-prefix=".length);
    } else if (a === "--runtime" && args[i + 1]) {
      runtime = args[++i];
    } else if (a.startsWith("--runtime=")) {
      runtime = a.slice("--runtime=".length);
    } else if (a === "--max-duration" && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error(
          `[1tube vercel-build] --max-duration must be a positive integer`,
        );
        return 2;
      }
      defaultMaxDuration = n;
    } else if (a === "--max-duration-cap" && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error(
          `[1tube vercel-build] --max-duration-cap must be a positive integer`,
        );
        return 2;
      }
      maxDurationCap = n;
    } else if (a === "--config" && args[i + 1]) {
      configPathArg = args[++i];
    } else if (a.startsWith("--config=")) {
      configPathArg = a.slice("--config=".length);
    } else if (a === "--no-config") {
      configPathArg = "";
    } else if (a === "--help" || a === "-h") {
      console.log(VERCEL_BUILD_USAGE);
      return 0;
    } else {
      console.error(
        `[1tube vercel-build] unknown argument: ${a}\n${VERCEL_BUILD_USAGE}`,
      );
      return 2;
    }
  }

  const configResult = await resolveDenoConfigPath({
    functionsDir,
    configArg: configPathArg,
    onMessage: (m) => console.log(`[1tube vercel-build] ${m}`),
  });
  if (configResult.error) {
    console.error(`[1tube vercel-build] ${configResult.error}`);
    return 2;
  }
  const configPath = configResult.configPath;

  console.log(
    `[1tube vercel-build] bundling functions from ${functionsDir} → ${outDir} ` +
      `(runtime ${runtime}, route /${normalizePrefix(pathPrefix)}/<name>)`,
  );
  const fmt = (n: number) => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  };

  try {
    const result = await buildVercel({
      functionsDir,
      outDir,
      ...(configPath ? { configPath } : {}),
      ...(only ? { only } : {}),
      sourcemap,
      minify,
      ...(esbuildTarget ? { esbuildTarget } : {}),
      pathPrefix,
      runtime,
      defaultMaxDuration,
      maxDurationCap,
      onProgress(event) {
        if (event.phase === "bundle-start") {
          console.log(
            `[1tube vercel-build] bundling ${event.functions} function(s) for Vercel Node…`,
          );
        } else if (event.phase === "bundle-complete") {
          console.log(
            `[1tube vercel-build] bundled ${event.functions} function(s) and ${event.chunks} chunk(s) in ${
              event.durationMs.toFixed(0)
            }ms`,
          );
        } else if (event.phase === "emit-function") {
          console.log(
            `[1tube vercel-build]   /${event.route} → ${
              fmt(event.bytes)
            } (maxDuration ${event.maxDuration}s)`,
          );
        } else if (event.phase === "config-merge") {
          console.log(
            `[1tube vercel-build] ${
              event.created ? "wrote" : "merged"
            } ${event.routes} sub-path route(s) into ${event.configPath}`,
          );
        } else if (event.phase === "capture-warning") {
          console.warn(`[1tube vercel-build] ${event.message}`);
        }
      },
    });

    const totalBytes = result.functions.reduce((acc, f) => acc + f.byteLength, 0);
    console.log(
      `[1tube vercel-build] emitted ${result.functions.length} function(s) ` +
        `(${fmt(totalBytes)}) into ${result.functionsRoot} in ${
          result.durationMs.toFixed(0)
        }ms`,
    );
    console.log(
      `[1tube vercel-build] deploy with: vercel deploy --prebuilt`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[1tube vercel-build] FAILED: ${msg}`);
    return 1;
  }
}

const VERCEL_BUILD_USAGE = `Usage: 1tube build --target vercel [options]

Emits Vercel Build Output API function artifacts under <out>/functions/<prefix>/.
Merges into an existing .vercel/output (e.g. from \`vercel build\`).

Options:
  -f, --functions <path>     Function source dir (default: ./supabase/functions)
  -o, --out <path>           Build Output root (default: ./.vercel/output)
      --only A,B,C           Build only the named subset
      --sourcemap MODE       none | linked (default) | inline
      --minify               Minify bundles
      --ecma-target TARGET   esbuild syntax target, e.g. es2024 | esnext
                             (default: ${DEFAULT_ESBUILD_TARGET})
      --path-prefix <p>      Route prefix under functions/ (default: functions/v1)
      --runtime <id>         Vercel runtime (default: nodejs24.x)
      --max-duration <s>     Fallback maxDuration seconds when a function
                             declares no timeoutMs via serve()/1tube.json
                             (default: 800)
      --max-duration-cap <s> Hard cap for maxDuration seconds (default: 800)
      --config <path>        Explicit deno.json path for the import map.
                             Default: auto-detect cwd/deno.json[c] then
                             <functions-dir>/deno.json[c] (Supabase layout).
      --no-config            Skip the import map entirely.
  -h, --help                 Show this help`;
