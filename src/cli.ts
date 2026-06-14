/**
 * 1tube CLI entry point.
 *
 * Dispatches between the lightweight subcommands (`build`, `--help`,
 * `--version`) and the default `serve` path (which loads the full
 * gateway machinery via dynamic import).
 *
 * Subcommand modules are imported lazily so a CI box running
 * `1tube build` never pays the gateway's static-import cost (Hono,
 * registry, supervisor, every middleware, …) — and conversely, the
 * serve hot path doesn't drag in esbuild's typings just because the
 * build command exists.
 *
 * `Deno.args` is readonly so we cannot strip a leading `serve` token
 * to forward only the tail. Instead, the gateway's `parseArgs` already
 * silently ignores unknown positional tokens — so a literal `serve`
 * passed in the args list just no-ops, which is exactly what we want.
 */

const arg0 = Deno.args[0];

if (arg0 === "build") {
  const { runBuild } = await import("./cli/build.ts");
  const code = await runBuild(Deno.args.slice(1));
  Deno.exit(code);
} else if (arg0 === "package") {
  const { runPackage } = await import("./cli/package.ts");
  const code = await runPackage(Deno.args.slice(1));
  Deno.exit(code);
} else if (arg0 === "--version" || arg0 === "-v") {
  const { VERSION } = await import("./version.ts");
  console.log(VERSION);
  Deno.exit(0);
} else if (arg0 === "--help" || arg0 === "-h") {
  console.log(`Usage: 1tube <command> [options]

Commands:
  serve       Run the gateway (default when no command given)
  build       Bundle functions for a target (--target workerd|vercel)
  package     Build and/or wrap dist/ into a signed .1tube firmware payload
  --version   Print version and exit
  --help      Print this help

Run \`1tube <command> --help\` for command-specific options.
`);
  Deno.exit(0);
} else {
  // Default path — load the gateway. Dynamic import so the heavy
  // graph is only resolved after the dispatch decision above.
  await import("./server.ts");
}
