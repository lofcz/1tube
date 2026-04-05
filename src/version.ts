import { join, fromFileUrl } from "jsr:@std/path@^1";

function readVersion(): string {
  try {
    const dir = fromFileUrl(new URL(".", import.meta.url));
    const raw = Deno.readTextFileSync(join(dir, "..", "package.json"));
    return JSON.parse(raw).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readVersion();
