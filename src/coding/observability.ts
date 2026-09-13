import { logger } from "../core/logger.js";

/**
 * Metadata-only lifecycle telemetry for coding runs. Keep untrusted task and
 * repository data out of this boundary so log retention cannot become source
 * retention by accident.
 */
export type CodingLifecycleStage =
  | "queued"
  | "prepared"
  | "launched"
  | "running"
  | "budget_cutoff"
  | "stopping"
  | "collected"
  | "pull_request_opened"
  | "pull_request_updated"
  | "terminal"
  | "cleanup";

export interface CodingLifecycleEvent {
  stage: CodingLifecycleStage;
  runId: string;
  /** Opaque launcher handle, never a container command line or environment. */
  jobId?: string;
  outcome?: "succeeded" | "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled";
  failureCategory?: string;
  diagnosticId?: string;
  durationMs?: number;
  budgetReservedUsd?: number;
  budgetActualUsd?: number;
  cleanupSucceeded?: boolean;
  /** Enumerated execution metadata only; never a model request or source field. */
  workerProvider?: "codex" | "claude-code";
  proxyProtocol?: "openai-responses" | "anthropic-messages";
}

export interface CodingRunObserver {
  emit(event: CodingLifecycleEvent): void;
}

export interface CodingMetricsSnapshot {
  stages: Record<CodingLifecycleStage, number>;
  terminalOutcomes: Record<string, number>;
  activeJobs: number;
  cleanupFailures: number;
  budgetReservedUsd: number;
  budgetActualUsd: number;
  runtimeMsTotal: number;
}

/** A small exporter-neutral aggregate that monitoring adapters can scrape or forward. */
export class CodingMetrics implements CodingRunObserver {
  private readonly stages = Object.fromEntries(
    [
      "queued",
      "prepared",
      "launched",
      "running",
      "budget_cutoff",
      "stopping",
      "collected",
      "pull_request_opened",
      "pull_request_updated",
      "terminal",
      "cleanup",
    ].map((stage) => [stage, 0]),
  ) as Record<CodingLifecycleStage, number>;
  private readonly terminalOutcomes: Record<string, number> = {};
  private activeJobs = 0;
  private cleanupFailures = 0;
  private budgetReservedUsd = 0;
  private budgetActualUsd = 0;
  private runtimeMsTotal = 0;

  emit(event: CodingLifecycleEvent): void {
    this.stages[event.stage] += 1;
    if (event.stage === "launched") this.activeJobs += 1;
    if (event.stage === "cleanup") {
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      if (event.cleanupSucceeded === false) this.cleanupFailures += 1;
    }
    if (event.stage === "terminal" && event.outcome) {
      this.terminalOutcomes[event.outcome] = (this.terminalOutcomes[event.outcome] ?? 0) + 1;
    }
    if (event.budgetReservedUsd !== undefined) this.budgetReservedUsd += event.budgetReservedUsd;
    if (event.budgetActualUsd !== undefined) this.budgetActualUsd += event.budgetActualUsd;
    if (event.durationMs !== undefined) this.runtimeMsTotal += event.durationMs;
  }

  snapshot(): CodingMetricsSnapshot {
    return {
      stages: { ...this.stages },
      terminalOutcomes: { ...this.terminalOutcomes },
      activeJobs: this.activeJobs,
      cleanupFailures: this.cleanupFailures,
      budgetReservedUsd: this.budgetReservedUsd,
      budgetActualUsd: this.budgetActualUsd,
      runtimeMsTotal: this.runtimeMsTotal,
    };
  }
}

export class PinoCodingRunObserver implements CodingRunObserver {
  constructor(private readonly metrics = new CodingMetrics()) {}

  emit(event: CodingLifecycleEvent): void {
    this.metrics.emit(event);
    logger.info({ event: `coding.${event.stage}`, ...event }, "coding run lifecycle");
  }

  snapshot(): CodingMetricsSnapshot {
    return this.metrics.snapshot();
  }
}

/** Default application observer. Production log infrastructure owns retention. */
export const codingRunObserver = new PinoCodingRunObserver();

export class InMemoryCodingRunObserver implements CodingRunObserver {
  readonly events: CodingLifecycleEvent[] = [];
  readonly metrics = new CodingMetrics();

  emit(event: CodingLifecycleEvent): void {
    const copy = { ...event };
    this.events.push(copy);
    this.metrics.emit(copy);
  }
}
