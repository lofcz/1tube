/**
 * Wire format for console lines escaping the workerd subprocess.
 *
 * Workerd has no postMessage channel back to the gateway, but its
 * stdout/stderr are already pumped line-by-line into the gateway
 * (see `backends/workerd/process.ts`). The bundler's console shim
 * serializes each captured console call as a single marked JSON line;
 * the gateway's log-line sink picks marked lines out of the stream and
 * turns them into structured log rows, while unmarked lines keep
 * flowing to the operator console as plain `[workerd]` output.
 */

export const WORKERD_LOG_MARKER = "__1TUBE_LOG__";

export interface MarkedConsoleLine {
  /** Invocation id, when the line was emitted inside a dispatch. */
  id: string | null;
  level: "debug" | "log" | "info" | "warn" | "error";
  /** Already-formatted message (args joined, objects inspected). */
  msg: string;
  /** Unix ms at emit time. */
  ts: number;
}

const LEVELS = new Set(["debug", "log", "info", "warn", "error"]);

/**
 * Parse a pumped output line. Returns null for ordinary workerd output.
 * Tolerates prefixes before the marker (workerd may decorate lines).
 */
export function parseMarkedConsoleLine(line: string): MarkedConsoleLine | null {
  const at = line.indexOf(WORKERD_LOG_MARKER);
  if (at === -1) return null;
  const payload = line.slice(at + WORKERD_LOG_MARKER.length).trim();
  try {
    const parsed = JSON.parse(payload) as Partial<MarkedConsoleLine>;
    if (typeof parsed.msg !== "string") return null;
    const level = LEVELS.has(parsed.level as string)
      ? parsed.level as MarkedConsoleLine["level"]
      : "log";
    return {
      id: typeof parsed.id === "string" && parsed.id.length > 0
        ? parsed.id
        : null,
      level,
      msg: parsed.msg,
      ts: typeof parsed.ts === "number" && Number.isFinite(parsed.ts)
        ? parsed.ts
        : Date.now(),
    };
  } catch {
    return null;
  }
}
