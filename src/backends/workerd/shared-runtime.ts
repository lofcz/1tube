import { pathToFileURL } from "node:url";

export const SHARED_RUNTIME_URL_ENV = "__1TUBE_SHARED_RUNTIME_URL";
export const SHARED_RUNTIME_TOKEN_ENV = "__1TUBE_SHARED_RUNTIME_TOKEN";

export interface SharedRuntimeModule {
  id: string;
  bundlePath: string;
  exportNames: readonly string[];
}

export interface WorkerdSharedRuntime {
  readonly url: string;
  readonly token: string;
  stop(): Promise<void>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const body = await req.json();
  return body && typeof body === "object"
    ? body as Record<string, unknown>
    : {};
}

/**
 * Gateway-owned singleton runtime for modules that rely on Deno's
 * process-wide semantics. Workerd function isolates call this over a
 * private loopback RPC instead of evaluating those modules per isolate.
 */
export async function startWorkerdSharedRuntime(
  modules: readonly SharedRuntimeModule[],
): Promise<WorkerdSharedRuntime | null> {
  if (modules.length === 0) return null;

  const loaded = new Map<string, Record<string, unknown>>();
  for (const module of modules) {
    const exports = await import(
      pathToFileURL(module.bundlePath).href
    ) as Record<string, unknown>;
    for (const name of module.exportNames) {
      if (typeof exports[name] !== "function") {
        throw new Error(
          `shared module ${module.bundlePath} does not export function ${name}()`,
        );
      }
    }
    loaded.set(module.id, exports);
  }

  const token = randomToken();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: () => {},
  }, async (req) => {
    if (req.headers.get("authorization") !== `Bearer ${token}`) {
      return json({ error: "unauthorized" }, 401);
    }

    const url = new URL(req.url);
    try {
      const match = /^\/modules\/([^/]+)\/call\/([^/]+)$/.exec(url.pathname);
      if (req.method === "POST" && match) {
        const [, moduleId, exportName] = match;
        const exports = loaded.get(decodeURIComponent(moduleId));
        if (!exports) return json({ error: "unknown shared module" }, 404);
        const fn = exports[decodeURIComponent(exportName)];
        if (typeof fn !== "function") {
          return json({ error: "unknown shared export" }, 404);
        }
        const body = await readJson(req);
        const args = Array.isArray(body.args) ? body.args : [];
        return json({ value: await fn(...args) });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return json({ error: message }, 500);
    }
  });

  const addr = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    token,
    async stop() {
      await server.shutdown();
    },
  };
}
