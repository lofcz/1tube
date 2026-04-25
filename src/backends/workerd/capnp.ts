/**
 * Cap'n Proto config generator for the workerd backend.
 *
 * Workerd is configured by a single `.capnp` file describing one or more
 * services (workers) plus the sockets they listen on. This module turns
 * the bundler's output into a deterministic capnp config that:
 *
 *  - Defines one service per function — each service runs in its own
 *    workerd isolate, giving real per-function isolation (separate heap,
 *    separate global state, independent crash domains).
 *  - Defines one socket per function on a loopback address, with ports
 *    auto-allocated from a configurable base. The 1tube gateway uses the
 *    returned route map to proxy `/functions/v1/<name>` to the right
 *    socket; user traffic never reaches workerd directly.
 *  - Embeds each function's bundle by basename (`embed "<name>.js"`),
 *    so the caller is responsible for writing the capnp file in the
 *    same directory as the bundles. We assert that contract instead of
 *    silently producing broken paths.
 *  - Pins `compatibilityDate = "2024-09-23"` by default — the date when
 *    `nodejs_compat_v2` became the default flag. This is stable across
 *    every modern workerd build and gives function code the broadest
 *    Node.js shim coverage. Override per-function via the manifest in
 *    M3+, or globally via {@link CapnpOptions.compatibilityDate}.
 *
 * The generator is intentionally pure (no I/O) so callers can write the
 * file wherever they want and tests can snapshot the output. All escape
 * paths are exercised by the test suite — capnp string literals support
 * the same `\\`-style escapes as JSON, but `embed` paths are interpreted
 * by the workerd capnp parser, not as capnp string literals, so they
 * cannot contain `"` or backslash. We reject those at generation time
 * rather than emit something that fails to parse at workerd boot.
 */

const SERVICE_NAME_RX = /^[A-Za-z][A-Za-z0-9_-]*$/;
const ENV_VAR_NAME_RX = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * Default compatibility date applied when the caller doesn't pin one.
 *
 * Set to today's date so freshly bundled functions get every behaviour
 * change Cloudflare has shipped through that point — most importantly
 * a fully built-out Node.js shim under `nodejs_compat`, the latest
 * Streams/Fetch spec fixes, and the modern `process.env` / module
 * stubs (`node:fs`, `node:os`, `node:http`, etc.) that real-world npm
 * packages depend on. See the M1 docs for the rationale and for the
 * runtime clamp that scales this back when the installed workerd
 * binary is older than this date.
 */
const DEFAULT_COMPAT_DATE = "2026-04-25";
const DEFAULT_COMPAT_FLAGS = ["nodejs_compat"] as const;

export interface CapnpFunctionInput {
  /** Function name. Must match `[A-Za-z][A-Za-z0-9_-]*`. */
  name: string;
  /**
   * Relative basename of the bundle file, as the capnp file will see it
   * after being written to disk (e.g. `"hello.js"`). Must not contain
   * path separators, double quotes, or backslashes — workerd's `embed`
   * directive interprets the value as a path relative to the capnp
   * file, not as an arbitrary string.
   */
  bundleBasename: string;
  /**
   * Optional per-function override for the compatibility date. When
   * omitted the global default (or {@link CapnpOptions.compatibilityDate})
   * applies.
   */
  compatibilityDate?: string;
  /**
   * Optional per-function compatibility flags appended to the global
   * defaults. Duplicates are de-duplicated in stable order.
   */
  extraCompatibilityFlags?: readonly string[];
  /**
   * Names of environment variables to expose to this function. Each
   * name appears in the worker's `env` parameter (and via the
   * `Deno.env.get` shim) with the value workerd reads from its own
   * process environment at boot. Using `fromEnvironment` (rather than
   * embedding the value as `text`) keeps secrets out of the on-disk
   * `config.capnp` — the file only ever contains the variable names.
   *
   * Names must match `[A-Za-z_][A-Za-z0-9_]*`. Duplicates are
   * de-duplicated in stable order. Pass an empty array (or omit) to
   * forward nothing, which is the safest default for untrusted code.
   */
  envBindings?: readonly string[];
}

export interface CapnpOptions {
  /**
   * Loopback address to bind workerd sockets on. Defaults to
   * `"127.0.0.1"` — exposing workerd to the network directly is never
   * supported; the gateway is the only authorised entrypoint.
   */
  bindAddress?: string;
  /**
   * First port to allocate. Each function takes the next port. Caller
   * is responsible for choosing a base that won't collide with other
   * services on the host. Defaults to `8800`.
   */
  basePort?: number;
  /** Compatibility date applied to every service unless overridden. */
  compatibilityDate?: string;
  /** Compatibility flags applied to every service. */
  compatibilityFlags?: readonly string[];
}

export interface CapnpRoute {
  /** Function name. */
  name: string;
  /** Workerd service name (matches function name after validation). */
  service: string;
  /** Bind address (without port). */
  address: string;
  /** Port allocated to this function. */
  port: number;
  /** Origin URL the gateway should proxy to. */
  origin: string;
}

export interface CapnpResult {
  /** Full text of the generated capnp config. */
  text: string;
  /** Per-function routing table. Same order as the input array. */
  routes: CapnpRoute[];
}

/**
 * Validate and escape a workerd service name. Returns the same name on
 * success; throws on any unsafe character so the operator gets a clear
 * error at boot rather than a cryptic capnp parse failure. The
 * acceptable charset matches both workerd's identifier rules and the
 * directory-name conventions 1tube already enforces, so well-behaved
 * function names pass through unchanged.
 */
function validateServiceName(name: string): string {
  if (!SERVICE_NAME_RX.test(name)) {
    throw new Error(
      `invalid workerd service name: ${JSON.stringify(name)} ` +
        `(must match ${SERVICE_NAME_RX.source})`,
    );
  }
  return name;
}

/**
 * Validate a bundle basename for use in `embed "..."`. Workerd's capnp
 * parser interprets the value as a filesystem path, so any character
 * that would break shell-style path resolution (`"`, `\`) or any path
 * separator is rejected. The basename must also be non-empty and not
 * traverse upwards.
 */
function validateBundleBasename(basename: string): string {
  if (!basename || basename.includes("/") || basename.includes("\\")) {
    throw new Error(
      `bundle basename must be a plain filename, got ${JSON.stringify(basename)}`,
    );
  }
  if (basename.includes('"')) {
    throw new Error(`bundle basename must not contain '"': ${JSON.stringify(basename)}`);
  }
  if (basename === "." || basename === "..") {
    throw new Error(`bundle basename must not be '.' or '..'`);
  }
  return basename;
}

/**
 * Validate a compatibility date. Workerd accepts ISO `YYYY-MM-DD`; we
 * mirror that constraint so a typo doesn't slip through into the capnp
 * file (which would surface only at boot as an opaque error).
 */
function validateCompatDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(
      `compatibilityDate must be ISO YYYY-MM-DD, got ${JSON.stringify(date)}`,
    );
  }
  return date;
}

/**
 * Validate a compatibility flag — workerd flag names follow the same
 * convention as service names (snake_case identifiers), with the added
 * convention that they may begin with `no_` to negate a default.
 */
/**
 * Validate an env var name for use in a `fromEnvironment` binding.
 * The constraint matches the POSIX-ish convention real shells enforce
 * (`[A-Za-z_][A-Za-z0-9_]*`) and rules out names that would be
 * unreachable through `Deno.env.get` anyway (spaces, `=`, etc.).
 */
function validateEnvVarName(name: string): string {
  if (!ENV_VAR_NAME_RX.test(name)) {
    throw new Error(
      `invalid env var name ${JSON.stringify(name)} ` +
        `(must match ${ENV_VAR_NAME_RX.source})`,
    );
  }
  return name;
}

function validateCompatFlag(flag: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(flag)) {
    throw new Error(
      `invalid compatibility flag ${JSON.stringify(flag)} ` +
        `(must match ^[a-z][a-z0-9_]*$)`,
    );
  }
  return flag;
}

/**
 * Escape a value for inclusion inside a capnp string literal. Capnp
 * string literals use the same escape grammar as JSON strings, so we
 * piggy-back on JSON.stringify and trim the surrounding quotes.
 *
 * Used for compatibility-flag values and dates only — service/socket
 * names and embed paths are validated to a strict charset and inserted
 * raw, which makes the output more readable.
 */
function capnpString(value: string): string {
  return JSON.stringify(value);
}

function dedupeStable<T>(items: readonly T[]): T[] {
  const seen = new Set<T>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Generate the capnp config + route table for a set of bundles.
 *
 * The output is purely a function of its inputs (no clocks, no random
 * sources), so identical input produces byte-identical capnp text.
 * Tests rely on this for snapshot stability and for the "deterministic
 * boot" property the operator gets in production.
 */
export function generateCapnp(
  inputs: readonly CapnpFunctionInput[],
  opts: CapnpOptions = {},
): CapnpResult {
  if (inputs.length === 0) {
    throw new Error("generateCapnp requires at least one function input");
  }

  const bindAddress = opts.bindAddress ?? "127.0.0.1";
  const basePort = opts.basePort ?? 8800;
  const globalDate = validateCompatDate(opts.compatibilityDate ?? DEFAULT_COMPAT_DATE);
  const globalFlags = (opts.compatibilityFlags ?? DEFAULT_COMPAT_FLAGS).map(validateCompatFlag);

  if (!Number.isInteger(basePort) || basePort < 1024 || basePort > 65535) {
    throw new Error(
      `basePort must be an integer in [1024, 65535], got ${basePort}`,
    );
  }
  if (basePort + inputs.length - 1 > 65535) {
    throw new Error(
      `port range overflows: basePort=${basePort} + ${inputs.length} functions exceeds 65535`,
    );
  }

  // Detect duplicate function names early — capnp would silently accept
  // duplicates in the array but workerd would reject the resulting config
  // at boot with a less actionable error.
  const seenNames = new Set<string>();
  for (const input of inputs) {
    if (seenNames.has(input.name)) {
      throw new Error(`duplicate function name in capnp inputs: ${input.name}`);
    }
    seenNames.add(input.name);
  }

  const routes: CapnpRoute[] = inputs.map((input, idx) => {
    const service = validateServiceName(input.name);
    const port = basePort + idx;
    return {
      name: input.name,
      service,
      address: bindAddress,
      port,
      origin: `http://${bindAddress}:${port}`,
    };
  });

  const serviceBlocks: string[] = inputs.map((input, idx) => {
    const route = routes[idx];
    const basename = validateBundleBasename(input.bundleBasename);
    const compatDate = input.compatibilityDate
      ? validateCompatDate(input.compatibilityDate)
      : globalDate;
    const flags = dedupeStable([
      ...globalFlags,
      ...(input.extraCompatibilityFlags ?? []).map(validateCompatFlag),
    ]);
    const flagsLine = flags.length > 0
      ? `compatibilityFlags = [${flags.map(capnpString).join(", ")}]`
      : `compatibilityFlags = []`;
    const envNames = dedupeStable(
      (input.envBindings ?? []).map(validateEnvVarName),
    );
    // Emit `bindings = [...]` only when at least one env var is
    // forwarded — workerd accepts both `bindings = []` and an absent
    // field, but omitting the field keeps the diff against the M1
    // snapshot small for the common no-bindings case.
    const bindingsLine = envNames.length > 0
      ? `,\n      bindings = [\n${
        envNames
          .map((n) => `        (name = ${capnpString(n)}, fromEnvironment = ${capnpString(n)})`)
          .join(",\n")
      }\n      ]`
      : "";
    return `  (
    name = "${route.service}",
    worker = (
      modules = [
        (name = "worker", esModule = embed "${basename}")
      ],
      compatibilityDate = ${capnpString(compatDate)},
      ${flagsLine}${bindingsLine}
    )
  )`;
  });

  const socketBlocks: string[] = routes.map((route) => {
    return `  (
    name = "${route.service}-sock",
    address = "${route.address}:${route.port}",
    http = (),
    service = "${route.service}"
  )`;
  });

  // The schema import path is fixed by workerd; it's resolved against
  // workerd's built-in schema, not the local filesystem.
  const text = `# AUTO-GENERATED by 1tube workerd backend — do not edit
# Each function is a separate workerd service in its own isolate, with
# its own loopback HTTP socket. The 1tube gateway proxies authorised
# requests to the right service via the route table returned alongside
# this file.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
${serviceBlocks.join(",\n")}
  ],
  sockets = [
${socketBlocks.join(",\n")}
  ]
);
`;

  return { text, routes };
}
