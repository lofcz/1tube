/**
 * Per-function global scope for `Bun.ModuleGraph`.
 *
 * `ModuleGraph`'s `globals` option rebinds bare identifiers (`Deno`,
 * `console`, …) for code inside the graph, but `globalThis` itself is still
 * the host's. Edge-function code reaches for both spellings —
 * `globalThis.__edgeFunctionRegistry`, `globalThis.Deno?.env` — so each
 * function also gets a `globalThis` proxy that layers its overrides (and any
 * properties it assigns) over the real global object. Writes land in the
 * function's layer, so one function's `globalThis.cache = …` never leaks
 * into another function or the gateway.
 */

import type { DenoEnv } from "./deno-shim.ts";

/**
 * Wrap `overrides` around the real global object. Reads prefer the
 * function's layer; writes and deletes stay in it.
 */
export function createGlobalProxy(overrides: Record<string, unknown>): typeof globalThis {
  const host = globalThis;
  const own = new Map<string | symbol, unknown>(Object.entries(overrides));
  const deleted = new Set<string | symbol>();
  // Proxy invariants are checked against the target, so the target can't be
  // the real global object: a function's non-configurable define would have
  // to land there. A per-function shadow holds exactly what the invariants
  // need to see — non-configurable properties, defined by the function or
  // mirrored from the host (`undefined`, `NaN`, `Bun`, …) — and nothing else.
  const shadow = Object.create(Object.getPrototypeOf(host)) as object;
  const pinned = (key: string | symbol) => Object.hasOwn(shadow, key);
  const proxy: typeof globalThis = new Proxy(shadow as typeof globalThis, {
    get(_target, key) {
      if (pinned(key)) return Reflect.get(shadow, key, proxy);
      if (key === "globalThis" || key === "self") return proxy;
      if (own.has(key)) return own.get(key);
      if (deleted.has(key)) return undefined;
      return Reflect.get(host, key);
    },
    set(_target, key, value) {
      if (pinned(key)) return Reflect.set(shadow, key, value);
      own.set(key, value);
      deleted.delete(key);
      return true;
    },
    defineProperty(_target, key, desc) {
      if (desc.configurable === false || pinned(key)) {
        if (!Reflect.defineProperty(shadow, key, desc)) return false;
        own.delete(key);
      } else {
        own.set(key, "value" in desc ? desc.value : desc.get?.call(proxy));
      }
      deleted.delete(key);
      return true;
    },
    deleteProperty(_target, key) {
      if (pinned(key)) return false;
      own.delete(key);
      deleted.add(key);
      return true;
    },
    has(_target, key) {
      if (pinned(key) || own.has(key)) return true;
      if (deleted.has(key)) return false;
      return Reflect.has(host, key);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (pinned(key)) return Reflect.getOwnPropertyDescriptor(shadow, key);
      if (own.has(key)) {
        return { value: own.get(key), writable: true, enumerable: true, configurable: true };
      }
      if (deleted.has(key)) return undefined;
      const d = Reflect.getOwnPropertyDescriptor(host, key);
      // A non-configurable host property may only be reported if the target
      // has it too; mirror it into the shadow first.
      if (d && !d.configurable) Reflect.defineProperty(shadow, key, d);
      return d;
    },
    ownKeys() {
      const keys = new Set<string | symbol>(Reflect.ownKeys(host));
      for (const k of deleted) keys.delete(k);
      for (const k of own.keys()) keys.add(k);
      for (const k of Reflect.ownKeys(shadow)) keys.add(k);
      return [...keys];
    },
  });
  return proxy;
}

/** `process.env` view filtered by a manifest allowlist. */
export function createScopedEnvObject(
  allow: ReadonlySet<string>,
): Record<string, string | undefined> {
  return new Proxy({} as Record<string, string | undefined>, {
    get: (_t, k) => (typeof k === "string" && allow.has(k) ? process.env[k] : undefined),
    has: (_t, k) => typeof k === "string" && allow.has(k) && k in process.env,
    set: () => false,
    deleteProperty: () => false,
    ownKeys: () => [...allow].filter((k) => k in process.env),
    getOwnPropertyDescriptor: (_t, k) =>
      typeof k === "string" && allow.has(k) && k in process.env
        ? { value: process.env[k], writable: false, enumerable: true, configurable: true }
        : undefined,
  });
}

/**
 * `process` for a function whose env is scoped. Everything but `env`
 * forwards to the real process (methods bound so native receivers work).
 */
export function createScopedProcess(
  env: Record<string, string | undefined>,
): NodeJS.Process {
  return new Proxy(process, {
    get(target, key) {
      if (key === "env") return env;
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/**
 * `Deno.env` backed by `process.env`. With an allowlist, reads outside it
 * come back empty and writes throw — functions must not mutate env for
 * each other. Without one it is a plain passthrough.
 */
export function createDenoEnv(
  functionName: string,
  allow: ReadonlySet<string> | null,
  PermissionDenied: new (msg: string) => Error,
): DenoEnv {
  const readable = (k: string) => allow === null || allow.has(k);
  const deny = (op: string, key: string): never => {
    throw new PermissionDenied(
      `Function "${functionName}" attempted Deno.env.${op}(${JSON.stringify(key)}); ` +
        `env writes are not permitted from function code.`,
    );
  };
  return {
    get: (k) => (readable(k) ? process.env[k] : undefined),
    has: (k) => readable(k) && k in process.env,
    set: (k, v) => {
      if (allow !== null) deny("set", k);
      process.env[k] = v;
    },
    delete: (k) => {
      if (allow !== null) deny("delete", k);
      delete process.env[k];
    },
    toObject: () => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && readable(k)) out[k] = v;
      }
      return out;
    },
  };
}
