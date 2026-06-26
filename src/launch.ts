/**
 * 1tube launcher — the single entry point for running and building 1tube.
 *
 * This is the one and only launcher: the npm `1tube` bin, the repo's deno
 * tasks, and host projects all funnel through here. There is no second
 * "in-process" serve path — `serve` always spawns the gateway as a child
 * `deno run`, which is what lets the launcher reconcile the lockfile with the
 * host's installed dependencies BEFORE the runtime resolves any npm specifier,
 * and fully reload it when a dependency changes while running.
 *
 * Dispatch
 * ========
 *   build      → cli/build.ts   (bundle for workerd/vercel)
 *   package    → cli/package.ts (sign a firmware payload)
 *   --version  → print version
 *   --help     → usage
 *   <else>     → serve (the gateway)            ← default, may be spelled `serve`
 *
 * Why a spawning launcher (the dependency story)
 * ==============================================
 * The edge runtime uses `--node-modules-dir=false`, so Deno resolves npm
 * specifiers from its own cache + lockfile, never from `node_modules`. A host
 * import map commonly maps 1tube with an UNCONSTRAINED specifier
 * (`npm:1tube/edge`, i.e. `@*`), and `@*` is satisfied by ANY version — so
 * once the lock pins, say, `1tube@0.1.43`, bumping the dependency in
 * `package.json` + `node_modules` silently changes nothing for the edge
 * runtime, and the gateway (loaded from `node_modules`) can end up a different
 * version than the edge surface its functions import.
 *
 * The launcher fixes this by rewriting every unconstrained `npm:` specifier to
 * the EXACT version installed in `node_modules` (the source of truth the user
 * controls via their package manager) and pointing the gateway at the
 * resulting generated config. Because the specifier's version now tracks the
 * installed dependency, Deno's NATIVE lockfile auto-update recomputes just
 * that entry on the next run — every already-pinned dependency is left alone,
 * so the lock keeps its reproducibility and warm-boot speed.
 *
 * Live reload
 * ===========
 * While serving, the launcher watches the host's deno config and the
 * `package.json` of every pinned dependency. When an install or a config edit
 * changes the effective dependency set, it prints a notice and fully reloads
 * the gateway (kill + respawn) so Deno re-resolves against the new versions.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AppliedPin, reconcileImports } from "./cli/dep-pin.ts";

// ---------------------------------------------------------------------------
// Top-level dispatch
// ---------------------------------------------------------------------------

export async function run(argv: readonly string[]): Promise<void> {
  const arg0 = argv[0];
  if (arg0 === "build") {
    const { runBuild } = await import("./cli/build.ts");
    Deno.exit(await runBuild(argv.slice(1)));
  }
  if (arg0 === "package") {
    const { runPackage } = await import("./cli/package.ts");
    Deno.exit(await runPackage(argv.slice(1)));
  }
  if (arg0 === "--version" || arg0 === "-v") {
    const { VERSION } = await import("./version.ts");
    console.log(VERSION);
    Deno.exit(0);
  }
  if (arg0 === "--help" || arg0 === "-h") {
    printHelp();
    Deno.exit(0);
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
  --version   Print version and exit
  --help      Print this help

Serve options (everything else is forwarded to the gateway):
  --lock <path>                 Managed lockfile (default <cwd>/.1tube/deno.lock)
  --no-lock                     Run without a lockfile
  --refresh-lock                Drop the managed lock for a clean re-resolve
  --config <path>               Host deno.json[c] (its import map is reconciled)
  --env-file[=<path>]           Env file forwarded to the gateway (repeatable)
  --minimum-dependency-age <n>  Forwarded to the gateway's deno run
  --node-modules-dir <v>        Forwarded to the gateway (default false)
  --no-pin                      Don't pin unconstrained npm specifiers
  --no-dep-watch                Don't live-reload on dependency changes
`);
}

// ---------------------------------------------------------------------------
// Serve argument parsing
// ---------------------------------------------------------------------------

interface ServeArgs {
  lock?: string;
  noLock: boolean;
  refreshLock: boolean;
  config?: string;
  envFiles: string[];
  minimumDependencyAge?: string;
  nodeModulesDir: string;
  serverOverride?: string;
  pin: boolean;
  depWatch: boolean;
  forwarded: string[];
}

const VALUE_FLAGS = new Set([
  "--lock",
  "--config",
  "--env-file",
  "--minimum-dependency-age",
  "--node-modules-dir",
  "--server",
]);

function parseServeArgs(argv: readonly string[]): ServeArgs {
  const out: ServeArgs = {
    noLock: false,
    refreshLock: false,
    envFiles: [],
    nodeModulesDir: "false",
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
    if (tok === "--no-lock") {
      out.noLock = true;
      continue;
    }
    if (tok === "--refresh-lock") {
      out.refreshLock = true;
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
        case "--lock":
          out.lock = value;
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
        case "--node-modules-dir":
          out.nodeModulesDir = value;
          break;
        case "--server":
          out.serverOverride = value;
          break;
      }
      continue;
    }
    out.forwarded.push(tok);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSONC (deno.jsonc) tolerant parse — mirrors the gateway's own stripper.
// ---------------------------------------------------------------------------

function stripJsonc(text: string): string {
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

// ---------------------------------------------------------------------------
// Installed-version resolution (the package manager is the source of truth)
// ---------------------------------------------------------------------------

/**
 * Locate the `package.json` of `pkg` in the nearest `node_modules`, walking up
 * from each start dir. Returns the path so the watcher can subscribe to it.
 */
function findInstalledPackageJson(
  pkg: string,
  startDirs: readonly string[],
): string | undefined {
  const segments = pkg.split("/");
  const tried = new Set<string>();
  for (const start of startDirs) {
    let dir = start;
    while (true) {
      const pkgJson = join(dir, "node_modules", ...segments, "package.json");
      if (!tried.has(pkgJson)) {
        tried.add(pkgJson);
        try {
          if (Deno.statSync(pkgJson).isFile) return pkgJson;
        } catch {
          // not here — keep walking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return undefined;
}

function readPackageVersion(pkgJsonPath: string): string | undefined {
  try {
    const version = JSON.parse(Deno.readTextFileSync(pkgJsonPath))?.version;
    if (typeof version === "string" && /^[0-9]/.test(version)) return version;
  } catch {
    // unreadable / non-standard version — leave unpinned
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Config reconciliation
// ---------------------------------------------------------------------------

function absolutizeTarget(value: string, baseFileUrl: URL): string {
  if (value.startsWith("./") || value.startsWith("../")) {
    return new URL(value, baseFileUrl).href;
  }
  return value;
}

interface ReconciledConfig {
  /** Absolute path the inner runtime should load as `--config`. */
  configPath: string;
  /**
   * The exact bytes the gateway will resolve against — the reload
   * fingerprint. For the generated config this is its content; with no
   * reconciliation needed it is the user config's own bytes.
   */
  fingerprint: string;
  /** Packages pinned this pass (for logging). */
  pins: AppliedPin[];
  /** Files to watch for live dependency changes. */
  watchPaths: string[];
  /** Generated config bytes to persist, or null when using the user config. */
  generated: string | null;
  /** Where the generated config should be written. */
  generatedPath: string;
}

/**
 * Read the host deno config, pin unconstrained npm specifiers to the installed
 * versions, and decide which config the gateway should load. Pure compute +
 * reads; the caller persists the generated file.
 */
function reconcileConfig(
  userConfigPath: string,
  lockDir: string,
  pin: boolean,
): ReconciledConfig {
  const userBytes = Deno.readTextFileSync(userConfigPath);
  const parsed = JSON.parse(stripJsonc(userBytes)) as {
    imports?: Record<string, string>;
    scopes?: Record<string, Record<string, string>>;
    [k: string]: unknown;
  };

  const baseFileUrl = pathToFileURL(userConfigPath);
  const startDirs = [Deno.cwd(), dirname(fileURLToPath(import.meta.url))];
  const watchPaths = new Set<string>([userConfigPath]);
  const resolveVersion = (p: string): string | undefined => {
    const pkgJson = findInstalledPackageJson(p, startDirs);
    if (!pkgJson) return undefined;
    const version = readPackageVersion(pkgJson);
    if (version) watchPaths.add(pkgJson);
    return version;
  };

  let changed = false;
  const next: typeof parsed = { ...parsed };
  const pins: AppliedPin[] = [];
  const generatedPath = join(lockDir, "deno.gen.json");

  if (pin && parsed.imports && typeof parsed.imports === "object") {
    const reconciled = reconcileImports(parsed.imports, resolveVersion);
    const withAbs: Record<string, string> = {};
    for (const [k, v] of Object.entries(reconciled.imports)) {
      const abs = absolutizeTarget(v, baseFileUrl);
      if (abs !== v) changed = true;
      withAbs[k] = abs;
    }
    if (reconciled.changed) changed = true;
    pins.push(...reconciled.pins);
    next.imports = withAbs;
  }

  if (pin && parsed.scopes && typeof parsed.scopes === "object") {
    const outScopes: Record<string, Record<string, string>> = {};
    for (const [scopeKey, map] of Object.entries(parsed.scopes)) {
      const r = reconcileImports(map, resolveVersion);
      if (r.changed) changed = true;
      const withAbs: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.imports)) {
        const abs = absolutizeTarget(v, baseFileUrl);
        if (abs !== v) changed = true;
        withAbs[k] = abs;
      }
      const newKey = absolutizeTarget(scopeKey, baseFileUrl);
      if (newKey !== scopeKey) changed = true;
      outScopes[newKey] = withAbs;
    }
    next.scopes = outScopes;
  }

  if (!changed) {
    // The user's config is already correct — load it directly, watch it.
    return {
      configPath: userConfigPath,
      fingerprint: userBytes,
      pins: [],
      watchPaths: [...watchPaths],
      generated: null,
      generatedPath,
    };
  }

  const serialized = JSON.stringify(next, null, 2) + "\n";
  return {
    configPath: generatedPath,
    fingerprint: serialized,
    pins,
    watchPaths: [...watchPaths],
    generated: serialized,
    generatedPath,
  };
}

/** Persist the generated config when its content differs from disk. */
function persistGenerated(rc: ReconciledConfig, lockDir: string): void {
  if (rc.generated === null) return;
  let previous: string | undefined;
  try {
    previous = Deno.readTextFileSync(rc.generatedPath);
  } catch {
    // first run
  }
  if (previous !== rc.generated) {
    try {
      Deno.mkdirSync(lockDir, { recursive: true });
    } catch {
      // dir already exists / not creatable — write will surface a real error
    }
    Deno.writeTextFileSync(rc.generatedPath, rc.generated);
  }
}

// ---------------------------------------------------------------------------
// Serve orchestrator
// ---------------------------------------------------------------------------

function resolveToAbs(p: string): string {
  return isAbsolute(p) ? p : resolve(Deno.cwd(), p);
}

async function runServe(args: ServeArgs): Promise<never> {
  const serverPath = args.serverOverride
    ? resolveToAbs(args.serverOverride)
    : fileURLToPath(new URL("./server.ts", import.meta.url));

  // Managed lockfile: default to the gateway-owned scratch path unless the
  // caller opted out. Never frozen, so dependency changes self-heal.
  let lockAbs: string | undefined;
  if (!args.noLock) {
    lockAbs = resolveToAbs(args.lock ?? join(".1tube", "deno.lock"));
    try {
      Deno.mkdirSync(dirname(lockAbs), { recursive: true });
    } catch {
      // best-effort
    }
    if (args.refreshLock) {
      try {
        Deno.removeSync(lockAbs);
      } catch {
        // already absent
      }
    }
  }
  const lockDir = lockAbs ? dirname(lockAbs) : resolveToAbs(".1tube");

  const userConfigAbs = args.config ? resolveToAbs(args.config) : undefined;

  // When the host doesn't supply its own import map, fall back to 1tube's
  // bundled deno.json (packageRoot/deno.json). The gateway's own sources use
  // fully-qualified npm:/jsr: specifiers, so this only matters for hosts whose
  // functions resolve bare aliases — and it never gets reconciled (its map is
  // 1tube's own, fully constrained).
  let bundledConfigAbs: string | undefined;
  if (!userConfigAbs) {
    const candidate = fileURLToPath(new URL("../deno.json", import.meta.url));
    try {
      if (Deno.statSync(candidate).isFile) bundledConfigAbs = candidate;
    } catch {
      // no bundled config (unbundled checkout) — run without one
    }
  }

  // Child env additions (merged onto the inherited environment).
  const childEnv: Record<string, string> = {};
  if (lockAbs) childEnv.ONETUBE_LOCK = lockAbs;
  // Deno 2.9's 24h minimum-dependency-age default makes freshly published
  // pins fail to resolve; it must be set before the gateway's Deno starts.
  if (
    !Deno.env.get("NPM_CONFIG_MIN_RELEASE_AGE") &&
    !Deno.env.get("npm_config_min_release_age")
  ) {
    childEnv.NPM_CONFIG_MIN_RELEASE_AGE = "0";
  }

  const buildAndPersist = (reason: "boot" | "reload"): ReconciledConfig | undefined => {
    if (!userConfigAbs) return undefined;
    let rc: ReconciledConfig;
    try {
      rc = reconcileConfig(userConfigAbs, lockDir, args.pin);
    } catch (err) {
      console.warn(
        `[1tube] launch: could not reconcile ${userConfigAbs} (${
          err instanceof Error ? err.message : String(err)
        }) — using it as-is`,
      );
      return undefined;
    }
    persistGenerated(rc, lockDir);
    if (rc.pins.length > 0) {
      const summary = rc.pins.map((p) => `${p.name}@${p.version}`).join(", ");
      const verb = reason === "boot" ? "pinned" : "re-pinned";
      console.log(`[1tube] launch: ${verb} npm specifier(s) to installed: ${summary}`);
    }
    return rc;
  };

  const buildDenoArgs = (configPath: string | undefined): string[] => {
    const denoArgs: string[] = ["run", "-q", "--allow-all"];
    denoArgs.push(`--node-modules-dir=${args.nodeModulesDir}`);
    if (lockAbs) denoArgs.push("--lock", lockAbs);
    if (args.minimumDependencyAge !== undefined) {
      denoArgs.push(`--minimum-dependency-age=${args.minimumDependencyAge}`);
    }
    for (const envFile of args.envFiles) {
      denoArgs.push(`--env-file=${resolveToAbs(envFile)}`);
    }
    if (configPath) denoArgs.push("--config", configPath);
    denoArgs.push(serverPath);
    denoArgs.push(...args.forwarded);
    return denoArgs;
  };

  // --- supervise loop: spawn the gateway, reload on dependency change ---

  let stopping = false;
  let currentChild: Deno.ChildProcess | undefined;

  const stop = (sig: Deno.Signal) => {
    stopping = true;
    try {
      currentChild?.kill(sig);
    } catch {
      // already gone
    }
  };
  const onSigint = () => stop("SIGINT");
  Deno.addSignalListener("SIGINT", onSigint);
  let onSigterm: (() => void) | undefined;
  if (Deno.build.os !== "windows") {
    onSigterm = () => stop("SIGTERM");
    Deno.addSignalListener("SIGTERM", onSigterm);
  }

  let lastFingerprint: string | undefined;

  while (!stopping) {
    const rc = buildAndPersist(lastFingerprint === undefined ? "boot" : "reload");
    lastFingerprint = rc?.fingerprint ?? "";
    const configPath = rc?.configPath ?? userConfigAbs ?? bundledConfigAbs;

    const child = new Deno.Command(Deno.execPath(), {
      args: buildDenoArgs(configPath),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv,
    }).spawn();
    currentChild = child;

    let reloadRequested = false;
    const watcher = args.depWatch && rc
      ? startDepWatcher(rc.watchPaths, () => {
        // Recompute the effective config; reload only on a real change.
        let nextRc: ReconciledConfig;
        try {
          nextRc = reconcileConfig(userConfigAbs!, lockDir, args.pin);
        } catch {
          return;
        }
        if (nextRc.fingerprint === lastFingerprint) return;
        console.log(
          "[1tube] launch: dependency change detected — reloading gateway",
        );
        reloadRequested = true;
        try {
          child.kill(Deno.build.os === "windows" ? "SIGKILL" : "SIGTERM");
        } catch {
          // already exiting
        }
      })
      : undefined;

    const status = await child.status;
    currentChild = undefined;
    watcher?.close();

    if (stopping) {
      cleanupSignals(onSigint, onSigterm);
      Deno.exit(status.code);
    }
    if (reloadRequested) {
      continue; // respawn with the freshly reconciled config
    }
    // The gateway exited on its own — propagate its code.
    cleanupSignals(onSigint, onSigterm);
    Deno.exit(status.code);
  }

  cleanupSignals(onSigint, onSigterm);
  Deno.exit(0);
}

function cleanupSignals(
  onSigint: () => void,
  onSigterm: (() => void) | undefined,
): void {
  try {
    Deno.removeSignalListener("SIGINT", onSigint);
  } catch {
    // ignore
  }
  if (onSigterm) {
    try {
      Deno.removeSignalListener("SIGTERM", onSigterm);
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Dependency watcher
// ---------------------------------------------------------------------------

interface DepWatcher {
  close(): void;
}

/**
 * Watch the host config + each pinned dependency's package.json (its parent
 * dir, so atomic-rename installs are still observed) and fire `onChange`
 * (debounced) on any filesystem event.
 */
function startDepWatcher(paths: readonly string[], onChange: () => void): DepWatcher {
  // Watch parent directories: editors and package managers frequently replace
  // files via rename, which drops a file-level watch.
  const dirs = [...new Set(paths.map((p) => dirname(p)))].filter((d) => {
    try {
      return Deno.statSync(d).isDirectory;
    } catch {
      return false;
    }
  });
  if (dirs.length === 0) return { close() {} };

  const targets = new Set(paths);
  let watcher: Deno.FsWatcher;
  try {
    watcher = Deno.watchFs(dirs, { recursive: false });
  } catch {
    return { close() {} };
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  (async () => {
    for await (const event of watcher) {
      if (closed) break;
      // Only react to the specific files we care about (the dirs may host
      // many unrelated files, e.g. all of node_modules/<pkg>/).
      if (!event.paths.some((p) => targets.has(p))) continue;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(onChange, 250);
    }
  })();

  return {
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        watcher.close();
      } catch {
        // already closed
      }
    },
  };
}

if (import.meta.main) {
  await run(Deno.args);
}
