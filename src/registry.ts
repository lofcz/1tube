/**
 * Global function registry that captures handlers from edge function modules.
 *
 * When a function module calls `serve(handler, opts)` from `_shared/handler.ts`,
 * the shim checks for `globalThis.__edgeFunctionRegistry`. If present, the handler
 * is stored here instead of starting a Deno.serve() per function.
 */

export interface AuthContext {
  userId: string;
  email: string;
  payload: JWTPayload;
  rawToken: string;
}

export interface JWTPayload {
  sub: string;
  email: string;
  exp: number;
  iat: number;
  role: string;
  iss: string;
  aud: string;
}

export type AuthenticatedHandler = (
  req: Request,
  auth: AuthContext,
) => Response | Promise<Response>;

export type PublicHandler = (req: Request) => Response | Promise<Response>;

export interface RegisteredFunction {
  handler: AuthenticatedHandler | PublicHandler;
  isPublic: boolean;
  /** Per-function wall clock timeout in ms. Undefined = use gateway default. 
   *  Only compatible with 1tube edge functions runtime. Ignored by Supabase Edge Functions runtime.
  */
  timeoutMs?: number;
}

export class FunctionRegistry {
  private handlers = new Map<string, RegisteredFunction>();
  private _currentName = "";

  /** Set by the discovery loader before importing each function module. */
  setCurrentFunction(name: string): void {
    this._currentName = name;
  }

  /**
   * Called by the `serve()` shim in `_shared/handler.ts`.
   * Captures the handler instead of starting a server.
   */
  register(
    handler: AuthenticatedHandler | PublicHandler,
    opts: { public: boolean; timeoutMs?: number },
  ): void {
    if (!this._currentName) {
      throw new Error(
        "[1tube] registry.register() called without setCurrentFunction(). " +
        "This is a bug in the function loader.",
      );
    }
    this.handlers.set(this._currentName, {
      handler,
      isPublic: opts.public,
      timeoutMs: opts.timeoutMs,
    });
  }

  get(name: string): RegisteredFunction | undefined {
    return this.handlers.get(name);
  }

  clear(): void {
    this.handlers.clear();
    this._currentName = "";
  }

  list(): string[] {
    return [...this.handlers.keys()].sort();
  }

  get size(): number {
    return this.handlers.size;
  }
}
