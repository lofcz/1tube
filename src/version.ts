import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function readVersion(): string {
  try {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const raw = readFileSync(join(dir, "..", "package.json"), "utf8");
    return JSON.parse(raw).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const VERSION = readVersion();
