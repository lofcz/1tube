/**
 * Configurable function route prefix.
 *
 * The gateway has always served functions under Supabase's
 * `/functions/v1/<name>` convention. That prefix is now configurable
 * (`--route-prefix` / `1TUBE_ROUTE_PREFIX`) so the gateway can sit
 * behind a different path convention (e.g. `/api`, `/edge/v2`) without a
 * reverse-proxy rewrite. The default is unchanged, so existing
 * deployments keep working with zero config.
 *
 * The prefix is process-global module state, set once at boot BEFORE any
 * route is mounted. It lives here (rather than threaded through every
 * call site) because the logging and rate-limit middleware — whose
 * public signatures we don't want to break — must strip the exact same
 * prefix the router mounts on. There is one gateway per process, so a
 * single shared value is correct; tests that need a custom prefix call
 * {@link setRoutePrefix} and reset it afterwards (or re-import the
 * module fresh).
 */

/** Supabase Edge Runtime convention — the historical, unchanged default. */
export const DEFAULT_ROUTE_PREFIX = "/functions/v1";

let _prefix = DEFAULT_ROUTE_PREFIX;

/**
 * Canonicalize a raw prefix: guarantee exactly one leading slash, no
 * trailing slash, and no duplicate inner slashes. Empty / root-only
 * inputs fall back to the default — the router can't mount on bare `/`
 * without swallowing `/health`, `/1tube/*`, and friends.
 */
export function normalizeRoutePrefix(raw: string | undefined | null): string {
  let v = (raw ?? "").trim();
  if (!v) return DEFAULT_ROUTE_PREFIX;
  if (!v.startsWith("/")) v = "/" + v;
  v = v.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return v === "" ? DEFAULT_ROUTE_PREFIX : v;
}

/** Set the process-wide route prefix. Returns the normalized value used. */
export function setRoutePrefix(raw: string | undefined | null): string {
  _prefix = normalizeRoutePrefix(raw);
  return _prefix;
}

/** Current normalized prefix (leading slash, no trailing slash). */
export function getRoutePrefix(): string {
  return _prefix;
}

/** Hono wildcard mount pattern for middleware, e.g. `/functions/v1/*`. */
export function routeWildcard(): string {
  return `${_prefix}/*`;
}

/** Hono dispatch pattern capturing the function name + nested path. */
export function routeDispatchPattern(): string {
  return `${_prefix}/:name{.+}`;
}

/**
 * Function name + nested path that follows `${prefix}/`. Returns "" when
 * the path isn't under the prefix. Used by logging + rate-limit to pull
 * the function name out of the request path (the middleware is mounted on
 * the wildcard, so `c.req.param()` can't see it).
 */
export function routeRemainder(path: string): string {
  if (path.startsWith(_prefix + "/")) return path.slice(_prefix.length + 1);
  return "";
}

/**
 * Strip the prefix off a full pathname, KEEPING the leading slash of the
 * remainder (`/functions/v1/hello/world` ? `/hello/world`,
 * `/functions/v1` ? ""). This is the URL the function/worker should see,
 * mirroring Supabase Edge Runtime behaviour. Callers fall back to "/" for
 * the empty result.
 */
export function stripRoutePrefixFromPathname(pathname: string): string {
  if (pathname === _prefix) return "";
  if (pathname.startsWith(_prefix + "/")) return pathname.slice(_prefix.length);
  return pathname;
}
