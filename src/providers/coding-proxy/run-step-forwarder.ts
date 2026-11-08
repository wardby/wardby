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
  MAX_STEPS_PER_POST,
  RUN_STEPS_INGRESS_PATH,
  type RunStepBatch,
  type RunStepSubmitter,
} from "../../core/run-steps/types.js";

const forwarderLog = logger.child({ module: "coding-proxy" });
export const MAX_FORWARD_QUEUE = 256;
/** The listener's write can take its lock wait (5 s) plus its transaction (10 s). */
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

export interface RunStepForwarderOptions {
  /** WARDBY_RUN_STEPS_URL, without a trailing slash. */
  url: string;
  fetchImpl?: typeof fetch;
  maxQueue?: number;
  timeoutMs?: number;
  /** How long flush() waits for the queue to settle before giving up. */
  flushTimeoutMs?: number;
  log?: { info(fields: Record<string, unknown>, message: string): void };
}

function split(batch: RunStepBatch): RunStepBatch[] {
  const parts: RunStepBatch[] = [];
  for (let at = 0; at < batch.steps.length; at += MAX_STEPS_PER_POST) {
    parts.push({ steps: batch.steps.slice(at, at + MAX_STEPS_PER_POST), results: [] });
  }
  for (let at = 0; at < batch.results.length; at += MAX_RESULTS_PER_POST) {
    parts.push({ steps: [], results: batch.results.slice(at, at + MAX_RESULTS_PER_POST) });
  }
  return parts;
}

export class RunStepForwarder implements RunStepSubmitter {
  private readonly queue: { capability: string; runId: string; batch: RunStepBatch }[] = [];
  private draining: Promise<void> | undefined;
  private dropped = 0;

  constructor(private readonly options: RunStepForwarderOptions) {}

  submit(capability: string, runId: string, batch: RunStepBatch): void {
    try {
      for (const part of split(batch)) {
        if (this.queue.length >= (this.options.maxQueue ?? MAX_FORWARD_QUEUE)) this.drop("queue_full");
        else this.queue.push({ capability, runId, batch: part });
      }
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
      while (this.draining) await this.draining;
    })().catch(() => undefined);
    await Promise.race([settled, bound]);
    clearTimeout(timer);
  }

  private kick(): void {
    if (this.draining || this.queue.length === 0) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      this.kick();
    });
  }

  private async drain(): Promise<void> {
    for (let next = this.queue.shift(); next; next = this.queue.shift()) {
      await this.post(next.capability, next.runId, next.batch);
    }
  }

  /**
   * The capability goes in the Authorization header only. The response body is never read, and a
   * failure is logged by a fixed reason: an error's or a response's text never reaches a log line.
   */
  private async post(capability: string, runId: string, batch: RunStepBatch): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref();
    try {
      const response = await (this.options.fetchImpl ?? fetch)(`${this.options.url}${RUN_STEPS_INGRESS_PATH}`, {
        method: "POST",
        headers: { authorization: `Bearer ${capability}`, "content-type": "application/json" },
        body: JSON.stringify({ runId, ...batch }),
        redirect: "error",
        signal: controller.signal,
      });
      await response.body?.cancel().catch(() => undefined);
      if (!response.ok) this.drop(`http_${response.status}`);
    } catch {
      this.drop(controller.signal.aborted ? "timeout" : "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  private drop(reason: string): void {
    this.dropped += 1;
    if (this.dropped === 1 || this.dropped % 100 === 0) {
      try {
        (this.options.log ?? forwarderLog).info(
          { event: "run_steps.forward_dropped", reason, dropped: this.dropped },
          "coding proxy: run steps not delivered to the control plane",
        );
      } catch {
        // logging must never break the relay
      }
    }
  }
}
