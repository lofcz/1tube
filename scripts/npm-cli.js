#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const denoConfig = resolve(packageRoot, "deno.json");
const cliEntrypoint = resolve(packageRoot, "src", "cli.ts");
const denoBin = process.env.DENO_BIN || "deno";

// Arg model
// ---------
// Everything BEFORE a standalone `--` is a 1tube CLI argument (forwarded
// after the entrypoint). Everything AFTER `--` is a raw `deno run` flag,
// inserted BEFORE the entrypoint — so this launcher can fully replace a
// hand-rolled `deno run … src/server.ts` line:
//
//   1tube serve --functions ./supabase/functions --dev --hmr \
//     -- --no-lock --env-file=.env --config ./supabase/functions/deno.json --node-modules-dir=false
//
// Projects that would rather not thread flags through the command line
// can set `1TUBE_DENO_ARGS` instead (same flags, space-separated).
const rawArgs = process.argv.slice(2);
const sepIndex = rawArgs.indexOf("--");
const tubeArgs = sepIndex === -1 ? rawArgs : rawArgs.slice(0, sepIndex);
const cliDenoArgs = sepIndex === -1 ? [] : rawArgs.slice(sepIndex + 1);

// CLI passthrough is appended last so it wins on any duplicate flag
// (Deno applies last-one-wins for repeated flags).
const denoPassthrough = [
  ...tokenizeArgs(
    process.env.ONETUBE_DENO_ARGS ?? process.env["1TUBE_DENO_ARGS"] ?? "",
  ),
  ...cliDenoArgs,
];

// Default to --help only when the user gave us nothing at all; if they
// supplied deno flags but no 1tube subcommand, let cli.ts fall through to
// its default `serve` path.
const forwardedTubeArgs = tubeArgs.length === 0 && denoPassthrough.length === 0
  ? ["--help"]
  : tubeArgs;

// 1tube ships its own deno.json (import map for the gateway's jsr:/npm:
// dependencies). Only inject it when the project didn't supply its own
// --config — a Supabase project points --config at
// supabase/functions/deno.json so its function workers resolve the
// project's bare specifiers. The gateway's own sources use fully
// qualified npm:/jsr: specifiers, so they resolve without our config.
const userSuppliedConfig = denoPassthrough.some((a) =>
  a === "--config" || a === "-c" ||
  a.startsWith("--config=") || a.startsWith("-c=")
);

// Managed lockfile
// ----------------
// A lockfile is what makes a big functions project boot fast: without one
// (`--no-lock`) Deno re-solves the entire npm/jsr version graph from
// scratch on every start, and a 100-function project pays that as a
// multi-second floor every boot. People reach for `--no-lock` to dodge
// "the lock went stale when I bumped a dep" pain — but in dev Deno's
// lockfile is ADDITIVE and non-frozen: a changed dependency is appended
// without error. So the right default is a lockfile we own, not none.
//
// We point `--lock` at `.1tube/deno.lock` — a gateway-owned scratch path
// (already gitignored alongside `.1tube/logs.db`) so it never adds git
// churn and never collides with a project's own committed `deno.lock`.
// We never pass `--frozen`, so dep changes self-heal. `1TUBE_REFRESH_LOCK=1`
// drops the managed lock for a clean rebuild. Any explicit `--lock`,
// `--no-lock`, or `--frozen` the user passes wins — we don't second-guess.
const managedLock = resolveManagedLock(denoPassthrough);

const denoArgs = ["run", "--quiet", "-A"];
if (!userSuppliedConfig) denoArgs.push("--config", denoConfig);
if (managedLock) denoArgs.push("--lock", managedLock);
denoArgs.push(...denoPassthrough, cliEntrypoint, ...forwardedTubeArgs);

// Deno 2.9 enables a 24h "minimum dependency age" by default, which makes
// a function that pins a freshly published npm version fail to resolve in
// local dev ("…newer than the specified minimum dependency date"). This
// setting cannot be changed from inside the process (Deno snapshots npm
// config at startup), so the launcher is the place to neutralize it.
//
// NPM_CONFIG_MIN_RELEASE_AGE is the LOWEST explicit tier in Deno's
// precedence chain (CLI flag > deno.json > .npmrc > this env var > the
// 24h built-in default). Setting it to 0 cancels ONLY the built-in
// default — any .npmrc `min-release-age`, deno.json `minimumDependencyAge`,
// or `--minimum-dependency-age` the project sets still wins. We never
// override a value the user already exported.
const childEnv = { ...process.env };
if (
  childEnv.NPM_CONFIG_MIN_RELEASE_AGE === undefined &&
  childEnv.npm_config_min_release_age === undefined
) {
  childEnv.NPM_CONFIG_MIN_RELEASE_AGE = "0";
}
// Let the gateway print which lockfile is in effect (it can't read its own
// process's `--lock` flag back out of Deno).
if (managedLock) childEnv.ONETUBE_LOCK = managedLock;

// Resolve the real deno binary up front. Node ≥18.20 refuses to spawn a
// `.cmd`/`.bat` shim without a shell, but spawning a real `.exe` (or a
// bare binary on POSIX) with `shell:false` lets Node escape arguments
// properly — important now that we forward arbitrary deno flags, some of
// which carry paths with spaces (`--config "C:\My Project\deno.json"`).
// We only fall back to a shell when we must (a `.cmd`/`.bat` shim, or we
// couldn't locate the binary on a Windows PATH at all).
const resolvedDeno = resolveExecutable(denoBin);
const needsShell = resolvedDeno
  ? /\.(cmd|bat)$/i.test(resolvedDeno)
  : process.platform === "win32";
const spawnBin = resolvedDeno ?? denoBin;

let child;
if (needsShell) {
  // A `.cmd`/`.bat` shim (the npm-installed deno) — or an unresolved name
  // on Windows — must go through a shell. We pass a single, manually
  // quoted command string instead of an args array so that (a) paths
  // with spaces survive and (b) we sidestep Node's DEP0190 "args are not
  // escaped" deprecation, which fires only for the shell-plus-array form.
  const command = [spawnBin, ...denoArgs].map(quoteForCmd).join(" ");
  child = spawn(command, {
    stdio: "inherit",
    shell: true,
    windowsHide: false,
    env: childEnv,
  });
} else {
  // Real executable (deno.exe / a POSIX binary): no shell, so Node
  // escapes each argument for us.
  child = spawn(spawnBin, denoArgs, {
    stdio: "inherit",
    shell: false,
    windowsHide: false,
    env: childEnv,
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on("error", (err) => {
  if (err && "code" in err && err.code === "ENOENT") {
    console.error(
      "[1tube] Deno was not found on PATH. Install Deno or set DENO_BIN to the deno executable.",
    );
    process.exit(127);
  }
  console.error(`[1tube] failed to start Deno: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

/**
 * Decide whether to inject a 1tube-managed lockfile, and where.
 *
 * Returns the absolute lock path to pass to `--lock`, or null when the
 * caller already made an explicit locking choice (`--lock`, `--no-lock`,
 * or `--frozen`) — in which case we stay out of the way entirely.
 *
 * The managed lock lives at `<cwd>/.1tube/deno.lock`: a scratch path that
 * 1tube already owns and gitignores, so enabling it adds no git churn and
 * never clashes with a project's own committed `deno.lock`.
 *
 * @param {string[]} passthrough  Raw deno flags being forwarded to `deno run`.
 * @returns {string | null}
 */
function resolveManagedLock(passthrough) {
  const explicit = passthrough.some((a) =>
    a === "--lock" || a.startsWith("--lock=") ||
    a === "--no-lock" || a.startsWith("--no-lock=") ||
    a === "--frozen" || a.startsWith("--frozen=")
  );
  if (explicit) return null;

  const dir = join(process.cwd(), ".1tube");
  const lockPath = join(dir, "deno.lock");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // If we can't create the scratch dir, fall back to no managed lock
    // rather than crash the launcher.
    return null;
  }

  // `1TUBE_REFRESH_LOCK=1` forces a clean rebuild by dropping the managed
  // lock; Deno then re-derives it from the current deps on this boot.
  if (truthy(process.env.ONETUBE_REFRESH_LOCK ?? process.env["1TUBE_REFRESH_LOCK"])) {
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // Best-effort.
    }
  }
  return lockPath;
}

/**
 * Loose truthiness for env-var flags: "1", "true", "yes", "on" (any case).
 *
 * @param {string | undefined} v
 * @returns {boolean}
 */
function truthy(v) {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Split a flag string into argv tokens, honoring single/double quotes so
 * values with spaces (`--env-file="my env.env"`) survive. Good enough for
 * a dev-time convenience var — not a full shell parser.
 *
 * @param {string} s
 * @returns {string[]}
 */
function tokenizeArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

/**
 * Locate an executable on PATH (honoring PATHEXT on Windows). Returns an
 * absolute path, or null when the name can't be resolved — in which case
 * the caller hands the bare name to spawn and lets the OS/shell try.
 *
 * @param {string} bin
 * @returns {string | null}
 */
function resolveExecutable(bin) {
  // An explicit path (absolute or containing a separator) is used as-is.
  if (isAbsolute(bin) || bin.includes("/") || bin.includes("\\")) {
    return existsSync(bin) ? bin : null;
  }
  const isWin = process.platform === "win32";
  const exts = isWin
    ? (process.env.PATHEXT?.split(";").map((e) => e.trim()).filter(Boolean) ??
      [".EXE", ".CMD", ".BAT"])
    : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, bin + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Quote a single argument for cmd.exe. Leaves simple tokens untouched to
 * avoid over-quoting; wraps anything with whitespace or shell
 * metacharacters in double quotes, doubling any embedded quotes.
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteForCmd(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}
