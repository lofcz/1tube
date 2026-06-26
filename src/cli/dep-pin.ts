/**
 * Dependency pinning for the Deno edge runtime.
 *
 * The problem this solves
 * =======================
 * 1tube's edge functions run under Deno with `--node-modules-dir=false`, so
 * Deno resolves npm specifiers from its OWN cache + lockfile, NOT from the
 * host project's `node_modules`. The import map a Supabase-style project ships
 * commonly maps 1tube's surface with an *unconstrained* specifier:
 *
 *     "1tube/edge": "npm:1tube/edge"        // === npm:1tube@*
 *
 * `@*` is satisfied by ANY version. So once the lockfile pins, say,
 * `1tube@0.1.43`, bumping the npm dependency (and `node_modules/1tube`) to
 * `0.1.46` changes nothing for the edge runtime: the old pin still satisfies
 * `*`, Deno never re-resolves, and the gateway (loaded from `node_modules`,
 * now 0.1.46) ends up serving a *different* version of the edge surface than
 * the functions import (still 0.1.43) — e.g. a missing export at boot.
 *
 * Deno's native lockfile auto-update is correct and fast, but it only triggers
 * when a specifier's *version requirement* actually changes. Unconstrained
 * specifiers never change, so they "stick" forever.
 *
 * The fix
 * =======
 * Before launching the gateway, rewrite every unconstrained `npm:` specifier
 * in the import map to the EXACT version installed in the host's
 * `node_modules` (the single source of truth the user controls via their
 * package manager). `npm:1tube/edge` → `npm:1tube@0.1.46/edge`. Now the
 * specifier version tracks the installed dependency, so bumping the dep makes
 * Deno's native lock auto-update recompute that one entry — while every
 * already-pinned dependency is left untouched, preserving lockfile
 * reproducibility and warm-boot performance.
 *
 * This module is the pure, IO-free core (parsing + reconciliation) so it can
 * be unit-tested; the file IO + process spawn live in `src/launch.ts`.
 */

/** A parsed `npm:` import-map specifier. */
export interface NpmSpecifier {
  /** Package name, including scope (e.g. `1tube`, `@supabase/server`). */
  name: string;
  /**
   * Version requirement as written (e.g. `0.1.46`, `^1`, `4.4.3`), or
   * `undefined` when the specifier is unconstrained (`npm:name` / `@*`).
   */
  version?: string;
  /** Subpath including the leading slash (e.g. `/edge`), or `""`. */
  subpath: string;
}

// `npm:` body grammar: (@scope/)?name (@version)? (/subpath)?
//   group 1 — name: scoped `@scope/name` or bare `name` (no `@` or `/` inside)
//   group 2 — `@version` (everything up to the next `/`)
//   group 3 — `/subpath`
const NPM_BODY_RE = /^(@[^/@]+\/[^/@]+|[^/@]+)(@[^/]+)?(\/.*)?$/;

/**
 * Parse an import-map value into its npm parts, or `null` when it is not an
 * `npm:` specifier (e.g. `jsr:`, `https:`, `./local.ts`).
 */
export function parseNpmSpecifier(value: string): NpmSpecifier | null {
  if (!value.startsWith("npm:")) return null;
  const body = value.slice(4);
  const m = NPM_BODY_RE.exec(body);
  if (!m) return null;
  return {
    name: m[1],
    version: m[2] ? m[2].slice(1) : undefined,
    subpath: m[3] ?? "",
  };
}

/** A single applied pin, for human-facing logging. */
export interface AppliedPin {
  name: string;
  version: string;
}

export interface ReconcileResult {
  /** The rewritten import map (a new object; input is not mutated). */
  imports: Record<string, string>;
  /** Distinct packages that were pinned, in first-seen order. */
  pins: AppliedPin[];
  /** True when at least one entry was rewritten. */
  changed: boolean;
}

/**
 * Rewrite every UNCONSTRAINED `npm:` specifier to the installed version
 * reported by `resolveVersion`. Constrained specifiers (those that already
 * carry a version/range) are left exactly as-is — Deno's native lock handling
 * already tracks those correctly. Non-npm specifiers pass through untouched.
 *
 * `resolveVersion` returns `undefined` when the package is not installed (or
 * has no readable version), in which case the specifier is left unchanged
 * rather than guessed.
 */
export function reconcileImports(
  imports: Record<string, string>,
  resolveVersion: (pkg: string) => string | undefined,
): ReconcileResult {
  const out: Record<string, string> = {};
  const pins: AppliedPin[] = [];
  const seen = new Set<string>();
  let changed = false;

  for (const [key, value] of Object.entries(imports)) {
    const spec = parseNpmSpecifier(value);
    if (spec && spec.version === undefined) {
      const version = resolveVersion(spec.name);
      if (version) {
        out[key] = `npm:${spec.name}@${version}${spec.subpath}`;
        changed = true;
        if (!seen.has(spec.name)) {
          seen.add(spec.name);
          pins.push({ name: spec.name, version });
        }
        continue;
      }
    }
    out[key] = value;
  }

  return { imports: out, pins, changed };
}
