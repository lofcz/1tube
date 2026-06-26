export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface SchemaLike<T = unknown> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

export interface JsonSchemaAdapter {
  toJsonSchema(schema: SchemaLike): unknown;
}

type SchemaOutput<TSchema> = TSchema extends SchemaLike<infer T> ? T
  : undefined;
type ParamsOutput<TSchema> = TSchema extends SchemaLike<infer T> ? T
  : Record<string, string>;
type QueryOutput<TSchema> = TSchema extends SchemaLike<infer T> ? T
  : Record<string, string>;

export enum HttpStatus {
  OK = 200,
  CREATED = 201,
  ACCEPTED = 202,
  NO_CONTENT = 204,
  RESET_CONTENT = 205,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  METHOD_NOT_ALLOWED = 405,
  REQUEST_TIMEOUT = 408,
  CONFLICT = 409,
  GONE = 410,
  PRECONDITION_FAILED = 412,
  PAYLOAD_TOO_LARGE = 413,
  UNSUPPORTED_MEDIA_TYPE = 415,
  UNPROCESSABLE_CONTENT = 422,
  LOCKED = 423,
  PRECONDITION_REQUIRED = 428,
  TOO_MANY_REQUESTS = 429,
  INTERNAL_SERVER_ERROR = 500,
  NOT_IMPLEMENTED = 501,
  BAD_GATEWAY = 502,
  SERVICE_UNAVAILABLE = 503,
  GATEWAY_TIMEOUT = 504,
}

export type ErrorHttpStatus =
  | HttpStatus.BAD_REQUEST
  | HttpStatus.UNAUTHORIZED
  | HttpStatus.FORBIDDEN
  | HttpStatus.NOT_FOUND
  | HttpStatus.METHOD_NOT_ALLOWED
  | HttpStatus.REQUEST_TIMEOUT
  | HttpStatus.CONFLICT
  | HttpStatus.GONE
  | HttpStatus.PRECONDITION_FAILED
  | HttpStatus.PAYLOAD_TOO_LARGE
  | HttpStatus.UNSUPPORTED_MEDIA_TYPE
  | HttpStatus.UNPROCESSABLE_CONTENT
  | HttpStatus.LOCKED
  | HttpStatus.PRECONDITION_REQUIRED
  | HttpStatus.TOO_MANY_REQUESTS
  | HttpStatus.INTERNAL_SERVER_ERROR
  | HttpStatus.NOT_IMPLEMENTED
  | HttpStatus.BAD_GATEWAY
  | HttpStatus.SERVICE_UNAVAILABLE
  | HttpStatus.GATEWAY_TIMEOUT;

export type RouteResponses = Partial<Record<HttpStatus, SchemaLike>>;

export interface RouteRequest<
  TParams extends SchemaLike | undefined,
  TQuery extends SchemaLike | undefined,
  TBody extends SchemaLike | undefined,
  TContext,
> {
  req: Request;
  ctx: TContext;
  params: ParamsOutput<TParams>;
  query: QueryOutput<TQuery>;
  body: SchemaOutput<TBody>;
}

export type RouteHandler<
  TParams extends SchemaLike | undefined = undefined,
  TQuery extends SchemaLike | undefined = undefined,
  TBody extends SchemaLike | undefined = undefined,
  TContext = unknown,
> = (
  input: RouteRequest<TParams, TQuery, TBody, TContext>,
) => Response | Promise<Response>;

export interface RouteOptions<
  TParams extends SchemaLike | undefined = undefined,
  TQuery extends SchemaLike | undefined = undefined,
  TBody extends SchemaLike | undefined = undefined,
  TResponses extends RouteResponses = RouteResponses,
  TContext = unknown,
> {
  params?: TParams;
  query?: TQuery;
  body?: TBody;
  responses: TResponses;
  summary?: string;
  description?: string;
  handler: RouteHandler<TParams, TQuery, TBody, TContext>;
}

export interface RouteDefinition<
  TParams extends SchemaLike | undefined = SchemaLike | undefined,
  TQuery extends SchemaLike | undefined = SchemaLike | undefined,
  TBody extends SchemaLike | undefined = SchemaLike | undefined,
  TResponses extends RouteResponses = RouteResponses,
  TContext = unknown,
> extends RouteOptions<TParams, TQuery, TBody, TResponses, TContext> {
  method: HttpMethod;
  path: string;
  operationId: string;
}

export interface JsonRouteOptions<
  TBody extends SchemaLike,
  TResponses extends RouteResponses,
  TContext,
> {
  body: TBody;
  responses: TResponses;
  summary?: string;
  description?: string;
  handler: RouteHandler<undefined, undefined, TBody, TContext>;
}

function defineRoute<
  TParams extends SchemaLike | undefined,
  TQuery extends SchemaLike | undefined,
  TBody extends SchemaLike | undefined,
  TResponses extends RouteResponses,
  TContext,
>(
  method: HttpMethod,
  path: string,
  operationId: string,
  options: RouteOptions<TParams, TQuery, TBody, TResponses, TContext>,
): RouteDefinition<TParams, TQuery, TBody, TResponses, TContext> {
  return { method, path: normalizeRoutePath(path), operationId, ...options };
}

function defineJsonRoute<
  TBody extends SchemaLike,
  TResponses extends RouteResponses,
  TContext,
>(
  method: HttpMethod,
  path: string,
  operationId: string,
  options: JsonRouteOptions<TBody, TResponses, TContext>,
): RouteDefinition<undefined, undefined, TBody, TResponses, TContext> {
  return defineRoute(method, path, operationId, options);
}

export function createRouteBuilder<TDefaultContext = unknown>() {
  return {
    get: <
      TParams extends SchemaLike | undefined = undefined,
      TQuery extends SchemaLike | undefined = undefined,
      TResponses extends RouteResponses = RouteResponses,
    >(
      path: string,
      operationId: string,
      options: RouteOptions<
        TParams,
        TQuery,
        undefined,
        TResponses,
        TDefaultContext
      >,
    ) => defineRoute("GET", path, operationId, options),

    post: <
      TParams extends SchemaLike | undefined = undefined,
      TQuery extends SchemaLike | undefined = undefined,
      TBody extends SchemaLike | undefined = undefined,
      TResponses extends RouteResponses = RouteResponses,
    >(
      path: string,
      operationId: string,
      options: RouteOptions<
        TParams,
        TQuery,
        TBody,
        TResponses,
        TDefaultContext
      >,
    ) => defineRoute("POST", path, operationId, options),

    put: <
      TParams extends SchemaLike | undefined = undefined,
      TQuery extends SchemaLike | undefined = undefined,
      TBody extends SchemaLike | undefined = undefined,
      TResponses extends RouteResponses = RouteResponses,
    >(
      path: string,
      operationId: string,
      options: RouteOptions<
        TParams,
        TQuery,
        TBody,
        TResponses,
        TDefaultContext
      >,
    ) => defineRoute("PUT", path, operationId, options),

    patch: <
      TParams extends SchemaLike | undefined = undefined,
      TQuery extends SchemaLike | undefined = undefined,
      TBody extends SchemaLike | undefined = undefined,
      TResponses extends RouteResponses = RouteResponses,
    >(
      path: string,
      operationId: string,
      options: RouteOptions<
        TParams,
        TQuery,
        TBody,
        TResponses,
        TDefaultContext
      >,
    ) => defineRoute("PATCH", path, operationId, options),

    delete: <
      TParams extends SchemaLike | undefined = undefined,
      TQuery extends SchemaLike | undefined = undefined,
      TResponses extends RouteResponses = RouteResponses,
    >(
      path: string,
      operationId: string,
      options: RouteOptions<
        TParams,
        TQuery,
        undefined,
        TResponses,
        TDefaultContext
      >,
    ) => defineRoute("DELETE", path, operationId, options),

    postJson: <
      TBody extends SchemaLike,
      TResponses extends RouteResponses,
    >(
      path: string,
      operationId: string,
      options: JsonRouteOptions<TBody, TResponses, TDefaultContext>,
    ) => defineJsonRoute("POST", path, operationId, options),

    putJson: <
      TBody extends SchemaLike,
      TResponses extends RouteResponses,
    >(
      path: string,
      operationId: string,
      options: JsonRouteOptions<TBody, TResponses, TDefaultContext>,
    ) => defineJsonRoute("PUT", path, operationId, options),

    patchJson: <
      TBody extends SchemaLike,
      TResponses extends RouteResponses,
    >(
      path: string,
      operationId: string,
      options: JsonRouteOptions<TBody, TResponses, TDefaultContext>,
    ) => defineJsonRoute("PATCH", path, operationId, options),
  };
}

export const route = createRouteBuilder();

export function json(
  body: unknown,
  init: number | ResponseInit = HttpStatus.OK,
): Response {
  const responseInit: ResponseInit = typeof init === "number"
    ? { status: init }
    : init;
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return new Response(JSON.stringify(body), { ...responseInit, headers });
}

export function jsonError(
  status: ErrorHttpStatus,
  message: string,
  details?: unknown,
  init: Omit<ResponseInit, "status"> = {},
): Response {
  return json(
    { error: message, ...(details === undefined ? {} : { details }) },
    { ...init, status },
  );
}

export function empty(
  status: HttpStatus = HttpStatus.NO_CONTENT,
  init: Omit<ResponseInit, "status"> = {},
): Response {
  return new Response(null, { ...init, status });
}

export function text(
  body: string,
  init: number | ResponseInit = HttpStatus.OK,
): Response {
  const responseInit: ResponseInit = typeof init === "number"
    ? { status: init }
    : init;
  const headers = new Headers(responseInit.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "text/plain;charset=UTF-8");
  }
  return new Response(body, { ...responseInit, headers });
}

export function created(
  body: unknown,
  init: Omit<ResponseInit, "status"> = {},
): Response {
  return json(body, { ...init, status: HttpStatus.CREATED });
}

export function accepted(
  body: unknown,
  init: Omit<ResponseInit, "status"> = {},
): Response {
  return json(body, { ...init, status: HttpStatus.ACCEPTED });
}

export function noContent(init: Omit<ResponseInit, "status"> = {}): Response {
  return empty(HttpStatus.NO_CONTENT, init);
}

export function badRequest(
  message = "Bad request",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.BAD_REQUEST, message, details);
}

export function unauthorized(
  message = "Unauthorized",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.UNAUTHORIZED, message, details);
}

export function forbidden(message = "Forbidden", details?: unknown): Response {
  return jsonError(HttpStatus.FORBIDDEN, message, details);
}

export function notFound(message = "Not found", details?: unknown): Response {
  return jsonError(HttpStatus.NOT_FOUND, message, details);
}

export function methodNotAllowed(
  allowedMethods: readonly string[],
  message = "Method not allowed",
): Response {
  return jsonError(HttpStatus.METHOD_NOT_ALLOWED, message, undefined, {
    headers: { Allow: [...allowedMethods].sort().join(", ") },
  });
}

export function conflict(message = "Conflict", details?: unknown): Response {
  return jsonError(HttpStatus.CONFLICT, message, details);
}

export function gone(message = "Gone", details?: unknown): Response {
  return jsonError(HttpStatus.GONE, message, details);
}

export function payloadTooLarge(
  message = "Payload too large",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.PAYLOAD_TOO_LARGE, message, details);
}

export function unsupportedMediaType(
  message = "Unsupported media type",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, message, details);
}

export function unprocessableContent(
  message = "Unprocessable content",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.UNPROCESSABLE_CONTENT, message, details);
}

export function tooManyRequests(input: {
  message?: string;
  retryAfterSeconds?: number;
} = {}): Response {
  const headers = input.retryAfterSeconds === undefined
    ? undefined
    : { "Retry-After": String(input.retryAfterSeconds) };
  return json(
    {
      error: input.message ?? "Rate limit exceeded",
      ...(input.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: input.retryAfterSeconds }),
    },
    { status: HttpStatus.TOO_MANY_REQUESTS, headers },
  );
}

export function internalServerError(
  message = "Internal server error",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.INTERNAL_SERVER_ERROR, message, details);
}

export function badGateway(
  message = "Bad gateway",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.BAD_GATEWAY, message, details);
}

export function serviceUnavailable(
  message = "Service unavailable",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.SERVICE_UNAVAILABLE, message, details);
}

export function gatewayTimeout(
  message = "Gateway timeout",
  details?: unknown,
): Response {
  return jsonError(HttpStatus.GATEWAY_TIMEOUT, message, details);
}

/**
 * How the rate limiter buckets requests for a function:
 *   - "identity" (default): one bucket per authenticated user, falling back to
 *     the client IP for unauthenticated/public functions.
 *   - "ip": always bucket by client IP, even when a user is authenticated.
 *   - "global": a single shared bucket for the whole function.
 *
 * Defined here (the self-contained `edge` surface) rather than in `manifest.ts`
 * so the published `dist/edge.d.ts` has no dangling cross-module reference;
 * `manifest.ts` re-exports it for the gateway side.
 */
export type RateLimitBy = "identity" | "ip" | "global";

/** Full-control form of `serve({ rateLimit })`. */
export interface RateLimitConfig {
  /**
   * Requests per minute. `0` = unlimited (the function is exempt). Omit to use
   * the gateway default / any `1tube.json` value.
   */
  rpm?: number;
  /**
   * Bucket key strategy. Defaults to "identity" (per authenticated user,
   * falling back to client IP). See {@link RateLimitBy}.
   */
  by?: RateLimitBy;
}

/**
 * Per-function rate-limit declaration for `serve({ rateLimit })`:
 *   - `false`  → exempt from rate limiting entirely (signed webhooks, trusted
 *     server-to-server callers).
 *   - `true`   → gateway default limit, keyed by identity (the implicit default
 *     when `rateLimit` is omitted).
 *   - `number` → requests-per-minute, keyed by identity.
 *   - object   → full control over rpm + key strategy.
 */
export type RateLimitOption = boolean | number | RateLimitConfig;

/** Normalized shape consumed by the registry / Worker `register()` contract. */
export interface NormalizedRateLimit {
  rpm?: number;
  rateLimitBy?: RateLimitBy;
}

/**
 * Collapse the friendly {@link RateLimitOption} into `{ rpm?, rateLimitBy? }`.
 * `undefined`/`true` leave both unset (gateway default); `false` maps to the
 * `rpm: 0` "unlimited" sentinel the gateway limiter understands.
 */
export function normalizeRateLimit(
  rl: RateLimitOption | undefined,
): NormalizedRateLimit {
  if (rl === undefined || rl === true) return {};
  if (rl === false) return { rpm: 0 };
  if (typeof rl === "number") return { rpm: rl };
  return { rpm: rl.rpm, rateLimitBy: rl.by };
}

export interface ServeConfig<TContext = unknown> {
  name: string;
  require: unknown;
  timeoutMs?: number;
  routes: RouteDefinition<
    SchemaLike | undefined,
    SchemaLike | undefined,
    SchemaLike | undefined,
    RouteResponses,
    TContext
  >[];
  /**
   * Public prefix in front of the function name. Supabase-compatible hosts use
   * `/functions/v1`; ASP.NET Core or other reverse proxies may expose a
   * different prefix while keeping the same function modules.
   */
  pathPrefix?: string;
  /**
   * Per-function rate-limit declaration. Overrides any `1tube.json` `rpm`.
   * Use `false` to exempt the function from rate limiting (e.g. a signed
   * server-to-server webhook). Honoured by the 1tube gateway; standalone
   * runtimes that front their own limiter ignore it.
   */
  rateLimit?: RateLimitOption;
}

export interface MatchedRoute {
  route: RouteDefinition<
    SchemaLike | undefined,
    SchemaLike | undefined,
    SchemaLike | undefined,
    RouteResponses,
    any
  >;
  params: Record<string, string>;
}

export interface RouteDispatcherContext<TContext> {
  req: Request;
  ctx: TContext;
  matched: MatchedRoute;
  getCorsHeaders?: (req: Request) => HeadersInit;
}

export type RouteDispatcher<TContext> = (
  input: RouteDispatcherContext<TContext>,
) => Promise<Response>;

export interface FetchHandlerOptions<TContext> {
  getContext(
    req: Request,
  ): TContext | Response | Promise<TContext | Response>;
  getCorsHeaders?: (req: Request) => HeadersInit;
  onError?: (error: unknown, req: Request) => Response | Promise<Response>;
  afterResponse?: (
    response: Response,
    req: Request,
  ) => Response | Promise<Response>;
}

export interface StandaloneServe {
  (handler: (req: Request) => Response | Promise<Response>): void;
}

export function getStandaloneServe(): StandaloneServe | null {
  const runtime = globalThis as { Deno?: { serve?: StandaloneServe } };
  const standaloneServe = runtime.Deno?.serve;
  return typeof standaloneServe === "function"
    ? standaloneServe.bind(runtime.Deno)
    : null;
}

export function normalizeRoutePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

export function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function getRelativePath(req: Request, functionName: string): string {
  const parts = splitPath(new URL(req.url).pathname);
  return getRelativePathFromParts(parts, functionName);
}

export function getRelativePathFromParts(
  pathnameParts: string[],
  functionName: string,
  pathPrefix?: string,
): string {
  const prefixParts = pathPrefix ? splitPath(pathPrefix) : ["functions", "v1"];
  const hasPrefix = prefixParts.length > 0 &&
    prefixParts.every((part, index) => pathnameParts[index] === part);
  const parts = hasPrefix
    ? pathnameParts.slice(prefixParts.length)
    : pathnameParts;

  if (parts[0] === functionName) {
    return normalizeRoutePath(parts.slice(1).join("/"));
  }

  if (
    pathnameParts[0] === "functions" && pathnameParts[1] === "v1" &&
    pathnameParts[2] === functionName
  ) {
    return normalizeRoutePath(pathnameParts.slice(3).join("/"));
  }

  return normalizeRoutePath(parts.join("/"));
}

export function matchRoutePath(
  routePath: string,
  requestPath: string,
): Record<string, string> | null {
  const routeParts = splitPath(routePath);
  const requestParts = splitPath(requestPath);
  if (routeParts.length !== requestParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < routeParts.length; i++) {
    const expected = routeParts[i];
    const actual = requestParts[i];
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export function findRoute<TContext>(
  config: ServeConfig<TContext>,
  req: Request,
): MatchedRoute | Response {
  const requestPath = getRelativePathFromParts(
    splitPath(new URL(req.url).pathname),
    config.name,
    config.pathPrefix,
  );
  const pathMatches = config.routes
    .map((routeDef) => ({
      route: routeDef,
      params: matchRoutePath(routeDef.path, requestPath),
    }))
    .filter((match): match is MatchedRoute => match.params !== null);

  if (pathMatches.length === 0) {
    return notFound();
  }

  const allowedMethods = [
    ...new Set(pathMatches.map((match) => match.route.method)),
  ].sort();
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: HttpStatus.NO_CONTENT,
      headers: { Allow: allowedMethods.join(", ") },
    });
  }

  const method = req.method.toUpperCase();
  const match = pathMatches.find((candidate) =>
    candidate.route.method === method
  );
  if (!match) {
    return methodNotAllowed(allowedMethods);
  }

  return match;
}

export function queryObject(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

export async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function flattenSchemaError(error: unknown): unknown {
  if (
    error &&
    typeof error === "object" &&
    "flatten" in error &&
    typeof (error as { flatten?: unknown }).flatten === "function"
  ) {
    return (error as { flatten: () => unknown }).flatten();
  }
  return error;
}

export function validateSchema<TSchema extends SchemaLike | undefined>(
  schema: TSchema,
  value: unknown,
  label: "params" | "query" | "body",
): SchemaOutput<TSchema> | Response {
  if (!schema) return value as SchemaOutput<TSchema>;
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return jsonError(
      HttpStatus.BAD_REQUEST,
      `Invalid ${label}`,
      flattenSchemaError(parsed.error),
    );
  }
  return parsed.data as SchemaOutput<TSchema>;
}

export function withCors(
  req: Request,
  response: Response,
  getCorsHeaders?: (req: Request) => HeadersInit,
): Response {
  if (!getCorsHeaders) return response;
  const headers = new Headers(response.headers);
  for (const [key, value] of new Headers(getCorsHeaders(req)).entries()) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function dispatchRoute<TContext>(
  input: RouteDispatcherContext<TContext>,
): Promise<Response> {
  const { req, ctx, matched } = input;
  const { route: routeDef, params: rawParams } = matched;

  const params = validateSchema(routeDef.params, rawParams, "params");
  if (params instanceof Response) {
    return withCors(req, params, input.getCorsHeaders);
  }

  const query = validateSchema(routeDef.query, queryObject(req), "query");
  if (query instanceof Response) {
    return withCors(req, query, input.getCorsHeaders);
  }

  const rawBody = routeDef.body ? await parseJsonBody(req) : undefined;
  const body = validateSchema(routeDef.body, rawBody, "body");
  if (body instanceof Response) {
    return withCors(req, body, input.getCorsHeaders);
  }

  return withCors(
    req,
    await routeDef.handler({ req, ctx, params, query, body }),
    input.getCorsHeaders,
  );
}

async function defaultOnError(error: unknown): Promise<Response> {
  const message =
    error instanceof Error && error.message === "Invalid JSON body"
      ? "Invalid JSON body"
      : "Internal server error";
  return message === "Invalid JSON body"
    ? badRequest(message)
    : internalServerError(message);
}

export function createFetchHandler<TContext>(
  config: ServeConfig<TContext>,
  options: FetchHandlerOptions<TContext>,
): (req: Request) => Promise<Response> {
  return async (req) => {
    try {
      const matched = findRoute(config, req);
      if (matched instanceof Response) {
        const response = withCors(req, matched, options.getCorsHeaders);
        return options.afterResponse
          ? await options.afterResponse(response, req)
          : response;
      }

      const context = await options.getContext(req);
      if (context instanceof Response) {
        const response = withCors(req, context, options.getCorsHeaders);
        return options.afterResponse
          ? await options.afterResponse(response, req)
          : response;
      }

      const response = await dispatchRoute({
        req,
        ctx: context,
        matched,
        getCorsHeaders: options.getCorsHeaders,
      });
      return options.afterResponse
        ? await options.afterResponse(response, req)
        : response;
    } catch (error) {
      const response = withCors(
        req,
        options.onError
          ? await options.onError(error, req)
          : await defaultOnError(error),
        options.getCorsHeaders,
      );
      return options.afterResponse
        ? await options.afterResponse(response, req)
        : response;
    }
  };
}

export interface OpenApiDocumentOptions {
  title: string;
  version: string;
  servers?: { url: string; description?: string }[];
  schemaAdapter?: JsonSchemaAdapter;
}

function schemaToOpenApi(
  schema: SchemaLike | undefined,
  adapter: JsonSchemaAdapter | undefined,
): unknown {
  if (!schema || !adapter) return undefined;
  return adapter.toJsonSchema(schema);
}

function pathToOpenApiPath(path: string): string {
  return normalizeRoutePath(path).replace(/:([^/]+)/g, "{$1}");
}

function pathParameterNames(path: string): string[] {
  return splitPath(path)
    .filter((part) => part.startsWith(":"))
    .map((part) => part.slice(1));
}

function objectSchemaProperties(schema: unknown): Record<string, unknown> {
  if (
    schema &&
    typeof schema === "object" &&
    "properties" in schema &&
    typeof (schema as { properties?: unknown }).properties === "object" &&
    (schema as { properties?: unknown }).properties !== null
  ) {
    return (schema as { properties: Record<string, unknown> }).properties;
  }
  return {};
}

function objectSchemaRequired(schema: unknown): Set<string> {
  if (
    schema &&
    typeof schema === "object" &&
    "required" in schema &&
    Array.isArray((schema as { required?: unknown }).required)
  ) {
    return new Set((schema as { required: string[] }).required);
  }
  return new Set();
}

function responseObject(
  status: string,
  schema: unknown,
): Record<string, unknown> {
  if (status === String(HttpStatus.NO_CONTENT) || !schema) {
    return { description: `${status} response` };
  }
  return {
    description: `${status} response`,
    content: {
      "application/json": { schema },
    },
  };
}

export function createOpenApiDocument(
  config: ServeConfig<any>,
  options: OpenApiDocumentOptions,
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const routeDef of config.routes) {
    const path = pathToOpenApiPath(routeDef.path);
    const pathItem = paths[path] ?? {};
    const paramsSchema = schemaToOpenApi(
      routeDef.params,
      options.schemaAdapter,
    );
    const paramsProperties = objectSchemaProperties(paramsSchema);
    const parameters: Record<string, unknown>[] = pathParameterNames(
      routeDef.path,
    ).map((name) => ({
      name,
      in: "path",
      required: true,
      schema: paramsProperties[name] ?? { type: "string" },
    }));

    const querySchema = schemaToOpenApi(routeDef.query, options.schemaAdapter);
    if (querySchema) {
      const queryProperties = objectSchemaProperties(querySchema);
      const queryRequired = objectSchemaRequired(querySchema);
      for (const [name, schema] of Object.entries(queryProperties)) {
        parameters.push({
          name,
          in: "query",
          required: queryRequired.has(name),
          schema,
        });
      }
      if (Object.keys(queryProperties).length === 0) {
        parameters.push({
          name: "query",
          in: "query",
          required: false,
          schema: querySchema,
        });
      }
    }

    pathItem[routeDef.method.toLowerCase()] = {
      operationId: routeDef.operationId,
      ...(routeDef.summary ? { summary: routeDef.summary } : {}),
      ...(routeDef.description ? { description: routeDef.description } : {}),
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(routeDef.body
        ? {
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: schemaToOpenApi(routeDef.body, options.schemaAdapter) ??
                  {},
              },
            },
          },
        }
        : {}),
      responses: Object.fromEntries(
        Object.entries(routeDef.responses).map(([status, schema]) => [
          status,
          responseObject(
            status,
            schemaToOpenApi(schema, options.schemaAdapter),
          ),
        ]),
      ),
    };

    paths[path] = pathItem;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: options.title,
      version: options.version,
    },
    ...(options.servers ? { servers: options.servers } : {}),
    paths,
  };
}
