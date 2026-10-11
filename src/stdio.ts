/**
 * Synchronous stdout/stderr writers — the `Deno.stdout.writeSync` shape the
 * log buffer, boot progress and gateway tagging rely on (and test fakes
 * implement). Writes go straight to the fd so lines are never reordered
 * behind buffered `console` output.
 */

import { writeSync } from "node:fs";

export interface SyncSink {
  writeSync(chunk: Uint8Array): number;
  isTerminal?(): boolean;
}

function fdSink(fd: number, stream: NodeJS.WriteStream): SyncSink {
  return {
    writeSync(chunk) {
      let off = 0;
      // A pipe may accept a partial write; finish the chunk.
      while (off < chunk.length) off += writeSync(fd, chunk, off);
      return chunk.length;
    },
    isTerminal: () => Boolean(stream.isTTY),
  };
}

export const stdout: SyncSink = fdSink(1, process.stdout);
export const stderr: SyncSink = fdSink(2, process.stderr);

const encoder = new TextEncoder();

/** Write a line (newline appended) to stderr, swallowing EPIPE & co. */
export function writeStderrLine(line: string): void {
  try {
    stderr.writeSync(encoder.encode(line + "\n"));
  } catch { /* stderr closed */ }
}
