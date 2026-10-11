/**
 * `1tube/test` everywhere else (the default export condition): drives the
 * standard `node:test` runner, which Node runs natively and other runtimes
 * implement for compatibility.
 */

import * as node from "node:test";
import type { DescribeFunction, Hook, TestFn, TestFunction, TestOptions, TestRuntime } from "./api.ts";

export * from "./assert.ts";
export type * from "./api.ts";

export const runtime: TestRuntime = "node";

// node:test passes a context (and a `done` callback to 2-arity functions);
// the 1tube contract has neither, so wrap to keep the arity at zero.
const register = (name: string, fn: TestFn, options: TestOptions) =>
  node.test(name, { timeout: options.timeout, skip: options.skip, only: options.only }, async () => {
    await fn();
  });

export const test: TestFunction = Object.assign(
  (name: string, fn: TestFn, options: TestOptions = {}) => void register(name, fn, options),
  {
    skip: (name: string, fn: TestFn, options: TestOptions = {}) => void register(name, fn, { ...options, skip: true }),
    only: (name: string, fn: TestFn, options: TestOptions = {}) => void register(name, fn, { ...options, only: true }),
    todo: (name: string) => void node.test(name, { todo: true }),
  },
);

export const describe: DescribeFunction = Object.assign(
  (name: string, fn: () => void) => void node.describe(name, fn),
  {
    skip: (name: string, fn: () => void) => void node.describe(name, { skip: true }, fn),
    only: (name: string, fn: () => void) => void node.describe(name, { only: true }, fn),
  },
);

const hook = (register: (fn: () => Promise<void>) => void): Hook => (fn) =>
  register(async () => {
    await fn();
  });

export const beforeAll: Hook = hook((fn) => node.before(fn));
export const afterAll: Hook = hook((fn) => node.after(fn));
export const beforeEach: Hook = hook((fn) => node.beforeEach(fn));
export const afterEach: Hook = hook((fn) => node.afterEach(fn));
