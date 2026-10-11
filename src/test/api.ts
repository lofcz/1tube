/**
 * The `1tube/test` contract every runner binding implements.
 *
 * Edge function tests import `test`, `describe`, hooks and assertions from
 * `1tube/test` instead of a specific runner, so the same files run under
 * `bun test` today and under another runtime's runner (node:test, a workerd
 * pool) later. Keep this surface to what every runner can express: no test
 * context argument, no runner-specific options.
 */

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

export interface TestFunction {
  (name: string, fn: TestFn, options?: TestOptions): void;
  skip(name: string, fn: TestFn, options?: TestOptions): void;
  only(name: string, fn: TestFn, options?: TestOptions): void;
  /** A placeholder for a test that is not written yet. */
  todo(name: string): void;
}

export interface DescribeFunction {
  (name: string, fn: () => void): void;
  skip(name: string, fn: () => void): void;
  only(name: string, fn: () => void): void;
}

export type Hook = (fn: HookFn) => void;

/** Which runner the active binding drives. */
export type TestRuntime = "bun" | "node";
