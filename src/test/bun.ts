/**
 * `1tube/test` under Bun (the `bun` export condition): drives `bun:test`.
 * Run with `1tube test` so function imports resolve like on the gateway.
 */

import * as bun from "bun:test";
import type { DescribeFunction, Hook, TestFn, TestFunction, TestOptions, TestRuntime } from "./api.ts";

export * from "./assert.ts";
export type * from "./api.ts";

export const runtime: TestRuntime = "bun";

export const test: TestFunction = Object.assign(
  (name: string, fn: TestFn, options: TestOptions = {}) => {
    if (options.skip) bun.test.skip(name, fn, options.timeout);
    else if (options.only) bun.test.only(name, fn, options.timeout);
    else bun.test(name, fn, options.timeout);
  },
  {
    skip: (name: string, fn: TestFn, options: TestOptions = {}) => bun.test.skip(name, fn, options.timeout),
    only: (name: string, fn: TestFn, options: TestOptions = {}) => bun.test.only(name, fn, options.timeout),
    todo: (name: string) => bun.test.todo(name, () => {}),
  },
);

export const describe: DescribeFunction = Object.assign(
  (name: string, fn: () => void) => bun.describe(name, fn),
  {
    skip: (name: string, fn: () => void) => bun.describe.skip(name, fn),
    only: (name: string, fn: () => void) => bun.describe.only(name, fn),
  },
);

export const beforeAll: Hook = (fn) => bun.beforeAll(fn);
export const afterAll: Hook = (fn) => bun.afterAll(fn);
export const beforeEach: Hook = (fn) => bun.beforeEach(fn);
export const afterEach: Hook = (fn) => bun.afterEach(fn);
