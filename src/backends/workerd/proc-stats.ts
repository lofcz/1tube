/**
 * Cross-platform "what's the RSS of this PID" helper.
 *
 * Deno doesn't expose per-process memory accounting in any portable
 * API — `Deno.memoryUsage()` only reports the current process's V8
 * heap. We need to inspect the workerd *child* process from the
 * gateway, so we shell out to platform-native tools:
 *
 *   - **Linux**: read `/proc/{pid}/status` and parse `VmRSS:` (in
 *     kilobytes). Zero-allocation in the kernel; cheap to poll.
 *   - **macOS**: `ps -o rss= -p {pid}` returns RSS in kilobytes.
 *   - **Windows**: `tasklist /FI "PID eq {pid}" /FO CSV /NH` returns
 *     a row whose 5th column is "Mem Usage" formatted as
 *     `"1,234 K"` (locale-sensitive thousand separator). We strip
 *     non-digits before parsing. `tasklist` is shipped with every
 *     Windows since XP and doesn't require admin.
 *
 * Each call shells out at most once. Failures (no such pid, parser
 * surprise, command missing) return `null` instead of throwing —
 * the watchdog treats `null` as "skip this sample" rather than
 * tearing down the gateway because `ps` was renamed in PATH.
 *
 * The helper exports a single async function so callers can
 * dependency-inject a fake for tests; the rest of this module is
 * pure parsing logic also exported for unit testing.
 */

const KB = 1024;

/**
 * Read the resident set size of `pid` in bytes, or `null` if it
 * couldn't be determined (process gone, command failure, parse
 * error). Never throws.
 */
export async function pidRss(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (Deno.build.os === "linux") return await readRssLinux(pid);
    if (Deno.build.os === "darwin") return await readRssMac(pid);
    if (Deno.build.os === "windows") return await readRssWindows(pid);
    // Other Unixes (freebsd, etc.) fall through to ps which exists
    // on all of them.
    return await readRssMac(pid);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Linux: /proc/{pid}/status
// ---------------------------------------------------------------------------

async function readRssLinux(pid: number): Promise<number | null> {
  try {
    const text = await Deno.readTextFile(`/proc/${pid}/status`);
    return parseLinuxStatus(text);
  } catch {
    return null;
  }
}

/** Parse a `/proc/{pid}/status` file and return VmRSS in bytes. Exported for tests. */
export function parseLinuxStatus(text: string): number | null {
  // The line looks like: `VmRSS:\t  12345 kB\n` — tab/space mix
  // depends on kernel version.
  const m = /^VmRSS:\s+(\d+)\s*kB/im.exec(text);
  if (!m) return null;
  return Number(m[1]) * KB;
}

// ---------------------------------------------------------------------------
// macOS / generic Unix: ps -o rss= -p {pid}
// ---------------------------------------------------------------------------

async function readRssMac(pid: number): Promise<number | null> {
  const cmd = new Deno.Command("ps", {
    args: ["-o", "rss=", "-p", String(pid)],
    stdout: "piped",
    stderr: "null",
  });
  const out = await cmd.output();
  if (!out.success) return null;
  return parsePsOutput(new TextDecoder().decode(out.stdout));
}

/** Parse `ps -o rss=` output (digits only, kilobytes). Exported for tests. */
export function parsePsOutput(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Some shells echo back "  1234" with leading whitespace; strip
  // and reject anything non-numeric (some `ps` variants on busybox
  // include the column header even with `=`).
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;
  const kb = Number(digits);
  if (!Number.isFinite(kb)) return null;
  return kb * KB;
}

// ---------------------------------------------------------------------------
// Windows: tasklist /FI "PID eq N" /FO CSV /NH
// ---------------------------------------------------------------------------

async function readRssWindows(pid: number): Promise<number | null> {
  const cmd = new Deno.Command("tasklist", {
    args: ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
    stdout: "piped",
    stderr: "null",
  });
  const out = await cmd.output();
  if (!out.success) return null;
  return parseTasklistCsv(new TextDecoder().decode(out.stdout));
}

/**
 * Parse the single-row CSV that `tasklist /FO CSV /NH` emits:
 *
 *     "workerd.exe","12345","Console","1","45,678 K"
 *
 * Columns: image name, pid, session name, session #, mem usage.
 * The mem usage is locale-formatted (commas in en-US, dots in de-DE)
 * so we strip every non-digit before parsing. Returns bytes.
 *
 * If the pid doesn't exist, tasklist exits 0 but emits the message
 *
 *     INFO: No tasks are running which match the specified criteria.
 *
 * which has no quotes; we detect that and return null.
 *
 * Exported for tests.
 */
export function parseTasklistCsv(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.toUpperCase().startsWith("INFO:")) return null;
  // Split on quoted fields. Robust to commas inside fields because
  // every field is double-quoted.
  const fields = [...trimmed.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  if (fields.length < 5) return null;
  const memField = fields[4];
  // Strip trailing " K" / " KB" and any locale separators.
  const digits = memField.replace(/[^\d]/g, "");
  if (!digits) return null;
  const kb = Number(digits);
  if (!Number.isFinite(kb)) return null;
  return kb * KB;
}
