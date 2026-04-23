// node: specifiers (instead of "jsr:@std/path") so this loads from node_modules
// in any host Deno project without needing a shared import-map entry.
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const raw = Deno.readTextFileSync(join(dir, "..", "package.json"));
    return JSON.parse(raw).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readVersion();
