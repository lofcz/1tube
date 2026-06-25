/**
 * Per-function env-var scoping.
 *
 * When `1TUBE_ENFORCE_MANIFEST=1`, `installEnvScope()` replaces `Deno.env` with
 * a wrapper that filters reads (`get`, `has`, `toObject`) against the active
 * function's manifest `permissions.env` allowlist, using AsyncLocalStorage to
 * know which function is currently executing. Outside any function context
 * (e.g. server bootstrap, gateway middleware) all env access passes through
 * unchanged so the gateway itself never gets sandboxed.
 *
 * Writes (`set`, `delete`) are always rejected from inside a function context
 * — functions should not be able to mutate process env on each other.
 *
 * `1TUBE_ALLOW_ALL=1` short-circuits the scope and is the documented escape
 * hatch for legacy functions whose env usage hasn't been audited yet.
 *
 * This is opt-in, monitored on bootstrap, and idempotent.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface EnvScopeContext {
  functionName: string;
  /** Allowlisted env var names (manifest.permissions.env). */
  allow: ReadonlySet<string>;
}

export const envScopeStorage = new AsyncLocalStorage<EnvScopeContext>();

let _installed = false;

/**
 * Replace Deno.env with a filtering wrapper. Safe to call multiple times;
 * only the first call has an effect.
 */
export function installEnvScope(): void {
  if (_installed) return;
  _installed = true;

  const original = Deno.env;
  const allowAll = (Deno.env.get("1TUBE_ALLOW_ALL") ?? "") === "1";

  const wrap: typeof Deno.env = {
    get(key: string) {
      const ctx = envScopeStorage.getStore();
      if (!ctx || allowAll) return original.get(key);
      if (ctx.allow.has(key)) return original.get(key);
      return undefined;
    },
    has(key: string) {
      const ctx = envScopeStorage.getStore();
      if (!ctx || allowAll) return original.has(key);
      if (!ctx.allow.has(key)) return false;
      return original.has(key);
    },
    set(key: string, value: string) {
      const ctx = envScopeStorage.getStore();
      if (ctx && !allowAll) {
        throw new Deno.errors.PermissionDenied(
          `Function "${ctx.functionName}" attempted Deno.env.set(${
            JSON.stringify(key)
          }); ` +
            `env writes are not permitted from function code.`,
        );
      }
      original.set(key, value);
    },
    delete(key: string) {
      const ctx = envScopeStorage.getStore();
      if (ctx && !allowAll) {
        throw new Deno.errors.PermissionDenied(
          `Function "${ctx.functionName}" attempted Deno.env.delete(${
            JSON.stringify(key)
          }); ` +
            `env writes are not permitted from function code.`,
        );
      }
      original.delete(key);
    },
    toObject() {
      const ctx = envScopeStorage.getStore();
      if (!ctx || allowAll) return original.toObject();
      const all = original.toObject();
      const filtered: Record<string, string> = {};
      for (const k of ctx.allow) {
        if (k in all) filtered[k] = all[k];
      }
      return filtered;
    },
  };

  try {
    Object.defineProperty(Deno, "env", {
      value: wrap,
      writable: false,
      configurable: true,
    });
  } catch {
    // Deno.env property is locked down on this runtime — patch the methods on
    // the existing object instead. This still gives us the same scoping
    // behaviour because the wrapper closes over `original`.
    (original as { get: typeof wrap.get }).get = wrap.get;
    (original as { has: typeof wrap.has }).has = wrap.has;
    (original as { set: typeof wrap.set }).set = wrap.set;
    (original as { delete: typeof wrap.delete }).delete = wrap.delete;
    (original as { toObject: typeof wrap.toObject }).toObject = wrap.toObject;
  }
}

/**
 * Run `fn` with the env-scope context bound to `name` + `allow`. Any nested
 * `Deno.env.*` call sees only the allowlisted variables.
 */
export function runWithEnvScope<T>(
  ctx: EnvScopeContext,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  return envScopeStorage.run(ctx, fn);
}

/** Test-only: allow re-installation in unit tests. */
export function _resetEnvScopeForTests(): void {
  _installed = false;
}
