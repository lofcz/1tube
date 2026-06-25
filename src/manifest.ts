/**
 * Per-function `1tube.json` manifest.
 *
 * The manifest declares the security/runtime contract for a function:
 *   - `permissions.{net,env,read,write}` — allowlists. `env` is enforceable
 *     today via a per-function Proxy on `Deno.env` (opt-in with
 *     `1TUBE_ENFORCE_MANIFEST=1`). The other three are recorded as advisory
 *     metadata — the in-process TS gateway has no way to enforce them inside
 *     a single V8 isolate; treat them as documentation for now.
 *   - `timeoutMs` — wall-clock dispatch timeout (real today).
 *   - `rpm` — per-function rate-limit override (real today).
 *   - `memoryMB` — recorded only; cannot be enforced from inside V8. Use the
 *     host process's cgroup / job-object cap instead (visible on /health as
 *     `memory.limit_mb`).
 *   - `warm`, `min_replicas` — pre-warming hints. `warm: true` opts a
 *     function out of lazy loading; `min_replicas` is recorded only.
 *   - `recycle.{maxRequests,errorRate,errorWindow,cooldownMs}` — circuit-breaker
 *     thresholds consumed by the in-process supervisor.
 *
 * All fields are optional. The loader is forgiving: malformed JSON or unknown
 * fields produce a warning, never a fatal, so a typo can't take a function
 * out of rotation.
 */

// node:path so this loads from node_modules in any host Deno project
// without depending on a shared import-map entry.
import { join } from "node:path";

export interface ManifestPermissions {
  /** Hostnames the function may reach (e.g. "api.example.com"). [] = none. */
  net: string[];
  /** Env var names the function may read. [] = none. */
  env: string[];
  /** Filesystem paths the function may read. [] = none. */
  read: string[];
  /** Filesystem paths the function may write. [] = none. */
  write: string[];
}

export interface ManifestRecycle {
  /** Recycle the function after this many invocations. 0 = never. */
  maxRequests: number;
  /** Trip circuit when error ratio over `errorWindow` exceeds this (0..1). */
  errorRate: number;
  /** Sliding window size (last N invocations) for error rate. */
  errorWindow: number;
  /** Cool-down (ms) after circuit trips before requests are admitted again. */
  cooldownMs: number;
}

export interface FunctionManifest {
  permissions: ManifestPermissions;
  /** Per-function timeout in ms. Undefined = use gateway default. */
  timeoutMs?: number;
  /** Per-function rate limit (requests per minute). Undefined = use gateway default. */
  rpm?: number;
  /** Memory cap (MB). Recorded only; not enforced by the TS runtime. */
  memoryMB?: number;
  /** Eagerly load + keep alive. Recorded only by the TS runtime. */
  warm?: boolean;
  /** Minimum live isolates. Recorded only by the TS runtime. */
  min_replicas?: number;
  recycle: ManifestRecycle;
  /** True if a `1tube.json` actually exists on disk for this function. */
  fromFile: boolean;
}

export const MANIFEST_FILENAME = "1tube.json";

const DEFAULT_RECYCLE: ManifestRecycle = {
  maxRequests: 0,
  errorRate: 0.5,
  errorWindow: 20,
  cooldownMs: 30_000,
};

export function defaultManifest(): FunctionManifest {
  return {
    permissions: { net: [], env: [], read: [], write: [] },
    recycle: { ...DEFAULT_RECYCLE },
    fromFile: false,
  };
}

function asStringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out;
}

function asPositiveInt(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
  const n = Math.floor(v);
  return n > 0 ? n : undefined;
}

function asRatio(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * Parse a raw object (already JSON.parsed) into a FunctionManifest. Never
 * throws — bad input degrades to defaults.
 */
export function parseManifest(raw: unknown, fromFile = true): FunctionManifest {
  const base = defaultManifest();
  base.fromFile = fromFile;
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;

  const perm = (obj.permissions ?? {}) as Record<string, unknown>;
  base.permissions = {
    net: asStringArray(perm.net, []),
    env: asStringArray(perm.env, []),
    read: asStringArray(perm.read, []),
    write: asStringArray(perm.write, []),
  };

  base.timeoutMs = asPositiveInt(obj.timeoutMs);
  base.rpm = asPositiveInt(obj.rpm);
  base.memoryMB = asPositiveInt(obj.memoryMB);

  if (typeof obj.warm === "boolean") base.warm = obj.warm;
  const replicas = asPositiveInt(obj.min_replicas);
  if (replicas !== undefined) base.min_replicas = replicas;

  const recycle = (obj.recycle ?? {}) as Record<string, unknown>;
  base.recycle = {
    maxRequests: asPositiveInt(recycle.maxRequests) ?? 0,
    errorRate: asRatio(recycle.errorRate, DEFAULT_RECYCLE.errorRate),
    errorWindow: asPositiveInt(recycle.errorWindow) ??
      DEFAULT_RECYCLE.errorWindow,
    cooldownMs: asPositiveInt(recycle.cooldownMs) ?? DEFAULT_RECYCLE.cooldownMs,
  };

  return base;
}

/**
 * Read and parse `<functionsDir>/<name>/1tube.json`. Missing file =
 * defaultManifest(). Malformed JSON = defaultManifest() with a stderr warning.
 */
export async function loadManifest(
  functionsDir: string,
  name: string,
): Promise<FunctionManifest> {
  const path = join(functionsDir, name, MANIFEST_FILENAME);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return defaultManifest();
    }
    console.warn(`[1tube] Could not read ${path}: ${err}`);
    return defaultManifest();
  }
  try {
    return parseManifest(JSON.parse(raw), true);
  } catch (err) {
    console.warn(`[1tube] Invalid JSON in ${path}: ${err}; using defaults`);
    return defaultManifest();
  }
}
