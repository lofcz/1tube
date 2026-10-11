/**
 * `1tube/test` under Bun (the `bun` export condition): drives `bun:test`.
 * Run with `1tube test` so function imports resolve like on the gateway.
 */

import * as bun from "bun:test";
import { fileURLToPath } from "node:url";
import type { TestRuntime } from "./api.ts";
import { createTestApi } from "./core.ts";

export * from "./assert.ts";
export { createMock, deepEquals, expect, isMock, spyOn } from "./expect.ts";
export type * from "./api.ts";
export type { Assertion, AsymmetricMatcher, Expect, Matchers, Mock, MockResult, MockState } from "./expect.ts";

export const runtime: TestRuntime = "bun";

export const { test, it, describe, beforeAll, afterAll, beforeEach, afterEach, mock } = createTestApi({
  test: (name, fn, { timeout, skip, only }) => {
    if (skip) bun.test.skip(name, fn, timeout);
    else if (only) bun.test.only(name, fn, timeout);
    else bun.test(name, fn, timeout);
  },
  todo: (name) => bun.test.todo(name, () => {}),
  describe: (name, fn, mode) =>
    mode === "skip" ? bun.describe.skip(name, fn) : mode === "only" ? bun.describe.only(name, fn) : bun.describe(name, fn),
  beforeAll: (fn, timeout) => bun.beforeAll(fn, timeout),
  afterAll: (fn, timeout) => bun.afterAll(fn, timeout),
  beforeEach: (fn, timeout) => bun.beforeEach(fn, timeout),
  afterEach: (fn, timeout) => bun.afterEach(fn, timeout),
  mockModule: (specifier, factory) => {
    void bun.mock.module(specifier.startsWith("file:") ? fileURLToPath(specifier) : specifier, factory);
  },
});
