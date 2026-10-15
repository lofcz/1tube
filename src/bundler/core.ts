/**
 * Target-agnostic edge-function bundler core.
 *
 * Runtimes like workerd and Vercel Node both need each function turned into a
 * single self-contained ESM file: they do not resolve `npm:`, `jsr:`, or
 * `https:` specifiers at runtime, so every module must be present on disk as a
 * fully-resolved ESM file before the function boots. This module fills that gap
 * by running esbuild over each function's `index.ts`, with the compat esbuild
 * plugin (`src/compat/esbuild-plugin.ts`) resolving Deno-style specifiers
 * against the same dependency store the Bun gateway runtime uses.
 *
 * Everything backend-specific — the runtime shims injected as a banner/footer,
 * which esbuild platform/conditions to resolve under, which specifiers to keep
 * external, and any extra resolver plugins — is supplied by the caller as a
 * {@link BundleProfile}. The core never imports a backend, so a single bundling
 * pipeline serves every target without any of them knowing about the others.
 *
 * Two shapes are produced:
 *
 *  - {@link createBundler} emits one self-contained file per function (the
 *    workerd backend's per-function bundle path).
 *  - {@link bundleAllChunked} emits an entry per function plus shared ESM chunks
 *    via esbuild code-splitting (the prebuilt/firmware + Vercel Build Output
 *    paths), so common dependencies are stored once.
 *
 * This module is pure I/O orchestration around esbuild. The test suite
 * drives it with real bundles against the playground fixtures — there is no mock
 * layer because esbuild's behaviour is the contract.
 */

import { existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import {
  type CompatEnvironment,
  createCompatEnvironment,
} from "../compat/environment.ts";
import {
  compatEsbuildPlugin,
  prepareBundleDependencies,
} from "../compat/esbuild-plugin.ts";
import { readImportMap } from "../compat/import-map.ts";
import {
  SHARED_RUNTIME_TOKEN_ENV,
  SHARED_RUNTIME_URL_ENV,
  type SharedRuntimeModule,
} from "../backends/workerd/shared-runtime.ts";
import { cjsDynamicImportPlugin } from "./cjs-dynamic-import.ts";
import type { BundleProfile } from "./profile.ts";

export type { BundleProfile };

/**
 * Default ECMAScript syntax level for emitted bundles, passed through to
 * esbuild's `target`. Both supported runtimes ship a very modern V8 — workerd
 * tracks the latest V8, and Vercel's `nodejs24.x` is Node 24 (V8 12.4+) — so we
 * down-level as little as possible: a higher target means smaller, faster output
 * that preserves modern syntax. `es2024` is the newest fully-ratified standard
 * (vs. a moving `esnext`), keeping output predictable.
 *
 * Override per build via {@link BundlerOptions.esbuildTarget}.
 */
export const DEFAULT_ESBUILD_TARGET = "es2024";

export interface BundleInput {
  /** Logical function name (used as bundle filename and in capnp config). */
  name: string;
  /** Absolute path to the function's `index.ts` entrypoint. */
  entrypoint: string;
}

export interface BundleResult {
  /** Same as input. */
  name: string;
  /** Absolute path to the produced `.js` bundle. */
  bundlePath: string;
  /** Absolute path to the produced sourcemap, or null when sourcemaps are off. */
  sourcemapPath: string | null;
  /** Bundle byte size — useful for diagnostics and CI assertions. */
  byteLength: number;
  /** Wall-clock time esbuild spent on this function. */
  durationMs: number;
}

export interface ChunkedBundleChunk {
  /** Manifest-relative POSIX path, e.g. `chunks/chunk-ABC123.js`. */
  file: string;
  /** Absolute path to the emitted chunk file. */
  path: string;
  /** Chunk byte size after chunk-only minification. */
  byteLength: number;
  /** Chunk byte size before chunk-only minification. */
  originalByteLength: number;
}

export interface ChunkedBundleResult extends BundleResult {
  /** Manifest-relative POSIX module files required by this worker, entry first. */
  moduleFiles: string[];
  /** Entry module byte size before entry-only minification. */
  originalByteLength: number;
}

export interface ChunkedBundleAllResult {
  functions: ChunkedBundleResult[];
  chunks: ChunkedBundleChunk[];
  entryMinification: {
    preBytes: number;
    postBytes: number;
  };
  chunkMinification: {
    preBytes: number;
    postBytes: number;
  };
}

export interface SharedModuleInput {
  /** Stable id used in the generated RPC path and prebuilt manifest. */
  id: string;
  /** Absolute source module path on disk. */
  sourcePath: string;
  /** Exported functions to expose through the shared runtime. */
  exportNames: readonly string[];
}

/**
 * @deprecated Use {@link SharedModuleInput}. Retained as an alias so existing
 * importers (bun backend, tests) keep compiling.
 */
export type WorkerdSharedModuleInput = SharedModuleInput;

export interface BundlerOptions {
  /**
   * Backend bundling profile (banner/footer, platform/conditions, externals).
   * Owned by the backend; the core never branches on a target.
   */
  profile: BundleProfile;
  /**
   * Directory to write bundles into. Files are named `<name>.js` (+
   * `<name>.js.map` when `sourcemap` is true). Created if missing.
   */
  outDir: string;
  /**
   * Path to the host project's `deno.json[c]`, read only for its import map
   * (`imports` / `scopes`). Optional — when omitted (or missing on disk) no
   * import map is applied.
   */
  configPath?: string;
  /**
   * Enable inline sourcemaps (`true`), separate `.map` files (`"linked"`),
   * or disable (`false`). Defaults to `"linked"` for production-style
   * debugging without bloating the bundle.
   */
  sourcemap?: boolean | "linked" | "inline";
  /** Emit minified output. Defaults to false (keeps readable stack traces). */
  minify?: boolean;
  /**
   * ECMAScript syntax level forwarded to esbuild's `target`. Accepts any value
   * esbuild understands (e.g. `"es2022"`, `"es2024"`, `"esnext"`, or an array
   * like `["es2024", "node24"]`). Defaults to {@link DEFAULT_ESBUILD_TARGET}.
   */
  esbuildTarget?: string | string[];
  /**
   * Modules that should be owned by the gateway process, not by each isolate.
   * Imports that resolve to one of these source paths are replaced with
   * generated RPC stubs.
   */
  sharedModules?: readonly SharedModuleInput[];
}

/** State held by a long-lived bundler so esbuild can be reused across builds. */
export interface Bundler {
  /** Bundle a single function. */
  bundle(input: BundleInput): Promise<BundleResult>;
  /** Bundle every function with bounded concurrency. */
  bundleAll(
    inputs: BundleInput[],
    opts?: { concurrency?: number },
  ): Promise<BundleResult[]>;
  /** Release esbuild's worker process. Always call from a `try/finally`. */
  dispose(): Promise<void>;
}

export interface SharedBundleResult extends SharedRuntimeModule {
  byteLength: number;
  originalByteLength: number;
  durationMs: number;
}

export async function disposeBundlerResources(): Promise<void> {
  await esbuild.stop();
}

/**
 * Dependency store + remote cache, shared per (cwd, deps dir) so every
 * bundler in the process funnels installs through ONE dependency manager —
 * its install queue is what keeps concurrent builds from racing `bun
 * install` in the same store.
 */
const compatStores = new Map<string, Omit<CompatEnvironment, "importMap" | "configPath">>();

/**
 * Deno-compat resolution for a build: npm:/jsr: via the managed store,
 * https: via the remote cache, and the import map of `configPath` (only —
 * an omitted config means "no import map", never auto-discovery). The
 * import map is re-read per call so long-lived hosts pick up edits.
 */
function compatEnvironmentFor(configPath: string | undefined): CompatEnvironment {
  const config = configPath && existsSync(configPath) ? configPath : undefined;
  const key = `${process.cwd()}\0${process.env["1TUBE_DEPS_DIR"] ?? ""}`;
  let store = compatStores.get(key);
  if (!store) {
    const { deps, remote } = createCompatEnvironment({ configPath: config });
    store = { deps, remote };
    compatStores.set(key, store);
  }
  return { ...store, importMap: readImportMap(config), configPath: config };
}

/**
 * Node builtins stay external for every target, as they did under Deno's
 * loader: `node:*` always, and a bare builtin name (`buffer`, `crypto`, …)
 * when nothing else resolves it — a package that ships its own polyfill
 * dependency (the npm `buffer` package) still gets it bundled. The runtime
 * supplies the module (workerd via `nodejs_compat`, Vercel's Node itself).
 */
/**
 * Bun's `isBuiltin` also reports modules Bun ships itself (`ws`, `undici`,
 * `bun`, `bun:*`). Bundles run on Node/workerd, where those are ordinary
 * npm packages that must be bundled.
 */
const BUN_ONLY_BUILTINS = new Set(["bun", "ws", "undici"]);

function isNodeBuiltin(spec: string): boolean {
  const head = spec.split("/", 1)[0];
  return isBuiltin(spec) && !spec.startsWith("bun:") && !BUN_ONLY_BUILTINS.has(head);
}

function nodeBuiltinsPlugin(): esbuild.Plugin {
  return {
    name: "1tube-node-builtins",
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path,
        external: true,
      }));
      build.onResolve({ filter: /^[a-z_][a-z0-9_/]*$/ }, async (args) => {
        if (!isNodeBuiltin(args.path)) return undefined;
        // Never answer a probe — ours or another plugin's — with another
        // probe: two probing plugins would bounce a specifier forever.
        const data = args.pluginData as { builtinProbe?: boolean; probe?: boolean } | undefined;
        if (data?.builtinProbe || data?.probe) return undefined;
        const probe = await build.resolve(args.path, {
          importer: args.importer,
          kind: args.kind,
          resolveDir: args.resolveDir,
          namespace: args.namespace,
          pluginData: { builtinProbe: true },
        });
        if (probe.errors.length === 0 && !probe.external) return probe;
        return { path: `node:${args.path}`, external: true };
      });
    },
  };
}

/**
 * Install every npm:/jsr: package reachable from `inputs` in one batch
 * before esbuild runs. The plugin's resolver is synchronous, so anything
 * missed here would fall back to a blocking per-package install mid-build.
 */
async function prepareInputs(
  env: CompatEnvironment,
  inputs: readonly BundleInput[],
): Promise<void> {
  if (inputs.length === 0) return;
  await prepareBundleDependencies(inputs, env);
}

function sharedModuleStubSource(module: SharedModuleInput): string {
  const exports = module.exportNames.map((name) =>
    `export async function ${name}(...args) {
  return await callShared(${JSON.stringify(name)}, args);
}`
  ).join("\n\n");
  return `
const RUNTIME_URL_ENV = ${JSON.stringify(SHARED_RUNTIME_URL_ENV)};
const RUNTIME_TOKEN_ENV = ${JSON.stringify(SHARED_RUNTIME_TOKEN_ENV)};
const MODULE_ID = ${JSON.stringify(module.id)};

function env(name) {
  const v = globalThis.Deno?.env?.get?.(name) ?? globalThis.process?.env?.[name];
  return typeof v === "string" ? v : "";
}

async function callShared(exportName, args) {
  const base = env(RUNTIME_URL_ENV);
  const token = env(RUNTIME_TOKEN_ENV);
  if (!base || !token) {
    throw new Error("1tube shared runtime is not configured");
  }
  const res = await fetch(
    base + "/modules/" + encodeURIComponent(MODULE_ID) + "/call/" + encodeURIComponent(exportName),
    {
    method: "POST",
    headers: {
      "authorization": "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ args }),
    },
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload?.error || "1tube shared runtime request failed");
  }
  return payload.value;
}

${exports}
`;
}

function importerToPath(importer: string): string | null {
  if (!importer) return null;
  try {
    if (importer.startsWith("file:")) return fileURLToPath(importer);
    return importer;
  } catch {
    return null;
  }
}

function resolveLocalImport(args: esbuild.OnResolveArgs): string | null {
  if (
    !args.path.startsWith(".") && !args.path.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(args.path)
  ) {
    return null;
  }
  if (args.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(args.path)) {
    return resolvePath(args.path);
  }
  const importerPath = importerToPath(args.importer);
  if (!importerPath) return null;
  return resolvePath(dirname(importerPath), args.path);
}

function sharedModulesExternalPlugin(
  sharedModules: readonly SharedModuleInput[],
): esbuild.Plugin {
  const byPath = new Map(
    sharedModules.map((m) => [resolvePath(m.sourcePath), m]),
  );
  return {
    name: "1tube-shared-modules",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const resolved = resolveLocalImport(args);
        if (!resolved) return null;
        const mod = byPath.get(resolved);
        if (!mod) return null;
        return { path: mod.id, namespace: "1tube-shared-runtime" };
      });
      build.onLoad(
        { filter: /.*/, namespace: "1tube-shared-runtime" },
        (args) => ({
          contents: sharedModuleStubSource(
            sharedModules.find((m) => m.id === args.path)!,
          ),
          loader: "js",
        }),
      );
    },
  };
}

function patchCjsDefaultInterop(code: string): string {
  // esbuild's default helper intentionally withholds `default` when a
  // CommonJS module sets `__esModule`. That matches Babel-transpiled
  // modules that also provide a real `.default`, but breaks plain CJS
  // packages such as `tslib` whose UMD wrapper sets `__esModule` while
  // only exporting named helpers. workerd's nodejs_compat behavior is
  // closer to Node's ESM/CJS bridge: a default import from CJS resolves
  // to module.exports. Preserve real default exports, but synthesize one
  // when absent.
  return code.replace(
    'isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,',
    'isNodeMode || !mod || !mod.__esModule || !("default" in mod) ? __defProp(target, "default", { value: mod, enumerable: true }) : target,',
  );
}

const ENTRY_PROXY_NAMESPACE = "1tube-entry-proxy";

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

function entryProxySource(entrypoint: string, profile: BundleProfile): string {
  return `${profile.banner}
await import(${JSON.stringify(entrypoint)});
${profile.footer}
`;
}

function entryProxyPlugin(
  inputs: readonly BundleInput[],
  profile: BundleProfile,
): esbuild.Plugin {
  const byName = new Map(inputs.map((input) => [input.name, input]));
  return {
    name: "1tube-entry-proxy",
    setup(build) {
      build.onResolve({ filter: /^1tube-entry-proxy:/ }, (args) => {
        return {
          path: args.path.slice("1tube-entry-proxy:".length),
          namespace: ENTRY_PROXY_NAMESPACE,
        };
      });
      build.onLoad(
        { filter: /.*/, namespace: ENTRY_PROXY_NAMESPACE },
        (args) => {
          const input = byName.get(args.path);
          if (!input) {
            throw new Error(
              `missing 1tube entry proxy input for ${args.path}`,
            );
          }
          return {
            contents: entryProxySource(input.entrypoint, profile),
            loader: "js",
            resolveDir: dirname(input.entrypoint),
          };
        },
      );
    },
  };
}

async function patchOutputFile(path: string): Promise<void> {
  const emitted = await readFile(path, "utf8");
  const patched = patchCjsDefaultInterop(emitted);
  if (patched !== emitted) {
    await writeFile(path, patched);
  }
}

async function minifyOutputFile(
  path: string,
  sourcemap: boolean | "linked" | "inline",
  target: string | string[],
  preamble?: string,
): Promise<{
  originalByteLength: number;
  byteLength: number;
}> {
  const raw = await readFile(path, "utf8");
  // Prepend the profile preamble (e.g. the Node createRequire shim) before the
  // minify transform so it reaches the shared chunks where esbuild hoists
  // helpers like `__require`. esbuild's own `banner` can't do this — it only
  // injects into entry points, never chunks. The transform keeps the preamble
  // in every file (it can't prove the initializer is side-effect-free), which
  // is harmless where unused.
  const original = preamble ? `${preamble}\n${raw}` : raw;
  const originalByteLength = new TextEncoder().encode(original).byteLength;
  const result = await esbuild.transform(original, {
    loader: "js",
    format: "esm",
    target,
    minify: true,
    legalComments: "none",
    sourcemap: sourcemap === "inline"
      ? "inline"
      : sourcemap === "linked"
      ? "external"
      : false,
    sourcefile: path.split(/[\\/]/).pop() ?? "bundle.js",
  });
  let code = result.code;
  if (sourcemap === "linked" && result.map) {
    const mapPath = `${path}.map`;
    await writeFile(mapPath, result.map);
    code = code.replace(/\n?\/\/# sourceMappingURL=.*$/m, "");
    code += `\n//# sourceMappingURL=${mapPath.split(/[\\/]/).pop()}\n`;
  }
  await writeFile(path, code);
  return {
    originalByteLength,
    byteLength: new TextEncoder().encode(code).byteLength,
  };
}

/**
 * Construct a bundler. esbuild keeps a long-lived worker subprocess; the
 * caller is responsible for invoking `dispose()` on shutdown. The
 * implementation is intentionally stateless apart from that worker —
 * configuration is captured in the closure.
 */
export function createBundler(opts: BundlerOptions): Bundler {
  const profile = opts.profile;
  const sourcemap = opts.sourcemap ?? "linked";
  const target = opts.esbuildTarget ?? DEFAULT_ESBUILD_TARGET;

  // The compat plugin resolves npm:/jsr:/https:/import-map specifiers
  // through the same dependency store the Bun runtime uses, so a bundle
  // binds to exactly the package versions a local run would. Created once
  // and reused across builds; pinning lives in `.1tube/deps/bun.lock`.
  const env = compatEnvironmentFor(opts.configPath);
  const plugin = compatEsbuildPlugin(env);
  const sharedModules = opts.sharedModules ?? [];
  const plugins = [
    ...(profile.resolverPlugins ?? []),
    ...(sharedModules.length > 0
      ? [sharedModulesExternalPlugin(sharedModules)]
      : []),
    nodeBuiltinsPlugin(),
    plugin,
  ];

  const buildOne = async (input: BundleInput): Promise<BundleResult> => {
    const start = performance.now();
    const outfile = join(opts.outDir, `${input.name}.js`);

    try {
      await esbuild.build({
        // Absolute path: esbuild's native resolver takes the entry, the
        // compat plugin only claims Deno-style specifiers inside it.
        entryPoints: [input.entrypoint],
        outfile,
        plugins,
        bundle: true,
        format: "esm",
        target,
        platform: profile.platform,
        conditions: [...profile.conditions],
        ...(profile.external ? { external: [...profile.external] } : {}),
        banner: { js: profile.banner },
        footer: { js: profile.footer },
        sourcemap,
        minify: opts.minify ?? false,
        // Tree-shaking is only safe when imports are pure — esbuild assumes
        // this for `format: esm`. Leave at default (true) so unused npm
        // surface (e.g. server-only Supabase code paths) is dropped.
        treeShaking: true,
        // Emit deterministic output regardless of CWD so the cache is
        // content-comparable across machines.
        absWorkingDir: opts.outDir,
        // We don't want esbuild to log to stdout — the host gateway controls
        // logging surface. Errors are surfaced via thrown exceptions.
        logLevel: "silent",
        mainFields: [...profile.mainFields],
      });
    } catch (err) {
      // esbuild throws on any build error with `logLevel: silent`. Re-raise
      // with the function name baked in so the operator immediately knows
      // which function broke without scanning the (potentially huge)
      // esbuild diagnostic block.
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${profile.id} bundle failed for function "${input.name}" (${input.entrypoint})\n${cause}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    await patchOutputFile(outfile);

    const outStat = await stat(outfile);
    const sourcemapPath = sourcemap === "linked" ? `${outfile}.map` : null;

    return {
      name: input.name,
      bundlePath: outfile,
      sourcemapPath,
      byteLength: outStat.size,
      durationMs: performance.now() - start,
    };
  };

  return {
    async bundle(input) {
      await mkdir(opts.outDir, { recursive: true });
      await prepareInputs(env, [input]);
      return await buildOne(input);
    },
    async bundleAll(inputs, runOpts = {}) {
      await mkdir(opts.outDir, { recursive: true });
      await prepareInputs(env, inputs);
      // Bounded concurrency keeps esbuild from spawning a separate worker
      // for every function; on a 50-function project the default 4
      // saturates a modern laptop without thrashing.
      const concurrency = Math.max(1, runOpts.concurrency ?? 4);
      const results: BundleResult[] = new Array(inputs.length);
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(concurrency, inputs.length) },
        async () => {
          while (true) {
            const i = cursor++;
            if (i >= inputs.length) return;
            results[i] = await buildOne(inputs[i]);
          }
        },
      );
      await Promise.all(workers);
      return results;
    },
    async dispose() {
      // esbuild keeps a global worker process for the whole runtime.
      // Calling stop() releases it so the host process can exit cleanly.
      await esbuild.stop();
    },
  };
}

export async function bundleAllChunked(
  opts: BundlerOptions & {
    inputs: BundleInput[];
  },
): Promise<ChunkedBundleAllResult> {
  await mkdir(opts.outDir, { recursive: true });
  const start = performance.now();
  const profile = opts.profile;
  const sourcemap = opts.sourcemap ?? "linked";
  const target = opts.esbuildTarget ?? DEFAULT_ESBUILD_TARGET;
  const sharedModules = opts.sharedModules ?? [];
  const env = compatEnvironmentFor(opts.configPath);
  await prepareInputs(env, opts.inputs);
  const plugins = [
    // Splitting turns `import()` of a CommonJS module into a default-only
    // chunk. Runs first so it sees the dynamic import before the probing
    // resolvers below claim it; its own probe still goes through all of them.
    cjsDynamicImportPlugin(),
    // Backend resolver plugins (e.g. node-builtin externalisation) must run
    // before the compat plugin gets a chance to resolve those specifiers.
    ...(profile.resolverPlugins ?? []),
    entryProxyPlugin(opts.inputs, profile),
    ...(sharedModules.length > 0
      ? [sharedModulesExternalPlugin(sharedModules)]
      : []),
    nodeBuiltinsPlugin(),
    compatEsbuildPlugin(env),
  ];
  const entryPoints = Object.fromEntries(
    opts.inputs.map((input) => [input.name, `1tube-entry-proxy:${input.name}`]),
  );

  let result: esbuild.BuildResult<{
    metafile: true;
    write: true;
  }>;
  try {
    result = await esbuild.build({
      entryPoints,
      outdir: opts.outDir,
      plugins,
      bundle: true,
      splitting: true,
      format: "esm",
      target,
      platform: profile.platform,
      conditions: [...profile.conditions],
      // esbuild applies `external` before any plugin's onResolve, so these
      // specifiers are never resolved (e.g. optional native deps a library
      // require()s behind a try/catch).
      ...(profile.external ? { external: [...profile.external] } : {}),
      sourcemap,
      minify: opts.minify ?? false,
      treeShaking: true,
      absWorkingDir: opts.outDir,
      logLevel: "silent",
      mainFields: [...profile.mainFields],
      entryNames: "functions/[name]",
      chunkNames: "chunks/[name]-[hash]",
      metafile: true,
      write: true,
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`${profile.id} chunked bundle failed\n${cause}`, {
      cause: err instanceof Error ? err : undefined,
    });
  }

  const outputs = result.metafile.outputs;
  const entryByName = new Map<string, string>();
  const importsByOutput = new Map<string, string[]>();
  for (const [outputPath, output] of Object.entries(outputs)) {
    if (!outputPath.endsWith(".js")) continue;
    const rel = toPosix(outputPath);
    importsByOutput.set(
      rel,
      output.imports
        .filter((i) => i.path.endsWith(".js"))
        .map((i) => toPosix(i.path)),
    );
    if (output.entryPoint) {
      const match = output.entryPoint.match(/^1tube-entry-proxy:(.+)$/);
      if (match) entryByName.set(match[1], rel);
    }
  }

  const collectReachable = (entry: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      out.push(file);
      for (const dep of importsByOutput.get(file) ?? []) visit(dep);
    };
    visit(entry);
    return out;
  };

  const emittedJs = Object.keys(outputs)
    .map(toPosix)
    .filter((file) => file.endsWith(".js"));
  await Promise.all(
    emittedJs.map((file) => patchOutputFile(join(opts.outDir, file))),
  );
  const minifiedSizesByFile = new Map<string, {
    originalByteLength: number;
    byteLength: number;
  }>();
  await Promise.all(
    emittedJs.map(async (file) => {
      minifiedSizesByFile.set(
        file,
        await minifyOutputFile(
          join(opts.outDir, file),
          sourcemap,
          target,
          profile.outputPreamble,
        ),
      );
    }),
  );

  const chunkFiles = emittedJs
    .filter((file) => file.startsWith("chunks/"))
    .sort();
  const chunks: ChunkedBundleChunk[] = chunkFiles.map((file) => {
    const path = join(opts.outDir, file);
    const sizes = minifiedSizesByFile.get(file);
    if (!sizes) {
      throw new Error(
        `${profile.id} chunked bundle missing minified size for ${file}`,
      );
    }
    return {
      file,
      path,
      byteLength: sizes.byteLength,
      originalByteLength: sizes.originalByteLength,
    };
  });
  const chunkMinification = chunks.reduce(
    (acc, chunk) => {
      acc.preBytes += chunk.originalByteLength;
      acc.postBytes += chunk.byteLength;
      return acc;
    },
    { preBytes: 0, postBytes: 0 },
  );
  const entryMinification = [...entryByName.values()].reduce(
    (acc, entry) => {
      const sizes = minifiedSizesByFile.get(entry);
      if (sizes) {
        acc.preBytes += sizes.originalByteLength;
        acc.postBytes += sizes.byteLength;
      }
      return acc;
    },
    { preBytes: 0, postBytes: 0 },
  );

  const durationMs = performance.now() - start;
  const functions: ChunkedBundleResult[] = [];
  for (const input of opts.inputs) {
    const entry = entryByName.get(input.name);
    if (!entry) {
      throw new Error(
        `${profile.id} chunked bundle missing entry output for ${input.name}`,
      );
    }
    const bundlePath = join(opts.outDir, entry);
    const sizes = minifiedSizesByFile.get(entry);
    if (!sizes) {
      throw new Error(
        `${profile.id} chunked bundle missing minified size for ${entry}`,
      );
    }
    functions.push({
      name: input.name,
      bundlePath,
      sourcemapPath: sourcemap === "linked" ? `${bundlePath}.map` : null,
      byteLength: sizes.byteLength,
      durationMs: durationMs / Math.max(1, opts.inputs.length),
      moduleFiles: collectReachable(entry),
      originalByteLength: sizes.originalByteLength,
    });
  }

  return { functions, chunks, entryMinification, chunkMinification };
}

export async function bundleSharedModule(opts: {
  /** Backend bundling profile (resolution platform/conditions). */
  profile: BundleProfile;
  module: SharedModuleInput;
  outDir: string;
  configPath?: string;
  minify?: boolean;
  /** ECMAScript target forwarded to esbuild. Defaults to {@link DEFAULT_ESBUILD_TARGET}. */
  esbuildTarget?: string | string[];
}): Promise<SharedBundleResult> {
  await mkdir(opts.outDir, { recursive: true });
  const start = performance.now();
  const profile = opts.profile;
  const target = opts.esbuildTarget ?? DEFAULT_ESBUILD_TARGET;
  const outfile = join(opts.outDir, `${opts.module.id}.js`);
  const env = compatEnvironmentFor(opts.configPath);
  await prepareInputs(env, [{
    name: opts.module.id,
    entrypoint: opts.module.sourcePath,
  }]);
  await esbuild.build({
    entryPoints: [opts.module.sourcePath],
    outfile,
    plugins: [
      ...(profile.resolverPlugins ?? []),
      nodeBuiltinsPlugin(),
      compatEsbuildPlugin(env),
    ],
    bundle: true,
    format: "esm",
    target,
    platform: profile.platform,
    conditions: [...profile.conditions],
    ...(profile.external ? { external: [...profile.external] } : {}),
    sourcemap: false,
    minify: opts.minify ?? false,
    treeShaking: true,
    absWorkingDir: opts.outDir,
    logLevel: "silent",
    mainFields: [...profile.mainFields],
  });
  await patchOutputFile(outfile);
  const sizes = await minifyOutputFile(
    outfile,
    false,
    target,
    profile.outputPreamble,
  );
  return {
    id: opts.module.id,
    bundlePath: outfile,
    exportNames: opts.module.exportNames,
    byteLength: sizes.byteLength,
    originalByteLength: sizes.originalByteLength,
    durationMs: performance.now() - start,
  };
}

function moduleIdFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "shared";
  return base.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-");
}

function extractExportedFunctionNames(source: string): string[] {
  const names = new Set<string>();
  for (
    const match of source.matchAll(
      /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    )
  ) {
    names.add(match[1]);
  }
  for (
    const match of source.matchAll(
      /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    )
  ) {
    names.add(match[1]);
  }
  for (
    const match of source.matchAll(
      /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*async\s+/g,
    )
  ) {
    names.add(match[1]);
  }
  return [...names].sort();
}

async function maybeSharedModule(
  path: string,
): Promise<SharedModuleInput | null> {
  try {
    if (!(await stat(path)).isFile()) return null;
    const source = await readFile(path, "utf8");
    const exportNames = extractExportedFunctionNames(source);
    if (exportNames.length === 0) {
      throw new Error(`shared module ${path} does not export any functions`);
    }
    return {
      id: moduleIdFromPath(path),
      sourcePath: resolvePath(path),
      exportNames,
    };
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
}

export async function discoverSharedModules(
  functionsDir: string,
  explicitPaths: readonly string[] = [],
): Promise<SharedModuleInput[]> {
  const root = resolvePath(functionsDir);
  const candidates = explicitPaths.length > 0
    ? explicitPaths.map((p) =>
      /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") ? p : resolvePath(root, p)
    )
    : [];

  // Built-in convention: if a Supabase-style profile cache exists, run
  // it as a gateway-owned shared module unless the caller already named it.
  const defaultProfile = join(root, "_shared", "profile-cache.ts");
  if (!candidates.some((p) => resolvePath(p) === resolvePath(defaultProfile))) {
    candidates.push(defaultProfile);
  }

  const out: SharedModuleInput[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = resolvePath(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    const mod = await maybeSharedModule(resolved);
    if (mod) out.push(mod);
  }
  return out;
}

/**
 * Convenience: discover function entrypoints under `functionsDir` (one
 * subdirectory per function, each containing `index.ts`) and return the
 * canonical `BundleInput[]`. Mirrors `src/discovery.ts` filtering rules so
 * every backend sees the same function set as the Bun backend.
 */
export async function discoverEntrypoints(
  functionsDir: string,
): Promise<BundleInput[]> {
  const root = resolvePath(functionsDir);
  const out: BundleInput[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith("_") || entry.name.endsWith("_shared")) continue;
    const indexPath = join(root, entry.name, "index.ts");
    try {
      if (!(await stat(indexPath)).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ name: entry.name, entrypoint: indexPath });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
