/**
 * Parsing for the Deno-style specifiers Supabase Edge Functions use.
 *
 * Bun understands `node:` natively and resolves bare specifiers through
 * `node_modules`, but `npm:`, `jsr:` and `https:` imports are Deno-isms.
 * The compat plugin (see `plugin.ts`) turns each into something Bun can
 * load; this module only owns the string parsing so the plugin, the
 * dependency pre-scan and the dep-graph all agree on the shape.
 *
 * Note: Bun's loader splits `npm:zod@^3/sub` into namespace `npm` and path
 * `zod@^3/sub` before a plugin sees it, so the parsers accept both the
 * prefixed form and the bare remainder.
 */

/** A package request against the npm registry (jsr packages included). */
export interface PackageRequest {
  /** Registry package name, e.g. `zod`, `@supabase/supabase-js`, `@jsr/std__path`. */
  name: string;
  /** Semver range; `"latest"` when the specifier carried none. */
  range: string;
  /** Subpath including its leading slash, or `""` for the package root. */
  subpath: string;
  /** Where the request came from — jsr packages install via npm.jsr.io. */
  registry: "npm" | "jsr";
}

/**
 * Split `name[@range][/subpath]` where `name` may be scoped. Returns null
 * when the string is not a plausible package reference.
 */
function splitPackage(
  rest: string,
): { name: string; range: string; subpath: string } | null {
  let i = 0;
  if (rest.startsWith("@")) {
    const slash = rest.indexOf("/");
    if (slash <= 1) return null;
    i = slash + 1;
  }
  // The name ends at the first `@` (range) or `/` (subpath) after the scope.
  let nameEnd = rest.length;
  for (let j = i; j < rest.length; j++) {
    if (rest[j] === "@" || rest[j] === "/") {
      nameEnd = j;
      break;
    }
  }
  const name = rest.slice(0, nameEnd);
  if (!name || name.endsWith("/")) return null;
  let range = "latest";
  let after = rest.slice(nameEnd);
  if (after.startsWith("@")) {
    const slash = after.indexOf("/");
    range = slash === -1 ? after.slice(1) : after.slice(1, slash);
    after = slash === -1 ? "" : after.slice(slash);
    if (!range) range = "latest";
  }
  return { name, range, subpath: after === "/" ? "" : after };
}

/** Parse `npm:<pkg>` (or the bare remainder Bun hands a namespace plugin). */
export function parseNpmSpecifier(spec: string): PackageRequest | null {
  let rest = spec.startsWith("npm:") ? spec.slice(4) : spec;
  // `npm:/pkg@1` is also accepted by Deno.
  if (rest.startsWith("/")) rest = rest.slice(1);
  const parts = splitPackage(rest);
  return parts ? { ...parts, registry: "npm" } : null;
}

/**
 * Parse `jsr:@scope/name@range/sub` into the npm-compat package served by
 * npm.jsr.io (`@jsr/scope__name`). JSR packages are always scoped.
 */
export function parseJsrSpecifier(spec: string): PackageRequest | null {
  let rest = spec.startsWith("jsr:") ? spec.slice(4) : spec;
  if (rest.startsWith("/")) rest = rest.slice(1);
  const parts = splitPackage(rest);
  if (!parts || !parts.name.startsWith("@")) return null;
  const [scope, pkg] = parts.name.slice(1).split("/");
  if (!scope || !pkg) return null;
  return {
    name: `@jsr/${scope}__${pkg}`,
    range: parts.range,
    subpath: parts.subpath,
    registry: "jsr",
  };
}

/** `npm:`/`jsr:` specifier → request, or null for anything else. */
export function parsePackageSpecifier(spec: string): PackageRequest | null {
  if (spec.startsWith("npm:")) return parseNpmSpecifier(spec);
  if (spec.startsWith("jsr:")) return parseJsrSpecifier(spec);
  return null;
}

export function isRemoteSpecifier(spec: string): boolean {
  return spec.startsWith("https://") || spec.startsWith("http://");
}

/** Stable key for one (package, range) pair — the unit of installation. */
export function packageKey(req: PackageRequest): string {
  return `${req.name}@${req.range}`;
}
