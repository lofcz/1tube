/**
 * 1tube launcher — the single entry point for running and building 1tube.
 *
 * The npm `1tube` bin, the repo's package scripts, and host projects all
 * funnel through here. `serve` always runs the gateway as a child
 * `bun src/server.ts`, which lets the launcher fully restart it when the
 * project's dependency inputs change while running.
 *
 * Dispatch
 * ========
 *   build      → cli/build.ts   (bundle for workerd/vercel)
 *   package    → cli/package.ts (sign a firmware payload)
 *   test       → cli/test.ts    (run function tests via `1tube/test`)
 *   --version  → print version
 *   --help     → usage
 *   <else>     → serve (the gateway)            ← default, may be spelled `serve`
 *
 * Dependencies
 * ============
 * Functions import packages Deno-style (`npm:zod@^3`, `jsr:@std/path`).
 * The gateway resolves each against the host project's installed
 * `node_modules` first (so an unconstrained `npm:1tube/edge` binds to the
 * version the user installed — their package manager stays the source of
 * truth) and otherwise installs it into a managed store
 * (`.1tube/deps`, with its own `bun.lock`). See `compat/deps.ts`.
 *
 * Live reload
 * ===========
 * The gateway reads the import map (deno.json) once at boot, and Bun caches
 * resolved packages per process. So the launcher watches the deno config
 * plus the host's package manifest and lockfiles, and restarts the gateway
 * when an install or config edit changes them.
 */

import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { watchFs } from "./fs-watch.ts";
import { IMPORT_MAP_FILES } from "./compat/import-map.ts";

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

export async function run(argv: readonly string[]): Promise<void> {
  const arg0 = argv[0];
  if (arg0 === "build") {
    const { runBuild } = await import("./cli/build.ts");
    process.exit(await runBuild(argv.slice(1)));
  }
  if (arg0 === "test") {
    const { runTest } = await import("./cli/test.ts");
    process.exit(await runTest(argv.slice(1)));
  }
  if (arg0 === "package") {
    const { runPackage } = await import("./cli/package.ts");
    process.exit(await runPackage(argv.slice(1)));
  }
  if (arg0 === "--version" || arg0 === "-v") {
    const { VERSION } = await import("./version.ts");
    console.log(VERSION);
    process.exit(0);
  }
  if (arg0 === "--help" || arg0 === "-h") {
    printHelp();
    process.exit(0);
  }
  // Default: serve. A literal `serve` token is accepted and dropped.
  const serveArgv = arg0 === "serve" ? argv.slice(1) : argv;
  await runServe(parseServeArgs(serveArgv));
}

function printHelp(): void {
  console.log(`Usage: 1tube <command> [options]

Commands:
  serve       Run the gateway (default when no command given)
  build       Bundle functions for a target (--target workerd|vercel)
  package     Build and/or wrap dist/ into a signed .1tube firmware payload
  test        Run function tests (files importing 1tube/test) with gateway resolution
  --version   Print version and exit
  --help      Print this help

Serve options (everything else is forwarded to the gateway):
  --deps-dir <path>             Managed npm:/jsr: store (default <cwd>/.1tube/deps)
  --refresh-deps                Drop the managed store's lockfile for a clean re-resolve
  --config <path>               Import map functions use (import_map.json, or deno.json[c])
  --env-file[=<path>]           Env file loaded into the gateway (repeatable)
  --minimum-dependency-age <n>  Minimum release age for managed installs (s, or 30m/24h/7d; default 0)
  --no-pin                      Ignore host node_modules; resolve npm: only via the managed store
  --no-dep-watch                Don't restart on dependency/config changes
`);
}

// ---------------------------------------------------------------------------
// Serve argument parsing
// ---------------------------------------------------------------------------

interface ServeArgs {
  depsDir?: string;
  refreshDeps: boolean;
  config?: string;
  envFiles: string[];
  minimumDependencyAge?: string;
  serverOverride?: string;
  pin: boolean;
  depWatch: boolean;
  forwarded: string[];
}

const VALUE_FLAGS = new Set([
  "--deps-dir",
  "--lock",
  "--config",
  "--env-file",
  "--minimum-dependency-age",
  "--node-modules-dir",
  "--server",
]);

export function parseServeArgs(argv: readonly string[]): ServeArgs {
  const out: ServeArgs = {
    refreshDeps: false,
    envFiles: [],
    pin: true,
    depWatch: true,
    forwarded: [],
  };
  let passthroughOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (passthroughOnly) {
      out.forwarded.push(tok);
      continue;
    }
    if (tok === "--") {
      passthroughOnly = true;
      continue;
    }
    if (tok === "--refresh-deps" || tok === "--refresh-lock") {
      out.refreshDeps = true;
      continue;
    }
    if (tok === "--no-lock") {
      // Deno-era flag: the managed store always keeps a bun.lock.
      continue;
    }
    if (tok === "--no-pin") {
      out.pin = false;
      continue;
    }
    if (tok === "--no-dep-watch") {
      out.depWatch = false;
      continue;
    }
    const eq = tok.indexOf("=");
    const flag = tok.startsWith("--") && eq !== -1 ? tok.slice(0, eq) : tok;
    if (VALUE_FLAGS.has(flag)) {
      const value = eq !== -1 ? tok.slice(eq + 1) : argv[++i];
      if (value === undefined) continue;
      switch (flag) {
        case "--deps-dir":
          out.depsDir = value;
          break;
        case "--lock":
          // Deno-era `--lock <dir>/deno.lock`: keep the managed store next
          // to where the caller wanted the lockfile.
          out.depsDir ??= join(dirname(value), "deps");
          break;
        case "--config":
          out.config = value;
          break;
        case "--env-file":
          out.envFiles.push(value);
          break;
        case "--minimum-dependency-age":
          out.minimumDependencyAge = value;
          break;
        case "--server":
          out.serverOverride = value;
          break;
        // --node-modules-dir: Deno-only; Bun always resolves node_modules.
      }
      continue;
    }
    out.forwarded.push(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependency inputs
// ---------------------------------------------------------------------------

/** Files whose change means the gateway must re-resolve dependencies. */
const PROJECT_DEP_FILES = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];

function resolveToAbs(p: string): string {
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

/** Snapshot the watched files' bytes — the restart fingerprint. */
function fingerprint(paths: readonly string[]): string {
  return paths.map((p) => {
    try {
      return `${p}\n${readFileSync(p, "utf8")}`;
    } catch {
      return `${p}\n<absent>`;
    }
  }).join("\n\u0000\n");
}

// ---------------------------------------------------------------------------
// Serve orchestrator
// ---------------------------------------------------------------------------

async function runServe(args: ServeArgs): Promise<never> {
  const serverPath = args.serverOverride
    ? resolveToAbs(args.serverOverride)
    : fileURLToPath(new URL("./server.ts", import.meta.url));

  const depsDir = resolveToAbs(args.depsDir ?? join(".1tube", "deps"));
  if (args.refreshDeps) {
    for (const f of ["bun.lock", "node_modules"]) {
      rmSync(join(depsDir, f), { recursive: true, force: true });
    }
  }

  let configAbs = args.config ? resolveToAbs(args.config) : undefined;
  if (configAbs && !existsSync(configAbs)) {
    console.warn(`[1tube] launch: --config ${configAbs} does not exist — ignoring`);
    configAbs = undefined;
  }

  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    "1TUBE_DEPS_DIR": depsDir,
  };
  if (configAbs) childEnv["1TUBE_IMPORT_MAP"] = configAbs;
  if (!args.pin) childEnv["1TUBE_DEPS_ISOLATED"] = "1";
  if (args.minimumDependencyAge !== undefined) {
    childEnv["1TUBE_MINIMUM_DEPENDENCY_AGE"] = args.minimumDependencyAge;
  }
  // The gateway HMR-watches the same env files Bun loads at start, so
  // secret edits land without a full restart.
  if (args.envFiles.length > 0) {
    childEnv["1TUBE_ENV_FILES"] = args.envFiles.map(resolveToAbs).join(",");
  }

  // Bun auto-loads `.env`, `.env.local`, … from the cwd unless told
  // otherwise; Deno never did. Only the files the caller named are loaded
  // (an explicit --env-file already switches auto-loading off).
  const bunArgs = [
    ...(args.envFiles.length > 0
      ? args.envFiles.map((f) => `--env-file=${resolveToAbs(f)}`)
      : ["--no-env-file"]),
    serverPath,
    ...args.forwarded,
  ];

  const watchPaths = [
    ...(configAbs ? [configAbs] : IMPORT_MAP_FILES.map(resolveToAbs)),
    ...PROJECT_DEP_FILES.map(resolveToAbs),
  ];

  // --- supervise loop: spawn the gateway, restart on dependency change ---

  let stopping = false;
  let currentChild: ReturnType<typeof Bun.spawn> | undefined;
  const stop = (sig: NodeJS.Signals) => {
    stopping = true;
    try {
      currentChild?.kill(sig);
    } catch {
      // already gone
    }
  };
  process.on("SIGINT", () => stop("SIGINT"));
  if (process.platform !== "win32") process.on("SIGTERM", () => stop("SIGTERM"));

  while (true) {
    const lastFingerprint = fingerprint(watchPaths);
    const child = Bun.spawn([process.execPath, ...bunArgs], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv,
    });
    currentChild = child;

    let restartRequested = false;
    const watcher = args.depWatch
      ? startDepWatcher(watchPaths, () => {
        if (fingerprint(watchPaths) === lastFingerprint) return;
        console.log("[1tube] launch: dependency change detected — restarting gateway");
        restartRequested = true;
        try {
          child.kill(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
        } catch {
          // already exiting
        }
      })
      : undefined;

    const code = await child.exited;
    currentChild = undefined;
    watcher?.close();

    if (!stopping && restartRequested) continue;
    process.exit(code ?? 1);
  }
}

// ---------------------------------------------------------------------------
// Dependency watcher
// ---------------------------------------------------------------------------

interface DepWatcher {
  close(): void;
}

/**
 * Watch the parent dirs of `paths` (editors and package managers replace
 * files via rename, which drops a file-level watch) and fire `onChange`
 * (debounced) when one of the target files is touched.
 */
function startDepWatcher(paths: readonly string[], onChange: () => void): DepWatcher {
  const dirs = [...new Set(paths.map((p) => dirname(p)))].filter((d) => {
    try {
      return statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
  if (dirs.length === 0) return { close() {} };
  const targets = new Set(paths);
  const names = new Set(paths.map((p) => basename(p)));

  let watcher: ReturnType<typeof watchFs>;
  try {
    watcher = watchFs(dirs, { recursive: false });
  } catch {
    return { close() {} };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  void (async () => {
    for await (const event of watcher) {
      if (closed) break;
      // The dirs may host many unrelated files; only react to ours.
      if (!event.paths.some((p) => targets.has(p) || names.has(basename(p)))) continue;
      clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    }
  })();

  return {
    close() {
      closed = true;
      clearTimeout(timer);
      watcher.close();
    },
  };
}

if (import.meta.main) {
  await run(process.argv.slice(2));
}
