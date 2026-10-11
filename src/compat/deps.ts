/**
 * Managed dependency store for `npm:` / `jsr:` specifiers.
 *
 * Deno downloads packages on demand into a global cache keyed by its
 * lockfile. Bun resolves through `node_modules`, so 1tube keeps a small
 * gateway-owned project (default `<cwd>/.1tube/deps`) whose `package.json`
 * lists every (package, range) pair the functions ask for, each under a
 * stable alias:
 *
 *     "zod--5f1c2a": "npm:zod@^3.23"
 *     "std__path--09ab11": "npm:@jsr/std__path@^1"     (jsr via npm.jsr.io)
 *
 * `bun install` materializes them and writes `.1tube/deps/bun.lock`, which
 * plays the role the managed `.1tube/deno.lock` used to: reproducible,
 * fast warm boots, self-healing when a range changes.
 *
 * Resolution order for a request (mirrors the old launcher's "the host's
 * package manager is the source of truth" pinning):
 *
 *   1. The host project's own `node_modules` (walking up from the
 *      importing file), if the installed version satisfies the range.
 *      An unconstrained `npm:1tube/edge` therefore always binds to the
 *      version the user installed.
 *   2. The managed store, installing on demand.
 *
 * Installs are batched: the gateway pre-scans every function's imports at
 * boot/HMR time and calls {@link DependencyManager.ensure} once. Bun's
 * plugin `onResolve` must be synchronous, so anything the scan missed
 * (computed dynamic imports) falls back to a blocking install.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { type PackageRequest, packageKey } from "./specifiers.ts";

export interface DependencyManagerOptions {
  /** Managed store directory. Created on first install. */
  dir: string;
  /** Bun executable used for installs. Defaults to the running binary. */
  bunBin?: string;
  /**
   * Minimum package age in seconds before Bun will install a release
   * (`install.minimumReleaseAge`). Default 0: install what the specifier
   * asks for immediately, overriding Bun's own release-age default.
   */
  minimumReleaseAgeSeconds?: number;
  /** Skip the host `node_modules` and always use the managed store. */
  isolated?: boolean;
  log?: (line: string) => void;
}

export interface DependencyManager {
  readonly dir: string;
  /**
   * Install every request not already satisfiable. Batched + serialized.
   * `importerPath` (a file the requests come from) anchors the host
   * `node_modules` lookup; without it the walk starts at the cwd.
   */
  ensure(reqs: Iterable<PackageRequest>, importerPath?: string): Promise<void>;
  /**
   * Resolve a request to an absolute file path, installing synchronously
   * if needed. Throws with an actionable message when the package cannot
   * be installed or the subpath doesn't exist.
   */
  resolveSync(req: PackageRequest, importerPath?: string): string;
}

const JSR_REGISTRY = "https://npm.jsr.io";

function aliasFor(req: PackageRequest): string {
  const base = req.name.replace(/^@/, "").replace(/\//g, "__")
    .replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
  const hash = (Number(BigInt(Bun.hash(packageKey(req))) & 0xffffffffn)).toString(16).padStart(8, "0");
  return `${base}--${hash}`;
}

/**
 * Locate `node_modules/<name>/package.json` walking up from `startDir`.
 * Returns the package directory or undefined.
 */
/**
 * A `node_modules` Deno created (`"nodeModulesDir": "auto"` in deno.json,
 * marked by its `.deno/` store). It belongs to Deno, not the host's package
 * manager, and its symlink layout can make one package reachable under
 * endless distinct paths — so the host walk never binds into it.
 */
const denoManaged = new Map<string, boolean>();
function isDenoManaged(nodeModules: string): boolean {
  let v = denoManaged.get(nodeModules);
  if (v === undefined) denoManaged.set(nodeModules, v = existsSync(join(nodeModules, ".deno")));
  return v;
}

function findHostPackage(name: string, startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    const nodeModules = join(dir, "node_modules");
    const candidate = join(nodeModules, name);
    const pkgJson = join(candidate, "package.json");
    if (existsSync(pkgJson) && !isDenoManaged(nodeModules)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function readVersion(pkgDir: string): string | undefined {
  try {
    const v = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"))
      ?.version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

function satisfies(version: string, range: string): boolean {
  if (range === "latest" || range === "*" || range === "") return true;
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    // A dist-tag or an exotic range: only the managed install can honour it.
    return false;
  }
}

export function createDependencyManager(
  opts: DependencyManagerOptions,
): DependencyManager {
  const dir = opts.dir;
  const bunBin = opts.bunBin ?? process.execPath;
  const log = opts.log ?? ((line: string) => console.log(line));
  const manifestPath = join(dir, "package.json");
  let installChain: Promise<void> = Promise.resolve();

  function readManifest(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
      return parsed?.dependencies && typeof parsed.dependencies === "object"
        ? parsed.dependencies
        : {};
    } catch {
      return {};
    }
  }

  function writeProject(deps: Record<string, string>): void {
    mkdirSync(dir, { recursive: true });
    const sorted = Object.fromEntries(
      Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          name: "1tube-managed-deps",
          private: true,
          description:
            "Generated by 1tube for npm:/jsr: specifiers used by edge functions. Safe to delete.",
          dependencies: sorted,
        },
        null,
        2,
      ) + "\n",
    );
    const bunfig = [
      "# Generated by 1tube.",
      "[install]",
      `minimumReleaseAge = ${opts.minimumReleaseAgeSeconds ?? 0}`,
      "",
      "[install.scopes]",
      `jsr = "${JSR_REGISTRY}"`,
      "",
    ].join("\n");
    const bunfigPath = join(dir, "bunfig.toml");
    let previous = "";
    try {
      previous = readFileSync(bunfigPath, "utf8");
    } catch { /* first run */ }
    if (previous !== bunfig) writeFileSync(bunfigPath, bunfig);
  }

  function isInstalled(alias: string): boolean {
    try {
      return statSync(join(dir, "node_modules", alias, "package.json")).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Present while `bun install` runs. Left behind means an install was
   * killed mid-way (Ctrl-C, timeout): package dirs may exist but be
   * half-extracted, so nothing in the store can be trusted until a forced
   * install repairs it.
   */
  const installMarker = join(dir, ".1tube-installing");

  function interrupted(): boolean {
    return existsSync(installMarker);
  }

  /** Requests whose alias is missing from the manifest or from disk. */
  function missing(reqs: Iterable<PackageRequest>): PackageRequest[] {
    const deps = readManifest();
    const broken = interrupted();
    const out = new Map<string, PackageRequest>();
    for (const r of reqs) {
      const alias = aliasFor(r);
      if (!broken && deps[alias] && isInstalled(alias)) continue;
      out.set(alias, r);
    }
    return [...out.values()];
  }

  function addToManifest(reqs: readonly PackageRequest[]): void {
    const deps = readManifest();
    for (const r of reqs) {
      deps[aliasFor(r)] = `npm:${r.name}@${r.range}`;
    }
    writeProject(deps);
  }

  function describe(reqs: readonly PackageRequest[]): string {
    return reqs.map((r) =>
      r.registry === "jsr"
        ? `jsr:@${r.name.slice(5).replace("__", "/")}@${r.range}`
        : `npm:${r.name}@${r.range}`
    ).join(", ");
  }

  /** Install argv; marks the store as mid-install until {@link installDone}. */
  function beginInstall(): string[] {
    const args = ["install", "--no-progress", "--no-summary"];
    // Repair a store a previous install left half-written.
    if (interrupted()) args.push("--force");
    writeFileSync(installMarker, String(process.pid));
    return args;
  }

  function installDone(): void {
    rmSync(installMarker, { force: true });
  }

  function reportFailure(reqs: readonly PackageRequest[], output: string): Error {
    return new Error(
      `[1tube] Failed to install ${describe(reqs)} into ${dir}:\n${output.trim()}`,
    );
  }

  async function installAsync(reqs: readonly PackageRequest[]): Promise<void> {
    addToManifest(reqs);
    const started = performance.now();
    log(`[1tube] Installing ${reqs.length} dependenc${reqs.length === 1 ? "y" : "ies"}: ${describe(reqs)}`);
    const proc = Bun.spawn([bunBin, ...beginInstall()], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, BUN_INSTALL_VERBOSE: undefined },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) throw reportFailure(reqs, stderr || stdout);
    installDone();
    log(`[1tube] Dependencies installed in ${(performance.now() - started).toFixed(0)}ms`);
  }

  function installSync(reqs: readonly PackageRequest[]): void {
    addToManifest(reqs);
    log(`[1tube] Installing ${describe(reqs)} (on-demand)`);
    const res = spawnSync(bunBin, beginInstall(), {
      cwd: dir,
      encoding: "utf8",
    });
    if (res.status !== 0) {
      throw reportFailure(reqs, `${res.stderr ?? ""}${res.stdout ?? ""}${res.error?.message ?? ""}`);
    }
    installDone();
  }

  function hostResolve(req: PackageRequest, importerPath?: string): string | null {
    if (opts.isolated) return null;
    const start = importerPath ? dirname(importerPath) : process.cwd();
    // Never let a package inside the managed store "find itself" through
    // the host walk — its own node_modules is the right scope already.
    if (start.startsWith(dir)) return null;
    const pkgDir = findHostPackage(req.name, start);
    if (!pkgDir) return null;
    const version = readVersion(pkgDir);
    if (!version || !satisfies(version, req.range)) return null;
    try {
      // Resolve from the directory owning the node_modules we validated,
      // not from the importer: a nearer node_modules can hold a broken or
      // dangling entry for the same name (e.g. a stale Deno-managed
      // `supabase/functions/node_modules`) that Bun's walk would hit first.
      const owner = pkgDir.slice(0, pkgDir.lastIndexOf(`${sep}node_modules${sep}`));
      return Bun.resolveSync(req.name + req.subpath, owner || start);
    } catch {
      return null;
    }
  }

  function managedResolve(req: PackageRequest): string {
    return Bun.resolveSync(aliasFor(req) + req.subpath, dir);
  }

  return {
    dir,
    ensure(reqs, importerPath) {
      const list = [...reqs];
      const run = installChain.then(async () => {
        const todo = missing(list).filter((r) => hostResolve(r, importerPath) === null);
        if (todo.length > 0) await installAsync(todo);
      });
      installChain = run.catch(() => {});
      return run;
    },
    resolveSync(req, importerPath) {
      const host = hostResolve(req, importerPath);
      if (host) return host;
      if (missing([req]).length > 0) installSync([req]);
      try {
        return managedResolve(req);
      } catch (err) {
        const spec = req.registry === "jsr"
          ? `jsr:@${req.name.slice(5).replace("__", "/")}@${req.range}${req.subpath}`
          : `npm:${req.name}@${req.range}${req.subpath}`;
        throw new Error(
          `Cannot resolve "${spec}"${importerPath ? ` from ${importerPath}` : ""}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  };
}

/** Parse `--minimum-dependency-age` values: seconds, or `30m` / `24h` / `7d`. */
export function parseReleaseAge(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)?$/i.exec(value.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "d" ? 86400 : unit === "h" ? 3600 : unit === "m" ? 60 : 1;
  return Math.round(n * mult);
}
