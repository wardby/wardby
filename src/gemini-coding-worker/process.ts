import { spawn, type ChildProcess } from "node:child_process";
import { totalmem } from "node:os";
import { GEMINI_CLI_ENTRY } from "./cli.js";

/**
 * The most of the CLI's stderr kept: only for classifying an exit without a result event, and the
 * debug trace (Decision 19). Must hold line 1 of the recorded unknown-flag stderr (a test checks).
 */
export const STDERR_TAIL_BYTES = 16 * 1024;
/** The longest stdout line (one stream-json event) passed on; a longer line is dropped and counted. */
export const STDOUT_LINE_MAX_BYTES = 8 * 1024 * 1024;
/** After SIGTERM on cancellation, the wait before SIGKILL. */
export const KILL_GRACE_MS = 10_000;

/** Bounds on the CLI's heap limit (MiB). */
export const MIN_CLI_HEAP_MIB = 512;
export const MAX_CLI_HEAP_MIB = 16_384;
const MIB = 1024 * 1024;

/**
 * The CLI's V8 heap limit: half the smaller of the machine's memory and the container's limit,
 * within MIN/MAX_CLI_HEAP_MIB. GEMINI_CLI_NO_RELAUNCH drops the flag the CLI's own relaunch would
 * set (which read the host's memory, not the container's), so the runner sets one.
 */
export function cliHeapMiB(total: number = totalmem(), constrained: number = process.constrainedMemory()): number {
  const limit = Math.min(total, constrained > 0 ? constrained : Number.POSITIVE_INFINITY);
  return Math.min(MAX_CLI_HEAP_MIB, Math.max(MIN_CLI_HEAP_MIB, Math.floor((limit / MIB) * 0.5)));
}

export interface GeminiCliDone {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
  /** stdout lines longer than STDOUT_LINE_MAX_BYTES, dropped whole; the driver decides what that means. */
  oversizedLines: number;
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
 * Runs `node --max-old-space-size=<cliHeapMiB> <entry> ...args` with exactly `env` (never the driver's own environment). stdout and
 * stderr are piped, never inherited or logged: the caller reads the lines, and the stderr tail
 * reaches only the classifier and the redacting debug trace.
 *
 * The CLI runs in its own process group: 0.70.0's gemini.js relaunches itself in a child that
 * inherits stdio (environment.ts also sets GEMINI_CLI_NO_RELAUNCH), so killing one pid would orphan
 * the real CLI and keep the pipes open. Signals go to the whole group, and whatever is left in the
 * group when the leader exits is killed, so the pipes close and the run ends.
 * A run cancelled before it starts never spawns.
 */
export function spawnGeminiCli(
  entry: string = GEMINI_CLI_ENTRY,
  options: { killGraceMs?: number; heapMiB?: number } = {},
): GeminiCliSpawner {
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const heapFlag = `--max-old-space-size=${options.heapMiB ?? cliHeapMiB()}`;
  return (args, run) => {
    if (run.signal.aborted) {
      return {
        lines: (async function* () {})(),
        done: Promise.resolve({ code: null, signal: null, stderrTail: "", oversizedLines: 0 }),
      };
    }
    const child = spawn(process.execPath, [heapFlag, entry, ...args], {
      cwd: run.cwd,
      env: run.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let tail = Buffer.alloc(0);
    child.stderr.on("data", (chunk: Buffer) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > STDERR_TAIL_BYTES) tail = tail.subarray(tail.length - STDERR_TAIL_BYTES);
    });
    let killTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), killGraceMs);
      killTimer.unref();
    };
    run.signal.addEventListener("abort", stop, { once: true });
    // The leader is gone: nothing else in its group may keep the pipes, and the run, open.
    child.once("exit", () => killGroup(child, "SIGKILL"));
    const counter = { oversized: 0 };
    const finish = () => {
      run.signal.removeEventListener("abort", stop);
      if (killTimer) clearTimeout(killTimer);
    };
    const done = new Promise<GeminiCliDone>((resolve, reject) => {
      child.once("error", (error) => {
        finish();
        reject(error);
      });
      child.once("close", (code, signal) => {
        finish();
        resolve({ code, signal, stderrTail: decodeTail(tail), oversizedLines: counter.oversized });
      });
    });
    // Handled here too, so a spawn failure seen while the caller is still reading lines is not an
    // unhandled rejection; the caller still sees it when it awaits done.
    done.catch(() => undefined);
    return { lines: boundedLines(child.stdout, counter), done };
  };
}

/** Signals the CLI's process group; falls back to the leader alone when there is no group. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

/** Newline-split UTF-8 lines; a line over STDOUT_LINE_MAX_BYTES is dropped whole and counted. */
async function* boundedLines(stream: AsyncIterable<Buffer>, counter: { oversized: number }): AsyncGenerator<string> {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;
  const take = (): string => {
    const line = Buffer.concat(parts).toString("utf8");
    parts = [];
    size = 0;
    return line.endsWith("\r") ? line.slice(0, -1) : line;
  };
  for await (const chunk of stream) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!dropping) {
        if (size + (end - start) > STDOUT_LINE_MAX_BYTES) {
          dropping = true;
          counter.oversized += 1;
          parts = [];
          size = 0;
        } else {
          parts.push(chunk.subarray(start, end));
          size += end - start;
        }
      }
      if (newline === -1) break;
      if (dropping) dropping = false;
      else yield take();
      start = newline + 1;
    }
  }
  if (!dropping && size > 0) yield take();
}

/** The tail as text; a multi-byte character cut at the start of the window is dropped, not mangled. */
function decodeTail(tail: Buffer): string {
  let start = 0;
  // Skip UTF-8 continuation bytes (10xxxxxx) left over from a character cut by the window.
  while (start < tail.length && start < 4 && (tail[start] & 0xc0) === 0x80) start += 1;
  return tail.subarray(start).toString("utf8");
}
