/**
 * Declarations for `Bun.ModuleGraph` (experimental, Bun ≥ 1.4.3), which
 * `@types/bun` does not ship yet. Shape matches the runtime: a graph owns
 * fresh module state, its own timers/I/O and `require.cache`, while parsed
 * code and bytecode are shared with every other graph in the process.
 */
declare module "bun" {
  type ModuleGraphErrorKind = "uncaughtException" | "unhandledRejection";

  interface ModuleGraphOptions {
    /** Bindings visible to code in the graph as bare global identifiers. */
    globals?: Record<string, unknown>;
    /** Errors escaping the graph's code (timers, orphan rejections). */
    onError?: (error: unknown, kind: ModuleGraphErrorKind) => void;
  }

  class ModuleGraph {
    constructor(options?: ModuleGraphOptions);
    /** Import `specifier` (resolved against cwd) into this graph. */
    import(specifier: string): Promise<Record<string, unknown>>;
    /** Run `fn` with this graph as the current module/timer context. */
    run<T>(fn: () => T): T;
    /** Cancel the graph's timers and I/O and release its module state. */
    dispose(): void;
  }
}
