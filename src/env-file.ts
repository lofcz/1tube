/**
 * Dotenv parse + apply helpers for HMR secret reloads.
 *
 * Deno's `--env-file` only loads once at process start. When `--hmr` is
 * on we re-read the same files on change, push values into `Deno.env`,
 * and ask the hot-reloader to respawn workers / workerd so top-level
 * `const KEY = Deno.env.get(...)` captures pick up the new secrets.
 */

import { basename, dirname, isAbsolute, resolve } from "node:path";

export type EnvSource = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
};

export interface EnvApplyDiff {
  /** Absolute paths that were successfully read. */
  files: string[];
  added: string[];
  updated: string[];
  removed: string[];
  /** True when at least one key was added, updated, or removed. */
  changed: boolean;
}

/** Keys currently owned by watched env files (union across all files). */
const ownedKeys = new Set<string>();

/** Test seam: reset owned-key tracking between tests. */
export function resetEnvFileOwnership(): void {
  ownedKeys.clear();
}

/**
 * Parse a dotenv-format document into an ordered map.
 *
 * Mirrors Deno's `--env-file` rules closely enough for HMR:
 *   - `#` comments and blank lines are ignored
 *   - optional `export ` prefix
 *   - first occurrence of a key wins within a file
 *   - unquoted / single-quoted / double-quoted values
 *   - `\n` / `\r` / `\t` / `\\` / `\"` escapes inside double quotes
 */
export function parseEnvFile(content: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const body = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (out.has(key)) continue; // first wins
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, "\\");
      }
    } else {
      // Unquoted: strip inline comments (`KEY=val # comment`).
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trimEnd();
    }
    out.set(key, value);
  }
  return out;
}

/**
 * Resolve which env files HMR should watch.
 *
 * Priority:
 *   1. Explicit list (tests / future CLI)
 *   2. `1TUBE_ENV_FILES` (comma-separated) — set by the launcher when
 *      the operator passes `--env-file=…`
 *   3. Convention: `.env`, `.env.local`, `.env.development` under cwd
 *      when those files already exist
 */
export function resolveWatchedEnvFiles(opts: {
  cwd?: string;
  explicit?: readonly string[];
  envFilesEnv?: string | null;
} = {}): string[] {
  const cwd = opts.cwd ?? Deno.cwd();
  const collected: string[] = [];
  if (opts.explicit) {
    for (const p of opts.explicit) collected.push(p);
  }
  const fromEnv = opts.envFilesEnv === null
    ? ""
    : (opts.envFilesEnv ?? Deno.env.get("1TUBE_ENV_FILES") ?? "");
  for (const part of fromEnv.split(",")) {
    const t = part.trim();
    if (t) collected.push(t);
  }
  if (collected.length === 0) {
    for (const name of [".env", ".env.local", ".env.development"]) {
      const candidate = resolve(cwd, name);
      try {
        if (Deno.statSync(candidate).isFile) collected.push(candidate);
      } catch {
        // absent — skip
      }
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of collected) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * Re-read `files` (in order; later files override earlier) and sync
 * into `env`. Keys that disappeared from every watched file since the
 * last apply are deleted so secret rotations/removals take effect.
 */
export function applyEnvFiles(
  files: readonly string[],
  env: EnvSource = Deno.env,
): EnvApplyDiff {
  const merged = new Map<string, string>();
  const readFiles: string[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = Deno.readTextFileSync(file);
    } catch {
      // Missing mid-edit (atomic save) — skip this file for now; the
      // next fs event will retry. Don't wipe owned keys on a transient
      // read failure.
      continue;
    }
    readFiles.push(file);
    const parsed = parseEnvFile(text);
    // Later files win (matches Deno's last `--env-file` precedence).
    for (const [k, v] of parsed) merged.set(k, v);
  }

  // If every file failed to read, leave state alone — likely a
  // transient atomic-rename race.
  if (files.length > 0 && readFiles.length === 0) {
    return {
      files: [],
      added: [],
      updated: [],
      removed: [],
      changed: false,
    };
  }

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];

  for (const [key, value] of merged) {
    const prev = env.get(key);
    if (prev === undefined) {
      env.set(key, value);
      added.push(key);
    } else if (prev !== value) {
      env.set(key, value);
      updated.push(key);
    }
  }

  for (const key of ownedKeys) {
    if (!merged.has(key)) {
      env.delete(key);
      removed.push(key);
    }
  }

  ownedKeys.clear();
  for (const key of merged.keys()) ownedKeys.add(key);

  added.sort();
  updated.sort();
  removed.sort();
  return {
    files: readFiles,
    added,
    updated,
    removed,
    changed: added.length + updated.length + removed.length > 0,
  };
}

/** Parent directories to feed `Deno.watchFs` (atomic renames land here). */
export function envFileWatchDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const f of files) {
    dirs.add(dirname(f));
  }
  return [...dirs];
}

/** True when an fs event path is (or renames onto) one of our env files. */
export function isEnvFileEvent(
  eventPaths: readonly string[],
  envFiles: readonly string[],
): boolean {
  if (envFiles.length === 0) return false;
  const targets = new Set(envFiles.map((p) => resolve(p)));
  const byDir = new Map<string, Set<string>>();
  for (const t of targets) {
    const dir = dirname(t);
    const name = basename(t);
    let set = byDir.get(dir);
    if (!set) {
      set = new Set();
      byDir.set(dir, set);
    }
    set.add(name);
  }
  for (const raw of eventPaths) {
    const p = resolve(raw);
    if (targets.has(p)) return true;
    // Atomic save: event may report the temp sibling or just the dir.
    const dir = dirname(p);
    const names = byDir.get(dir);
    if (!names) continue;
    if (names.has(basename(p))) return true;
    // Directory-level events (Windows) — treat as "maybe our file".
    try {
      if (Deno.statSync(p).isDirectory && byDir.has(p)) return true;
    } catch {
      // deleted path — if its basename matched we'd already returned;
      // a missing temp file still warrants a re-read of that dir's targets.
      if (byDir.has(dir)) return true;
    }
  }
  return false;
}
