/**
 * Runtime-agnostic assertions for `1tube/test`.
 *
 * Pure TypeScript with no runtime imports, so the same assertions run under
 * `bun test`, `node --test`, or a workerd test pool. The surface follows the
 * familiar `assertX(actual, expected, msg?)` shape (the one Supabase-style
 * edge function tests are written against), so test files only change their
 * import line when moving between runners.
 */

export class AssertionError extends Error {
  override name = "AssertionError";
  constructor(message: string) {
    super(message);
  }
}

type AnyConstructor = abstract new (...args: never[]) => unknown;
type ErrorClass<E extends Error = Error> = abstract new (...args: never[]) => E;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Readable, deterministic rendering of a value for failure messages. */
export function format(value: unknown): string {
  const seen = new WeakSet<object>();
  const indent = (s: string) => s.replace(/\n/g, "\n  ");
  const render = (v: unknown): string => {
    switch (typeof v) {
      case "string":
        return JSON.stringify(v);
      case "bigint":
        return `${v}n`;
      case "symbol":
      case "undefined":
      case "boolean":
        return String(v);
      case "number":
        return Object.is(v, -0) ? "-0" : String(v);
      case "function":
        return `[Function: ${(v as { name?: string }).name || "anonymous"}]`;
    }
    if (v === null) return "null";
    const obj = v as object;
    if (seen.has(obj)) return "[Circular]";
    if (obj instanceof Date) return `Date(${Number.isNaN(obj.getTime()) ? "Invalid" : obj.toISOString()})`;
    if (obj instanceof RegExp) return String(obj);
    if (obj instanceof Error) return `${obj.name}: ${obj.message}`;
    if (typeof URL !== "undefined" && obj instanceof URL) return `URL(${obj.href})`;
    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        if (obj.length === 0) return "[]";
        return `[\n  ${obj.map((x) => indent(render(x))).join(",\n  ")},\n]`;
      }
      if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        const items = Array.from(obj as unknown as ArrayLike<number | bigint>, (x) => render(x));
        return `${obj.constructor.name}(${items.length}) [${items.join(", ")}]`;
      }
      if (obj instanceof Map) {
        if (obj.size === 0) return "Map(0) {}";
        const rows = [...obj].map(([k, x]) => `${indent(render(k))} => ${indent(render(x))}`);
        return `Map(${obj.size}) {\n  ${rows.join(",\n  ")},\n}`;
      }
      if (obj instanceof Set) {
        if (obj.size === 0) return "Set(0) {}";
        return `Set(${obj.size}) {\n  ${[...obj].map((x) => indent(render(x))).join(",\n  ")},\n}`;
      }
      const keys: (string | symbol)[] = [
        ...Object.keys(obj),
        ...Object.getOwnPropertySymbols(obj).filter((s) =>
          Object.prototype.propertyIsEnumerable.call(obj, s)
        ),
      ];
      const proto = Object.getPrototypeOf(obj);
      const tag = proto === null
        ? "[Object: null prototype] "
        : proto !== Object.prototype && proto?.constructor?.name
        ? `${proto.constructor.name} `
        : "";
      if (keys.length === 0) return `${tag}{}`;
      const rows = keys.map((k) => {
        const name = typeof k === "symbol"
          ? `[${String(k)}]`
          : /^[A-Za-z_$][\w$]*$/.test(k)
          ? k
          : JSON.stringify(k);
        return `${name}: ${indent(render((obj as Record<string | symbol, unknown>)[k]))}`;
      });
      return `${tag}{\n  ${rows.join(",\n  ")},\n}`;
    } finally {
      seen.delete(obj);
    }
  };
  return render(value);
}

/** Line-level diff of two formatted values (`-` actual, `+` expected). */
function diff(actual: unknown, expected: unknown): string {
  const a = format(actual).split("\n");
  const b = format(expected).split("\n");
  // LCS over lines: values printed for assertion failures are small.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`    ${a[i]}`);
      i++;
      j++;
    } else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      out.push(`+   ${b[j++]}`);
    } else {
      out.push(`-   ${a[i++]}`);
    }
  }
  return out.join("\n");
}

const suffix = (msg?: string) => (msg ? `: ${msg}` : "");

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

/**
 * Deep structural equality: same constructor, same own enumerable keys
 * (strings and symbols), recursively equal values. `NaN` equals `NaN`;
 * `0` and `-0` differ. Maps and Sets compare by content, order-insensitive.
 */
export function equal(a: unknown, b: unknown): boolean {
  const seen = new Map<object, object>();
  const eq = (x: unknown, y: unknown): boolean => {
    if (Object.is(x, y)) return true;
    if (typeof x !== "object" || typeof y !== "object" || x === null || y === null) {
      return false;
    }
    if (seen.get(x) === y) return true;
    if (Object.getPrototypeOf(x) !== Object.getPrototypeOf(y)) return false;
    seen.set(x, y);

    if (x instanceof Date) return Object.is(x.getTime(), (y as Date).getTime());
    if (x instanceof RegExp) return String(x) === String(y);
    if (typeof URL !== "undefined" && x instanceof URL) return x.href === (y as URL).href;
    if (x instanceof WeakMap || x instanceof WeakSet || x instanceof WeakRef) {
      throw new TypeError("cannot compare WeakMap, WeakSet or WeakRef instances");
    }
    if (x instanceof Number || x instanceof String || x instanceof Boolean) {
      if (!Object.is(x.valueOf(), (y as typeof x).valueOf())) return false;
    }
    if (x instanceof ArrayBuffer) {
      return eq(new Uint8Array(x), new Uint8Array(y as ArrayBuffer));
    }
    if (x instanceof DataView) {
      return eq(
        new Uint8Array(x.buffer, x.byteOffset, x.byteLength),
        new Uint8Array((y as DataView).buffer, (y as DataView).byteOffset, (y as DataView).byteLength),
      );
    }
    if (ArrayBuffer.isView(x)) {
      const xa = x as unknown as ArrayLike<unknown>;
      const ya = y as unknown as ArrayLike<unknown>;
      if (xa.length !== ya.length) return false;
      for (let i = 0; i < xa.length; i++) if (!Object.is(xa[i], ya[i])) return false;
      return true;
    }
    if (x instanceof Map) {
      const ym = y as Map<unknown, unknown>;
      if (x.size !== ym.size) return false;
      const unmatched = [...ym];
      for (const [k, v] of x) {
        const idx = unmatched.findIndex(([k2, v2]) => eq(k, k2) && eq(v, v2));
        if (idx === -1) return false;
        unmatched.splice(idx, 1);
      }
      return true;
    }
    if (x instanceof Set) {
      const ys = y as Set<unknown>;
      if (x.size !== ys.size) return false;
      const unmatched = [...ys];
      for (const v of x) {
        const idx = unmatched.findIndex((v2) => eq(v, v2));
        if (idx === -1) return false;
        unmatched.splice(idx, 1);
      }
      return true;
    }
    if (x instanceof Error) {
      const ye = y as Error;
      if (x.name !== ye.name || x.message !== ye.message) return false;
    }

    const keysOf = (o: object) => [
      ...Object.keys(o),
      ...Object.getOwnPropertySymbols(o).filter((s) => Object.prototype.propertyIsEnumerable.call(o, s)),
    ];
    const xk = keysOf(x);
    const yk = keysOf(y);
    if (xk.length !== yk.length) return false;
    const rec = (o: object, k: string | symbol) => (o as Record<string | symbol, unknown>)[k];
    for (const k of xk) {
      if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
      if (!eq(rec(x, k), rec(y, k))) return false;
    }
    return true;
  };
  return eq(a, b);
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Assert that `expr` is truthy. */
export function assert(expr: unknown, msg = ""): asserts expr {
  if (!expr) throw new AssertionError(msg || "Expected value to be truthy");
}

/** Assert that `expr` is falsy. */
export function assertFalse(expr: unknown, msg = ""): void {
  if (expr) throw new AssertionError(msg || `Expected value to be falsy, got ${format(expr)}`);
}

/** Deep equality (see {@link equal}). */
export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  if (equal(actual, expected)) return;
  throw new AssertionError(
    `Values are not equal${suffix(msg)}\n\n    [Diff] Actual / Expected\n\n${diff(actual, expected)}\n`,
  );
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  if (!equal(actual, expected)) return;
  throw new AssertionError(`Expected actual: ${format(actual)} not to be: ${format(expected)}${suffix(msg)}`);
}

/** Identity (`Object.is`). */
export function assertStrictEquals<T>(actual: unknown, expected: T, msg?: string): asserts actual is T {
  if (Object.is(actual, expected)) return;
  const sameRendering = format(actual) === format(expected);
  throw new AssertionError(
    sameRendering
      ? `Values have the same structure but are not reference-equal${suffix(msg)}\n\n    ${format(actual).replace(/\n/g, "\n    ")}\n`
      : `Values are not strictly equal${suffix(msg)}\n\n    [Diff] Actual / Expected\n\n${diff(actual, expected)}\n`,
  );
}

export function assertNotStrictEquals<T>(actual: T, expected: T, msg?: string): void {
  if (!Object.is(actual, expected)) return;
  throw new AssertionError(`Expected "actual" to not be strictly equal to: ${format(expected)}${suffix(msg)}`);
}

/** |actual - expected| <= tolerance (default 1e-7). */
export function assertAlmostEquals(actual: number, expected: number, tolerance = 1e-7, msg?: string): void {
  if (Object.is(actual, expected)) return;
  const delta = Math.abs(expected - actual);
  if (delta <= tolerance) return;
  throw new AssertionError(
    `Expected actual: "${actual}" to be close to "${expected}": delta "${delta}" is greater than "${tolerance}"${suffix(msg)}`,
  );
}

/** Not `null` and not `undefined`. */
export function assertExists<T>(actual: T, msg?: string): asserts actual is NonNullable<T> {
  if (actual === undefined || actual === null) {
    throw new AssertionError(msg || `Expected actual: "${actual}" to not be null or undefined`);
  }
}

export function assertInstanceOf<T extends AnyConstructor>(
  actual: unknown,
  expectedType: T,
  msg?: string,
): asserts actual is InstanceType<T> {
  if (actual instanceof expectedType) return;
  const got = actual === null
    ? "null"
    : typeof actual === "object"
    ? (Object.getPrototypeOf(actual)?.constructor?.name ?? "Object")
    : typeof actual;
  throw new AssertionError(
    `Expected object to be an instance of "${expectedType.name}" but was "${got}"${suffix(msg)}`,
  );
}

export function assertNotInstanceOf<T extends AnyConstructor>(actual: unknown, unexpectedType: T, msg?: string): void {
  if (!(actual instanceof unexpectedType)) return;
  throw new AssertionError(`Expected object to not be an instance of "${unexpectedType.name}"${suffix(msg)}`);
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (typeof actual === "string" && actual.includes(expected)) return;
  throw new AssertionError(msg || `Expected actual: ${format(actual)} to contain: ${format(expected)}`);
}

export function assertMatch(actual: string, expected: RegExp, msg?: string): void {
  expected.lastIndex = 0;
  if (expected.test(actual)) return;
  throw new AssertionError(msg || `Expected actual: ${format(actual)} to match: ${expected}`);
}

export function assertNotMatch(actual: string, expected: RegExp, msg?: string): void {
  expected.lastIndex = 0;
  if (!expected.test(actual)) return;
  throw new AssertionError(msg || `Expected actual: ${format(actual)} to not match: ${expected}`);
}

/** Every element of `expected` is deep-equal to some element of `actual`. */
export function assertArrayIncludes<T>(actual: ArrayLike<T>, expected: ArrayLike<T>, msg?: string): void {
  const missing: T[] = [];
  for (const e of Array.from(expected)) {
    if (!Array.from(actual).some((a) => equal(a, e))) missing.push(e);
  }
  if (missing.length === 0) return;
  throw new AssertionError(
    msg || `Expected actual: ${format(actual)} to include: ${format(expected)}\nmissing: ${format(missing)}`,
  );
}

/** `actual` contains (recursively) every key/value of `expected`. */
export function assertObjectMatch(actual: Record<PropertyKey, unknown>, expected: Record<PropertyKey, unknown>, msg?: string): void {
  const pick = (a: unknown, e: unknown): unknown => {
    if (Array.isArray(e) && Array.isArray(a)) return a.map((x, i) => (i < e.length ? pick(x, e[i]) : x));
    if (e && typeof e === "object" && a && typeof a === "object" && !(e instanceof Date) && !(e instanceof RegExp)) {
      const out: Record<PropertyKey, unknown> = {};
      for (const k of Reflect.ownKeys(e)) {
        if (k in (a as object)) out[k] = pick((a as Record<PropertyKey, unknown>)[k], (e as Record<PropertyKey, unknown>)[k]);
      }
      return out;
    }
    return a;
  };
  assertEquals(pick(actual, expected), expected as unknown, msg);
}

export function assertGreater<T>(actual: T, expected: T, msg?: string): void {
  if (actual > expected) return;
  throw new AssertionError(msg || `Expect ${format(actual)} > ${format(expected)}`);
}

export function assertGreaterOrEqual<T>(actual: T, expected: T, msg?: string): void {
  if (actual >= expected) return;
  throw new AssertionError(msg || `Expect ${format(actual)} >= ${format(expected)}`);
}

export function assertLess<T>(actual: T, expected: T, msg?: string): void {
  if (actual < expected) return;
  throw new AssertionError(msg || `Expect ${format(actual)} < ${format(expected)}`);
}

export function assertLessOrEqual<T>(actual: T, expected: T, msg?: string): void {
  if (actual <= expected) return;
  throw new AssertionError(msg || `Expect ${format(actual)} <= ${format(expected)}`);
}

function checkError(
  err: unknown,
  ErrorClass: ErrorClass | undefined,
  msgIncludes: string | undefined,
  msg: string | undefined,
): void {
  if (!ErrorClass) return;
  if (!(err instanceof ErrorClass)) {
    throw new AssertionError(
      `Expected error to be instance of "${ErrorClass.name}", but was "${
        err instanceof Error ? err.constructor.name : typeof err
      }"${suffix(msg)}`,
    );
  }
  if (msgIncludes !== undefined && !String((err as Error).message).includes(msgIncludes)) {
    throw new AssertionError(
      `Expected error message to include ${format(msgIncludes)}, but got ${format((err as Error).message)}${suffix(msg)}`,
    );
  }
}

/** Assert `fn` throws; returns the thrown value. */
export function assertThrows(fn: () => unknown, msg?: string): unknown;
export function assertThrows<E extends Error = Error>(
  fn: () => unknown,
  ErrorClass: ErrorClass<E>,
  msgIncludes?: string,
  msg?: string,
): E;
export function assertThrows(
  fn: () => unknown,
  classOrMsg?: ErrorClass | string,
  msgIncludes?: string,
  msg?: string,
): unknown {
  const ErrorClass = typeof classOrMsg === "function" ? classOrMsg : undefined;
  if (typeof classOrMsg === "string") msg = classOrMsg;
  let thrown = false;
  let error: unknown;
  try {
    fn();
  } catch (err) {
    thrown = true;
    error = err;
  }
  if (!thrown) throw new AssertionError(`Expected function to throw${suffix(msg)}`);
  checkError(error, ErrorClass, msgIncludes, msg);
  return error;
}

/** Assert the promise (or `fn()`'s promise) rejects; resolves to the reason. */
export function assertRejects(fn: (() => PromiseLike<unknown>) | PromiseLike<unknown>, msg?: string): Promise<unknown>;
export function assertRejects<E extends Error = Error>(
  fn: (() => PromiseLike<unknown>) | PromiseLike<unknown>,
  ErrorClass: ErrorClass<E>,
  msgIncludes?: string,
  msg?: string,
): Promise<E>;
export async function assertRejects(
  fn: (() => PromiseLike<unknown>) | PromiseLike<unknown>,
  classOrMsg?: ErrorClass | string,
  msgIncludes?: string,
  msg?: string,
): Promise<unknown> {
  const ErrorClass = typeof classOrMsg === "function" ? classOrMsg : undefined;
  if (typeof classOrMsg === "string") msg = classOrMsg;
  let p: unknown;
  try {
    p = typeof fn === "function" ? fn() : fn;
  } catch {
    // A synchronous throw is not a rejection (an async function never does this).
    throw new AssertionError(`Function throws when expected to reject${suffix(msg)}`);
  }
  if (!p || typeof (p as PromiseLike<unknown>).then !== "function") {
    throw new AssertionError(`Function returns a non-promise when expected to reject${suffix(msg)}`);
  }
  let rejected = false;
  let error: unknown;
  try {
    await p;
  } catch (err) {
    rejected = true;
    error = err;
  }
  if (!rejected) throw new AssertionError(`Expected function to reject${suffix(msg)}`);
  checkError(error, ErrorClass, msgIncludes, msg);
  return error;
}

/** Unconditionally fail. */
export function fail(msg?: string): never {
  throw new AssertionError(`Failed assertion${suffix(msg)}`);
}

export function unreachable(msg?: string): never {
  throw new AssertionError(msg ?? "Unreachable");
}

export function unimplemented(msg?: string): never {
  throw new AssertionError(msg ?? "Unimplemented");
}
