/**
 * 1tube -- Self-hosted Supabase Edge Functions gateway.
 *
 * Discovers and loads edge function modules, exposes them via a single HTTP
 * server with JWT auth, CORS, rate limiting, and structured logging.
 *
 * Usage:
 *   deno run --allow-all src/server.ts
 *   deno run --allow-all src/server.ts --functions ../sciobot-next/supabase/functions --port 3100
 */

import { Hono } from "npm:hono@4";
import { FunctionRegistry } from "./registry.ts";
import { discoverAndLoad } from "./discovery.ts";
import { validateRequest } from "./gateway/auth.ts";
import { corsMiddleware } from "./gateway/cors.ts";
import { loggingMiddleware } from "./gateway/logging.ts";
import { createRateLimiter } from "./gateway/rate-limit.ts";
import { createHealthHandler, createMetricsHandler } from "./health.ts";
import { VERSION } from "./version.ts";

// ---------------------------------------------------------------------------
// CLI args & env
// ---------------------------------------------------------------------------

// Well-known defaults for local Supabase (identical for every `supabase init` project).
// These are only applied when the env vars are not already set.
const LOCAL_SUPABASE_DEFAULTS: Record<string, string> = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU",
  JWT_SECRET: "super-secret-jwt-token-with-at-least-32-characters-long",
};

function applyLocalDefaults() {
  let applied = 0;
  for (const [key, value] of Object.entries(LOCAL_SUPABASE_DEFAULTS)) {
    if (!Deno.env.get(key)) {
      Deno.env.set(key, value);
      applied++;
    }
  }
  if (applied > 0) {
    console.log(`[1tube] Applied ${applied} local Supabase default(s)`);
  }
}

function parseArgs(): { port: number; functionsPath: string; defaultTimeoutMs: number } {
  const args = Deno.args;
  let port = parseInt(Deno.env.get("PORT") || "3100", 10);
  let functionsPath = Deno.env.get("FUNCTIONS_PATH") || "./supabase/functions";
  let defaultTimeoutMs = parseInt(Deno.env.get("FUNCTION_TIMEOUT_MS") || "150000", 10);

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--functions" && args[i + 1]) {
      functionsPath = args[i + 1];
      i++;
    } else if (args[i] === "--timeout" && args[i + 1]) {
      defaultTimeoutMs = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { port, functionsPath, defaultTimeoutMs };
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const { port, functionsPath, defaultTimeoutMs } = parseArgs();

applyLocalDefaults();

const denoVersion = `${Deno.version.deno} (V8 ${Deno.version.v8}, TS ${Deno.version.typescript})`;
const bannerText = `  1tube v${VERSION}  ·  Deno ${denoVersion}  `;
const bannerLine = "─".repeat(bannerText.length);
console.log(`\x1b[36m┌${bannerLine}┐\x1b[0m`);
console.log(`\x1b[36m│\x1b[0m  \x1b[1m1tube\x1b[0m v${VERSION}  \x1b[2m·\x1b[0m  Deno ${denoVersion}  \x1b[36m│\x1b[0m`);
console.log(`\x1b[36m└${bannerLine}┘\x1b[0m`);

const registry = new FunctionRegistry();
(globalThis as any).__edgeFunctionRegistry = registry;

async function reloadFunctions(reason: string) {
  console.log(`[1tube] Reloading functions (${reason})...`);
  registry.clear();
  const cacheBust = `${Date.now()}-${crypto.randomUUID()}`;
  const { loaded, skipped, errors } = await discoverAndLoad(functionsPath, registry, { cacheBust });

  console.log(`[1tube] Loaded ${loaded.length} functions, skipped ${skipped.length} directories`);
  if (loaded.length > 0) {
    console.log(`[1tube] Functions: ${loaded.join(", ")}`);
  }
  if (errors.length > 0) {
    console.error(`[1tube] ${errors.length} function(s) failed to load (check .env for missing vars):`);
    for (const e of errors) {
      console.error(`  ${e.name}: ${e.error}`);
    }
  }
}

console.log(`[1tube] Loading functions from: ${functionsPath}`);
await reloadFunctions("initial boot");

let reloadTimer: number | undefined;
let isReloading = false;
let needsAnotherReload = false;

function scheduleReload(reason: string) {
  if (reloadTimer !== undefined) {
    clearTimeout(reloadTimer);
  }
  reloadTimer = setTimeout(async () => {
    if (isReloading) {
      needsAnotherReload = true;
      return;
    }

    isReloading = true;
    try {
      await reloadFunctions(reason);
    } catch (err) {
      console.error("[1tube] Reload failed:", err);
    } finally {
      isReloading = false;
      if (needsAnotherReload) {
        needsAnotherReload = false;
        scheduleReload("batched filesystem updates");
      }
    }
  }, 200);
}

async function watchFunctions() {
  try {
    const watcher = Deno.watchFs(functionsPath, { recursive: true });
    console.log(`[1tube] HMR watching: ${functionsPath}`);
    for await (const event of watcher) {
      if (event.paths.length === 0) continue;
      scheduleReload(`${event.kind} (${event.paths.length} path(s))`);
    }
  } catch (err) {
    console.warn("[1tube] HMR watcher disabled:", err);
  }
}

watchFunctions();

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

/** Set on authenticated function calls; read in logging middleware. */
type GatewayVariables = { userId?: string };

const app = new Hono<{ Variables: GatewayVariables }>();
const rateLimiter = createRateLimiter();

// Gateway middleware on all function routes
app.use("/functions/v1/*", corsMiddleware);
app.use("/functions/v1/*", loggingMiddleware);
app.use("/functions/v1/*", rateLimiter);

// Function dispatch
app.all("/functions/v1/:name{.+}", async (c) => {
  const name = c.req.param("name");
  const fn = registry.get(name);

  if (!fn) {
    return c.json({ error: `Function "${name}" not found` }, 404);
  }

  const timeoutMs = fn.timeoutMs ?? defaultTimeoutMs;

  // Rewrite URL to strip /functions/v1 prefix, matching Supabase Edge Runtime
  // behavior. Functions expect paths like /rooms/:id, not /functions/v1/rooms/:id.
  const originalUrl = new URL(c.req.raw.url);
  const rewrittenPath = originalUrl.pathname.replace(/^\/functions\/v1/, "") || "/";
  const rewrittenUrl = new URL(rewrittenPath + originalUrl.search, originalUrl.origin);
  const rewrittenReq = new Request(rewrittenUrl.toString(), c.req.raw);

  let handlerPromise: Promise<Response>;

  if (!fn.isPublic) {
    const auth = await validateRequest(c.req.raw);
    if (!auth) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    c.set("userId", auth.userId);
    handlerPromise = Promise.resolve((fn.handler as any)(rewrittenReq, auth));
  } else {
    handlerPromise = Promise.resolve((fn.handler as any)(rewrittenReq));
  }

  try {
    if (timeoutMs > 0) {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Function "${name}" timed out after ${timeoutMs}ms`)), timeoutMs),
      );
      return await Promise.race([handlerPromise, timeout]);
    }
    return await handlerPromise;
  } catch (err) {
    if (err instanceof Error && err.message.includes("timed out")) {
      console.error(`[1tube] ${err.message}`);
      return c.json({ error: "Function execution timed out" }, 504);
    }
    console.error(`[1tube] Unhandled error in "${name}":`, err);
    return c.json({ error: "Internal server error" }, 500);
  }
});

// Health & observability
app.get("/health", createHealthHandler(registry));
app.get("/metrics", createMetricsHandler());

// Root info
app.get("/", (c) =>
  c.json({
    name: "1tube",
    description: "Self-hosted Supabase Edge Functions gateway",
    functions: registry.size,
    endpoints: {
      functions: "/functions/v1/:name",
      health: "/health",
      metrics: "/metrics",
    },
  }),
);

console.log(`[1tube] Starting on http://localhost:${port}`);

Deno.serve({ port }, app.fetch);
