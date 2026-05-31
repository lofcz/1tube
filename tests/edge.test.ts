import { assert, assertEquals, assertObjectMatch } from "@std/assert";

import {
  accepted,
  badRequest,
  created,
  createFetchHandler,
  createOpenApiDocument,
  createRouteBuilder,
  HttpStatus,
  methodNotAllowed,
  noContent,
  notFound,
  type SchemaLike,
  tooManyRequests,
} from "../src/edge.ts";
import { createEdgeCaller } from "../src/edge-caller.ts";

function schema<T>(
  validate: (value: unknown) => T | Error,
  jsonSchema: unknown,
): SchemaLike<T> & { jsonSchema: unknown } {
  return {
    jsonSchema,
    safeParse(value) {
      const result = validate(value);
      if (result instanceof Error) return { success: false, error: result };
      return { success: true, data: result };
    },
  };
}

const schemaAdapter = {
  toJsonSchema(input: SchemaLike): unknown {
    return (input as { jsonSchema?: unknown }).jsonSchema ?? {};
  },
};

Deno.test("edge: createFetchHandler dispatches, validates, and applies CORS", async () => {
  const route = createRouteBuilder<{ requestId: string }>();
  const BodySchema = schema<{ name: string }>((value) => {
    if (
      value && typeof value === "object" &&
      typeof (value as { name?: unknown }).name === "string"
    ) {
      return { name: (value as { name: string }).name };
    }
    return new Error("Invalid body");
  }, {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  });
  const ResponseSchema = schema((value) => value, { type: "object" });

  const handler = createFetchHandler({
    name: "widgets",
    require: "public",
    routes: [
      route.postJson("/", "createWidget", {
        body: BodySchema,
        responses: { [HttpStatus.CREATED]: ResponseSchema },
        handler: ({ body, ctx }) =>
          created({ id: `${ctx.requestId}:${body.name}` }),
      }),
    ],
  }, {
    getContext: () => ({ requestId: "req-1" }),
    getCorsHeaders: () => ({ "Access-Control-Allow-Origin": "*" }),
  });

  const response = await handler(
    new Request("http://localhost/functions/v1/widgets", {
      method: "POST",
      body: JSON.stringify({ name: "alpha" }),
    }),
  );

  assertEquals(response.status, HttpStatus.CREATED);
  assertEquals(response.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(await response.json(), { id: "req-1:alpha" });
});

Deno.test("edge: createFetchHandler returns validation errors consistently", async () => {
  const route = createRouteBuilder<Record<string, never>>();
  const BodySchema = schema<{ name: string }>(() => new Error("Invalid body"), {
    type: "object",
  });

  const handler = createFetchHandler({
    name: "widgets",
    require: "public",
    routes: [
      route.postJson("/", "createWidget", {
        body: BodySchema,
        responses: { [HttpStatus.BAD_REQUEST]: BodySchema },
        handler: () => created({ ok: true }),
      }),
    ],
  }, {
    getContext: () => ({}),
  });

  const response = await handler(
    new Request("http://localhost/functions/v1/widgets", {
      method: "POST",
      body: "{}",
    }),
  );

  assertEquals(response.status, HttpStatus.BAD_REQUEST);
  assertObjectMatch(await response.json(), { error: "Invalid body" });
});

Deno.test("edge: pathPrefix supports non-Supabase hosts like ASP.NET Core", async () => {
  const route = createRouteBuilder<Record<string, never>>();
  const ParamsSchema = schema<{ id: string }>((value) => {
    if (
      value && typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string"
    ) {
      return { id: (value as { id: string }).id };
    }
    return new Error("Invalid params");
  }, {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  });

  const handler = createFetchHandler({
    name: "widgets",
    require: "public",
    pathPrefix: "/api/edge",
    routes: [
      route.get("/:id", "getWidget", {
        params: ParamsSchema,
        responses: { [HttpStatus.OK]: ParamsSchema },
        handler: ({ params }) => accepted({ id: params.id }),
      }),
    ],
  }, {
    getContext: () => ({}),
  });

  const response = await handler(
    new Request("http://localhost/api/edge/widgets/w-123"),
  );

  assertEquals(response.status, HttpStatus.ACCEPTED);
  assertEquals(await response.json(), { id: "w-123" });
});

Deno.test("edge: response helpers cover common API outcomes", async () => {
  assertEquals(await created({ ok: true }).json(), { ok: true });
  assertEquals(created({ ok: true }).status, HttpStatus.CREATED);
  assertEquals(noContent().status, HttpStatus.NO_CONTENT);
  assertEquals(await noContent().text(), "");
  assertEquals((await badRequest("Nope").json()).error, "Nope");
  assertEquals((await notFound().json()).error, "Not found");
  assertEquals(
    methodNotAllowed(["POST", "GET"]).headers.get("Allow"),
    "GET, POST",
  );
  const limited = tooManyRequests({ retryAfterSeconds: 30 });
  assertEquals(limited.headers.get("Retry-After"), "30");
  assertEquals((await limited.json()).retryAfterSeconds, 30);
});

Deno.test("edge: createOpenApiDocument emits path, query, body, and response metadata", () => {
  const route = createRouteBuilder<Record<string, never>>();
  const ParamsSchema = schema((value) => value, {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string" } },
  });
  const QuerySchema = schema((value) => value, {
    type: "object",
    properties: { includeArchived: { type: "boolean" } },
  });
  const BodySchema = schema((value) => value, {
    type: "object",
    required: ["name"],
    properties: { name: { type: "string" } },
  });
  const ResponseSchema = schema((value) => value, {
    type: "object",
    properties: { ok: { type: "boolean" } },
  });

  const document = createOpenApiDocument({
    name: "widgets",
    require: "public",
    routes: [
      route.patchJson("/:id", "updateWidget", {
        body: BodySchema,
        responses: {
          [HttpStatus.OK]: ResponseSchema,
          [HttpStatus.NO_CONTENT]: ResponseSchema,
        },
        handler: () => noContent(),
      }),
      route.get("/:id", "getWidget", {
        params: ParamsSchema,
        query: QuerySchema,
        responses: { [HttpStatus.OK]: ResponseSchema },
        handler: () => accepted({ ok: true }),
      }),
    ],
  }, {
    title: "Widgets",
    version: "1.0.0",
    servers: [{ url: "https://example.test/functions/v1" }],
    schemaAdapter,
  });

  assertObjectMatch(document, {
    openapi: "3.1.0",
    info: { title: "Widgets", version: "1.0.0" },
  });

  const paths = document.paths as Record<string, Record<string, unknown>>;
  const getOperation = paths["/{id}"].get as Record<string, unknown>;
  const patchOperation = paths["/{id}"].patch as Record<string, unknown>;
  const parameters = getOperation.parameters as Record<string, unknown>[];

  assertEquals(getOperation.operationId, "getWidget");
  assertEquals(patchOperation.operationId, "updateWidget");
  assert(
    parameters.some((param) => param.name === "id" && param.in === "path"),
  );
  assert(
    parameters.some((param) =>
      param.name === "includeArchived" && param.in === "query"
    ),
  );
  assert("requestBody" in patchOperation);

  const responses = patchOperation.responses as Record<string, unknown>;
  assertEquals(responses[String(HttpStatus.NO_CONTENT)], {
    description: "204 response",
  });
});

Deno.test("edge-caller: builds Supabase-compatible requests by default", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const caller = createEdgeCaller({
    getBaseUrl: () => "https://edge.example.test/",
    getServiceRoleToken: () => "service-token",
    getUserToken: () => null,
    getAnonKey: () => "anon-key",
    fetch: (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return Promise.resolve(new Response("ok"));
    },
  });

  const response = await caller.callEdgeFunction("widgets", {
    path: "/sync",
    query: { page: 2, archived: false, skip: null },
    body: { ok: true },
  });

  assertEquals(await response.text(), "ok");
  assertEquals(
    capturedUrl,
    "https://edge.example.test/functions/v1/widgets/sync?page=2&archived=false",
  );
  assertEquals(capturedInit?.method, "POST");
  const headers = new Headers(capturedInit?.headers);
  assertEquals(headers.get("Authorization"), "Bearer service-token");
  assertEquals(headers.get("apikey"), "anon-key");
  assertEquals(headers.get("Content-Type"), "application/json");
  assertEquals(capturedInit?.body, JSON.stringify({ ok: true }));
});

Deno.test("edge-caller: supports custom host prefixes and user-token forwarding", async () => {
  let capturedUrl = "";
  let capturedAuthorization = "";
  const caller = createEdgeCaller({
    getBaseUrl: () => "https://api.example.test",
    pathPrefix: "/api/edge",
    getServiceRoleToken: () => "service-token",
    getUserToken: () => "user-token",
    fetch: (url, init) => {
      capturedUrl = String(url);
      capturedAuthorization = new Headers(
        (init as { headers?: HeadersInit } | undefined)?.headers,
      ).get("Authorization") ?? "";
      return Promise.resolve(new Response("ok"));
    },
  });

  await caller.callEdgeFunction("widgets", {
    auth: "user",
    method: "GET",
  });

  assertEquals(capturedUrl, "https://api.example.test/api/edge/widgets");
  assertEquals(capturedAuthorization, "Bearer user-token");
});
