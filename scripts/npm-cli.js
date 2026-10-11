#!/usr/bin/env node

/**
 * `1tube` npm bin — a tiny Node shim that locates Bun and runs the single
 * launcher (`src/launch.ts`). All argument handling, the managed dependency
 * store, dependency pinning, minimum-dependency-age, and live reload live in
 * the launcher itself, so this shim stays trivial: find bun, forward argv,
 * wire up signals + exit code.
 *
 * Machines using this need Bun on PATH (or set `BUN_BIN`). Arguments are
 * forwarded verbatim — the launcher recognizes its own flags (`--deps-dir`,
 * `--refresh-deps`, `--config`, `--env-file`, `--minimum-dependency-age`,
 * `--no-pin`, `--no-dep-watch`, …) and forwards everything else to the
 * gateway. `1TUBE_BUN_ARGS` (space-separated) is appended for projects that
 * prefer to keep flags out of the command line; the Deno-era
 * `1TUBE_DENO_ARGS` is still honoured.
 *
 * The package's own dependencies (hono, esbuild, …) are installed next to it
 * by the host's package manager, so Bun resolves them from node_modules.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherEntrypoint = resolve(packageRoot, "src", "launch.ts");
const bunBin = process.env.BUN_BIN || "bun";

// The launcher imports only node: builtins + relative source, and it owns the
// gateway child's dependency store and env — so the outer `bun` stays minimal.
const bunArgs = [
  launcherEntrypoint,
  ...tokenizeArgs(
    process.env.ONETUBE_BUN_ARGS ?? process.env["1TUBE_BUN_ARGS"] ??
      process.env.ONETUBE_DENO_ARGS ?? process.env["1TUBE_DENO_ARGS"] ?? "",
  ),
  ...process.argv.slice(2),
];

// Resolve the real bun binary up front. Node ≥18.20 refuses to spawn a
// `.cmd`/`.bat` shim (e.g. npm's global `bun.cmd`) without a shell, but
// spawning a real `.exe` (or a bare binary on POSIX) with `shell:false` lets
// Node escape arguments properly — important since we forward arbitrary
// flags, some carrying paths with spaces.
const resolvedBun = resolveExecutable(bunBin);
const needsShell = resolvedBun
  ? /\.(cmd|bat)$/i.test(resolvedBun)
  : process.platform === "win32";
const spawnBin = resolvedBun ?? bunBin;

let child;
if (needsShell) {
  const command = [spawnBin, ...bunArgs].map(quoteForCmd).join(" ");
  child = spawn(command, {
    stdio: "inherit",
    shell: true,
    windowsHide: false,
  });
} else {
  child = spawn(spawnBin, bunArgs, {
    stdio: "inherit",
    shell: false,
    windowsHide: false,
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
      "[1tube] Bun was not found on PATH. Install Bun (https://bun.sh) or set BUN_BIN",
    );
    process.exit(127);
  }
  console.error(`[1tube] failed to start Bun: ${err.message}`);
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
 * Split a flag string into argv tokens, honoring single/double quotes so
 * values with spaces (`--env-file="my env.env"`) survive. Good enough for a
 * dev-time convenience var — not a full shell parser.
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
 * absolute path, or null when the name can't be resolved — in which case the
 * caller hands the bare name to spawn and lets the OS/shell try.
 *
 * @param {string} bin
 * @returns {string | null}
 */
function resolveExecutable(bin) {
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
 * Quote a single argument for cmd.exe. Leaves simple tokens untouched to avoid
 * over-quoting; wraps anything with whitespace or shell metacharacters in
 * double quotes, doubling any embedded quotes.
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteForCmd(arg) {
  if (arg === "") return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '""') + '"';
}
