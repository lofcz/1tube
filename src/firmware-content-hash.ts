import { dirname, join, normalize } from "node:path";
import { init, parse } from "es-module-lexer";
import { canonicalJson } from "./cli/envelope.ts";
import type { PrebuiltManifest } from "./backends/workerd/prebuilt.ts";

async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string"
    ? new TextEncoder().encode(bytes)
    : bytes;
  const buf = await crypto.subtle.digest("SHA-256", data as BufferSource);
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += view[i].toString(16).padStart(2, "0");
  }
  return out;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function sortPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortPlain);
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = sortPlain(obj[key]);
  }
  return out;
}

function resolveModuleSpecifier(
  fromFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const resolved = normalize(join(dirname(fromFile), specifier));
  return toPosix(resolved);
}

async function normalizeModule(
  moduleFile: string,
  source: string,
  knownModules: ReadonlySet<string>,
): Promise<{ source: string; dependencies: string[] }> {
  const dependencies: string[] = [];
  const withoutSourceMap = source.replace(
    /\n?\/\/# sourceMappingURL=.*$/m,
    "\n",
  );
  await init;
  const [imports] = parse(withoutSourceMap);
  const patches: Array<{ start: number; end: number; value: string }> = [];
  for (const specifier of imports) {
    const rawSpecifier = specifier.n ??
      withoutSourceMap.slice(specifier.s, specifier.e);
    if (!rawSpecifier.startsWith(".")) continue;
    const target = resolveModuleSpecifier(moduleFile, rawSpecifier);
    if (!target || !knownModules.has(target)) continue;

    dependencies.push(target);
    patches.push({
      start: specifier.s,
      end: specifier.e,
      value: "__1tube_module_ref__",
    });
  }

  let normalized = withoutSourceMap;
  for (const patch of patches.sort((a, b) => b.start - a.start)) {
    normalized = normalized.slice(0, patch.start) + patch.value +
      normalized.slice(patch.end);
  }

  return { source: normalized, dependencies: uniqueSorted(dependencies) };
}

export interface FirmwareContentFingerprint {
  sha256: string;
  canonical: string;
}

export async function computeFirmwareContentFingerprint(
  distDir: string,
  manifest: PrebuiltManifest,
): Promise<FirmwareContentFingerprint> {
  const moduleFiles = uniqueSorted([
    ...manifest.functions.flatMap((fn) =>
      fn.moduleFiles?.length ? fn.moduleFiles : [fn.bundleFile]
    ),
    ...manifest.chunks.map((chunk) => chunk.file),
    ...manifest.sharedModules.map((shared) => shared.bundleFile),
  ]);

  const rawSources = new Map<string, string>();
  for (const file of moduleFiles) {
    const bytes = await Deno.readFile(join(distDir, file));
    const source = new TextDecoder().decode(bytes);
    rawSources.set(file, source);
  }

  const knownModules = new Set(moduleFiles);
  const normalizedModules = new Map(
    await Promise.all(
      moduleFiles.map(async (file) =>
        [
          file,
          await normalizeModule(file, rawSources.get(file) ?? "", knownModules),
        ] as const
      ),
    ),
  );
  const moduleHashes = new Map<string, string>();
  async function hashModule(
    file: string,
    stack = new Set<string>(),
  ): Promise<string> {
    const cached = moduleHashes.get(file);
    if (cached) return cached;

    const normalized = normalizedModules.get(file);
    if (!normalized) {
      throw new Error(`firmware content fingerprint missing module ${file}`);
    }
    if (stack.has(file)) {
      return await sha256Hex("__1tube_module_cycle__");
    }

    stack.add(file);
    const dependencyHashes = [];
    for (const dependency of normalized.dependencies) {
      dependencyHashes.push(await hashModule(dependency, stack));
    }
    stack.delete(file);

    const hash = await sha256Hex(canonicalJson({
      source: normalized.source,
      dependencies: uniqueSorted(dependencyHashes),
    }));
    moduleHashes.set(file, hash);
    return hash;
  }
  for (const file of moduleFiles) {
    await hashModule(file);
  }

  const functionEntries = manifest.functions
    .map((fn) => {
      const modules = fn.moduleFiles?.length ? fn.moduleFiles : [fn.bundleFile];
      return {
        name: fn.name,
        manifest: sortPlain(fn.manifest),
        modules: uniqueSorted(
          modules.map((file) => moduleHashes.get(file) ?? ""),
        ),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const sharedEntries = manifest.sharedModules
    .map((shared) => ({
      id: shared.id,
      exportNames: uniqueSorted(shared.exportNames),
      module: moduleHashes.get(shared.bundleFile) ?? "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const chunkEntries = uniqueSorted(
    manifest.chunks.map((chunk) => moduleHashes.get(chunk.file) ?? ""),
  );

  const canonical = canonicalJson({
    schema: manifest.schema,
    compatibilityDate: manifest.compatibilityDate,
    compatibilityFlags: uniqueSorted(manifest.compatibilityFlags ?? []),
    envAllowlist: uniqueSorted(manifest.envAllowlist ?? []),
    chunks: chunkEntries,
    sharedModules: sharedEntries,
    functions: functionEntries,
  });

  return {
    sha256: await sha256Hex(canonical),
    canonical,
  };
}
