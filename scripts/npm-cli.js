#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const denoConfig = resolve(packageRoot, "deno.json");
const cliEntrypoint = resolve(packageRoot, "src", "cli.ts");
const denoBin = process.env.DENO_BIN || "deno";
const cliArgs = process.argv.slice(2);
const forwardedArgs = cliArgs.length === 0 ? ["--help"] : cliArgs;

const child = spawn(
  denoBin,
  [
    "run",
    "--quiet",
    "-A",
    "--config",
    denoConfig,
    cliEntrypoint,
    ...forwardedArgs,
  ],
  {
    stdio: "inherit",
    windowsHide: false,
  },
);

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
