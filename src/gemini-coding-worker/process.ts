import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { GEMINI_CLI_ENTRY } from "./cli.js";

/**
 * The most of the CLI's stderr kept: only for classifying an exit without a result event, and the
 * debug trace (Decision 19). Must hold line 1 of the recorded unknown-flag stderr (a test checks).
 */
export const STDERR_TAIL_BYTES = 16 * 1024;
/** After SIGTERM on cancellation, the wait before SIGKILL. */
export const KILL_GRACE_MS = 10_000;

export interface GeminiCliDone {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}
export interface GeminiCliRun {
  lines: AsyncIterable<string>;
  done: Promise<GeminiCliDone>;
}
export type GeminiCliSpawner = (
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; signal: AbortSignal },
) => GeminiCliRun;

/**
 * Runs `node <entry> ...args` with exactly `env` (never the driver's own environment). stdout and
 * stderr are piped, never inherited or logged: the caller reads the lines, and the stderr tail
 * reaches only the classifier and the redacting debug trace.
 */
export function spawnGeminiCli(entry: string = GEMINI_CLI_ENTRY): GeminiCliSpawner {
  return (args, options) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
    });
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    };
    if (options.signal.aborted) stop();
    else options.signal.addEventListener("abort", stop, { once: true });
    const done = new Promise<GeminiCliDone>((resolve, reject) => {
      child.once("error", (error) => {
        options.signal.removeEventListener("abort", stop);
        if (killTimer) clearTimeout(killTimer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        options.signal.removeEventListener("abort", stop);
        if (killTimer) clearTimeout(killTimer);
        resolve({ code, signal, stderrTail: decodeTail(tail) });
      });
    });
    // Handled here too, so a spawn failure seen while the caller is still reading lines is not an
    // unhandled rejection; the caller still sees it when it awaits done.
    done.catch(() => undefined);
    return { lines: createInterface({ input: child.stdout, crlfDelay: Infinity }), done };
  };
}

/** The tail as text; a multi-byte character cut at the start of the window is dropped, not mangled. */
function decodeTail(tail: Buffer): string {
  let start = 0;
  // Skip UTF-8 continuation bytes (10xxxxxx) left over from a character cut by the window.
  while (start < tail.length && start < 4 && (tail[start] & 0xc0) === 0x80) start += 1;
  return tail.subarray(start).toString("utf8");
}
