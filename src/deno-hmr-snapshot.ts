/**
 * Deno backend HMR snapshotting.
 *
 * Deno's in-process module cache is keyed by module URL and cannot be
 * invalidated. Importing `index.ts?v=...` refreshes only the entrypoint;
 * relative children such as `./types.ts` keep their old file URLs. HMR reloads
 * therefore import from a fresh snapshot path per generation, which gives the
 * entire relative dependency graph new module identities.
 */

import { basename, dirname, join, resolve as resolvePath } from "node:path";

const DEFAULT_KEEP_GENERATIONS = 3;

export type SnapshotChanged = ReadonlySet<string> | "all";

export interface DenoHmrSnapshotOptions {
  /** Real functions directory, e.g. `supabase/functions`. */
  functionsDir: string;
  /** Changed function names, or `"all"` for shared/full reloads. */
  changed: SnapshotChanged;
  /** Monotonic generation number owned by the caller. */
  generation: number;
  /** Cache root; defaults to `<cwd>/.1tube-cache/deno-hmr`. */
  cacheDir?: string;
  /** Number of newest generations to keep on disk. */
  keepGenerations?: number;
}

export interface DenoHmrSnapshot {
  /** Generation root, e.g. `.1tube-cache/deno-hmr/gen-4`. */
  root: string;
  /** Snapshot functions root passed to the discovery importer. */
  functionsDir: string;
  /** Names of top-level directories materialized into this snapshot. */
  copiedDirs: string[];
}

function defaultCacheDir(): string {
  return join(Deno.cwd(), ".1tube-cache", "deno-hmr");
}

function isSharedDir(name: string): boolean {
  return name.startsWith("_") || name.endsWith("_shared");
}

async function copyEntry(src: string, dest: string): Promise<void> {
  const info = await Deno.lstat(src);

  if (info.isSymlink) {
    const target = await Deno.readLink(src);
    try {
      await Deno.symlink(target, dest);
      return;
    } catch {
      // Windows often disallows symlink creation for normal users. Fall
      // through to copying the resolved target so the snapshot remains usable.
      const stat = await Deno.stat(src);
      if (stat.isDirectory) {
        await copyDirectory(src, dest);
      } else {
        await Deno.copyFile(src, dest);
      }
      return;
    }
  }

  if (info.isDirectory) {
    await copyDirectory(src, dest);
    return;
  }

  if (info.isFile) {
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.copyFile(src, dest);
  }
}

async function copyDirectory(src: string, dest: string): Promise<void> {
  await Deno.mkdir(dest, { recursive: true });
  for await (const entry of Deno.readDir(src)) {
    await copyEntry(join(src, entry.name), join(dest, entry.name));
  }
}

async function existingTopLevelDirs(functionsDir: string): Promise<string[]> {
  const dirs: string[] = [];
  for await (const entry of Deno.readDir(functionsDir)) {
    if (entry.isDirectory) dirs.push(entry.name);
  }
  dirs.sort();
  return dirs;
}

async function pruneGenerations(
  cacheDir: string,
  keepGenerations: number,
): Promise<void> {
  const generations: Array<{ name: string; n: number }> = [];
  try {
    for await (const entry of Deno.readDir(cacheDir)) {
      if (!entry.isDirectory) continue;
      const match = /^gen-(\d+)$/.exec(entry.name);
      if (match) generations.push({ name: entry.name, n: Number(match[1]) });
    }
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }

  generations.sort((a, b) => b.n - a.n);
  for (const old of generations.slice(Math.max(1, keepGenerations))) {
    await Deno.remove(join(cacheDir, old.name), { recursive: true }).catch(
      () => {},
    );
  }
}

export async function createDenoHmrSnapshot(
  options: DenoHmrSnapshotOptions,
): Promise<DenoHmrSnapshot> {
  const sourceRoot = await Deno.realPath(options.functionsDir);
  const cacheDir = resolvePath(options.cacheDir ?? defaultCacheDir());
  const keepGenerations = Math.max(
    1,
    options.keepGenerations ?? DEFAULT_KEEP_GENERATIONS,
  );
  const root = join(cacheDir, `gen-${options.generation}`);
  const snapshotFunctionsDir = join(root, basename(sourceRoot));

  await Deno.remove(root, { recursive: true }).catch((err) => {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  });
  await Deno.mkdir(snapshotFunctionsDir, { recursive: true });

  const topLevelDirs = await existingTopLevelDirs(sourceRoot);
  const selected = (() => {
    if (options.changed === "all") return topLevelDirs;
    const changed = options.changed;
    return topLevelDirs.filter((name) =>
      isSharedDir(name) || changed.has(name)
    );
  })();

  for (const name of selected) {
    await copyDirectory(
      join(sourceRoot, name),
      join(snapshotFunctionsDir, name),
    );
  }

  await pruneGenerations(cacheDir, keepGenerations);

  return {
    root,
    functionsDir: snapshotFunctionsDir,
    copiedDirs: selected,
  };
}
