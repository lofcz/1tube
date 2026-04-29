/**
 * `1tube package` — wrap a `dist/` produced by `1tube build` into a
 * signed `.1tube` firmware payload.
 *
 * The on-disk shape of the payload mirrors the input shape so the
 * runtime consumer (workerd backend's `--prebuilt` reader) needs no
 * special-casing — extract the zip, point `--prebuilt` at
 * `<extracted>/dist/`, done. The envelope sits next to `dist/` and
 * carries the metadata needed to verify the bundle is intact and
 * produced by a trusted CI runner.
 *
 * Layout:
 *
 *     fw.1tube  (zip)
 *     ├── envelope.json
 *     └── dist/
 *         ├── manifest.json
 *         ├── functions/
 *         │   ├── <fn>.js
 *         │   └── <fn>.js.map   (when sourcemap=linked)
 *         ├── chunks/
 *         │   └── <chunk>.js     (when shared ESM chunks are emitted)
 *         └── shared/
 *             └── <module>.js   (when manifest.sharedModules is non-empty)
 *
 * Verification (done by the C# `FirmwareSupervisor` and the TS-side
 * round-trip tests) is:
 *
 *   1. Parse `envelope.json`. Reject if schema/algo unknown.
 *   2. HMAC-SHA256 the canonical JSON of `envelope - signature` and
 *      compare to `signature.value`. → catches envelope tampering.
 *   3. SHA-256 the bytes of `dist/manifest.json`, compare to
 *      `envelope.manifestSha256`. → catches manifest tampering.
 *   4. For each function/shared module in the manifest, SHA-256 the
 *      bytes of `dist/<bundleFile>` and compare to the recorded
 *      `bundleSha256`. → catches per-bundle tampering/missing entries.
 *
 * One signature, transitive integrity over the whole payload.
 */

import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { walk } from "jsr:@std/fs@^1/walk";
import { BlobWriter, Uint8ArrayReader, ZipWriter } from "@zip-js/zip-js";
import {
  decodeKey,
  ENVELOPE_SCHEMA,
  type FirmwareEnvelope,
  parseEnvelope,
  signEnvelope,
  type UnsignedEnvelope,
} from "./envelope.ts";
import {
  parsePrebuiltManifest,
  type PrebuiltManifest,
} from "../backends/workerd/prebuilt.ts";
import { computeFirmwareContentFingerprint } from "../firmware-content-hash.ts";
import { VERSION } from "../version.ts";

/**
 * Progress event emitted at granular points during packaging.
 *
 * Phases (in order):
 *   - "collect"    — walking dist/ + reading file bytes into memory.
 *                    `current`/`total` count files; `bytes` accumulates
 *                    (uncompressed) bytes read so far.
 *   - "compress"   — adding entries to the zip. `current`/`total` count
 *                    files; `bytes` accumulates uncompressed bytes
 *                    consumed; `name` is the file just added.
 *   - "finalize"   — closing the zip + writing it to disk. `current`
 *                    and `total` are both 1; `bytes` is the final zip
 *                    byte size once known.
 *
 * The CLI maps these to a single-line TTY-aware progress display; tests
 * and library consumers can ignore them or capture them as a stream.
 */
export interface PackageProgress {
  phase: "collect" | "compress" | "finalize";
  current: number;
  total: number;
  bytes: number;
  totalBytes?: number;
  name?: string;
}

export interface PackageOptions {
  /** Path to a `dist/` produced by `1tube build`. */
  distDir: string;
  /** Path to the `.1tube` zip to write. Will be overwritten. */
  outFile: string;
  /** HMAC-SHA256 key bytes (decoded). */
  key: Uint8Array;
  /** Stable version id. Computed from inputs if omitted. */
  version?: string;
  /** Override the createdAt timestamp; tests use this for determinism. */
  createdAt?: string;
  /**
   * Optional callback invoked at every progress milestone. Synchronous —
   * the renderer is expected to be fast (writing to stdout is fine,
   * blocking I/O is not). Errors thrown by the callback bubble up and
   * abort packaging.
   */
  onProgress?: (event: PackageProgress) => void;
}

export interface PackageResult {
  envelope: FirmwareEnvelope;
  manifest: PrebuiltManifest;
  outFile: string;
  zipBytes: number;
  durationMs: number;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Build the default version id when the operator hasn't specified
 * one. Format is `<ISO-without-colons>-<8-char-hex>` so it's
 * lexicographically sortable, filesystem-safe (no colons → Windows
 * is happy), and disambiguates two builds taken at the same second.
 *
 * The 8-char hex tail is the first 8 hex chars of `manifestSha256`,
 * which means the same `dist/` always produces the same version id
 * modulo the timestamp portion — handy for spotting accidental
 * "rebuilt with no changes" cycles in CI logs.
 */
function defaultVersion(manifestSha256: string, when: Date): string {
  const ts = when.toISOString()
    .replace(/[:.]/g, "-")
    .replace(/Z$/, "Z");
  return `${ts}-${manifestSha256.slice(0, 8)}`;
}

/**
 * Walk `<distDir>/manifest.json` + runtime subtrees and
 * return them as a flat list of (zipPath, bytes) pairs. README.txt
 * and .gitignore are intentionally excluded — they're build-time
 * conveniences, not part of the runtime contract, and shipping them
 * would just bloat the payload.
 */
async function collectDistFiles(
  distDir: string,
  manifest: PrebuiltManifest,
  onProgress?: (e: PackageProgress) => void,
): Promise<Array<{ zipPath: string; bytes: Uint8Array }>> {
  // First pass: walk the tree to enumerate paths + sizes so the
  // progress callback can report a meaningful "X of N" / "Y of Z MB"
  // up front. Reading sizes via stat avoids touching file contents
  // twice.
  const manifestPath = join(distDir, "manifest.json");
  try {
    await Deno.stat(manifestPath);
  } catch {
    throw new Error(
      `1tube package: ${manifestPath} not found. Did you run \`1tube build\` first?`,
    );
  }
  const functionsDir = join(distDir, "functions");
  try {
    await Deno.stat(functionsDir);
  } catch {
    throw new Error(
      `1tube package: ${functionsDir} not found. Did the build emit zero functions?`,
    );
  }

  const plan: Array<{ src: string; zipPath: string; size: number }> = [];
  {
    const stat = await Deno.stat(manifestPath);
    plan.push({
      src: manifestPath,
      zipPath: "dist/manifest.json",
      size: stat.size,
    });
  }
  for await (
    const entry of walk(functionsDir, {
      includeFiles: true,
      includeDirs: false,
    })
  ) {
    const stat = await Deno.stat(entry.path);
    const rel = entry.path.slice(distDir.length).replace(/\\/g, "/").replace(
      /^\/+/,
      "",
    );
    plan.push({ src: entry.path, zipPath: `dist/${rel}`, size: stat.size });
  }

  const sharedDir = join(distDir, "shared");
  try {
    const stat = await Deno.stat(sharedDir);
    if (stat.isDirectory) {
      for await (
        const entry of walk(sharedDir, {
          includeFiles: true,
          includeDirs: false,
        })
      ) {
        const fileStat = await Deno.stat(entry.path);
        const rel = entry.path.slice(distDir.length).replace(/\\/g, "/")
          .replace(/^\/+/, "");
        plan.push({
          src: entry.path,
          zipPath: `dist/${rel}`,
          size: fileStat.size,
        });
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  const chunksDir = join(distDir, "chunks");
  try {
    const stat = await Deno.stat(chunksDir);
    if (stat.isDirectory) {
      for await (
        const entry of walk(chunksDir, {
          includeFiles: true,
          includeDirs: false,
        })
      ) {
        const fileStat = await Deno.stat(entry.path);
        const rel = entry.path.slice(distDir.length).replace(/\\/g, "/")
          .replace(/^\/+/, "");
        plan.push({
          src: entry.path,
          zipPath: `dist/${rel}`,
          size: fileStat.size,
        });
      }
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  for (const fn of manifest.functions) {
    for (const sourceFile of fn.sourceFiles ?? []) {
      const src = join(distDir, "sources", fn.name, sourceFile);
      try {
        const fileStat = await Deno.stat(src);
        if (fileStat.isFile) {
          const rel = `sources/${fn.name}/${sourceFile}`.replace(/\\/g, "/");
          plan.push({ src, zipPath: `dist/${rel}`, size: fileStat.size });
        }
      } catch (err) {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      }
    }
  }

  const plannedZipPaths = new Set(plan.map((p) => p.zipPath));
  for (const fn of manifest.functions) {
    const expected = `dist/${fn.bundleFile}`;
    if (!plannedZipPaths.has(expected)) {
      throw new Error(
        `1tube package: manifest references missing function bundle ${expected}`,
      );
    }
  }
  for (const shared of manifest.sharedModules) {
    const expected = `dist/${shared.bundleFile}`;
    if (!plannedZipPaths.has(expected)) {
      throw new Error(
        `1tube package: manifest references missing shared module bundle ${expected}`,
      );
    }
  }
  for (const chunk of manifest.chunks) {
    const expected = `dist/${chunk.file}`;
    if (!plannedZipPaths.has(expected)) {
      throw new Error(
        `1tube package: manifest references missing chunk ${expected}`,
      );
    }
  }

  const totalFiles = plan.length;
  const totalBytes = plan.reduce((acc, p) => acc + p.size, 0);

  // Second pass: actually read bytes, emitting per-file progress.
  const files: Array<{ zipPath: string; bytes: Uint8Array }> = [];
  let cursorBytes = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const bytes = await Deno.readFile(p.src);
    files.push({ zipPath: p.zipPath, bytes });
    cursorBytes += bytes.length;
    onProgress?.({
      phase: "collect",
      current: i + 1,
      total: totalFiles,
      bytes: cursorBytes,
      totalBytes,
      name: p.zipPath,
    });
  }

  return files;
}

/**
 * Library form. Returns the parsed envelope + manifest in addition
 * to writing the zip file, so callers (tests, CI scripts) can
 * inspect them without re-reading the file.
 */
export async function packageDist(
  opts: PackageOptions,
): Promise<PackageResult> {
  const startedAt = performance.now();
  const cwd = Deno.cwd();
  const distDir = isAbsolute(opts.distDir)
    ? opts.distDir
    : resolvePath(cwd, opts.distDir);
  const outFile = isAbsolute(opts.outFile)
    ? opts.outFile
    : resolvePath(cwd, opts.outFile);

  // Sanity-check the input by parsing the manifest first. We don't
  // actually need the parsed value to write the zip (the manifest
  // ships verbatim) but rejecting an unrecognisable input here gives
  // CI a clean "this dist/ doesn't look right" error rather than
  // shipping a bogus payload that fails at unpack time.
  const manifestPath = join(distDir, "manifest.json");
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(await Deno.readTextFile(manifestPath));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`1tube package: cannot read ${manifestPath}: ${msg}`);
  }
  const manifest = parsePrebuiltManifest(manifestRaw);

  const files = await collectDistFiles(distDir, manifest, opts.onProgress);
  const manifestEntry = files.find((f) => f.zipPath === "dist/manifest.json")!;
  const manifestSha256 = await sha256Hex(manifestEntry.bytes);
  const contentFingerprint = await computeFirmwareContentFingerprint(
    distDir,
    manifest,
  );

  const totalBundleBytes = manifest.functions.reduce(
    (acc, f) => acc + f.bundleBytes,
    0,
  );
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const version = opts.version ??
    defaultVersion(manifestSha256, new Date(createdAt));

  const unsigned: UnsignedEnvelope = {
    envelopeSchema: ENVELOPE_SCHEMA,
    version,
    createdAt,
    createdBy: `1tube@${VERSION}`,
    manifestSha256,
    contentSha256: contentFingerprint.sha256,
    functionCount: manifest.functions.length,
    totalBundleBytes,
  };
  const envelope = await signEnvelope(unsigned, opts.key);

  const envelopeBytes = new TextEncoder().encode(
    JSON.stringify(envelope, null, 2) + "\n",
  );

  // ── Write the zip ─────────────────────────────────────────────
  // BlobWriter buffers in memory because firmware payloads are
  // expected to be tens of MB at most (50 functions × ~1MB each).
  // Streaming-to-disk would be possible via a FileSystemWritableFileStream
  // shim but the added complexity isn't worth it at these sizes.
  const blobWriter = new BlobWriter("application/zip");
  const zip = new ZipWriter(blobWriter, {
    // Deflate by default — JS bundles compress 3-4× and the cost is
    // trivial at packaging time.
    level: 6,
  });
  // Envelope first so an unzip viewer shows it at the top.
  await zip.add("envelope.json", new Uint8ArrayReader(envelopeBytes));
  // Compression progress is emitted per-file (uncompressed bytes
  // consumed). We deliberately don't try to track compressed bytes
  // mid-stream — the BlobWriter doesn't expose that and computing it
  // would require switching to a custom writer just for the metric.
  const totalUncompressed = files.reduce((acc, f) => acc + f.bytes.length, 0);
  let consumed = 0;
  const compressTotal = files.length + 1; // +1 for envelope.json, already added
  opts.onProgress?.({
    phase: "compress",
    current: 1,
    total: compressTotal,
    bytes: envelopeBytes.length,
    totalBytes: totalUncompressed + envelopeBytes.length,
    name: "envelope.json",
  });
  consumed += envelopeBytes.length;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    await zip.add(f.zipPath, new Uint8ArrayReader(f.bytes));
    consumed += f.bytes.length;
    opts.onProgress?.({
      phase: "compress",
      current: i + 2,
      total: compressTotal,
      bytes: consumed,
      totalBytes: totalUncompressed + envelopeBytes.length,
      name: f.zipPath,
    });
  }
  await zip.close();
  const blob = await blobWriter.getData();
  const zipBuf = new Uint8Array(await blob.arrayBuffer());
  await Deno.writeFile(outFile, zipBuf);
  opts.onProgress?.({
    phase: "finalize",
    current: 1,
    total: 1,
    bytes: zipBuf.length,
    name: outFile,
  });

  return {
    envelope,
    manifest,
    outFile,
    zipBytes: zipBuf.length,
    durationMs: performance.now() - startedAt,
  };
}

/**
 * The reverse of {@link packageDist} — used by the round-trip tests
 * and (eventually) by a `1tube verify` debug subcommand. Reads the
 * zip into memory, returns the parsed envelope plus a closure that
 * extracts every entry into a target directory.
 */
export async function readPayload(
  payloadPath: string,
): Promise<{
  envelope: FirmwareEnvelope;
  /** Map of zip-relative path → entry bytes. */
  entries: Map<string, Uint8Array>;
}> {
  const { BlobReader, ZipReader, Uint8ArrayWriter } = await import(
    "@zip-js/zip-js"
  );
  const bytes = await Deno.readFile(payloadPath);
  const blob = new Blob([bytes as BlobPart]);
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const entries = new Map<string, Uint8Array>();
    for (const e of await reader.getEntries()) {
      if (e.directory) continue;
      const writer = new Uint8ArrayWriter();
      const data = await e.getData!(writer);
      entries.set(e.filename, data);
    }
    const envBytes = entries.get("envelope.json");
    if (!envBytes) throw new Error("payload missing envelope.json");
    const envelope = parseEnvelope(
      JSON.parse(new TextDecoder().decode(envBytes)),
    );
    return { envelope, entries };
  } finally {
    await reader.close();
  }
}

/**
 * Build a stdout progress renderer. On a TTY it draws a single
 * carriage-returned line that updates in place; on a non-TTY (e.g.
 * CI logs, piped output) it falls back to one final line per phase
 * so log files stay grep-friendly.
 *
 * Output rate-limited to ~10 Hz so packaging large dists doesn't
 * spend more time formatting strings than zipping bytes.
 */
function makeProgressRenderer(): (e: PackageProgress) => void {
  const isTTY = (() => {
    try {
      return Deno.stdout.isTerminal();
    } catch {
      return false;
    }
  })();
  const fmt = (n: number) => {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(2)}MB`;
  };
  let lastDraw = 0;
  let lastWidth = 0;
  let lastPhase: PackageProgress["phase"] | null = null;

  return (e) => {
    const now = performance.now();
    const phaseTransition = lastPhase !== e.phase;
    const isFinal = e.current === e.total;
    // Throttle redraws but always emit the first frame of a new
    // phase + the final frame of any phase, so the log captures the
    // full transition story.
    if (!phaseTransition && !isFinal && now - lastDraw < 100) return;
    lastDraw = now;
    lastPhase = e.phase;

    const pct = e.totalBytes
      ? `${((e.bytes / e.totalBytes) * 100).toFixed(0)}%`
      : "";
    const sizeStr = e.totalBytes
      ? `${fmt(e.bytes)}/${fmt(e.totalBytes)}`
      : fmt(e.bytes);
    const tag = e.phase === "collect"
      ? "reading"
      : e.phase === "compress"
      ? "zipping"
      : "wrote";
    const displayName = e.phase === "finalize"
      ? e.name
      : e.name
      ? truncateMiddle(e.name, 40)
      : "";
    const namePart = displayName ? ` ${displayName}` : "";
    const line = `[1tube package] ${tag} ${e.current}/${e.total}` +
      (pct ? ` (${pct})` : "") +
      ` ${sizeStr}${namePart}`;

    if (isTTY) {
      // Pad to the previous width so a shorter line clears the
      // remainder of the previous one without a separate \x1b[K.
      const padded = line.length < lastWidth
        ? line + " ".repeat(lastWidth - line.length)
        : line;
      Deno.stdout.writeSync(new TextEncoder().encode(`\r${padded}`));
      lastWidth = line.length;
      if (e.phase === "finalize") {
        Deno.stdout.writeSync(new TextEncoder().encode("\n"));
      }
    } else if (isFinal || phaseTransition) {
      // Non-TTY: only print on phase boundaries to keep log volume
      // sane on CI.
      console.log(line);
    }
  };
}

/**
 * Trim the middle of a string with an ellipsis so the head and tail
 * stay visible — handy for filenames where the leading "dist/" is
 * boring but the trailing basename matters.
 */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

const PACKAGE_USAGE = `Usage: 1tube package [options]

Options:
  -i, --in <dir>             Path to dist/. With --functions, build here and keep it.
                             Without --functions, packages an existing dist/ (required).
  -f, --functions <dir>      Build functions first, then package the resulting dist/.
  -o, --out <file>           Path to .1tube zip to write (required)
      --sign-key <hex|b64>   HMAC signing key. Falls back to env 1TUBE_PACKAGE_SIGN_KEY.
      --version <id>         Stable version id (default: <ISO>-<8hex of manifestSha256>)
      --only A,B,C           Build only the named subset when --functions is set
      --sourcemap MODE       Build sourcemap mode: none | linked (default) | inline
      --minify               Also minify during the initial esbuild pass
      --compat-date DATE     Workerd compatibility date for the generated manifest
      --compat-flag FLAG     Add a workerd compatibility flag (repeatable)
      --workerd-env A,B,C    Env vars baked into the manifest's allowlist
      --workerd-shared path  Shared module path (repeatable)
      --config <path>        Explicit deno.json path for the build import map
      --no-config            Skip the build import map entirely
  -h, --help                 Show this help`;

/**
 * CLI entry point. Mirrors the shape of {@link runBuild} — returns
 * an exit code rather than calling Deno.exit, so the parent
 * dispatcher (`src/cli.ts`) can decide its own termination policy.
 */
export async function runPackage(args: string[]): Promise<number> {
  let inDir: string | undefined;
  let outFile: string | undefined;
  let signKeyArg: string | undefined;
  let version: string | undefined;
  let functionsDir: string | undefined;
  const buildArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--in" || a === "-i") && args[i + 1]) inDir = args[++i];
    else if ((a === "--functions" || a === "-f") && args[i + 1]) {
      functionsDir = args[++i];
      buildArgs.push("--functions", functionsDir);
    } else if (a === "--only" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (a === "--sourcemap" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (a === "--concurrency" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (a === "--compat-date" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (a === "--compat-flag" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (a === "--workerd-env" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (a.startsWith("--workerd-env=")) {
      buildArgs.push(a);
    } else if (a === "--workerd-shared" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (a.startsWith("--workerd-shared=")) {
      buildArgs.push(a);
    } else if (a === "--config" && args[i + 1]) {
      buildArgs.push(a, args[++i]);
    } else if (
      a.startsWith("--config=") || a === "--no-config" || a === "--minify"
    ) {
      buildArgs.push(a);
    } else if ((a === "--out" || a === "-o") && args[i + 1]) {
      outFile = args[++i];
    } else if (a === "--sign-key" && args[i + 1]) signKeyArg = args[++i];
    else if (a.startsWith("--sign-key=")) {
      signKeyArg = a.slice("--sign-key=".length);
    } else if (a === "--version" && args[i + 1]) version = args[++i];
    else if (a === "--help" || a === "-h") {
      console.log(PACKAGE_USAGE);
      return 0;
    } else {
      console.error(`[1tube package] unknown argument: ${a}\n${PACKAGE_USAGE}`);
      return 2;
    }
  }

  if (!outFile || (!inDir && !functionsDir)) {
    console.error(
      `[1tube package] --out and either --in or --functions are required\n${PACKAGE_USAGE}`,
    );
    return 2;
  }

  const keyMaterial = signKeyArg ?? Deno.env.get("1TUBE_PACKAGE_SIGN_KEY");
  if (!keyMaterial) {
    console.error(
      `[1tube package] no signing key. Pass --sign-key <hex|base64> or set ` +
        `1TUBE_PACKAGE_SIGN_KEY in the environment.`,
    );
    return 2;
  }

  let key: Uint8Array;
  try {
    key = decodeKey(keyMaterial);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[1tube package] ${msg}`);
    return 2;
  }

  let cleanupDir: string | undefined;
  try {
    if (functionsDir) {
      if (!inDir) {
        inDir = await Deno.makeTempDir({ prefix: "1tube-package-build-" });
        cleanupDir = inDir;
      }
      const { runBuild } = await import("./build.ts");
      const buildCode = await runBuild([...buildArgs, "--out", inDir]);
      if (buildCode !== 0) return buildCode;
    }
    if (!inDir) {
      throw new Error("internal error: no dist directory selected");
    }

    const result = await packageDist({
      distDir: inDir,
      outFile,
      key,
      ...(version ? { version } : {}),
      onProgress: makeProgressRenderer(),
    });
    const fmt = (n: number) => {
      if (n < 1024) return `${n}B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
      return `${(n / (1024 * 1024)).toFixed(2)}MB`;
    };
    console.log(
      `[1tube package] wrote ${outFile} (${fmt(result.zipBytes)}) ` +
        `in ${
          result.durationMs.toFixed(0)
        }ms — version=${result.envelope.version}`,
    );
    console.log(
      `[1tube package] envelope: ${result.envelope.functionCount} function(s), ` +
        `${fmt(result.envelope.totalBundleBytes)} bundle bytes, ` +
        `manifest sha256=${result.envelope.manifestSha256.slice(0, 12)}…, ` +
        `content sha256=${
          result.envelope.contentSha256?.slice(0, 12) ?? "<none>"
        }…`,
    );
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[1tube package] FAILED: ${msg}`);
    return 1;
  } finally {
    if (cleanupDir) {
      await Deno.remove(cleanupDir, { recursive: true }).catch(() => {});
    }
  }
}
