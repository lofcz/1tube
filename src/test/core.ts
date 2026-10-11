/**
 * Builds the full `1tube/test` surface from a runner's minimal base, so
 * `.each`, `.if`/`.skipIf`, `it`, mocks and title formatting behave the
 * same on every runner.
 */

import type {
  DescribeFunction,
  Hook,
  MockFunction,
  RegisterSuite,
  RegisterTest,
  RunnerBase,
  TestFn,
  TestFunction,
  TestOptions,
} from "./api.ts";
import { format } from "./assert.ts";
import { createMock, restoreAllMocks } from "./expect.ts";

export interface TestApi {
  test: TestFunction;
  it: TestFunction;
  describe: DescribeFunction;
  beforeAll: Hook;
  afterAll: Hook;
  beforeEach: Hook;
  afterEach: Hook;
  mock: MockFunction;
}

const rowArgs = (row: unknown): unknown[] => (Array.isArray(row) ? row : [row]);

/** jest-style `.each` titles: printf placeholders, or `$path` for object rows. */
export function formatTitle(title: string, args: unknown[], index: number): string {
  const [first] = args;
  if (args.length === 1 && first && typeof first === "object" && !Array.isArray(first) && /\$[A-Za-z_]/.test(title)) {
    return title.replace(/\$([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g, (m, path: string) => {
      let cur: unknown = first;
      for (const p of path.split(".")) {
        if (cur === null || cur === undefined) return m;
        cur = (cur as Record<string, unknown>)[p];
      }
      return typeof cur === "string" ? cur : format(cur);
    });
  }
  let i = 0;
  return title.replace(/%[sdifjoOp#%]/g, (m) => {
    if (m === "%%") return "%";
    if (m === "%#") return String(index);
    if (i >= args.length) return m;
    const v = args[i++];
    switch (m) {
      case "%s":
        return typeof v === "string" ? v : format(v);
      case "%d":
      case "%i":
        return String(typeof v === "bigint" ? v : Math.trunc(Number(v)));
      case "%f":
        return String(Number(v));
      case "%j":
        return JSON.stringify(v);
      default:
        return format(v);
    }
  });
}

export function createTestApi(base: RunnerBase): TestApi {
  const register = (mode: "run" | "skip" | "only"): RegisterTest => (name, fn, options: TestOptions = {}) =>
    base.test(name, fn, {
      ...options,
      skip: mode === "skip" || options.skip,
      only: mode === "only" || options.only,
    });

  const test: TestFunction = Object.assign(register("run"), {
    skip: register("skip"),
    only: register("only"),
    todo: (name: string) => base.todo(name),
    if: (condition: unknown) => register(condition ? "run" : "skip"),
    skipIf: (condition: unknown) => register(condition ? "skip" : "run"),
    each: <Row>(table: readonly Row[]) =>
    (name: string, fn: (...args: never[]) => void | Promise<unknown>, options?: TestOptions) => {
      table.forEach((row, index) => {
        const args = rowArgs(row);
        register("run")(formatTitle(name, args, index), (() => fn(...(args as never[]))) as TestFn, options);
      });
    },
  }) as TestFunction;

  const suite = (mode: "run" | "skip" | "only"): RegisterSuite => (name, fn) => base.describe(name, fn, mode);
  const describe: DescribeFunction = Object.assign(suite("run"), {
    skip: suite("skip"),
    only: suite("only"),
    if: (condition: unknown) => suite(condition ? "run" : "skip"),
    skipIf: (condition: unknown) => suite(condition ? "skip" : "run"),
    each: <Row>(table: readonly Row[]) => (name: string, fn: (...args: never[]) => void) => {
      table.forEach((row, index) => {
        const args = rowArgs(row);
        suite("run")(formatTitle(name, args, index), () => fn(...(args as never[])));
      });
    },
  }) as DescribeFunction;

  const mock = Object.assign(<T extends (...args: never[]) => unknown>(impl?: T) => createMock(impl as never), {
    module: (specifier: string | URL, factory: () => Record<string, unknown>) => {
      const s = specifier instanceof URL ? specifier.href : String(specifier);
      if (s.startsWith("./") || s.startsWith("../") || s === "." || s === "..") {
        throw new Error(
          `mock.module(${JSON.stringify(s)}): relative specifiers depend on the calling file, which a ` +
            `shared helper can't see. Pass import.meta.resolve(${JSON.stringify(s)}) instead.`,
        );
      }
      base.mockModule(s, factory);
    },
    restore: () => restoreAllMocks(),
  }) as MockFunction;

  return {
    test,
    it: test,
    describe,
    beforeAll: base.beforeAll,
    afterAll: base.afterAll,
    beforeEach: base.beforeEach,
    afterEach: base.afterEach,
    mock,
  };
}
