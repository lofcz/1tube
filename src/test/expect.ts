/**
 * Runtime-agnostic `expect`, mock functions and spies for `1tube/test`.
 *
 * Pure TypeScript with no runtime imports — the same semantics under every
 * runner. Matchers follow the jest conventions Bun's `bun:test` also uses
 * (`toEqual` ignores `undefined` properties and object types,
 * `toStrictEqual` does not, `toMatchObject` matches subsets, asymmetric
 * matchers like `expect.objectContaining` nest anywhere), so tests written
 * against `bun:test` port by changing the import line.
 */

import { AssertionError, format, formatDiff } from "./assert.ts";

// ---------------------------------------------------------------------------
// Asymmetric matchers
// ---------------------------------------------------------------------------

const ASYMMETRIC = Symbol.for("1tube.test.asymmetricMatcher");

export interface AsymmetricMatcher {
  readonly [ASYMMETRIC]: true;
  asymmetricMatch(other: unknown): boolean;
  toString(): string;
}

function asymmetric(describe: string, match: (other: unknown) => boolean): AsymmetricMatcher {
  return { [ASYMMETRIC]: true, asymmetricMatch: match, toString: () => describe };
}

function isAsymmetric(v: unknown): v is AsymmetricMatcher {
  return typeof v === "object" && v !== null && (v as Record<symbol, unknown>)[ASYMMETRIC] === true;
}

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

const tag = (v: unknown) => Object.prototype.toString.call(v);

function ownKeys(o: object, strict: boolean): (string | symbol)[] {
  const keys: (string | symbol)[] = [
    ...Object.keys(o),
    ...Object.getOwnPropertySymbols(o).filter((s) => Object.prototype.propertyIsEnumerable.call(o, s)),
  ];
  // Loose equality treats `{ a: undefined }` like `{}`.
  return strict ? keys : keys.filter((k) => (o as Record<string | symbol, unknown>)[k] !== undefined);
}

/**
 * jest-style deep equality. `strict` (toStrictEqual) additionally checks
 * constructors, `undefined`-valued keys and array holes.
 */
export function deepEquals(a: unknown, b: unknown, strict = false): boolean {
  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  const eq = (x: unknown, y: unknown): boolean => {
    if (isAsymmetric(x)) return x.asymmetricMatch(y);
    if (isAsymmetric(y)) return y.asymmetricMatch(x);
    if (Object.is(x, y)) return true;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) return false;
    const t = tag(x);
    if (t !== tag(y)) return false;
    if (strict && Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) return false;

    // Cycles: a pair already being compared is assumed equal.
    const i = seenA.indexOf(x);
    if (i !== -1 && seenB[i] === y) return true;
    seenA.push(x);
    seenB.push(y);
    try {
      if (x instanceof Date) return Object.is(x.getTime(), (y as Date).getTime());
      if (x instanceof RegExp) return x.source === (y as RegExp).source && x.flags === (y as RegExp).flags;
      if (typeof URL !== "undefined" && x instanceof URL) return x.href === (y as URL).href;
      if (x instanceof Number || x instanceof String || x instanceof Boolean) {
        return Object.is(x.valueOf(), (y as typeof x).valueOf());
      }
      if (x instanceof Error) {
        const ye = y as Error;
        if (x.name !== ye.name || x.message !== ye.message) return false;
      }
      if (x instanceof ArrayBuffer) return eq(new Uint8Array(x), new Uint8Array(y as ArrayBuffer));
      if (ArrayBuffer.isView(x) && !(x instanceof DataView)) {
        const xa = x as unknown as ArrayLike<unknown>;
        const ya = y as unknown as ArrayLike<unknown>;
        if (xa.length !== ya.length) return false;
        for (let k = 0; k < xa.length; k++) if (!Object.is(xa[k], ya[k])) return false;
        return true;
      }
      if (x instanceof Map) {
        const ym = y as Map<unknown, unknown>;
        if (x.size !== ym.size) return false;
        outer: for (const [k, v] of x) {
          if (ym.has(k)) {
            if (!eq(v, ym.get(k))) return false;
            continue;
          }
          for (const [k2, v2] of ym) if (eq(k, k2) && eq(v, v2)) continue outer;
          return false;
        }
        return true;
      }
      if (x instanceof Set) {
        const ys = y as Set<unknown>;
        if (x.size !== ys.size) return false;
        outer: for (const v of x) {
          if (ys.has(v)) continue;
          for (const v2 of ys) if (eq(v, v2)) continue outer;
          return false;
        }
        return true;
      }
      if (Array.isArray(x)) {
        const ya = y as unknown[];
        if (x.length !== ya.length) return false;
        for (let k = 0; k < x.length; k++) {
          if (strict && (k in x) !== (k in ya)) return false;
          if (!eq(x[k], ya[k])) return false;
        }
        // Extra non-index properties on arrays still count.
      }
      const xk = ownKeys(x, strict).filter((k) => !(Array.isArray(x) && typeof k === "string" && /^\d+$/.test(k)));
      const yk = ownKeys(y, strict).filter((k) => !(Array.isArray(y) && typeof k === "string" && /^\d+$/.test(k)));
      if (xk.length !== yk.length) return false;
      const rec = (o: object, k: string | symbol) => (o as Record<string | symbol, unknown>)[k];
      for (const k of xk) {
        if (strict && !Object.prototype.hasOwnProperty.call(y, k)) return false;
        if (!eq(rec(x, k), rec(y, k))) return false;
      }
      return true;
    } finally {
      seenA.pop();
      seenB.pop();
    }
  };
  return eq(a, b);
}

/** `actual` contains `expected` recursively (toMatchObject semantics). */
function subsetEquals(actual: unknown, expected: unknown): boolean {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length &&
      expected.every((e, i) => subsetEquals(actual[i], e));
  }
  if (
    typeof expected === "object" && expected !== null && tag(expected) === "[object Object]"
  ) {
    if (typeof actual !== "object" || actual === null) return false;
    return ownKeys(expected, true).every((k) =>
      k in actual &&
      subsetEquals((actual as Record<string | symbol, unknown>)[k], (expected as Record<string | symbol, unknown>)[k])
    );
  }
  return deepEquals(actual, expected);
}

// ---------------------------------------------------------------------------
// Mock functions
// ---------------------------------------------------------------------------

// `any` is unavoidable for generic function shapes.
type AnyFn = (...args: any[]) => any;

export type MockResult<T> =
  | { type: "return"; value: T }
  | { type: "throw"; value: unknown }
  | { type: "incomplete"; value: undefined };

export interface MockState<T extends AnyFn> {
  calls: Parameters<T>[];
  results: MockResult<ReturnType<T>>[];
  instances: unknown[];
  lastCall: Parameters<T> | undefined;
}

export type Mock<T extends AnyFn = AnyFn> = T & {
  readonly mock: MockState<T>;
  mockImplementation(fn: T): Mock<T>;
  mockImplementationOnce(fn: T): Mock<T>;
  mockReturnValue(value: ReturnType<T>): Mock<T>;
  mockReturnValueOnce(value: ReturnType<T>): Mock<T>;
  mockResolvedValue(value: Awaited<ReturnType<T>>): Mock<T>;
  mockResolvedValueOnce(value: Awaited<ReturnType<T>>): Mock<T>;
  mockRejectedValue(value: unknown): Mock<T>;
  mockRejectedValueOnce(value: unknown): Mock<T>;
  mockName(name: string): Mock<T>;
  getMockName(): string;
  /** Forget recorded calls and results. */
  mockClear(): Mock<T>;
  /** mockClear() plus drop implementations. */
  mockReset(): Mock<T>;
  /** For spies: put the original method back. */
  mockRestore(): void;
};

const MOCK = Symbol.for("1tube.test.mock");
const spies = new Set<Mock>();

/** Create a mock function, optionally wrapping an implementation. */
export function createMock<T extends AnyFn = AnyFn>(impl?: T, restore?: () => void): Mock<T> {
  let defaultImpl: AnyFn | undefined = impl;
  const once: AnyFn[] = [];
  let name = impl?.name || "mock";
  const state: MockState<T> = { calls: [], results: [], instances: [], lastCall: undefined };

  const fn = function (this: unknown, ...args: Parameters<T>) {
    state.calls.push(args);
    state.lastCall = args;
    state.instances.push(this);
    const result: MockResult<ReturnType<T>> = { type: "incomplete", value: undefined };
    state.results.push(result);
    const current = once.shift() ?? defaultImpl;
    try {
      const value = current ? (new.target ? Reflect.construct(current, args, new.target) : current.apply(this, args)) : undefined;
      Object.assign(result, { type: "return", value });
      return value;
    } catch (err) {
      Object.assign(result, { type: "throw", value: err });
      throw err;
    }
  } as unknown as Mock<T>;

  const self = fn as unknown as Record<string, unknown>;
  Object.defineProperty(fn, "mock", { value: state, enumerable: false });
  Object.defineProperty(fn, MOCK, { value: true });
  Object.assign(self, {
    mockImplementation: (f: T) => ((defaultImpl = f), fn),
    mockImplementationOnce: (f: T) => (once.push(f), fn),
    mockReturnValue: (v: unknown) => ((defaultImpl = () => v), fn),
    mockReturnValueOnce: (v: unknown) => (once.push(() => v), fn),
    mockResolvedValue: (v: unknown) => ((defaultImpl = () => Promise.resolve(v)), fn),
    mockResolvedValueOnce: (v: unknown) => (once.push(() => Promise.resolve(v)), fn),
    mockRejectedValue: (v: unknown) => ((defaultImpl = () => Promise.reject(v)), fn),
    mockRejectedValueOnce: (v: unknown) => (once.push(() => Promise.reject(v)), fn),
    mockName: (n: string) => ((name = n), fn),
    getMockName: () => name,
    mockClear: () => {
      state.calls.length = 0;
      state.results.length = 0;
      state.instances.length = 0;
      state.lastCall = undefined;
      return fn;
    },
    mockReset: () => {
      (self.mockClear as () => void)();
      defaultImpl = undefined;
      once.length = 0;
      return fn;
    },
    mockRestore: () => {
      (self.mockReset as () => void)();
      restore?.();
      spies.delete(fn as unknown as Mock);
    },
  });
  return fn;
}

export function isMock(v: unknown): v is Mock {
  return typeof v === "function" && (v as unknown as Record<symbol, unknown>)[MOCK] === true;
}

/** Replace `obj[key]` with a mock that calls through to the original. */
export function spyOn<O extends object, K extends keyof O>(
  obj: O,
  key: K,
): O[K] extends AnyFn ? Mock<O[K]> : never {
  const original = obj[key];
  if (typeof original !== "function") throw new TypeError(`spyOn: ${String(key)} is not a function`);
  const hadOwn = Object.prototype.hasOwnProperty.call(obj, key);
  const spy = createMock(original as AnyFn, () => {
    if (hadOwn) obj[key] = original;
    else delete obj[key];
  });
  obj[key] = spy as O[K];
  spies.add(spy);
  return spy as never;
}

/** Restore every active spy (`mock.restore()`). */
export function restoreAllMocks(): void {
  for (const spy of [...spies]) spy.mockRestore();
}

// ---------------------------------------------------------------------------
// expect
// ---------------------------------------------------------------------------

export interface Matchers<R> {
  not: Matchers<R>;
  toBe(expected: unknown): R;
  toEqual(expected: unknown): R;
  toStrictEqual(expected: unknown): R;
  toMatchObject(expected: object): R;
  toBeNull(): R;
  toBeUndefined(): R;
  toBeDefined(): R;
  toBeTruthy(): R;
  toBeFalsy(): R;
  toBeNaN(): R;
  toBeTypeOf(type: "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function"): R;
  toBeInstanceOf(ctor: abstract new (...args: never[]) => unknown): R;
  toBeGreaterThan(n: number | bigint): R;
  toBeGreaterThanOrEqual(n: number | bigint): R;
  toBeLessThan(n: number | bigint): R;
  toBeLessThanOrEqual(n: number | bigint): R;
  toBeCloseTo(n: number, numDigits?: number): R;
  toBeOneOf(values: readonly unknown[]): R;
  toContain(item: unknown): R;
  toContainEqual(item: unknown): R;
  toInclude(substring: string): R;
  toStartWith(prefix: string): R;
  toEndWith(suffix: string): R;
  toMatch(pattern: string | RegExp): R;
  toHaveLength(n: number): R;
  toHaveProperty(path: string | readonly (string | number)[], value?: unknown): R;
  toBeEmpty(): R;
  toThrow(expected?: string | RegExp | Error | (abstract new (...args: never[]) => unknown) | AsymmetricMatcher): R;
  toThrowError(expected?: string | RegExp | Error | (abstract new (...args: never[]) => unknown) | AsymmetricMatcher): R;
  toHaveBeenCalled(): R;
  toHaveBeenCalledTimes(n: number): R;
  toHaveBeenCalledWith(...args: unknown[]): R;
  toHaveBeenLastCalledWith(...args: unknown[]): R;
  toHaveBeenNthCalledWith(n: number, ...args: unknown[]): R;
  toHaveReturned(): R;
  toHaveReturnedTimes(n: number): R;
  toHaveReturnedWith(value: unknown): R;
}

export interface Assertion extends Matchers<void> {
  /** Await the promise, then match its value. */
  resolves: Matchers<Promise<void>>;
  /** Await the promise, then match its rejection reason. */
  rejects: Matchers<Promise<void>>;
}

export interface Expect {
  (actual: unknown, message?: string): Assertion;
  anything(): AsymmetricMatcher;
  any(ctor: unknown): AsymmetricMatcher;
  objectContaining(obj: object): AsymmetricMatcher;
  arrayContaining(items: readonly unknown[]): AsymmetricMatcher;
  stringContaining(s: string): AsymmetricMatcher;
  stringMatching(p: string | RegExp): AsymmetricMatcher;
  closeTo(n: number, numDigits?: number): AsymmetricMatcher;
  not: {
    objectContaining(obj: object): AsymmetricMatcher;
    arrayContaining(items: readonly unknown[]): AsymmetricMatcher;
    stringContaining(s: string): AsymmetricMatcher;
    stringMatching(p: string | RegExp): AsymmetricMatcher;
  };
}

interface Outcome {
  pass: boolean;
  /** Message for the failing direction (receives whether `.not` was used). */
  message: (negated: boolean) => string;
}

const show = (v: unknown) => (isAsymmetric(v) ? v.toString() : format(v));

const closeTo = (actual: number, expected: number, digits: number) =>
  (actual === Infinity && expected === Infinity) || (actual === -Infinity && expected === -Infinity) ||
  Math.abs(expected - actual) < 10 ** -digits / 2;

function getPath(obj: unknown, path: string | readonly (string | number)[]): { found: boolean; value: unknown } {
  const parts = typeof path === "string"
    ? path.replace(/\[(\d+)\]/g, ".$1").split(".").filter((p) => p !== "")
    : [...path];
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    const box = Object(cur) as Record<string | number, unknown>;
    if (!(p in box)) return { found: false, value: undefined };
    cur = box[p];
  }
  return { found: true, value: cur };
}

function throwMatches(err: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof expected === "string") return message.includes(expected);
  if (expected instanceof RegExp) return expected.test(message);
  if (isAsymmetric(expected)) return expected.asymmetricMatch(err);
  if (expected instanceof Error) return message === expected.message;
  if (typeof expected === "function") return err instanceof (expected as new () => unknown);
  return false;
}

function requireMock(v: unknown, matcher: string): Mock {
  if (!isMock(v)) throw new AssertionError(`${matcher}: received value must be a mock function (from mock() or spyOn())`);
  return v;
}

const lengthOf = (v: unknown): number | undefined =>
  v !== null && v !== undefined && typeof (v as { length?: unknown }).length === "number"
    ? (v as { length: number }).length
    : undefined;

/** Evaluate one matcher against `actual`. `thrown` carries `.rejects`. */
function evaluate(name: string, actual: unknown, args: unknown[]): Outcome {
  const [expected] = args;
  const recv = `Received: ${show(actual)}`;
  const simple = (pass: boolean, what: string): Outcome => ({
    pass,
    message: (neg) => `expect(received).${neg ? "not." : ""}${name}(${args.map(show).join(", ")})\n\n${what ? `${what}\n` : ""}${recv}`,
  });
  switch (name) {
    case "toBe": {
      const pass = Object.is(actual, expected);
      return {
        pass,
        message: (neg) =>
          neg
            ? `expect(received).not.toBe(expected)\n\nExpected: not ${show(expected)}`
            : deepEquals(actual, expected, true)
            ? `expect(received).toBe(expected)\n\nValues have the same structure but are not the same reference\n\nReceived: ${show(actual)}`
            : `expect(received).toBe(expected)\n\nExpected: ${show(expected)}\n${recv}`,
      };
    }
    case "toEqual":
    case "toStrictEqual": {
      const pass = deepEquals(actual, expected, name === "toStrictEqual");
      return {
        pass,
        message: (neg) =>
          neg
            ? `expect(received).not.${name}(expected)\n\nExpected: not ${show(expected)}`
            : `expect(received).${name}(expected)\n\n- Received\n+ Expected\n\n${formatDiff(actual, expected)}`,
      };
    }
    case "toMatchObject": {
      const pass = typeof actual === "object" && actual !== null && subsetEquals(actual, expected);
      return {
        pass,
        message: (neg) =>
          neg
            ? `expect(received).not.toMatchObject(expected)\n\nExpected: not ${show(expected)}\n${recv}`
            : `expect(received).toMatchObject(expected)\n\n- Received\n+ Expected\n\n${formatDiff(actual, expected)}`,
      };
    }
    case "toBeNull":
      return simple(actual === null, "");
    case "toBeUndefined":
      return simple(actual === undefined, "");
    case "toBeDefined":
      return simple(actual !== undefined, "");
    case "toBeTruthy":
      return simple(!!actual, "");
    case "toBeFalsy":
      return simple(!actual, "");
    case "toBeNaN":
      return simple(typeof actual === "number" && Number.isNaN(actual), "");
    case "toBeTypeOf":
      return simple(typeof actual === expected, `Received type: ${typeof actual}`);
    case "toBeInstanceOf":
      return simple(
        typeof expected === "function" && actual instanceof (expected as new () => unknown),
        `Expected constructor: ${(expected as { name?: string })?.name ?? String(expected)}`,
      );
    case "toBeGreaterThan":
      return simple((actual as number) > (expected as number), "");
    case "toBeGreaterThanOrEqual":
      return simple((actual as number) >= (expected as number), "");
    case "toBeLessThan":
      return simple((actual as number) < (expected as number), "");
    case "toBeLessThanOrEqual":
      return simple((actual as number) <= (expected as number), "");
    case "toBeCloseTo": {
      const digits = (args[1] as number | undefined) ?? 2;
      return simple(
        typeof actual === "number" && closeTo(actual, expected as number, digits),
        `Expected precision: ${digits}\nExpected difference: < ${10 ** -digits / 2}\nReceived difference: ${
          Math.abs((expected as number) - (actual as number))
        }`,
      );
    }
    case "toBeOneOf":
      return simple((expected as unknown[]).some((v) => deepEquals(actual, v)), "");
    case "toContain": {
      let pass = false;
      if (typeof actual === "string") pass = actual.includes(String(expected));
      else if (actual && typeof (actual as Iterable<unknown>)[Symbol.iterator] === "function") {
        for (const item of actual as Iterable<unknown>) {
          if (item === expected || Object.is(item, expected)) {
            pass = true;
            break;
          }
        }
      }
      return simple(pass, "");
    }
    case "toContainEqual": {
      let pass = false;
      if (actual && typeof (actual as Iterable<unknown>)[Symbol.iterator] === "function") {
        for (const item of actual as Iterable<unknown>) {
          if (deepEquals(item, expected)) {
            pass = true;
            break;
          }
        }
      }
      return simple(pass, "");
    }
    case "toInclude":
      return simple(typeof actual === "string" && actual.includes(expected as string), "");
    case "toStartWith":
      return simple(typeof actual === "string" && actual.startsWith(expected as string), "");
    case "toEndWith":
      return simple(typeof actual === "string" && actual.endsWith(expected as string), "");
    case "toMatch":
      return simple(
        typeof actual === "string" &&
          (typeof expected === "string" ? actual.includes(expected) : ((expected as RegExp).lastIndex = 0, (expected as RegExp).test(actual))),
        "",
      );
    case "toHaveLength": {
      const len = lengthOf(actual);
      return simple(len === expected, `Received length: ${len}`);
    }
    case "toHaveProperty": {
      const { found, value } = getPath(actual, expected as string);
      const pass = found && (args.length < 2 || deepEquals(value, args[1]));
      return simple(pass, found ? `Received value: ${show(value)}` : "Property not found");
    }
    case "toBeEmpty": {
      let pass = false;
      if (typeof actual === "string" || Array.isArray(actual)) pass = actual.length === 0;
      else if (actual instanceof Map || actual instanceof Set) pass = actual.size === 0;
      else if (actual && typeof actual === "object") pass = Object.keys(actual).length === 0;
      return simple(pass, "");
    }
    case "toHaveBeenCalled": {
      const m = requireMock(actual, name);
      return simple(m.mock.calls.length > 0, `Number of calls: ${m.mock.calls.length}`);
    }
    case "toHaveBeenCalledTimes": {
      const m = requireMock(actual, name);
      return simple(m.mock.calls.length === expected, `Number of calls: ${m.mock.calls.length}`);
    }
    case "toHaveBeenCalledWith": {
      const m = requireMock(actual, name);
      return simple(
        m.mock.calls.some((c) => deepEquals(c, args)),
        `Calls:\n${m.mock.calls.map((c) => `  ${show(c)}`).join("\n") || "  (none)"}`,
      );
    }
    case "toHaveBeenLastCalledWith": {
      const m = requireMock(actual, name);
      return simple(m.mock.lastCall !== undefined && deepEquals(m.mock.lastCall, args), `Last call: ${show(m.mock.lastCall)}`);
    }
    case "toHaveBeenNthCalledWith": {
      const m = requireMock(actual, name);
      const call = m.mock.calls[(expected as number) - 1];
      return simple(call !== undefined && deepEquals(call, args.slice(1)), `Call ${expected}: ${show(call)}`);
    }
    case "toHaveReturned": {
      const m = requireMock(actual, name);
      return simple(m.mock.results.some((r) => r.type === "return"), "");
    }
    case "toHaveReturnedTimes": {
      const m = requireMock(actual, name);
      return simple(m.mock.results.filter((r) => r.type === "return").length === expected, "");
    }
    case "toHaveReturnedWith": {
      const m = requireMock(actual, name);
      return simple(m.mock.results.some((r) => r.type === "return" && deepEquals(r.value, expected)), "");
    }
  }
  throw new TypeError(`expect: unknown matcher ${name}`);
}

const MATCHERS = [
  "toBe", "toEqual", "toStrictEqual", "toMatchObject", "toBeNull", "toBeUndefined", "toBeDefined",
  "toBeTruthy", "toBeFalsy", "toBeNaN", "toBeTypeOf", "toBeInstanceOf", "toBeGreaterThan",
  "toBeGreaterThanOrEqual", "toBeLessThan", "toBeLessThanOrEqual", "toBeCloseTo", "toBeOneOf",
  "toContain", "toContainEqual", "toInclude", "toStartWith", "toEndWith", "toMatch", "toHaveLength",
  "toHaveProperty", "toBeEmpty", "toHaveBeenCalled", "toHaveBeenCalledTimes", "toHaveBeenCalledWith",
  "toHaveBeenLastCalledWith", "toHaveBeenNthCalledWith", "toHaveReturned", "toHaveReturnedTimes",
  "toHaveReturnedWith",
] as const;

function fail(outcome: Outcome, negated: boolean, message: string | undefined): never {
  const text = outcome.message(negated);
  throw new AssertionError(message ? `${message}\n\n${text}` : text);
}

/** Matchers for a synchronous value, or (mode) for a promise's settlement. */
function matchers(actual: unknown, negated: boolean, mode: "sync" | "resolves" | "rejects", message?: string): Matchers<unknown> {
  const out: Record<string, unknown> = {};
  const check = (name: string, value: unknown, args: unknown[]) => {
    const outcome = evaluate(name, value, args);
    if (outcome.pass === negated) fail(outcome, negated, message);
  };
  const names: readonly string[] = mode === "sync" ? MATCHERS : [...MATCHERS, "toThrow", "toThrowError"];
  for (const name of names) {
    out[name] = (...args: unknown[]) => {
      if (mode === "sync") return check(name, actual, args);
      return (async () => {
        let fulfilled: boolean;
        let value: unknown;
        try {
          value = await (typeof actual === "function" ? (actual as () => unknown)() : actual);
          fulfilled = true;
        } catch (err) {
          value = err;
          fulfilled = false;
        }
        if (mode === "rejects" && fulfilled) {
          throw new AssertionError(`expect(received).rejects.${name}()\n\nReceived promise resolved instead of rejected\nResolved to value: ${show(value)}`);
        }
        if (mode === "resolves" && !fulfilled) {
          throw new AssertionError(`expect(received).resolves.${name}()\n\nReceived promise rejected instead of resolved\nRejected to value: ${show(value)}`);
        }
        // `.rejects.toThrow(x)` matches the reason itself.
        if (mode === "rejects" && (name === "toThrow" || name === "toThrowError")) {
          const pass = throwMatches(value, args[0]);
          if (pass === negated) {
            fail({ pass, message: (neg) => `expect(received).rejects.${neg ? "not." : ""}${name}(${args.map(show).join(", ")})\n\nReceived: ${show(value)}` }, negated, message);
          }
          return;
        }
        if (name === "toThrow" || name === "toThrowError") {
          throw new AssertionError(`expect(received).resolves.${name}() is not supported; use .rejects.${name}()`);
        }
        check(name, value, args);
      })();
    };
  }
  for (const name of ["toThrow", "toThrowError"] as const) {
    if (mode !== "sync") continue;
    out[name] = (expected?: unknown) => {
      if (typeof actual !== "function") throw new AssertionError(`expect(received).${name}()\n\nReceived value must be a function`);
      let threw = false;
      let error: unknown;
      try {
        (actual as () => unknown)();
      } catch (err) {
        threw = true;
        error = err;
      }
      const pass = threw && throwMatches(error, expected);
      if (pass === negated) {
        fail({
          pass,
          message: (neg) =>
            `expect(received).${neg ? "not." : ""}${name}(${expected === undefined ? "" : show(expected)})\n\n${
              threw ? `Thrown: ${show(error)}` : "Received function did not throw"
            }`,
        }, negated, message);
      }
    };
  }
  Object.defineProperty(out, "not", { get: () => matchers(actual, !negated, mode, message) });
  return out as unknown as Matchers<unknown>;
}

export const expect: Expect = Object.assign(
  (actual: unknown, message?: string): Assertion => {
    const base = matchers(actual, false, "sync", message) as unknown as Assertion;
    Object.defineProperty(base, "resolves", { get: () => matchers(actual, false, "resolves", message) });
    Object.defineProperty(base, "rejects", { get: () => matchers(actual, false, "rejects", message) });
    return base;
  },
  {
    anything: () => asymmetric("Anything", (o) => o !== null && o !== undefined),
    any: (ctor: unknown) =>
      asymmetric(`Any<${(ctor as { name?: string })?.name}>`, (o) => {
        if (ctor === String) return typeof o === "string" || o instanceof String;
        if (ctor === Number) return typeof o === "number" || o instanceof Number;
        if (ctor === Boolean) return typeof o === "boolean" || o instanceof Boolean;
        if (ctor === BigInt) return typeof o === "bigint";
        if (ctor === Symbol) return typeof o === "symbol";
        if (ctor === Function) return typeof o === "function";
        if (ctor === Object) return typeof o === "object" && o !== null;
        return typeof ctor === "function" && o instanceof (ctor as new () => unknown);
      }),
    objectContaining: (obj: object) => objectContaining(obj, false),
    arrayContaining: (items: readonly unknown[]) => arrayContaining(items, false),
    stringContaining: (s: string) => stringContaining(s, false),
    stringMatching: (p: string | RegExp) => stringMatching(p, false),
    closeTo: (n: number, digits = 2) =>
      asymmetric(`NumberCloseTo ${n} (${digits} digits)`, (o) => typeof o === "number" && closeTo(o, n, digits)),
    not: {
      objectContaining: (obj: object) => objectContaining(obj, true),
      arrayContaining: (items: readonly unknown[]) => arrayContaining(items, true),
      stringContaining: (s: string) => stringContaining(s, true),
      stringMatching: (p: string | RegExp) => stringMatching(p, true),
    },
  },
);

function objectContaining(obj: object, invert: boolean): AsymmetricMatcher {
  return asymmetric(`${invert ? "Not" : ""}ObjectContaining ${format(obj)}`, (o) => {
    const pass = typeof o === "object" && o !== null &&
      ownKeys(obj, true).every((k) =>
        k in o && deepEquals((o as Record<string | symbol, unknown>)[k], (obj as Record<string | symbol, unknown>)[k])
      );
    return pass !== invert;
  });
}

function arrayContaining(items: readonly unknown[], invert: boolean): AsymmetricMatcher {
  return asymmetric(`${invert ? "Not" : ""}ArrayContaining ${format(items)}`, (o) => {
    const pass = Array.isArray(o) && items.every((i) => o.some((x) => deepEquals(x, i)));
    return pass !== invert;
  });
}

function stringContaining(s: string, invert: boolean): AsymmetricMatcher {
  return asymmetric(`${invert ? "Not" : ""}StringContaining ${JSON.stringify(s)}`, (o) =>
    (typeof o === "string" && o.includes(s)) !== invert);
}

function stringMatching(p: string | RegExp, invert: boolean): AsymmetricMatcher {
  const re = typeof p === "string" ? new RegExp(p) : p;
  return asymmetric(`${invert ? "Not" : ""}StringMatching ${re}`, (o) =>
    (typeof o === "string" && ((re.lastIndex = 0), re.test(o))) !== invert);
}
