/**
 * Global function registry that captures handlers from edge function modules.
 *
 * When a function module calls `serve(handler, opts)` from `_shared/handler.ts`,
 * the shim checks for `globalThis.__edgeFunctionRegistry`. If present, the handler
 * is stored here instead of starting a Deno.serve() per function.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { defaultManifest, type FunctionManifest } from "./manifest.ts";

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
  /**
   * Per-function manifest (`1tube.json`). Always populated; defaults are used
   * when no manifest file exists on disk. The manifest's `timeoutMs` and
   * `rpm` override gateway defaults when present.
   */
  manifest: FunctionManifest;
}

/**
 * Async-context-scoped binding of "the function currently being imported".
 * Set by the discovery loader via `runWithCurrentFunction()` so that concurrent
 * dynamic imports each see the correct name when their top-level `serve()` call
 * fires `register()`. The async-context is the only supported path —
 * `register()` throws if no scope is active.
 */
const currentNameStorage = new AsyncLocalStorage<string>();

/**
 * Async-context-scoped current AuthContext for a dispatched request. Exposed
 * so per-function env Proxies can read manifest scoping based on the call
 * site without thread-locals.
 */
export const currentRequestStorage = new AsyncLocalStorage<{
  functionName: string;
}>();

/**
 * A function discovered on disk but whose module has not yet been
 * dynamically imported. Used to drive lazy load on first dispatch.
 */
export interface FunctionCandidate {
  name: string;
  /** Absolute or file-URL string passed to dynamic `import()`. */
  moduleUrl: string;
  manifest: FunctionManifest;
}

export class FunctionRegistry {
  private handlers = new Map<string, RegisteredFunction>();
  private pendingManifests = new Map<string, FunctionManifest>();
  private candidates = new Map<string, FunctionCandidate>();
  /**
   * Manifests for functions that exist outside the in-process registry —
   * specifically, workerd-backed functions whose handlers live in a
   * subprocess. The gateway never holds a JS handler for these, but
   * the rate-limiter / supervisor / fast-fail middleware all need to
   * see the same manifest the function uses, so we register it here.
   * Kept separate from `handlers` and `candidates` to avoid implying
   * a JS handler exists.
   */
  private externalManifests = new Map<string, FunctionManifest>();
  /** In-flight import dedupe: many concurrent first-requests await the same Promise. */
  private loading = new Map<string, Promise<RegisteredFunction | null>>();

  /**
   * Loader hook: stash a manifest for a function before its module is
   * imported. The manifest is consumed by `register()` so the registered
   * entry already carries it.
   */
  attachManifest(name: string, manifest: FunctionManifest): void {
    this.pendingManifests.set(name, manifest);
    const existing = this.handlers.get(name);
    if (existing) {
      existing.manifest = manifest;
    }
  }

  /**
   * Run `fn` with `name` bound as the "current function" for any synchronous or
   * asynchronous `register()` calls reached from within. Safe under parallel
   * imports.
   */
  runWithCurrentFunction<T>(name: string, fn: () => Promise<T> | T): Promise<T> | T {
    return currentNameStorage.run(name, fn);
  }

  /**
   * Called by the `serve()` shim in `_shared/handler.ts`.
   * Captures the handler instead of starting a server.
   */
  register(
    handler: AuthenticatedHandler | PublicHandler,
    opts: { public: boolean; timeoutMs?: number },
  ): void {
    const name = currentNameStorage.getStore();
    if (!name) {
      throw new Error(
        "[1tube] registry.register() called without an active function context. " +
        "This is a bug in the function loader — must be wrapped in runWithCurrentFunction().",
      );
    }
    const manifest = this.pendingManifests.get(name) ?? defaultManifest();
    this.handlers.set(name, {
      handler,
      isPublic: opts.public,
      timeoutMs: opts.timeoutMs ?? manifest.timeoutMs,
      manifest,
    });
  }

  get(name: string): RegisteredFunction | undefined {
    return this.handlers.get(name);
  }

  /**
   * True if a handler is loaded OR a candidate exists for `name`. Cheap; does
   * not trigger a dynamic import. Used by the gateway's fast-fail middleware
   * to 404 unknown function names before paying for auth/rate-limit.
   */
  has(name: string): boolean {
    return (
      this.handlers.has(name) ||
      this.candidates.has(name) ||
      this.externalManifests.has(name)
    );
  }

  /** Names visible to dispatch (loaded handlers + unloaded candidates). */
  knownNames(): string[] {
    const out = new Set<string>();
    for (const k of this.handlers.keys()) out.add(k);
    for (const k of this.candidates.keys()) out.add(k);
    for (const k of this.externalManifests.keys()) out.add(k);
    return [...out].sort();
  }

  /**
   * Register a manifest for a function whose handler lives outside the
   * in-process registry (workerd backend). The gateway will treat the
   * name as known for fast-fail / rate-limit purposes and consult this
   * manifest from `manifestFor()`. No `RegisteredFunction` is created
   * — `getOrLoad()` will still return undefined for these names so
   * dispatch logic that expects a JS handler keeps short-circuiting.
   */
  setExternalManifest(name: string, manifest: FunctionManifest): void {
    this.externalManifests.set(name, manifest);
  }

  /** Drop all external manifests. Used by the workerd backend on stop. */
  clearExternalManifests(): void {
    this.externalManifests.clear();
  }

  /**
   * Register a function found on disk but not yet imported. The discovery
   * loader uses this in lazy mode; the first dispatch then triggers
   * `getOrLoad()` which performs the dynamic import.
   */
  registerCandidate(candidate: FunctionCandidate): void {
    this.candidates.set(candidate.name, candidate);
    this.pendingManifests.set(candidate.name, candidate.manifest);
  }

  candidate(name: string): FunctionCandidate | undefined {
    return this.candidates.get(name);
  }

  /**
   * Read the manifest for a known function regardless of whether it has been
   * imported yet. Used by the rate-limiter to honour `manifest.rpm` for lazy
   * candidates BEFORE their first dispatch.
   */
  manifestFor(name: string): FunctionManifest | undefined {
    return (
      this.handlers.get(name)?.manifest ??
      this.candidates.get(name)?.manifest ??
      this.externalManifests.get(name)
    );
  }

  /**
   * Return the loaded handler if present, otherwise dynamically import the
   * candidate module (deduped across concurrent callers) and return the
   * resulting handler. Returns `undefined` when neither a handler nor a
   * candidate exists, and `null` when import fails.
   */
  async getOrLoad(name: string): Promise<RegisteredFunction | null | undefined> {
    const fn = this.handlers.get(name);
    if (fn) return fn;
    const cand = this.candidates.get(name);
    if (!cand) return undefined;

    let pending = this.loading.get(name);
    if (!pending) {
      pending = (async () => {
        this.attachManifest(name, cand.manifest);
        try {
          await this.runWithCurrentFunction(name, async () => {
            await import(cand.moduleUrl);
          });
        } catch (err) {
          // On failure, drop the candidate so subsequent calls 404 (or the
          // operator can re-add via reload). Surface the error to the caller.
          this.candidates.delete(name);
          throw err;
        }
        return this.handlers.get(name) ?? null;
      })();
      this.loading.set(name, pending);
    }
    try {
      return await pending;
    } finally {
      this.loading.delete(name);
      // Once loaded, the candidate has fulfilled its purpose. Keep it around
      // anyway so reloaders can re-import without re-running discovery.
    }
  }

  delete(name: string): boolean {
    this.pendingManifests.delete(name);
    this.candidates.delete(name);
    this.loading.delete(name);
    return this.handlers.delete(name);
  }

  clear(): void {
    this.handlers.clear();
    this.pendingManifests.clear();
    this.candidates.clear();
    this.loading.clear();
  }

  list(): string[] {
    return [...this.handlers.keys()].sort();
  }

  get size(): number {
    return this.handlers.size;
  }

  /** Number of candidates not yet imported (cheap to compute on small sets). */
  get pendingCount(): number {
    let n = 0;
    for (const k of this.candidates.keys()) if (!this.handlers.has(k)) n++;
    return n;
  }
}
