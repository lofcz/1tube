import {
  basename,
  dirname,
  join,
  normalize,
  relative,
  resolve as resolvePath,
} from "node:path";
import { ensureDir } from "jsr:@std/fs@^1/ensure-dir";
import {
  defaultManifest,
  type FunctionManifest,
  MANIFEST_FILENAME,
  parseManifest,
} from "../../manifest.ts";
import type { PrebuiltManifest } from "./prebuilt.ts";

const NAME_RX = /^[A-Za-z][A-Za-z0-9_-]*$/;
const OVERLAY_SCHEMA = 1;

export type EditableFunctionOrigin = "manifest" | "patched" | "added";

export interface RuntimeOverrideEntry {
  name: string;
  origin: "patched" | "added";
  updatedAt: string;
  files: string[];
}

interface RuntimeOverrideIndex {
  schema: number;
  functions: RuntimeOverrideEntry[];
}

export interface EditableFunctionSummary {
  name: string;
  origin: EditableFunctionOrigin;
  files: string[];
  manifest: FunctionManifest;
  bundleBytes: number | null;
  source:
    | "overlay"
    | "snapshot"
    | "sourcemap"
    | "bundle"
    | "source-tree"
    | "missing";
  degraded: boolean;
}

export interface EditableSourceFile {
  path: string;
  content: string;
  language: "typescript" | "javascript" | "json" | "text";
}

export interface EditableSourceResponse {
  name: string;
  origin: EditableFunctionOrigin;
  files: EditableSourceFile[];
  selected: string;
  degraded: boolean;
  warning?: string;
}

export interface SaveEditableSourceInput {
  files: Record<string, string>;
}

export interface ComposeOverlayInput {
  baseNames: ReadonlySet<string>;
}

export interface OverlayComposeEntry {
  name: string;
  origin: "patched" | "added";
  sourceDir: string;
  entrypoint: string;
  manifest: FunctionManifest;
  files: string[];
}

export interface RuntimeOverrideStoreOptions {
  rootDir: string;
  sourceFunctionsDir: string;
  prebuiltDir?: string | null;
  getPrebuiltManifest?: () => PrebuiltManifest | null;
  getLiveManifests?: () => ReadonlyMap<string, FunctionManifest>;
  getBundleBytes?: () => ReadonlyMap<string, number>;
}

export function defaultRuntimeOverrideRoot(cwd: string): string {
  const env = Deno.env.get("1TUBE_RUNTIME_FUNCTIONS_DIR")?.trim();
  return env
    ? (isAbsolutePath(env) ? env : resolvePath(cwd, env))
    : resolvePath(cwd, ".1tube-cache", "runtime-functions");
}

function isAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") ||
    path.startsWith("\\\\");
}

function safeName(name: string): string {
  const trimmed = name.trim();
  if (!NAME_RX.test(trimmed)) {
    throw new Error(
      `invalid function name ${
        JSON.stringify(name)
      }; expected ${NAME_RX.source}`,
    );
  }
  return trimmed;
}

function safeRelPath(path: string): string {
  const p = path.replaceAll("\\", "/").trim();
  if (!p || p.startsWith("/") || p.startsWith("./") || p.includes("\0")) {
    throw new Error(`invalid source path ${JSON.stringify(path)}`);
  }
  const parts = p.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`invalid source path ${JSON.stringify(path)}`);
  }
  return parts.join("/");
}

function langFor(path: string): EditableSourceFile["language"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (
    lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".jsx")
  ) return "javascript";
  return "text";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

async function removeDirIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === ".DS_Store") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(abs);
      } else if (entry.isFile) {
        out.push(relative(root, abs).replaceAll("\\", "/"));
      }
    }
  }
  try {
    await walk(root);
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function hashSha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function parseManifestText(text: string | null): FunctionManifest {
  if (text === null) return defaultManifest();
  try {
    return parseManifest(JSON.parse(text), true);
  } catch {
    return defaultManifest();
  }
}

export class RuntimeOverrideStore {
  readonly rootDir: string;
  private readonly functionsRoot: string;
  private readonly indexPath: string;
  private index: RuntimeOverrideIndex = {
    schema: OVERLAY_SCHEMA,
    functions: [],
  };
  private loaded = false;

  constructor(private readonly opts: RuntimeOverrideStoreOptions) {
    this.rootDir = opts.rootDir;
    this.functionsRoot = join(opts.rootDir, "functions");
    this.indexPath = join(opts.rootDir, "overrides.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await ensureDir(this.functionsRoot);
    const raw = await readTextIfExists(this.indexPath);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as RuntimeOverrideIndex;
        if (
          parsed.schema === OVERLAY_SCHEMA && Array.isArray(parsed.functions)
        ) {
          this.index = {
            schema: OVERLAY_SCHEMA,
            functions: parsed.functions
              .filter((f) =>
                NAME_RX.test(f.name) &&
                (f.origin === "added" || f.origin === "patched")
              )
              .map((f) => ({
                name: f.name,
                origin: f.origin,
                updatedAt: typeof f.updatedAt === "string"
                  ? f.updatedAt
                  : new Date(0).toISOString(),
                files: Array.isArray(f.files)
                  ? f.files.map(safeRelPath).sort()
                  : [],
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        }
      } catch (err) {
        console.warn(
          `[1tube] ignoring invalid runtime override index ${this.indexPath}: ${err}`,
        );
      }
    }
    this.loaded = true;
    await this.persist();
  }

  async list(
    baseNames: ReadonlySet<string>,
  ): Promise<EditableFunctionSummary[]> {
    await this.load();
    const names = new Set<string>(baseNames);
    for (const e of this.index.functions) names.add(e.name);
    const bundleBytes = this.opts.getBundleBytes?.() ?? new Map();
    const rows: EditableFunctionSummary[] = [];
    for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
      const overlay = this.index.functions.find((e) => e.name === name);
      const origin: EditableFunctionOrigin = overlay?.origin ?? "manifest";
      const source = overlay ? "overlay" : await this.detectBaseSource(name);
      rows.push({
        name,
        origin,
        files: overlay?.files.length
          ? overlay.files
          : await this.baseFileList(name),
        manifest: overlay
          ? await this.readOverlayManifest(name)
          : this.baseManifest(name),
        bundleBytes: bundleBytes.get(name) ?? null,
        source,
        degraded: source === "bundle" || source === "missing",
      });
    }
    return rows;
  }

  async read(
    name: string,
    baseNames: ReadonlySet<string>,
  ): Promise<EditableSourceResponse> {
    await this.load();
    name = safeName(name);
    const overlay = this.index.functions.find((e) => e.name === name);
    if (overlay) {
      const files = await this.readOverlayFiles(name, overlay.files);
      return {
        name,
        origin: overlay.origin,
        files,
        selected: files.find((f) => f.path === "index.ts")?.path ??
          files[0]?.path ?? "index.ts",
        degraded: false,
      };
    }
    if (!baseNames.has(name)) {
      throw new Error(`function "${name}" does not exist`);
    }
    return await this.readBaseSource(name);
  }

  async create(name: string): Promise<EditableSourceResponse> {
    await this.load();
    name = safeName(name);
    if (this.index.functions.some((e) => e.name === name)) {
      throw new Error(`function "${name}" already has a runtime override`);
    }
    const baseNames = new Set(
      this.opts.getPrebuiltManifest?.()?.functions.map((f) => f.name) ?? [],
    );
    if (baseNames.has(name)) {
      throw new Error(
        `function "${name}" exists in firmware; open Code and save a patch instead`,
      );
    }
    await this.writeFiles(name, {
      "index.ts": [
        "export default async function handler(req: Request): Promise<Response> {",
        '  const body = req.method === "GET" ? null : await req.text();',
        "  return Response.json({ ok: true, method: req.method, body });",
        "}",
        "",
      ].join("\n"),
      [MANIFEST_FILENAME]: JSON.stringify(defaultManifestForFile(), null, 2) +
        "\n",
    });
    await this.upsertIndex({
      name,
      origin: "added",
      updatedAt: new Date().toISOString(),
      files: await listFiles(this.fnDir(name)),
    });
    return await this.read(name, new Set());
  }

  async save(
    name: string,
    input: SaveEditableSourceInput,
    baseNames: ReadonlySet<string>,
  ): Promise<RuntimeOverrideEntry> {
    await this.load();
    name = safeName(name);
    const existsInBase = baseNames.has(name);
    const current = this.index.functions.find((e) => e.name === name);
    if (!existsInBase && current?.origin !== "added") {
      throw new Error(`function "${name}" is not in firmware; create it first`);
    }
    const files: Record<string, string> = {};
    for (const [rawPath, content] of Object.entries(input.files ?? {})) {
      files[safeRelPath(rawPath)] = String(content ?? "");
    }
    if (!files["index.ts"] && !files["index.js"]) {
      throw new Error(
        `runtime function "${name}" must include index.ts or index.js`,
      );
    }
    if (!files[MANIFEST_FILENAME]) {
      files[MANIFEST_FILENAME] =
        JSON.stringify(defaultManifestForFile(), null, 2) + "\n";
    }
    await this.writeFiles(name, files);
    const entry: RuntimeOverrideEntry = {
      name,
      origin: existsInBase ? "patched" : "added",
      updatedAt: new Date().toISOString(),
      files: await listFiles(this.fnDir(name)),
    };
    await this.upsertIndex(entry);
    return entry;
  }

  async deleteAdded(name: string): Promise<void> {
    await this.load();
    name = safeName(name);
    const entry = this.index.functions.find((e) => e.name === name);
    if (!entry) return;
    if (entry.origin !== "added") {
      throw new Error(
        `function "${name}" is from firmware; use revert instead`,
      );
    }
    await removeDirIfExists(this.fnDir(name));
    this.index.functions = this.index.functions.filter((e) => e.name !== name);
    await this.persist();
  }

  async revert(name: string): Promise<void> {
    await this.load();
    name = safeName(name);
    const entry = this.index.functions.find((e) => e.name === name);
    if (!entry) return;
    if (entry.origin !== "patched") {
      throw new Error(`function "${name}" is runtime-added; delete it instead`);
    }
    await removeDirIfExists(this.fnDir(name));
    this.index.functions = this.index.functions.filter((e) => e.name !== name);
    await this.persist();
  }

  async compose(
    baseNames: ReadonlySet<string>,
  ): Promise<OverlayComposeEntry[]> {
    await this.load();
    const out: OverlayComposeEntry[] = [];
    for (const entry of this.index.functions) {
      if (entry.origin === "patched" && !baseNames.has(entry.name)) {
        entry.origin = "added";
      }
      const dir = this.fnDir(entry.name);
      const entrypoint = await this.resolveEntrypoint(dir);
      out.push({
        name: entry.name,
        origin: entry.origin,
        sourceDir: dir,
        entrypoint,
        manifest: await this.readOverlayManifest(entry.name),
        files: await listFiles(dir),
      });
    }
    await this.persist();
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  private async persist(): Promise<void> {
    await ensureDir(this.rootDir);
    this.index.functions.sort((a, b) => a.name.localeCompare(b.name));
    await Deno.writeTextFile(
      this.indexPath,
      JSON.stringify(this.index, null, 2) + "\n",
    );
  }

  private async upsertIndex(entry: RuntimeOverrideEntry): Promise<void> {
    this.index.functions = this.index.functions.filter((e) =>
      e.name !== entry.name
    );
    this.index.functions.push(entry);
    await this.persist();
  }

  private fnDir(name: string): string {
    return join(this.functionsRoot, safeName(name));
  }

  private async writeFiles(
    name: string,
    files: Record<string, string>,
  ): Promise<void> {
    const dir = this.fnDir(name);
    await removeDirIfExists(dir);
    await ensureDir(dir);
    for (const [path, content] of Object.entries(files)) {
      const rel = safeRelPath(path);
      const abs = normalize(join(dir, rel));
      if (!abs.startsWith(dir)) {
        throw new Error(`source path escapes function dir: ${rel}`);
      }
      await ensureDir(dirname(abs));
      await Deno.writeTextFile(abs, content);
    }
  }

  private async readOverlayManifest(name: string): Promise<FunctionManifest> {
    return parseManifestText(
      await readTextIfExists(join(this.fnDir(name), MANIFEST_FILENAME)),
    );
  }

  private async readOverlayFiles(
    name: string,
    paths: string[],
  ): Promise<EditableSourceFile[]> {
    const dir = this.fnDir(name);
    const listed = paths.length ? paths : await listFiles(dir);
    const files: EditableSourceFile[] = [];
    for (const path of listed) {
      files.push({
        path,
        content: await Deno.readTextFile(join(dir, safeRelPath(path))),
        language: langFor(path),
      });
    }
    return files.sort((a, b) =>
      sourceSortKey(a.path).localeCompare(sourceSortKey(b.path))
    );
  }

  private baseManifest(name: string): FunctionManifest {
    const prebuilt = this.opts.getPrebuiltManifest?.();
    const fromPrebuilt = prebuilt?.functions.find((f) => f.name === name)
      ?.manifest;
    if (fromPrebuilt) return fromPrebuilt;
    return this.opts.getLiveManifests?.()?.get(name) ?? defaultManifest();
  }

  private async baseFileList(name: string): Promise<string[]> {
    const sourceDir = join(this.opts.sourceFunctionsDir, name);
    const files = await listFiles(sourceDir);
    if (files.length > 0) return files;
    return [MANIFEST_FILENAME, "index.ts"];
  }

  private async detectBaseSource(
    name: string,
  ): Promise<EditableFunctionSummary["source"]> {
    const sourceDir = join(this.opts.sourceFunctionsDir, name);
    if (
      await pathExists(join(sourceDir, "index.ts")) ||
      await pathExists(join(sourceDir, "index.js"))
    ) return "source-tree";
    const source = await this.readPrebuiltSource(name);
    return source.source;
  }

  private async readBaseSource(name: string): Promise<EditableSourceResponse> {
    const sourceDir = join(this.opts.sourceFunctionsDir, name);
    const sourceFiles = await listFiles(sourceDir);
    if (sourceFiles.length > 0) {
      const files: EditableSourceFile[] = [];
      for (const path of sourceFiles) {
        files.push({
          path,
          content: await Deno.readTextFile(join(sourceDir, path)),
          language: langFor(path),
        });
      }
      return {
        name,
        origin: "manifest",
        files: files.sort((a, b) =>
          sourceSortKey(a.path).localeCompare(sourceSortKey(b.path))
        ),
        selected: files.find((f) => f.path === "index.ts")?.path ??
          files[0]?.path ?? "index.ts",
        degraded: false,
      };
    }
    const fallback = await this.readPrebuiltSource(name);
    return {
      name,
      origin: "manifest",
      files: fallback.files,
      selected: fallback.files[0]?.path ?? "index.ts",
      degraded: fallback.source === "bundle" || fallback.source === "missing",
      warning: fallback.warning,
    };
  }

  private async readPrebuiltSource(name: string): Promise<{
    source: EditableFunctionSummary["source"];
    files: EditableSourceFile[];
    warning?: string;
  }> {
    const prebuilt = this.opts.getPrebuiltManifest?.();
    const prebuiltDir = this.opts.prebuiltDir;
    const entry = prebuilt?.functions.find((f) => f.name === name);
    if (!entry || !prebuiltDir) {
      return {
        source: "missing",
        files: [{ path: "index.ts", content: "", language: "typescript" }],
        warning: "Source is not available for this firmware function.",
      };
    }
    const snapshot = await this.readSourceSnapshot(name);
    if (snapshot.length > 0) return { source: "snapshot", files: snapshot };

    for (
      const moduleFile of entry.moduleFiles.length
        ? entry.moduleFiles
        : [entry.bundleFile]
    ) {
      const map = await readTextIfExists(
        join(prebuiltDir, `${moduleFile}.map`),
      );
      if (!map) continue;
      const extracted = extractSourcesContent(map);
      if (extracted.length > 0) {
        return { source: "sourcemap", files: extracted };
      }
    }

    const emittedFiles = [
      ...new Set(
        entry.moduleFiles.length ? entry.moduleFiles : [entry.bundleFile],
      ),
    ];
    const emittedSources: EditableSourceFile[] = [];
    for (const moduleFile of emittedFiles) {
      const bundle = await readTextIfExists(join(prebuiltDir, moduleFile));
      if (bundle !== null) {
        emittedSources.push({
          path: moduleFile,
          content: bundle,
          language: langFor(moduleFile),
        });
      }
    }
    if (emittedSources.length > 0) {
      return {
        source: "bundle",
        files: emittedSources.sort((a, b) =>
          emittedSortKey(entry.bundleFile, a.path).localeCompare(
            emittedSortKey(entry.bundleFile, b.path),
          )
        ),
        warning:
          "Authored source was not packaged with this firmware; showing emitted JS fallback modules.",
      };
    }
    return {
      source: "missing",
      files: [{ path: "index.ts", content: "", language: "typescript" }],
      warning: "Source is not available for this firmware function.",
    };
  }

  private async readSourceSnapshot(
    name: string,
  ): Promise<EditableSourceFile[]> {
    const prebuiltDir = this.opts.prebuiltDir;
    if (!prebuiltDir) return [];
    const snapshotDir = join(prebuiltDir, "sources", name);
    const files = await listFiles(snapshotDir);
    const out: EditableSourceFile[] = [];
    for (const path of files) {
      out.push({
        path,
        content: await Deno.readTextFile(join(snapshotDir, path)),
        language: langFor(path),
      });
    }
    return out.sort((a, b) =>
      sourceSortKey(a.path).localeCompare(sourceSortKey(b.path))
    );
  }

  private async resolveEntrypoint(dir: string): Promise<string> {
    const ts = join(dir, "index.ts");
    if (await pathExists(ts)) return ts;
    const js = join(dir, "index.js");
    if (await pathExists(js)) return js;
    throw new Error(
      `runtime override at ${dir} is missing index.ts or index.js`,
    );
  }
}

function extractSourcesContent(rawMap: string): EditableSourceFile[] {
  try {
    const map = JSON.parse(rawMap) as {
      sources?: unknown;
      sourcesContent?: unknown;
    };
    if (!Array.isArray(map.sources) || !Array.isArray(map.sourcesContent)) {
      return [];
    }
    const files: EditableSourceFile[] = [];
    for (let i = 0; i < map.sources.length; i++) {
      const source = map.sources[i];
      const content = map.sourcesContent[i];
      if (typeof source !== "string" || typeof content !== "string") continue;
      const name =
        source.replace(/^file:\/+/, "").replaceAll("\\", "/").split("/").filter(
          Boolean,
        ).pop() ?? `source-${i}.ts`;
      files.push({
        path: safeRelPath(name),
        content,
        language: langFor(name),
      });
    }
    return files.sort((a, b) =>
      sourceSortKey(a.path).localeCompare(sourceSortKey(b.path))
    );
  } catch {
    return [];
  }
}

function sourceSortKey(path: string): string {
  if (path === "index.ts" || path === "index.js") return `0:${path}`;
  if (path === MANIFEST_FILENAME) return `9:${path}`;
  return `5:${path}`;
}

function emittedSortKey(entryFile: string, path: string): string {
  if (path === entryFile) return `0:${path}`;
  if (basename(path) === basename(entryFile)) return `1:${path}`;
  return `5:${path}`;
}

function defaultManifestForFile(): Record<string, unknown> {
  const manifest = defaultManifest();
  return {
    permissions: manifest.permissions,
    recycle: manifest.recycle,
  };
}

export async function copyPrebuiltRuntimeFiles(
  prebuilt: PrebuiltManifest,
  prebuiltDir: string,
  cacheDir: string,
): Promise<void> {
  await ensureDir(cacheDir);
  const copied = new Set<string>();
  async function copyRel(rel: string) {
    const safe = safeRelPath(rel);
    if (copied.has(safe)) return;
    copied.add(safe);
    const from = join(prebuiltDir, safe);
    const to = join(cacheDir, safe);
    await ensureDir(dirname(to));
    const content = await Deno.readFile(from);
    await Deno.writeFile(to, content);
  }
  for (const fn of prebuilt.functions) {
    await copyRel(fn.bundleFile);
    for (const moduleFile of fn.moduleFiles) await copyRel(moduleFile);
  }
  for (const chunk of prebuilt.chunks) await copyRel(chunk.file);
  for (const shared of prebuilt.sharedModules) await copyRel(shared.bundleFile);
}

export async function readTextDigestFile(
  path: string,
): Promise<{ bytes: number; sha256: string }> {
  const data = await Deno.readFile(path);
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return {
    bytes: data.byteLength,
    sha256: Array.from(new Uint8Array(digest)).map((b) =>
      b.toString(16).padStart(2, "0")
    ).join(""),
  };
}

export async function sourceFingerprint(
  files: readonly EditableSourceFile[],
): Promise<string> {
  const canonical = files
    .map((f) => `${safeRelPath(f.path)}\0${f.content}`)
    .sort()
    .join("\0");
  return await hashSha256Hex(canonical);
}
