/**
 * `1tube test` — run edge function tests with gateway-identical resolution.
 *
 *   1tube test [--functions <dir>] [--config <import map>] [--env-file <f>]…
 *              [bun test args / paths…]
 *
 * Test files import from `1tube/test`; this command picks the runner for
 * the current runtime (Bun: `bun test`) and preloads the compat layer so
 * the import map, `npm:` / `jsr:` specifiers and the managed dependency
 * store apply to function code under test. Without explicit paths it runs
 * every test under the functions dir.
 *
 * Each test file runs isolated (fresh globals and module registry), like
 * each function on the gateway: by default in parallel worker processes,
 * so `mock.module` and other module state cannot leak between files.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** `bun test` flags that consume the following token as their value. */
const BUN_TEST_VALUE_FLAGS = new Set([
  "--timeout",
  "--rerun-each",
  "--retry",
  "-t",
  "--test-name-pattern",
  "--preload",
  "--coverage-reporter",
  "--coverage-dir",
  "--reporter",
  "--reporter-outfile",
  "--seed",
  "--max-concurrency",
  "--path-ignore-patterns",
]);

export interface TestArgs {
  functionsDir: string;
  /** `--no-parallel`: isolate files in one process instead of workers. */
  parallel: boolean;
  config?: string;
  depsDir?: string;
  envFiles: string[];
  forwarded: string[];
  hasPaths: boolean;
}

export function parseTestArgs(argv: readonly string[]): TestArgs {
  const out: TestArgs = { functionsDir: "", parallel: true, envFiles: [], forwarded: [], hasPaths: false };
  let functionsDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "--") {
      for (const rest of argv.slice(i + 1)) {
        out.forwarded.push(rest);
        if (!rest.startsWith("-")) out.hasPaths = true;
      }
      break;
    }
    const eq = tok.startsWith("--") ? tok.indexOf("=") : -1;
    const flag = eq === -1 ? tok : tok.slice(0, eq);
    const value = () => (eq !== -1 ? tok.slice(eq + 1) : argv[++i]);
    switch (flag) {
      case "--functions":
      case "-f":
        functionsDir = value();
        continue;
      case "--config":
      case "--import-map":
        out.config = value();
        continue;
      case "--deps-dir":
        out.depsDir = value();
        continue;
      case "--env-file":
        out.envFiles.push(value());
        continue;
      case "--no-parallel":
        out.parallel = false;
        continue;
    }
    out.forwarded.push(tok);
    if (BUN_TEST_VALUE_FLAGS.has(flag) && eq === -1 && i + 1 < argv.length) {
      out.forwarded.push(argv[++i]);
    } else if (!tok.startsWith("-")) {
      out.hasPaths = true;
    }
  }
  out.functionsDir = functionsDir ??
    (existsSync("supabase/functions") ? "supabase/functions" : "functions");
  return out;
}

export async function runTest(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: 1tube test [options] [bun test args / paths…]

Runs edge function tests (files importing \`1tube/test\`) with the gateway's
module resolution. Without paths, runs every test under the functions dir.
Each file runs isolated, in parallel workers by default.

Options:
  --functions, -f <dir>   Functions dir (default: supabase/functions, else functions)
  --config <path>         Import map (import_map.json, or a deno.json[c] with "imports")
  --deps-dir <path>       Managed npm:/jsr: store (default <cwd>/.1tube/deps)
  --env-file <path>       Env file loaded into the test process (repeatable)
  --no-parallel           Run files one after another in one process (still isolated)
  --                      Pass everything after it to the runner verbatim
`);
    return 0;
  }
  const args = parseTestArgs(argv);
  const cwd = process.cwd();
  const functionsAbs = resolve(cwd, args.functionsDir);
  if (!existsSync(functionsAbs)) {
    console.error(`[1tube] test: functions dir not found: ${functionsAbs}`);
    return 1;
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    "1TUBE_FUNCTIONS_DIR": functionsAbs,
  };
  if (args.config) {
    const abs = isAbsolute(args.config) ? args.config : resolve(cwd, args.config);
    if (!existsSync(abs)) {
      console.error(`[1tube] test: --config not found: ${abs}`);
      return 1;
    }
    env["1TUBE_IMPORT_MAP"] = abs;
  }
  if (args.depsDir) env["1TUBE_DEPS_DIR"] = resolve(cwd, args.depsDir);

  const preload = fileURLToPath(new URL("../test/preload.ts", import.meta.url));
  // A path filter starting with "./" is matched as a path, not a substring.
  const rel = relative(cwd, functionsAbs).replace(/\\/g, "/");
  const defaultPath = rel.startsWith("..") || isAbsolute(rel) ? functionsAbs : `./${rel || "."}`;
  const cmd = [
    process.execPath,
    // Like the gateway: only the env files the caller named.
    ...(args.envFiles.length > 0
      ? args.envFiles.map((f) => `--env-file=${resolve(cwd, f)}`)
      : ["--no-env-file"]),
    "test",
    "--preload",
    preload,
    // Isolation unless the caller chose a mode themselves.
    ...(args.forwarded.some((a) => /^--(parallel|isolate|no-isolate)(=|$)/.test(a))
      ? []
      : [args.parallel ? "--parallel" : "--isolate"]),
    ...args.forwarded,
    ...(args.hasPaths ? [] : [defaultPath]),
  ];
  const child = Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => child.kill(sig));
  }
  return await child.exited;
}
