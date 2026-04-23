#!/usr/bin/env -S deno run --allow-read --allow-write
/**
 * Generate per-function `1tube.json` manifests from a Deno permission audit log.
 *
 * Usage:
 *
 *   # 1) Boot 1tube with audit logging on, exercise every function once.
 *   $env:DENO_AUDIT_PERMISSIONS = "./perms.log"
 *   $env:DENO_TRACE_PERMISSIONS = "1"
 *   deno run --allow-all src/server.ts \
 *       --functions ../sciobot-next/supabase/functions
 *   # ...curl /functions/v1/<each-fn> ...
 *
 *   # 2) Convert the log into one 1tube.json per function.
 *   deno run --allow-read --allow-write \
 *       scripts/audit-to-manifest.ts \
 *       --log ./perms.log \
 *       --functions ../sciobot-next/supabase/functions \
 *       [--write] [--merge] [--include-shared]
 *
 * Without `--write`, the script prints what it would do (dry run). With
 * `--merge`, an existing manifest's permissions are taken as a floor and
 * widened — never narrowed — so manual entries survive a re-run.
 *
 * Stack-trace attribution: each audit record's stack is scanned for the first
 * frame whose path lies inside `<functionsDir>/<name>/...`. Records that only
 * touch shared / dependency code are dropped unless `--include-shared` is set
 * (in which case they're applied to every function — useful for libraries
 * that read a globally-required env var).
 */

import { join, normalize, relative, resolve, SEPARATOR } from "@std/path";
import {
  defaultManifest,
  type FunctionManifest,
  MANIFEST_FILENAME,
} from "../src/manifest.ts";

// ---------------------------------------------------------------------------
// Audit log model
// ---------------------------------------------------------------------------

/**
 * A single record from `DENO_AUDIT_PERMISSIONS`. The exact shape varies by
 * Deno version; we accept any of the common variants. With
 * `DENO_TRACE_PERMISSIONS=1`, a `stack` (string) or `frames` (array) field
 * is also present.
 */
export interface AuditRecord {
  permission: string;
  value?: string;
  stack?: string;
  frames?: Array<{ fileName?: string; functionName?: string }>;
  // Anything else — kept on the record so a future Deno release can add fields
  // without breaking us.
  [k: string]: unknown;
}

export interface AuditOptions {
  /** Absolute path to the directory containing per-function subdirectories. */
  functionsDir: string;
  /** When true, audit entries with no resolvable function get applied to all. */
  includeShared?: boolean;
}

export interface FunctionPermissions {
  env: Set<string>;
  read: Set<string>;
  write: Set<string>;
  net: Set<string>;
  /** Unknown / unsupported permission keys we saw, for the operator to triage. */
  other: Map<string, Set<string>>;
}

export type PermissionMap = Map<string, FunctionPermissions>;

function emptyPerms(): FunctionPermissions {
  return {
    env: new Set(),
    read: new Set(),
    write: new Set(),
    net: new Set(),
    other: new Map(),
  };
}

/**
 * Pull file paths out of a stack-trace string. Matches the common Deno format:
 *   "    at fn (file:///abs/path/file.ts:line:col)"
 *   "    at file:///abs/path/file.ts:line:col"
 *   "    at /abs/path/file.ts:line:col"  (rare)
 */
export function extractPathsFromStack(stack: string): string[] {
  const out: string[] = [];
  // Match (a) `file://` followed by either `/<posix-path>` or `/<drive>:/...`,
  // or (b) a bare absolute path (POSIX `/x/y` or Windows `C:\x\y`) that
  // appears after a word boundary. We deliberately keep the leading `/` for
  // POSIX paths in the captured group — `file://` (two slashes) lets the
  // third `/` belong to the path itself.
  const re =
    /(?:file:\/\/|\b)(\/[A-Za-z]:[\\/][^\s:)]+|\/[^\s:)]+|[A-Za-z]:[\\/][^\s:)]+)(?::\d+:\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stack)) !== null) {
    let p = m[1].replace(/\\/g, "/");
    // `file:///C:/x` captures as `/C:/x` — strip the synthetic leading slash
    // so the result is the real Windows path `C:/x`.
    if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1);
    out.push(decodeURIComponent(p));
  }
  return out;
}

function pathsFromRecord(rec: AuditRecord): string[] {
  if (rec.frames && Array.isArray(rec.frames)) {
    return rec.frames
      .map((f) => f.fileName ?? "")
      .filter(Boolean)
      .map((p) => decodeURIComponent(p.replace(/^file:\/\/\//, "")));
  }
  if (typeof rec.stack === "string") return extractPathsFromStack(rec.stack);
  return [];
}

/**
 * Identify which function (if any) owns a given absolute path under
 * `functionsDir`. Skips paths under `_shared` or any directory whose first
 * segment starts with `_` (mirroring discovery's filter).
 */
export function functionForPath(
  absPath: string,
  functionsDirAbs: string,
): string | null {
  const norm = normalize(absPath).replace(/\\/g, "/");
  const root = normalize(functionsDirAbs).replace(/\\/g, "/");
  if (!norm.toLowerCase().startsWith(root.toLowerCase() + "/")) return null;
  const tail = norm.slice(root.length + 1);
  const first = tail.split("/", 1)[0];
  if (!first) return null;
  if (first.startsWith("_") || first.endsWith("_shared")) return null;
  return first;
}

/**
 * Resolve a record's owning function by walking the stack frames in order
 * (most recent first). Returns `null` for records that only touch shared /
 * dependency code.
 */
export function ownerForRecord(
  rec: AuditRecord,
  functionsDirAbs: string,
): string | null {
  for (const p of pathsFromRecord(rec)) {
    const owner = functionForPath(p, functionsDirAbs);
    if (owner) return owner;
  }
  return null;
}

/**
 * Parse a single audit JSONL line. Returns null for blank/comment lines and
 * for entries that don't look like audit records.
 */
export function parseAuditLine(line: string): AuditRecord | null {
  const t = line.trim();
  if (!t || t.startsWith("#")) return null;
  try {
    const obj = JSON.parse(t) as AuditRecord;
    if (typeof obj.permission !== "string") return null;
    return obj;
  } catch {
    return null;
  }
}

/** Translate an audit record's permission name to a FunctionPermissions key. */
type ManifestKey = "env" | "read" | "write" | "net";
function manifestKey(p: string): ManifestKey | null {
  return p === "env" || p === "read" || p === "write" || p === "net" ? p : null;
}

/**
 * Build a {function → permissions} map from an audit log + a functions dir.
 * Pure function: easily unit tested without writing any files.
 */
export function buildPermissionMap(
  records: AuditRecord[],
  opts: AuditOptions,
): PermissionMap {
  // We do NOT call `resolve()` here so callers can pass any absolute path
  // shape (POSIX in tests, Windows in production CLI). The CLI driver below
  // resolves before invoking us. This keeps `buildPermissionMap` portable.
  const functionsDirAbs = opts.functionsDir;
  const map: PermissionMap = new Map();
  const sharedRecords: AuditRecord[] = [];

  const addRec = (perms: FunctionPermissions, rec: AuditRecord): void => {
    const k = manifestKey(rec.permission);
    if (k) {
      if (rec.value) perms[k].add(rec.value);
    } else {
      let bag = perms.other.get(rec.permission);
      if (!bag) {
        bag = new Set();
        perms.other.set(rec.permission, bag);
      }
      if (rec.value) bag.add(rec.value);
    }
  };

  for (const rec of records) {
    const owner = ownerForRecord(rec, functionsDirAbs);
    if (!owner) {
      if (opts.includeShared) sharedRecords.push(rec);
      continue;
    }
    let perms = map.get(owner);
    if (!perms) {
      perms = emptyPerms();
      map.set(owner, perms);
    }
    addRec(perms, rec);
  }

  if (opts.includeShared && sharedRecords.length > 0) {
    for (const rec of sharedRecords) {
      for (const perms of map.values()) addRec(perms, rec);
    }
  }

  return map;
}

/**
 * Convert an in-memory permissions set into a `FunctionManifest`. Existing
 * manifest values are preserved when `merge` is true.
 */
export function permissionsToManifest(
  perms: FunctionPermissions,
  existing?: FunctionManifest,
  merge = false,
): FunctionManifest {
  const base = existing ?? defaultManifest();
  const widen = (key: ManifestKey): string[] => {
    const fromExisting = merge && existing ? existing.permissions[key] : [];
    const merged = new Set<string>([...fromExisting, ...perms[key]]);
    return [...merged].sort();
  };
  return {
    ...base,
    permissions: {
      env: widen("env"),
      read: widen("read"),
      write: widen("write"),
      net: widen("net"),
    },
    fromFile: true,
  };
}

// ---------------------------------------------------------------------------
// CLI driver
// ---------------------------------------------------------------------------

interface CliArgs {
  log: string;
  functionsDir: string;
  write: boolean;
  merge: boolean;
  includeShared: boolean;
}

function parseCliArgs(argv: string[]): CliArgs {
  const out: Partial<CliArgs> = {
    write: false,
    merge: false,
    includeShared: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--log" && argv[i + 1]) out.log = argv[++i];
    else if (a === "--functions" && argv[i + 1]) out.functionsDir = argv[++i];
    else if (a === "--write") out.write = true;
    else if (a === "--merge") out.merge = true;
    else if (a === "--include-shared") out.includeShared = true;
    else if (a === "--help" || a === "-h") {
      printUsage();
      Deno.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      printUsage();
      Deno.exit(2);
    }
  }
  if (!out.log || !out.functionsDir) {
    console.error("Missing required --log and/or --functions arguments.");
    printUsage();
    Deno.exit(2);
  }
  return out as CliArgs;
}

function printUsage(): void {
  console.error(
    "Usage: audit-to-manifest --log <perms.log> --functions <dir> " +
      "[--write] [--merge] [--include-shared]",
  );
}

async function readExistingManifest(
  functionsDir: string,
  name: string,
): Promise<FunctionManifest | undefined> {
  const path = join(functionsDir, name, MANIFEST_FILENAME);
  try {
    const raw = await Deno.readTextFile(path);
    const parsed = JSON.parse(raw) as Partial<FunctionManifest>;
    // We only care about merging permissions; the other fields stay as-is.
    return {
      ...defaultManifest(),
      ...parsed,
      permissions: { ...defaultManifest().permissions, ...(parsed.permissions ?? {}) },
      fromFile: true,
    } as FunctionManifest;
  } catch {
    return undefined;
  }
}

async function readAuditLog(path: string): Promise<AuditRecord[]> {
  const text = await Deno.readTextFile(path);
  const out: AuditRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const rec = parseAuditLine(line);
    if (rec) out.push(rec);
  }
  return out;
}

function summarisePerms(p: FunctionPermissions): string {
  const bits: string[] = [];
  for (const k of ["env", "read", "write", "net"] as const) {
    if (p[k].size > 0) bits.push(`${k}=${p[k].size}`);
  }
  for (const [k, vals] of p.other) {
    if (vals.size > 0) bits.push(`${k}=${vals.size}(skipped)`);
  }
  return bits.length === 0 ? "(none)" : bits.join(" ");
}

export async function main(argv: string[]): Promise<number> {
  const args = parseCliArgs(argv);
  const records = await readAuditLog(args.log);
  if (records.length === 0) {
    console.error(`No audit records parsed from ${args.log}.`);
    return 1;
  }

  const fnsDirAbs = resolve(args.functionsDir);
  const map = buildPermissionMap(records, {
    functionsDir: fnsDirAbs,
    includeShared: args.includeShared,
  });

  if (map.size === 0) {
    console.error(
      `Parsed ${records.length} record(s) but none could be attributed to a ` +
        `function under ${args.functionsDir}. Re-run with DENO_TRACE_PERMISSIONS=1 ` +
        `or pass --include-shared.`,
    );
    return 1;
  }

  console.log(
    `Parsed ${records.length} record(s) → ${map.size} function(s)` +
      (args.write ? "" : " (DRY RUN — pass --write to apply)"),
  );

  for (const [name, perms] of [...map.entries()].sort()) {
    const existing = await readExistingManifest(fnsDirAbs, name);
    const manifest = permissionsToManifest(perms, existing, args.merge);
    const target = join(fnsDirAbs, name, MANIFEST_FILENAME);
    const rel = relative(Deno.cwd(), target).split(SEPARATOR).join("/");
    console.log(`  ${name}  →  ${rel}  ${summarisePerms(perms)}`);

    if (args.write) {
      const json = JSON.stringify(manifest, null, 2) + "\n";
      await Deno.writeTextFile(target, json);
    }
  }
  return 0;
}

if (import.meta.main) {
  const code = await main(Deno.args);
  Deno.exit(code);
}
