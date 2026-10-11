/**
 * The `1tube/test` contract every runner binding implements.
 *
 * Edge function tests import `test`, `describe`, hooks, `expect`, mocks and
 * assertions from `1tube/test` instead of a specific runner, so the same
 * files run under `bun test` today and under another runtime's runner
 * (node:test, a workerd pool) later. Keep this surface to what every runner
 * can express: no test context argument, no runner-specific options.
 */

import type { Mock } from "./expect.ts";

export type TestFn = () => void | Promise<unknown>;
export type HookFn = () => void | Promise<unknown>;

export interface TestOptions {
  /** Per-test timeout in milliseconds (runner default when omitted). */
  timeout?: number;
  /** Register but do not run. */
  skip?: boolean;
  /** Run only tests marked `only` (where the runner supports focusing). */
  only?: boolean;
}

/** Row arguments for `.each`: array rows spread, anything else is one argument. */
export type EachArgs<Row> = Row extends readonly unknown[] ? Row : [Row];

export type RegisterTest = (name: string, fn: TestFn, options?: TestOptions) => void;

export interface TestFunction extends RegisterTest {
  skip: RegisterTest;
  only: RegisterTest;
  /** A placeholder for a test that is not written yet. */
  todo(name: string): void;
  /** Register normally when `condition` is truthy, else as skipped. */
  if(condition: unknown): RegisterTest;
  /** Register as skipped when `condition` is truthy. */
  skipIf(condition: unknown): RegisterTest;
  /**
   * One test per row. The name supports printf placeholders (`%s %d %i %f
   * %j %o %p %#`) and `$key` for object rows.
   */
  each<Row>(
    table: readonly Row[],
  ): (name: string, fn: (...args: EachArgs<Row>) => void | Promise<unknown>, options?: TestOptions) => void;
}

export type RegisterSuite = (name: string, fn: () => void) => void;

export interface DescribeFunction extends RegisterSuite {
  skip: RegisterSuite;
  only: RegisterSuite;
  if(condition: unknown): RegisterSuite;
  skipIf(condition: unknown): RegisterSuite;
  each<Row>(table: readonly Row[]): (name: string, fn: (...args: EachArgs<Row>) => void) => void;
}

export type Hook = (fn: HookFn) => void;

// `any` is unavoidable for generic function shapes.
type AnyFn = (...args: any[]) => any;

export interface MockFunction {
  /** A mock function (records calls; optional implementation). */
  <T extends AnyFn = AnyFn>(impl?: T): Mock<T>;
  /**
   * Replace a module for subsequently loaded importers. The specifier must
   * be absolute — a shared helper can't know which file called it — so
   * pass `import.meta.resolve("./dep.ts")` or a package name. The factory
   * returns the module's exports (`default` for the default export).
   */
  module(specifier: string | URL, factory: () => Record<string, unknown>): void;
  /** Restore every `spyOn` replacement. */
  restore(): void;
}

/** Which runner the active binding drives. */
export type TestRuntime = "bun" | "node";

/** What a runner binding provides; `createTestApi` builds the rest. */
export interface RunnerBase {
  test(name: string, fn: TestFn, options: TestOptions): void;
  todo(name: string): void;
  describe(name: string, fn: () => void, mode: "run" | "skip" | "only"): void;
  beforeAll: Hook;
  afterAll: Hook;
  beforeEach: Hook;
  afterEach: Hook;
  /** `specifier` is already checked to be absolute (path, file: URL or bare). */
  mockModule(specifier: string, factory: () => Record<string, unknown>): void;
}
