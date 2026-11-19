import { describe, expect, it } from "vitest";
import { CodingMetrics, InMemoryCodingRunObserver, PinoCodingRunObserver } from "./observability.js";

describe("coding lifecycle observability", () => {
  it("counts lifecycle, budget, terminal, and cleanup outcomes without carrying source data", () => {
    const observer = new InMemoryCodingRunObserver();
    observer.emit({ stage: "queued", runId: "run-1", budgetReservedUsd: 0.5 });
    observer.emit({ stage: "launched", runId: "run-1", jobId: "job-opaque" });
    observer.emit({ stage: "terminal", runId: "run-1", outcome: "succeeded", durationMs: 120, budgetActualUsd: 0.1 });
    observer.emit({ stage: "cleanup", runId: "run-1", jobId: "job-opaque", cleanupSucceeded: true });

    expect(observer.events).toEqual([
      { stage: "queued", runId: "run-1", budgetReservedUsd: 0.5 },
      { stage: "launched", runId: "run-1", jobId: "job-opaque" },
      { stage: "terminal", runId: "run-1", outcome: "succeeded", durationMs: 120, budgetActualUsd: 0.1 },
      { stage: "cleanup", runId: "run-1", jobId: "job-opaque", cleanupSucceeded: true },
    ]);
    expect(observer.metrics.snapshot()).toMatchObject({
      stages: { queued: 1, launched: 1, terminal: 1, cleanup: 1 },
      terminalOutcomes: { succeeded: 1 },
      activeJobs: 0,
      cleanupFailures: 0,
      budgetReservedUsd: 0.5,
      budgetActualUsd: 0.1,
      runtimeMsTotal: 120,
    });
  });

  it("fans events out to attached sinks until they are detached", () => {
    const observer = new PinoCodingRunObserver();
    const sink = new InMemoryCodingRunObserver();
    const detach = observer.addSink(sink);
    observer.emit({ stage: "launched", runId: "run-1", jobId: "job-opaque" });
    detach();
    observer.emit({ stage: "cleanup", runId: "run-1", jobId: "job-opaque", cleanupSucceeded: true });

    expect(sink.events).toEqual([{ stage: "launched", runId: "run-1", jobId: "job-opaque" }]);
    expect(observer.snapshot().stages).toMatchObject({ launched: 1, cleanup: 1 });
  });

  it("keeps delivering to the other sinks when one throws", () => {
    const observer = new PinoCodingRunObserver();
    const failing = {
      emit: () => {
        throw new Error("sink down");
      },
    };
    const sink = new InMemoryCodingRunObserver();
    observer.addSink(failing);
    observer.addSink(sink);

    expect(() => observer.emit({ stage: "queued", runId: "run-1" })).not.toThrow();
    expect(sink.events).toEqual([{ stage: "queued", runId: "run-1" }]);
  });

  it("never allows active-job or cleanup-failure counters to become ambiguous", () => {
    const metrics = new CodingMetrics();
    metrics.emit({ stage: "cleanup", runId: "run-1", cleanupSucceeded: false });
    expect(metrics.snapshot()).toMatchObject({ activeJobs: 0, cleanupFailures: 1 });
  });
});
