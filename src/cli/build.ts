/**
 * `1tube build` — compile the workerd backend into a sealed artifact.
 *
 * Produces a self-contained `dist/` directory that `1tube serve --prebuilt
 * dist/` can boot with zero esbuild on the critical path:
 *
 *     dist/
 *       manifest.json         — index of bundles, hashes, per-fn FunctionManifest
 *       functions/
 *         <name>.js           — esbuild output, one file per function
 *         <name>.js.map       — sourcemap (linked) when --sourcemap is on
 *       README.txt            — operator-facing "this dir is generated" note
 *       .gitignore            — defence-in-depth so the dir doesn't get committed
 *
 * Bundles live under `functions/` so the on-disk shape matches the
 * `.1tube` firmware payload — `1tube package` becomes a pure zip
 * passthrough, and the runtime consumer needs no path-shape knowledge
 * because `bundleFile` in the manifest is just a relative string.
 *
 * The `manifest.json` schema is the contract between build and serve:
 * bundle filenames, sha-256 hashes (so prod can verify integrity at boot),
 * the parsed per-function `FunctionManifest`, and the build-time env
 * allowlist. Capnp is regenerated at serve time from this index because
 * `--port`, `--bind-address`, and `--workerd-env` are runtime concerns —
 * baking them at build time would force a rebuild for a port change.
 *
 * Build is offline-friendly (modulo whatever specifiers esbuild's Deno
 * loader needs to resolve). It does not start workerd; it does not need
 * workerd on PATH at build time. Operators can build on CI with no
 * runtime, ship `dist/` + `workerd` to a sealed prod box, and `1tube
 * serve --prebuilt dist/` will not touch the network.
 */

import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  bundleSharedModule,
  type BundleResult,
  createBundler,
  discoverEntrypoints,
  discoverSharedModules,
} from "../backends/workerd/bundler.ts";
import { loadManifest } from "../manifest.ts";
import {
  PREBUILT_SCHEMA,
  type PrebuiltFunctionEntry,
  type PrebuiltManifest,
  type PrebuiltSharedModuleEntry,
} from "../backends/workerd/prebuilt.ts";
import { VERSION } from "../version.ts";

export { PREBUILT_SCHEMA, type PrebuiltManifest };

export interface BuildOptions {
  functionsDir: string;
  outDir: string;
  /** Path to host project's deno.json (for esbuild's Deno loader import map). */
  configPath?: string;
  /** Restrict the build to a subset of function names. */
  only?: readonly string[];
  /** Sourcemap mode. Defaults to "linked" — prod-style debugging without bloat. */
  sourcemap?: boolean | "linked" | "inline";
  /** Minify bundles. Defaults to false. */
  minify?: boolean;
  /** Bundler concurrency. Defaults to 4. */
  concurrency?: number;
  /** Compat date baked into the manifest. */
  compatibilityDate?: string;
  /** Compat flags baked into the manifest. */
  compatibilityFlags?: readonly string[];
  /** Env var names baked into the manifest. */
  envAllowlist?: readonly string[];
  /** Shared module paths relative to functionsDir or absolute. */
  sharedModules?: readonly string[];
}

export interface BuildResult {
  manifest: PrebuiltManifest;
  outDir: string;
  durationMs: number;
}

/**
 * SHA-256 a `Uint8Array` to a lowercase hex string. Web-Crypto-only —
 * keeps this command zero-dep and works under Deno + workerd alike.
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Build every function under `functionsDir` into `outDir`. Idempotent
 * w.r.t. the on-disk artifact — running twice with the same inputs
 * produces the same `manifest.json` (modulo `builtAt`) and identical
 * bundles (esbuild output is deterministic for fixed inputs).
 *
 * Throws on the first bundle failure so CI fails fast with the function
 * name baked into the error. The bundler is always disposed before
 * returning, even on failure — important on Windows where esbuild's
 * worker subprocess otherwise lingers and prevents `dist/` deletion.
 */
export async function build(opts: BuildOptions): Promise<BuildResult> {
  const startedAt = performance.now();
  const cwd = Deno.cwd();
  const functionsDir = isAbsolute(opts.functionsDir)
    ? opts.functionsDir
    : resolvePath(cwd, opts.functionsDir);
  const outDir = isAbsolute(opts.outDir) ? opts.outDir : resolvePath(cwd, opts.outDir);

  let inputs = await discoverEntrypoints(functionsDir);
  if (opts.only && opts.only.length > 0) {
    const allow = new Set(opts.only);
    inputs = inputs.filter((i) => allow.has(i.name));
  }
  if (inputs.length === 0) {
    throw new Error(
      `1tube build: no functions matched under ${functionsDir}` +
        (opts.only ? ` (only=${JSON.stringify(opts.only)})` : ""),
    );
  }

  await ensureDir(outDir);

  // Bundles live under `dist/functions/` to mirror the `.1tube`
  // firmware payload layout. Manifest stays at `dist/manifest.json`
  // so a top-level `ls dist/` is still a clean two-item listing
  // (manifest + functions dir).
  const functionsOutDir = join(outDir, "functions");
  const sharedOutDir = join(outDir, "shared");
  await ensureDir(functionsOutDir);

  const sharedModules = await discoverSharedModules(functionsDir, opts.sharedModules ?? []);

  const bundler = createBundler({
    outDir: functionsOutDir,
    configPath: opts.configPath,
    sourcemap: opts.sourcemap ?? "linked",
    minify: opts.minify ?? false,
    sharedModules,
  });

  let bundleResults: BundleResult[];
  try {
    bundleResults = await bundler.bundleAll(inputs, {
      concurrency: opts.concurrency ?? 4,
    });
  } finally {
    await bundler.dispose().catch(() => {});
  }

  const sharedEntries: PrebuiltSharedModuleEntry[] = [];
  for (const module of sharedModules) {
    const shared = await bundleSharedModule({
      module,
      outDir: sharedOutDir,
      configPath: opts.configPath,
      minify: opts.minify ?? false,
    });
    const bytes = await Deno.readFile(shared.bundlePath);
    const baseName = shared.bundlePath.split(/[\\/]/).pop()!;
    sharedEntries.push({
      id: shared.id,
      bundleFile: `shared/${baseName}`,
      bundleBytes: shared.byteLength,
      bundleSha256: await sha256Hex(bytes),
      exportNames: [...shared.exportNames],
    });
  }

  // Hash each bundle. We do this on raw bytes (not the path) so the
  // resulting hash is stable across machines and can be verified at
  // serve time without needing esbuild present.
  const entries: PrebuiltFunctionEntry[] = await Promise.all(
    bundleResults.map(async (r) => {
      const bytes = await Deno.readFile(r.bundlePath);
      const sha = await sha256Hex(bytes);
      const manifest = await loadManifest(functionsDir, r.name);
      // `bundleFile` is the manifest-relative path. Always uses
      // forward slashes so the same manifest validates on both
      // Windows (build) and Linux (serve) — `path.join` on either
      // OS treats this as a relative segment correctly.
      const baseName = r.bundlePath.split(/[\\/]/).pop()!;
      const bundleFile = `functions/${baseName}`;
      return {
        name: r.name,
        bundleFile,
        bundleBytes: r.byteLength,
        bundleSha256: sha,
        manifest,
      };
    }),
  );
  // Stable order — diff-friendly manifests + deterministic capnp later.
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const manifest: PrebuiltManifest = {
    schema: PREBUILT_SCHEMA,
    builtBy: `1tube@${VERSION}`,
    builtAt: new Date().toISOString(),
    ...(opts.compatibilityDate ? { compatibilityDate: opts.compatibilityDate } : {}),
    ...(opts.compatibilityFlags && opts.compatibilityFlags.length > 0
      ? { compatibilityFlags: [...opts.compatibilityFlags] }
      : {}),
    envAllowlist: opts.envAllowlist ? [...opts.envAllowlist] : [],
    sharedModules: sharedEntries,
    functions: entries,
  };

  await Deno.writeTextFile(
    join(outDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );

  // Drop a README + .gitignore so an operator stumbling into the dir
  // immediately knows it's generated and so accidental `git add dist`
  // becomes a no-op when the parent project's .gitignore is missing.
  await Deno.writeTextFile(
    join(outDir, "README.txt"),
    `This directory is produced by \`1tube build\`. Every file is regenerated
on each build; do not edit by hand. Serve it with:

    1tube serve --backend workerd --prebuilt ${outDir}

Schema: ${PREBUILT_SCHEMA}.  Built by: ${manifest.builtBy} at ${manifest.builtAt}.
`,
  );
  // Idempotent: only write the .gitignore if missing so we don't churn
  // mtimes on every build.
  const gitignorePath = join(outDir, ".gitignore");
  try {
    await Deno.stat(gitignorePath);
  } catch {
    await Deno.writeTextFile(gitignorePath, "# 1tube build artifact — typically regenerated, not committed.\n*\n!.gitignore\n!README.txt\n");
  }

  return { manifest, outDir, durationMs: performance.now() - startedAt };
}

/**
 * CLI entry point. Returns a process exit code instead of calling
 * `Deno.exit` directly so the caller (server.ts) can decide on its
 * own exit semantics — important for the test harness which imports
 * this and asserts on the return value.
 *
 * Recognised flags (all optional):
 *   --functions <path>     where to find function source dirs (default ./supabase/functions)
 *   --out <path>           where to write the artifact (default ./dist)
 *   --only A,B,C           build a subset of functions
 *   --sourcemap none|linked|inline   (default: linked)
 *   --minify               minify bundle output (default: off)
 *   --concurrency N        bundler concurrency (default: 4)
 *   --compat-date YYYY-MM-DD
 *   --compat-flag FLAG     repeatable; bakes a compat flag into manifest
 *   --workerd-env A,B,C    env names to forward (mirrors serve-time flag)
 *   --workerd-shared path  repeatable; module to run in gateway shared runtime
 */
export async function runBuild(args: string[]): Promise<number> {
  let functionsDir = Deno.env.get("FUNCTIONS_PATH") || "./supabase/functions";
  let outDir = "./dist";
  let only: string[] | undefined;
  let sourcemap: boolean | "linked" | "inline" = "linked";
  let minify = false;
  let concurrency = 4;
  let compatDate: string | undefined;
  const compatFlags: string[] = [];
  let envAllowlist: string[] | undefined;
  const sharedModules: string[] = (Deno.env.get("1TUBE_WORKERD_SHARED") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  let configPathArg: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--functions" || a === "-f") && args[i + 1]) {
      functionsDir = args[++i];
    } else if ((a === "--out" || a === "-o") && args[i + 1]) {
      outDir = args[++i];
    } else if (a === "--only" && args[i + 1]) {
      only = args[++i].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a === "--sourcemap" && args[i + 1]) {
      const v = args[++i];
      if (v === "none" || v === "false" || v === "off") sourcemap = false;
      else if (v === "inline") sourcemap = "inline";
      else if (v === "linked" || v === "true" || v === "on") sourcemap = "linked";
      else {
        console.error(`[1tube build] unknown --sourcemap value: ${v}`);
        return 2;
      }
    } else if (a === "--minify") {
      minify = true;
    } else if (a === "--concurrency" && args[i + 1]) {
      const n = parseInt(args[++i], 10);
      if (!Number.isFinite(n) || n < 1) {
        console.error(`[1tube build] --concurrency must be a positive integer`);
        return 2;
      }
      concurrency = n;
    } else if (a === "--compat-date" && args[i + 1]) {
      compatDate = args[++i];
    } else if (a === "--compat-flag" && args[i + 1]) {
      compatFlags.push(args[++i]);
    } else if (a === "--config" && args[i + 1]) {
      configPathArg = args[++i];
    } else if (a.startsWith("--config=")) {
      configPathArg = a.slice("--config=".length);
    } else if (a === "--no-config") {
      configPathArg = "";
    } else if (a === "--workerd-env" && args[i + 1]) {
      envAllowlist = args[++i].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
    } else if (a.startsWith("--workerd-env=")) {
      envAllowlist = a.slice("--workerd-env=".length).split(",").map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else if (a === "--workerd-shared" && args[i + 1]) {
      sharedModules.push(args[++i]);
    } else if (a.startsWith("--workerd-shared=")) {
      sharedModules.push(a.slice("--workerd-shared=".length));
    } else if (a === "--help" || a === "-h") {
      console.log(BUILD_USAGE);
      return 0;
    } else {
      console.error(`[1tube build] unknown argument: ${a}\n${BUILD_USAGE}`);
      return 2;
    }
  }

  // Resolve the Deno config path. Three modes, in priority order:
  //   1. --config <path>          → explicit, must exist (we hard-fail if not)
  //   2. --no-config              → explicit "build with no import map"
  //   3. <auto-detect at cwd>     → use cwd/deno.json or cwd/deno.jsonc if
  //                                 either is present, otherwise omit.
  // Auto-detect is the important case: hosts like sciobot-next are Vite/Bun
  // projects with no deno.json at all, and the bundler tolerates a missing
  // import map. Forcing one would break those hosts; we'd rather degrade
  // gracefully and just resolve specifiers without an import map.
  let configPath: string | undefined;
  if (configPathArg !== undefined) {
    if (configPathArg === "") {
      configPath = undefined;
    } else {
      const abs = isAbsolute(configPathArg) ? configPathArg : resolvePath(Deno.cwd(), configPathArg);
      try {
        const stat = await Deno.stat(abs);
        if (!stat.isFile) throw new Error("not a regular file");
        configPath = abs;
      } catch (err) {
        console.error(`[1tube build] --config path not readable: ${abs} (${(err as Error).message})`);
        return 2;
      }
    }
  } else {
    // Probe in order of specificity:
    //   1. cwd/deno.json[c]            — host project root (Deno-native repos)
    //   2. functionsDir/deno.json[c]   — Supabase layout, which colocates the
    //                                    deno.json inside supabase/functions/
    //                                    so the import map applies to all fns.
    // The functions-dir fallback is what makes this work for sciobot-next
    // (a Vite/Bun project where the only deno.json lives next to the
    // edge functions, not at repo root).
    const fnDirAbs = isAbsolute(functionsDir) ? functionsDir : resolvePath(Deno.cwd(), functionsDir);
    const candidates = [
      `${Deno.cwd()}/deno.json`,
      `${Deno.cwd()}/deno.jsonc`,
      `${fnDirAbs}/deno.json`,
      `${fnDirAbs}/deno.jsonc`,
    ];
    for (const abs of candidates) {
      try {
        const stat = await Deno.stat(abs);
        if (stat.isFile) { configPath = abs; break; }
      } catch { /* not found, try next */ }
    }
    if (configPath) {
      console.log(`[1tube build] using deno config: ${configPath}`);
    } else {
      console.log(
        `[1tube build] no deno.json / deno.jsonc at ${Deno.cwd()} or ${fnDirAbs} — bundling without an import map. ` +
          `Pass --config <path> if you want one.`,
      );
    }
  }

  console.log(`[1tube build] bundling functions from ${functionsDir} → ${outDir}`);
  try {
    const result = await build({
      functionsDir,
      outDir,
      ...(configPath ? { configPath } : {}),
      ...(only ? { only } : {}),
      sourcemap,
      minify,
      concurrency,
      ...(sharedModules.length > 0 ? { sharedModules } : {}),
      ...(compatDate ? { compatibilityDate: compatDate } : {}),
      ...(compatFlags.length > 0 ? { compatibilityFlags: compatFlags } : {}),
      ...(envAllowlist ? { envAllowlist } : {}),
    });

    const { manifest, durationMs } = result;
    const totalBytes = manifest.functions.reduce((acc, f) => acc + f.bundleBytes, 0);
    const fmt = (n: number) => {
      if (n < 1024) return `${n}B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
      return `${(n / (1024 * 1024)).toFixed(2)}MB`;
    };
    const namePad = manifest.functions.reduce((m, f) => Math.max(m, f.name.length), 8);
    console.log(`[1tube build] ${manifest.functions.length} function(s):`);
    for (const f of manifest.functions) {
      console.log(
        `  ${f.name.padEnd(namePad)}  ${fmt(f.bundleBytes).padStart(8)}  sha256=${f.bundleSha256.slice(0, 12)}…`,
      );
    }
    console.log(
      `[1tube build] total ${fmt(totalBytes)} in ${durationMs.toFixed(0)}ms — wrote manifest.json (schema ${PREBUILT_SCHEMA})`,
    );
    console.log(`[1tube build] serve with: 1tube serve --backend workerd --prebuilt ${outDir}`);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[1tube build] FAILED: ${msg}`);
    return 1;
  }
}

const BUILD_USAGE = `Usage: 1tube build [options]

Options:
  -f, --functions <path>     Function source dir (default: ./supabase/functions)
  -o, --out <path>           Output directory (default: ./dist)
      --only A,B,C           Build only the named subset
      --sourcemap MODE       none | linked (default) | inline
      --minify               Minify output (default: off)
      --concurrency N        Bundler concurrency (default: 4)
      --compat-date DATE     Workerd compatibility date (YYYY-MM-DD)
      --compat-flag FLAG     Add a workerd compatibility flag (repeatable)
      --workerd-env A,B,C    Env vars baked into the manifest's allowlist
      --workerd-shared path  Shared module path (repeatable). Defaults include
                             _shared/profile-cache.ts when present.
      --config <path>        Explicit deno.json path for the import map.
                             Default: auto-detect cwd/deno.json[c] then
                             <functions-dir>/deno.json[c] (Supabase layout).
      --no-config            Skip the import map entirely.
  -h, --help                 Show this help`;
