/**
 * Minimal `serve()` shim used by every playground function.
 *
 * - When 1tube is hosting the process, `globalThis.__edgeFunctionRegistry`
 *   exists and the handler is captured into the registry instead of starting
 *   its own listener.
 * - When the file is executed directly (e.g. `deno run --allow-net hello/index.ts`)
 *   the shim falls back to `Deno.serve()` so the function still works
 *   standalone — same shape Supabase Edge Runtime expects.
 *
 * This is the "4-line shim" referenced in the README. Copy it verbatim into
 * your own project's `supabase/functions/_shared/handler.ts`.
 */

export interface AuthContext {
  userId: string;
  email: string;
  rawToken: string;
  payload: Record<string, unknown>;
}

export type PublicHandler = (req: Request) => Response | Promise<Response>;
export type AuthenticatedHandler = (
  req: Request,
  auth: AuthContext,
) => Response | Promise<Response>;

export interface ServeOptions {
  /** When true, the gateway skips JWT validation. Defaults to false. */
  public?: boolean;
  /** Per-function wall-clock timeout (ms). 1tube only; ignored by Supabase. */
  timeoutMs?: number;
}

interface OneTubeRegistry {
  register(
    handler: PublicHandler | AuthenticatedHandler,
    opts: { public: boolean; timeoutMs?: number },
  ): void;
}

export function serve(
  handler: PublicHandler | AuthenticatedHandler,
  opts: ServeOptions = {},
): void {
  const registry = (globalThis as { __edgeFunctionRegistry?: OneTubeRegistry })
    .__edgeFunctionRegistry;

  if (registry) {
    registry.register(handler, {
      public: opts.public ?? false,
      timeoutMs: opts.timeoutMs,
    });
    return;
  }

  // Standalone fallback — no JWT validation, auth context is faked as anon.
  Deno.serve((req) => {
    if (opts.public) {
      return (handler as PublicHandler)(req);
    }
    const fakeAuth: AuthContext = {
      userId: "anon",
      email: "anon@local",
      rawToken: "",
      payload: {},
    };
    return (handler as AuthenticatedHandler)(req, fakeAuth);
  });
}
