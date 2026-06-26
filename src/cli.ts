/**
 * 1tube CLI entry point (compatibility alias).
 *
 * The real dispatcher + serve orchestrator lives in `./launch.ts` — this file
 * exists only so existing references to `src/cli.ts` (downstream CI, the npm
 * bin's historical entrypoint, docs) keep working. There is a single launcher
 * implementation; this just forwards to it.
 */

import { run } from "./launch.ts";

await run(Deno.args);
