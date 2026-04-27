/**
 * Prebuilt-artifact contract shared between `1tube build` (writer) and
 * the workerd backend (reader at serve time).
 *
 * Lives in its own module — instead of inside the build CLI — so the
 * backend can import the schema without dragging in esbuild and the
 * `@deno/esbuild-plugin` dependency tree at serve time. A `--prebuilt`
 * deploy is supposed to need *no* bundler on the box; pulling those
 * imports through `cli/build.ts` would defeat that property at the
 * type-level even if runtime bundling is skipped.
 */

import { type FunctionManifest, parseManifest } from "../../manifest.ts";

/**
 * Schema version of `dist/manifest.json`. Bumped on incompatible
 * layout changes. The serve loader refuses to boot any artifact whose
 * schema is newer than this constant — older binaries should fail
 * fast rather than misinterpret a future format.
 */
export const PREBUILT_SCHEMA = 2;

/**
 * Per-function record carried inside `dist/manifest.json`. The bundle
 * is on disk as `<bundleFile>` next to this manifest; we keep its
 * sha-256 + byte count for serve-time integrity verification.
 */
export interface PrebuiltFunctionEntry {
  name: string;
  /** Relative filename inside the artifact dir (e.g. `"hello.js"`). */
  bundleFile: string;
  bundleBytes: number;
  /** SHA-256 over the bundle bytes, lowercase hex. */
  bundleSha256: string;
  /** Per-function `1tube.json` parsed at build time. */
  manifest: FunctionManifest;
}

export interface PrebuiltSharedModuleEntry {
  id: string;
  bundleFile: string;
  bundleBytes: number;
  bundleSha256: string;
  exportNames: string[];
}

export interface PrebuiltManifest {
  schema: number;
  /** "1tube@x.y.z" string emitted by the build command. Diagnostic only. */
  builtBy: string;
  /** ISO-8601 build timestamp. Diagnostic only. */
  builtAt: string;
  /** Compat date the build was wired with. */
  compatibilityDate?: string;
  /** Compat flags the build was wired with. */
  compatibilityFlags?: string[];
  /** Env var names the build expects to be available at serve time. */
  envAllowlist: string[];
  /** Gateway-owned shared module bundles used by workerd RPC stubs. */
  sharedModules: PrebuiltSharedModuleEntry[];
  /** Indexed function table, sorted by name for deterministic diffs. */
  functions: PrebuiltFunctionEntry[];
}

/**
 * Parse a JSON object loaded from `manifest.json` into a typed
 * {@link PrebuiltManifest}. Throws with a clear message when the
 * schema is incompatible or the shape is wrong — better than a silent
 * `undefined` cascade at boot.
 *
 * Per-function `manifest` blocks are run through {@link parseManifest}
 * (which never throws) so partial / older shapes degrade to defaults
 * rather than failing the whole load. The `fromFile` flag is forced
 * on so the gateway treats them as authored manifests, not synthesised
 * defaults — that distinction matters for `1TUBE_ENFORCE_MANIFEST=1`
 * deployments where the absence of a manifest makes a function fall
 * back to "no permissions declared".
 */
export function parsePrebuiltManifest(raw: unknown): PrebuiltManifest {
  if (!raw || typeof raw !== "object") {
    throw new Error("prebuilt manifest is not an object");
  }
  const obj = raw as Record<string, unknown>;
  const schema = typeof obj.schema === "number" ? obj.schema : -1;
  if (schema < 1 || schema > PREBUILT_SCHEMA) {
    throw new Error(
      `prebuilt manifest schema=${schema} not supported by this 1tube ` +
        `(supports schemas up to ${PREBUILT_SCHEMA}). Rebuild with a matching version.`,
    );
  }
  if (!Array.isArray(obj.functions)) {
    throw new Error(`prebuilt manifest missing "functions" array`);
  }
  const functions: PrebuiltFunctionEntry[] = obj.functions.map((rawEntry, idx) => {
    if (!rawEntry || typeof rawEntry !== "object") {
      throw new Error(`functions[${idx}] is not an object`);
    }
    const e = rawEntry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : "";
    const bundleFile = typeof e.bundleFile === "string" ? e.bundleFile : "";
    const bundleBytes = typeof e.bundleBytes === "number" ? e.bundleBytes : 0;
    const bundleSha256 = typeof e.bundleSha256 === "string" ? e.bundleSha256 : "";
    if (!name || !bundleFile || !bundleSha256) {
      throw new Error(
        `functions[${idx}] missing required fields (name, bundleFile, bundleSha256)`,
      );
    }
    return {
      name,
      bundleFile,
      bundleBytes,
      bundleSha256,
      manifest: parseManifest(e.manifest, /* fromFile */ true),
    };
  });
  const sharedModules: PrebuiltSharedModuleEntry[] = Array.isArray(obj.sharedModules)
    ? obj.sharedModules.map((rawEntry, idx) => {
      if (!rawEntry || typeof rawEntry !== "object") {
        throw new Error(`sharedModules[${idx}] is not an object`);
      }
      const e = rawEntry as Record<string, unknown>;
      const id = typeof e.id === "string" ? e.id : "";
      const bundleFile = typeof e.bundleFile === "string" ? e.bundleFile : "";
      const bundleBytes = typeof e.bundleBytes === "number" ? e.bundleBytes : 0;
      const bundleSha256 = typeof e.bundleSha256 === "string" ? e.bundleSha256 : "";
      const exportNames = Array.isArray(e.exportNames)
        ? e.exportNames.filter((n): n is string => typeof n === "string")
        : [];
      if (!id || !bundleFile || !bundleSha256) {
        throw new Error(
          `sharedModules[${idx}] missing required fields (id, bundleFile, bundleSha256)`,
        );
      }
      return { id, bundleFile, bundleBytes, bundleSha256, exportNames };
    })
    : [];
  return {
    schema,
    builtBy: typeof obj.builtBy === "string" ? obj.builtBy : "unknown",
    builtAt: typeof obj.builtAt === "string" ? obj.builtAt : "unknown",
    ...(typeof obj.compatibilityDate === "string"
      ? { compatibilityDate: obj.compatibilityDate }
      : {}),
    ...(Array.isArray(obj.compatibilityFlags)
      ? { compatibilityFlags: obj.compatibilityFlags.filter((f): f is string => typeof f === "string") }
      : {}),
    envAllowlist: Array.isArray(obj.envAllowlist)
      ? obj.envAllowlist.filter((n): n is string => typeof n === "string")
      : [],
    sharedModules,
    functions,
  };
}
