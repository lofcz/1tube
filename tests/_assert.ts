/**
 * `@std/assert`-style helpers on top of `bun:test`'s `expect`.
 *
 * The suites were written against Deno's assertion module; keeping the same
 * call shapes makes them read the same under `bun test`, while failures
 * still surface through Bun's matcher diffs.
 */

import { expect } from "bun:test";

export function assert(expr: unknown, msg?: string): asserts expr {
  if (!expr) throw new Error(msg ?? `Expected truthy value, got ${Bun.inspect(expr)}`);
}

export function assertFalse(expr: unknown, msg?: string): void {
  if (expr) throw new Error(msg ?? `Expected falsy value, got ${Bun.inspect(expr)}`);
}

export function assertEquals<T>(actual: unknown, expected: T, msg?: string): asserts actual is T {
  try {
    expect(actual).toEqual(expected);
  } catch (err) {
    if (msg) (err as Error).message = `${msg}\n${(err as Error).message}`;
    throw err;
  }
}

export function assertNotEquals(actual: unknown, expected: unknown, msg?: string): void {
  try {
    expect(actual).not.toEqual(expected);
  } catch (err) {
    if (msg) (err as Error).message = `${msg}\n${(err as Error).message}`;
    throw err;
  }
}

export function assertStrictEquals<T>(actual: unknown, expected: T, msg?: string): asserts actual is T {
  try {
    expect(actual).toBe(expected);
  } catch (err) {
    if (msg) (err as Error).message = `${msg}\n${(err as Error).message}`;
    throw err;
  }
}

export function assertExists<T>(actual: T, msg?: string): asserts actual is NonNullable<T> {
  if (actual === null || actual === undefined) {
    throw new Error(msg ?? `Expected value to exist, got ${actual}`);
  }
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      msg ?? `Expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`,
    );
  }
}

export function assertMatch(actual: string, expected: RegExp, msg?: string): void {
  if (!expected.test(actual)) {
    throw new Error(msg ?? `Expected ${JSON.stringify(actual)} to match ${expected}`);
  }
}

export function assertObjectMatch(actual: object, expected: Record<PropertyKey, unknown>): void {
  expect(actual).toMatchObject(expected);
}

export function assertGreater<T extends number | bigint>(actual: T, expected: T, msg?: string): void {
  if (!(actual > expected)) throw new Error(msg ?? `Expected ${actual} > ${expected}`);
}

export function assertInstanceOf<T>(
  actual: unknown,
  ctor: abstract new (...args: never[]) => T,
  msg?: string,
): asserts actual is T {
  if (!(actual instanceof ctor)) {
    throw new Error(msg ?? `Expected instance of ${ctor.name}, got ${Bun.inspect(actual)}`);
  }
}

type ErrorClass = abstract new (...args: never[]) => Error;

function checkError(err: unknown, cls?: ErrorClass, includes?: string): Error {
  if (cls && !(err instanceof cls)) {
    throw new Error(`Expected error to be instance of ${cls.name}, got ${Bun.inspect(err)}`);
  }
  if (includes !== undefined) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes(includes)) {
      throw new Error(`Expected error message ${JSON.stringify(message)} to include ${JSON.stringify(includes)}`);
    }
  }
  return err as Error;
}

/**
 * `assertThrows(fn)`, `(fn, msgIncludes)`, `(fn, ErrorClass, msgIncludes?,
 * failureMsg?)`.
 */
export function assertThrows(
  fn: () => unknown,
  clsOrMsg?: ErrorClass | string,
  msgIncludes?: string,
  failureMsg?: string,
): Error {
  try {
    fn();
  } catch (err) {
    return typeof clsOrMsg === "string"
      ? checkError(err, undefined, clsOrMsg)
      : checkError(err, clsOrMsg, msgIncludes);
  }
  throw new Error(failureMsg ?? "Expected function to throw");
}

/**
 * `assertRejects(fn)`, `(fn, msgIncludes)`, `(fn, ErrorClass, msgIncludes?,
 * failureMsg?)`.
 */
export async function assertRejects(
  fn: () => PromiseLike<unknown>,
  clsOrMsg?: ErrorClass | string,
  msgIncludes?: string,
  failureMsg?: string,
): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return typeof clsOrMsg === "string"
      ? checkError(err, undefined, clsOrMsg)
      : checkError(err, clsOrMsg, msgIncludes);
  }
  throw new Error(failureMsg ?? "Expected promise to reject");
}

export function fail(msg?: string): never {
  throw new Error(msg ?? "Failed assertion");
}
