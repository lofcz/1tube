#!/usr/bin/env node

/**
 * `1tube` npm bin — a tiny Node shim that locates Deno and runs the single
 * launcher (`src/launch.ts`). All argument handling, the managed lockfile,
 * dependency pinning, minimum-dependency-age, and live reload live in the
 * launcher itself, so this shim stays trivial: find deno, forward argv, wire
 * up signals + exit code.
 *
 * Machines using this need Deno on PATH (or set `DENO_BIN`). Arguments are
 * forwarded verbatim — the launcher recognizes its own flags (`--lock`,
 * `--config`, `--env-file`, `--node-modules-dir`, `--minimum-dependency-age`,
 * `--no-lock`, `--no-pin`, `--no-dep-watch`, …) and forwards everything else
 * to the gateway. `1TUBE_DENO_ARGS` (space-separated) is appended for projects
 * that prefer to keep flags out of the command line.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherEntrypoint = resolve(packageRoot, "src", "launch.ts");
const denoBin = process.env.DENO_BIN || "deno";

// The launcher needs no import map or lockfile of its own (it imports only
// node: builtins + relative source), and it owns the gateway child's lock,
// config and npm-config — so the outer `deno run` stays minimal and fast.
const denoArgs = [
  "run",
  "--quiet",
  "-A",
  "--node-modules-dir=false",
  launcherEntrypoint,
  ...tokenizeArgs(
    process.env.ONETUBE_DENO_ARGS ?? process.env["1TUBE_DENO_ARGS"] ?? "",
  ),
  ...process.argv.slice(2),
];

// Resolve the real deno binary up front. Node ≥18.20 refuses to spawn a
// `.cmd`/`.bat` shim without a shell, but spawning a real `.exe` (or a bare
// binary on POSIX) with `shell:false` lets Node escape arguments properly —
// important since we forward arbitrary flags, some carrying paths with spaces.
const resolvedDeno = resolveExecutable(denoBin);
const needsShell = resolvedDeno
  ? /\.(cmd|bat)$/i.test(resolvedDeno)
  : process.platform === "win32";
const spawnBin = resolvedDeno ?? denoBin;

let child;
if (needsShell) {
  const command = [spawnBin, ...denoArgs].map(quoteForCmd).join(" ");
  child = spawn(command, {
    stdio: "inherit",
    shell: true,
    windowsHide: false,
  });
} else {
  child = spawn(spawnBin, denoArgs, {
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
