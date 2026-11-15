/**
 * A coding worker's supervision by its bridge: the worker's last lines kept in memory, then, once it
 * exits, its transcript (if any) and result uploaded, and on no usable result the operator-diagnostics
 * tail and the exit report. The agent bridge (pair runs) and the Codex bridge (one-actor runs) share it.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 * Nothing secret is logged (see Logger in common.ts).
 */
import { postCapped, uploadFile, withRound, type DiagnosticsTail, type Logger } from "./common.js";
import { WORKER_OUTPUT_TAIL } from "./constants.js";
import { findWorkerDiagnostic, LineTail, waitAtMost } from "./diagnostics.js";
import type { RetryPolicy } from "./http.js";
import type { GroupSignalTarget } from "./workspace.js";

export interface WorkerHandle {
  exited: Promise<number>;
  /** The worker's output, when the bridge can read it (kept in memory only; see diagnostics.ts). */
  stdout?: NodeJS.ReadableStream;
  stderr?: NodeJS.ReadableStream;
  /** The worker's pid, when it runs as a child of the bridge. */
  pid?: number;
  /** The worker's child process, when it leads its own process group (the bridge ends the group). */
  child?: GroupSignalTarget;
}

/** How long, after the worker exits, the bridge waits for its output streams to end. */
const OUTPUT_DRAIN_MS = 2_000;
/** The transcript is best effort: it never holds the result back for longer than this. */
export const TRANSCRIPT_DEADLINE_MS = 2 * 60_000;

export interface SuperviseOptions {
  /** `<proxy>/substrate/runs/<run token>`. */
  base: string;
  round: number;
  /** The run token (log fields only). */
  token: string;
  headers: Record<string, string>;
  resultPath: string;
  /** No transcript upload when absent. */
  transcriptPath?: string;
  transcriptDeadlineMs?: number;
  tail: DiagnosticsTail;
  policy: RetryPolicy;
  log: Logger;
  signal: AbortSignal;
}

/** Uploads the transcript (if any) and result after exit; on no usable result, the diagnostics tail then the exit report. */
export function superviseWorker(
  worker: WorkerHandle,
  options: SuperviseOptions,
): { exited: Promise<number>; uploaded: Promise<void> } {
  const { base, round, token, headers, tail, policy, log, signal } = options;
  // The worker's last lines, in memory only: nothing of them leaves the actor except the one fixed
  // diagnostic findWorkerDiagnostic accepts.
  const output = new LineTail(WORKER_OUTPUT_TAIL.lines, WORKER_OUTPUT_TAIL.bytes);
  const drained = Promise.all([
    ...[worker.stdout, worker.stderr].flatMap((stream) => (stream ? [output.follow(stream)] : [])),
    ...(worker.stderr ? [tail.tail.follow(worker.stderr)] : []),
  ]);
  // The transcript, then the result, once the worker has exited. Of what this supervision uploads,
  // the result (or, on no usable result, the diagnostics tail and then the exit report) comes last:
  // the control plane may read the transcript as soon as the result lands. The transcript is best
  // effort and bounded, and never blocks it. A one-actor run's workspace upload (codex.ts) follows
  // `uploaded`; the proxy writes the run's done record only then (workspace or workspace-failed).
  const uploaded = worker.exited.then(async (code) => {
    log("substrate_bridge_worker_exited", { runToken: token, code });
    if (options.transcriptPath !== undefined) {
      await uploadFile(
        withRound(`${base}/transcript`, round),
        headers,
        options.transcriptPath,
        policy,
        log,
        "transcript",
        AbortSignal.any([signal, AbortSignal.timeout(options.transcriptDeadlineMs ?? TRANSCRIPT_DEADLINE_MS)]),
      );
    }
    const outcome = await uploadFile(
      withRound(`${base}/result`, round),
      headers,
      options.resultPath,
      policy,
      log,
      "result",
      signal,
    );
    // No usable result: the diagnostics tail, then the exit report that tells the proxy the worker is
    // gone (for a pair run it also asks the tool actor for the workspace), with the worker's own
    // diagnostic code when it printed one.
    if (outcome !== "ok") {
      await waitAtMost(drained, OUTPUT_DRAIN_MS);
      const diagnostic = findWorkerDiagnostic(output.lines());
      // A failure: the operator gets the worker's stderr tail (redacted) in the proxy's log, before the
      // exit report that ends the round.
      await tail.post(withRound(`${base}/diagnostics`, round), headers, policy, log, signal);
      await postCapped(withRound(`${base}/exit`, round), headers, { code, ...diagnostic }, policy, log, "exit", signal);
    }
  });
  return { exited: worker.exited, uploaded };
}
