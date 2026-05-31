export type CallEdgeAuth = "service" | "user" | { bearer: string };

export interface CallEdgeFunctionOptions {
  /** HTTP method. Defaults to `"POST"`. */
  method?: string;
  /** Optional route path inside the target function, e.g. `/sync`. */
  path?: string;
  /** Query parameters appended to the function URL. */
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  auth?: CallEdgeAuth;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface EdgeCallerRuntime {
  getBaseUrl(): string;
  /** Public prefix in front of the function name. Defaults to `/functions/v1`. */
  pathPrefix?: string;
  getServiceRoleToken(): string | null | undefined;
  getAnonKey?(): string | null | undefined;
  getUserToken(): string | null | undefined;
  fetch?: typeof fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface EdgeCaller {
  callEdgeFunction(
    name: string,
    options?: CallEdgeFunctionOptions,
  ): Promise<Response>;
  callEdgeFunctionInBackground(
    name: string,
    options?: CallEdgeFunctionOptions,
  ): void;
}

function resolveBearerToken(
  runtime: EdgeCallerRuntime,
  auth: CallEdgeAuth,
): string {
  if (typeof auth === "object" && auth !== null && "bearer" in auth) {
    return auth.bearer;
  }

  if (auth === "user") {
    const token = runtime.getUserToken();
    if (!token) {
      throw new Error(
        "[callEdgeFunction] auth: 'user' requires an authenticated caller " +
          "(no user token available).",
      );
    }
    return token;
  }

  const serviceToken = runtime.getServiceRoleToken();
  if (!serviceToken) {
    throw new Error(
      "[callEdgeFunction] service auth requires a service role token.",
    );
  }
  return serviceToken;
}

function serializeBody(
  body: unknown,
): { body: BodyInit | null | undefined; contentType?: string } {
  if (body === undefined || body === null) return { body: undefined };
  if (typeof body === "string") {
    return { body, contentType: "text/plain;charset=UTF-8" };
  }
  if (
    body instanceof Uint8Array ||
    body instanceof ArrayBuffer ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof ReadableStream
  ) {
    return { body: body as BodyInit };
  }
  return { body: JSON.stringify(body), contentType: "application/json" };
}

function buildRequest(
  runtime: EdgeCallerRuntime,
  name: string,
  opts: CallEdgeFunctionOptions,
): { url: string; init: RequestInit } {
  const pathPrefix = runtime.pathPrefix ?? "/functions/v1";
  const routePath = opts.path ? `/${opts.path.replace(/^\/+/, "")}` : "";
  const url = new URL(
    `${runtime.getBaseUrl().replace(/\/+$/, "")}/${
      pathPrefix.replace(/^\/+|\/+$/g, "")
    }/${name}${routePath}`,
  );
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
  const token = resolveBearerToken(runtime, opts.auth ?? "service");
  const { body, contentType } = serializeBody(opts.body);
  const anonKey = runtime.getAnonKey?.();

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(anonKey ? { apikey: anonKey } : {}),
    ...opts.headers,
  };

  return {
    url: url.toString(),
    init: {
      method: opts.method ?? "POST",
      headers,
      body: body ?? null,
      signal: opts.signal,
    },
  };
}

export function createEdgeCaller(runtime: EdgeCallerRuntime): EdgeCaller {
  const fetchImpl = runtime.fetch ?? fetch;

  return {
    async callEdgeFunction(name, options = {}) {
      const { url, init } = buildRequest(runtime, name, options);
      return await fetchImpl(url, init);
    },

    callEdgeFunctionInBackground(name, options = {}) {
      const { url, init } = buildRequest(runtime, name, options);
      const promise = fetchImpl(url, init).catch((err) => {
        console.error(`[callEdgeFunctionInBackground] ${name} failed:`, err);
      });
      runtime.waitUntil?.(promise);
    },
  };
}
