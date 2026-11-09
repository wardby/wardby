/**
 * Hands coding runs' steps from the proxy to the control plane's run-steps listener
 * (`POST <WARDBY_RUN_STEPS_URL>/internal/run-steps`, `Authorization: Bearer <the run capability>`).
 * The proxy forwards raw step text over the authenticated in-cluster listener; the control plane
 * redacts by exact value before anything is stored. Because the body is raw, this class never logs,
 * echoes, or puts into an error any part of the body, the step text, or the capability: log lines
 * carry a fixed reason and a count only.
 *
 * A bounded in-memory queue, drained one POST at a time off the relay path: a full queue or a slow
 * or failing control plane drops steps and never delays a model request.
 */
import { logger } from "../../core/logger.js";
import {
  MAX_RESULTS_PER_POST,
  MAX_RUN_STEPS_POST_BYTES,
  MAX_STEPS_PER_POST,
  RUN_STEPS_INGRESS_PATH,
  type RunStepBatch,
  type RunStepSubmitter,
} from "../../core/run-steps/types.js";

const forwarderLog = logger.child({ module: "coding-proxy" });
export const MAX_FORWARD_QUEUE = 256;
/** A queue holds at most this many bytes of (estimated) serialized submissions. */
export const MAX_FORWARD_QUEUE_BYTES = 8 * 1024 * 1024;
/** Margin over the listener's 15 s request limit (its write can take lock wait 5 s + transaction 10 s). */
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
/** The envelope around the arrays, with slack for the runId. */
const ENVELOPE_SLACK_BYTES = 1024;

export interface RunStepForwarderOptions {
  /** WARDBY_RUN_STEPS_URL, without a trailing slash. */
  url: string;
  fetchImpl?: typeof fetch;
  maxQueue?: number;
  maxQueueBytes?: number;
  timeoutMs?: number;
  /** How long flush() and close() wait for the queue to settle before giving up. */
  flushTimeoutMs?: number;
  log?: { info(fields: Record<string, unknown>, message: string): void };
}

interface Entry {
  capability: string;
  runId: string;
  batch: RunStepBatch;
  estimate: number;
}

/** A cheap upper-ish bound on a batch's serialized size, with no stringify on the caller's stack. */
function estimate(batch: RunStepBatch): number {
  let bytes = ENVELOPE_SLACK_BYTES;
  for (const step of batch.steps) {
    bytes += step.text.length * 3 + step.callId.length * 3 + 256;
    if (step.kind === "tool") bytes += (step.input?.length ?? 0) * 3;
  }
  for (const result of batch.results) bytes += 128 + (result.output?.length ?? 0) * 3;
  return bytes;
}

/** Splits by count and by serialized UTF-8 size, so no body passes MAX_RUN_STEPS_POST_BYTES. */
function split(batch: RunStepBatch, runId: string): RunStepBatch[] {
  const parts: RunStepBatch[] = [];
  const base = ENVELOPE_SLACK_BYTES + Buffer.byteLength(runId);
  let steps: RunStepBatch["steps"] = [];
  let size = base;
  for (const step of batch.steps) {
    const bytes = Buffer.byteLength(JSON.stringify(step)) + 1;
    if (steps.length > 0 && (steps.length >= MAX_STEPS_PER_POST || size + bytes > MAX_RUN_STEPS_POST_BYTES)) {
      parts.push({ steps, results: [] });
      steps = [];
      size = base;
    }
    steps.push(step);
    size += bytes;
  }
  if (steps.length > 0) parts.push({ steps, results: [] });
  let results: RunStepBatch["results"] = [];
  let resultBytes = base;
  for (const result of batch.results) {
    const bytes = Buffer.byteLength(JSON.stringify(result)) + 1;
    if (
      results.length > 0 &&
      (results.length >= MAX_RESULTS_PER_POST || resultBytes + bytes > MAX_RUN_STEPS_POST_BYTES)
    ) {
      parts.push({ steps: [], results });
      results = [];
      resultBytes = base;
    }
    results.push(result);
    resultBytes += bytes;
  }
  if (results.length > 0) parts.push({ steps: [], results });
  return parts;
}

export class RunStepForwarder implements RunStepSubmitter {
  private queue: Entry[] = [];
  private queueBytes = 0;
  private draining: Promise<void> | undefined;
  private scheduled = false;
  private closed = false;
  private inflight: AbortController | undefined;
  private dropped = 0;
  private readonly loggedReasons = new Set<string>();

  constructor(private readonly options: RunStepForwarderOptions) {}

  submit(capability: string, runId: string, batch: RunStepBatch): void {
    try {
      if (this.closed) return this.drop("closed");
      const size = estimate(batch);
      if (
        this.queue.length >= (this.options.maxQueue ?? MAX_FORWARD_QUEUE) ||
        this.queueBytes + size > (this.options.maxQueueBytes ?? MAX_FORWARD_QUEUE_BYTES)
      ) {
        return this.drop("queue_full");
      }
      this.queue.push({ capability, runId, batch, estimate: size });
      this.queueBytes += size;
      this.kick();
    } catch {
      this.drop("submit_failed");
    }
  }

  /** Resolves once everything submitted so far was posted or dropped, or after a bound. Never rejects. */
  async flush(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS);
      timer.unref();
    });
    const settled = (async () => {
      while (this.draining || this.scheduled) await (this.draining ?? new Promise((r) => setImmediate(r)));
    })().catch(() => undefined);
    await Promise.race([settled, bound]);
    clearTimeout(timer);
  }

  /** Stops accepting, waits at most the flush bound, then drops what is left and aborts the in-flight POST. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
    const left = this.queue.length;
    this.queue = [];
    this.queueBytes = 0;
    for (let n = 0; n < left; n += 1) this.drop("closed");
    this.inflight?.abort();
  }

  private kick(): void {
    if (this.draining || this.scheduled || this.queue.length === 0) return;
    this.scheduled = true;
    // Off the caller's stack: the first serialization must not run on the relay path.
    setImmediate(() => {
      this.scheduled = false;
      if (this.draining || this.queue.length === 0) return;
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
        this.kick();
      });
    });
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      this.queueBytes -= next.estimate;
      if (this.closed) {
        this.drop("closed");
        continue;
      }
      let bodies: string[];
      try {
        bodies = split(next.batch, next.runId).map((part) => JSON.stringify({ runId: next.runId, ...part }));
      } catch {
        this.drop("serialize_failed");
        continue;
      }
      for (const body of bodies) {
        if (this.closed) this.drop("closed");
        else await this.post(next.capability, body);
      }
    }
  }

  /**
   * The capability goes in the Authorization header only. The response body is never read, and a
   * failure is logged by a fixed reason: an error's or a response's text never reaches a log line.
   */
  private async post(capability: string, body: string): Promise<void> {
    const controller = new AbortController();
    this.inflight = controller;
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.url}${RUN_STEPS_INGRESS_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) this.drop(`http_${response.status}`);
    } catch {
      this.drop(this.closed ? "closed" : controller.signal.aborted ? "timeout" : "unreachable");
    } finally {
      clearTimeout(timer);
      if (this.inflight === controller) this.inflight = undefined;
    }
  }

  private drop(reason: string): void {
    this.dropped += 1;
    const first = !this.loggedReasons.has(reason);
    this.loggedReasons.add(reason);
    if (first || this.dropped % 100 === 0) {
      try {
        (this.options.log ?? forwarderLog).info(
          { event: "run_steps.forward_dropped", reason, droppedParts: this.dropped },
          "coding proxy: run steps not delivered to the control plane",
        );
      } catch {
        // logging must never break the relay
      }
    }
  }
}
