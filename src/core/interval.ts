/**
 * The one periodic-tick helper every background loop uses (lease heartbeat and sweep, model catalog
 * refresh, scheduler, reconciler, notification dispatcher). A bare `setInterval` plus a `running`
 * flag has two faults this fixes: a tick that never settles (a hung database query) keeps the flag
 * set, so the loop never runs again; and `clearInterval` does not wait for a tick already in flight,
 * which can then start work or write to the database after shutdown has moved on.
 */
import { logger } from "./logger.js";

const intervalLog = logger.child({ module: "interval" });

export type IntervalErrorKind = "error" | "timeout";

export interface IntervalOptions {
  /** Names the loop in logs. */
  name: string;
  everyMs: number;
  /** A tick still running after this long is abandoned and the next one may start. */
  timeoutMs: number;
  /**
   * One pass of the loop. `signal` aborts when the tick times out: pass it to anything that can
   * cancel (fetch, a Prisma query) so an abandoned tick does not keep holding a connection.
   */
  tick: (signal: AbortSignal) => Promise<void>;
  /** Called once per tick that threw or timed out (metrics). Must not throw; if it does, it is ignored. */
  onError?: (kind: IntervalErrorKind, err: unknown) => void;
  /** Run the first tick now instead of one interval after start. */
  runImmediately?: boolean;
}

export interface IntervalHandle {
  /**
   * Stops future ticks and resolves once the tick in flight has settled or timed out, so it is
   * bounded by `timeoutMs`. No tick starts after this is called. Safe to call more than once.
   */
  stop(): Promise<void>;
}

/** Runs `options.tick` every `everyMs`, never two at once, each raced against `timeoutMs`. */
export function startInterval(options: IntervalOptions): IntervalHandle {
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const report = (kind: IntervalErrorKind, err: unknown): void => {
    intervalLog.warn(
      { event: kind === "timeout" ? "interval.tick_timeout" : "interval.tick_failed", loop: options.name, err },
      kind === "timeout" ? `${options.name}: tick timed out and was abandoned` : `${options.name}: tick failed`,
    );
    try {
      options.onError?.(kind, err);
    } catch {
      // A throwing metrics hook must not break the loop.
    }
  };

  const run = (): void => {
    if (stopped || inFlight) return;
    const controller = new AbortController();
    let abandoned = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const settled = (async () => options.tick(controller.signal))().then(
      () => undefined,
      (err: unknown) => {
        // An abandoned tick already counted as a timeout; its late failure is not a second error.
        if (!abandoned) report("error", err);
      },
    );
    const timedOut = new Promise<void>((resolve) => {
      timeoutTimer = setTimeout(() => {
        abandoned = true;
        controller.abort();
        report("timeout", new Error(`${options.name}: tick exceeded ${options.timeoutMs} ms`));
        resolve();
      }, options.timeoutMs);
      timeoutTimer.unref();
    });
    inFlight = Promise.race([settled, timedOut]).finally(() => {
      clearTimeout(timeoutTimer);
      inFlight = undefined;
    });
  };

  const timer = setInterval(run, options.everyMs);
  timer.unref();
  if (options.runImmediately) run();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
