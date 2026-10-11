/**
 * `1tube/test` everywhere else (the default export condition): drives the
 * standard `node:test` runner, which Node runs natively and other runtimes
 * implement for compatibility.
 */

import * as node from "node:test";
import type { TestRuntime } from "./api.ts";
import { createTestApi } from "./core.ts";

export * from "./assert.ts";
export { createMock, deepEquals, expect, isMock, spyOn } from "./expect.ts";
export type * from "./api.ts";
export type { Assertion, AsymmetricMatcher, Expect, Matchers, Mock, MockResult, MockState } from "./expect.ts";

export const runtime: TestRuntime = "node";

// node:test passes a context (and a `done` callback to 2-arity functions);
// the 1tube contract has neither, so wrap to keep the arity at zero.
const wrap = (fn: () => unknown) => async () => {
  await fn();
};

export const { test, it, describe, beforeAll, afterAll, beforeEach, afterEach, mock } = createTestApi({
  test: (name, fn, { timeout, skip, only }) => void node.test(name, { timeout, skip, only }, wrap(fn)),
  todo: (name) => void node.test(name, { todo: true }),
  describe: (name, fn, mode) => void node.describe(name, { skip: mode === "skip", only: mode === "only" }, fn),
  beforeAll: (fn, timeout) => node.before(wrap(fn), { timeout }),
  afterAll: (fn, timeout) => node.after(wrap(fn), { timeout }),
  beforeEach: (fn, timeout) => node.beforeEach(wrap(fn), { timeout }),
  afterEach: (fn, timeout) => node.afterEach(wrap(fn), { timeout }),
  mockModule: (specifier, factory) => {
    const moduleMock = (node.mock as { module?: (s: string, o: object) => unknown }).module;
    if (typeof moduleMock !== "function") {
      throw new Error("mock.module on node:test needs `node --test --experimental-test-module-mocks`");
    }
    const exports = factory();
    if (exports && typeof (exports as { then?: unknown }).then === "function") {
      throw new Error("mock.module on node:test needs a synchronous factory");
    }
    const { default: defaultExport, ...namedExports } = exports;
    moduleMock.call(node.mock, specifier, {
      namedExports,
      ...("default" in exports ? { defaultExport } : {}),
    });
  },
});
