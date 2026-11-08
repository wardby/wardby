/**
 * The one writer of RunStep rows. Every source hands it batches (RunStepSink). Before anything is
 * stored, each step's text is redacted by exact value against the secret values the loader covers:
 * the agent's secrets (readable and brokered) and its attached MCP servers' secrets, the same source
 * the transcript recorder uses; run capabilities are masked by token shape. The native-sandbox
 * gateway capability is passed by the gateway as `extraSecretValues` and redacted the same way. A batch whose run's secret values
 * can't be read writes nothing (fail closed). A step whose kind is unknown, whose callId is invalid or
 * would change under redaction is dropped and not counted in stepsDropped; only steps past the cap are
 * counted, once per callId. One run's batches are written in arrival order, within one process only
 * (step/result ordering across processes is not guaranteed), under a row lock on the run, so seq has
 * no gaps or duplicates whichever process writes. Known limits: a dropped step may be counted again
 * after a process restart, after its run is evicted from the remembered set, past the per-run id
 * limit, or when two processes write the same run. A result is matched only to a stored callId, which
 * is already clean, so a result's callId is never persisted. Log lines
 * carry the run id, a fixed event code and an error's name: never text, never an error's message.
 */
import { createHash } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { redactSecrets } from "../../coding/redact.js";
import { logger } from "../logger.js";
import { loadAgentSecretValues } from "../secret-guard.js";
import { effectiveRunStepsLevel, loadRunStepRetentionDays, loadRunStepsLevel, type RunStepsLevel } from "./config.js";
import { stepSummary } from "./summarize.js";
import {
  MAX_RUN_STEPS,
  STEP_CALL_ID,
  STEP_STATUS,
  STEP_TOOL_NAME,
  type ExtractedStep,
  type RunStepBatch,
  type RunStepSink,
} from "./types.js";

const stepsLog = logger.child({ module: "run-steps" });
const DAY_MS = 24 * 60 * 60 * 1000;
const TX = { maxWait: 5_000, timeout: 10_000 } as const;
/** How long flush() waits for queued writes at shutdown. */
export const FLUSH_TIMEOUT_MS = 5_000;
/** Over-cap callIds remembered (as 32-character hashes): at most this many per run and in all. */
const DROPPED_PER_RUN = 10_000;
const DROPPED_TOTAL = 200_000;
const callKey = (callId: string): string => createHash("sha256").update(callId).digest("hex").slice(0, 32);

export type RunStepWriterDb = Pick<PrismaClient, "run" | "runStep" | "$transaction">;

export interface RunStepWriterDeps {
  db: RunStepWriterDb;
  /** Every secret value of the agent (already with JSON-escaped forms); rejects when any can't be read. */
  secretValues: (agentId: string) => Promise<string[]>;
  level: RunStepsLevel;
  retentionDays: number;
  /** Tests only; MAX_RUN_STEPS otherwise. */
  maxSteps?: number;
  /** Tests only; the remembered-callId limits (per run, in all). */
  droppedLimits?: { perRun: number; total: number };
  now?: () => Date;
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}

function uniqueByCallId(steps: readonly ExtractedStep[]): ExtractedStep[] {
  const seen = new Set<string>();
  return steps.filter((step) => {
    if (!STEP_CALL_ID.test(step.callId) || seen.has(step.callId)) return false;
    seen.add(step.callId);
    return true;
  });
}

function safeToolName(tool: string, secretValues: readonly string[]): string {
  const shown = redactSecrets(tool, secretValues);
  return STEP_TOOL_NAME.test(shown) ? shown : "tool";
}

export class RunStepWriter implements RunStepSink {
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * Hashes of the callIds already counted in stepsDropped, so history resent past the cap is not
   * counted again. Least recently used run first; bounded in total, whatever the ids' length.
   */
  private readonly droppedIds = new Map<string, Set<string>>();

  constructor(private readonly deps: RunStepWriterDeps) {}

  record(runId: string, batch: RunStepBatch, extraSecretValues: readonly string[] = []): Promise<void> {
    if (effectiveRunStepsLevel(this.deps.level) === "off") return Promise.resolve();
    if (batch.steps.length === 0 && batch.results.length === 0) return Promise.resolve();
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous
      .then(() => this.write(runId, batch, extraSecretValues))
      .catch((err: unknown) => {
        (this.deps.log ?? stepsLog).warn(
          { runId, event: "run_steps_write_failed", errorName: err instanceof Error ? err.name : typeof err },
          "could not record a run's steps; they were dropped",
        );
      });
    this.queues.set(runId, next);
    void next.then(() => {
      if (this.queues.get(runId) === next) this.queues.delete(runId);
    });
    return next;
  }

  /**
   * Resolves when every write queued so far has settled, or after `timeoutMs`: called before the
   * process disconnects from the database, so a run's last steps are not cut off. Never rejects.
   */
  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    const pending = [...this.queues.values()];
    if (pending.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([Promise.allSettled(pending), bound]);
    } finally {
      clearTimeout(timer);
    }
  }

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async write(runId: string, batch: RunStepBatch, extraSecretValues: readonly string[]): Promise<void> {
    const { db } = this.deps;
    const run = await db.run.findUnique({ where: { id: runId }, select: { agentId: true } });
    if (!run) return;
    const steps = uniqueByCallId(batch.steps.filter((step) => step.kind === "tool" || step.kind === "said"));
    // Read fresh for every batch (never cached: a rotated or newly attached secret must be covered).
    // Rejects (and the batch is dropped) when the values can't be read: never an unredacted write.
    const values =
      steps.length > 0 ? [...(await this.deps.secretValues(run.agentId)), ...extraSecretValues.filter(Boolean)] : [];
    const at = this.now();
    const expiresAt = new Date(at.getTime() + this.deps.retentionDays * DAY_MS);
    // callId is stored as text: a step whose callId holds a secret value is not stored at all.
    const clean = steps.filter((step) => redactSecrets(step.callId, values) === step.callId);
    const rows = clean.map((step) => ({
      kind: step.kind,
      tool: step.kind === "tool" ? safeToolName(step.tool, values) : null,
      callId: step.callId,
      summary: stepSummary(step, values),
      at,
      expiresAt,
    }));
    const results = batch.results.filter((r) => STEP_CALL_ID.test(r.callId) && STEP_STATUS.test(r.status));
    const maxSteps = this.deps.maxSteps ?? MAX_RUN_STEPS;
    const counted = this.droppedIds.get(runId) ?? new Set<string>();
    if (this.droppedIds.has(runId)) {
      this.droppedIds.delete(runId);
      this.droppedIds.set(runId, counted);
    }
    const newlyDropped: string[] = [];
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "Run" WHERE "id" = ${runId} FOR UPDATE`;
      if (rows.length > 0) {
        const existing = await tx.runStep.findMany({
          where: { runId, callId: { in: rows.map((row) => row.callId) } },
          select: { callId: true },
        });
        const known = new Set(existing.map((row) => row.callId));
        const fresh = rows.filter((row) => !known.has(row.callId));
        const last = await tx.runStep.findFirst({ where: { runId }, orderBy: { seq: "desc" }, select: { seq: true } });
        const start = last?.seq ?? 0;
        const kept = fresh.slice(0, Math.max(0, maxSteps - start));
        if (kept.length > 0) {
          await tx.runStep.createMany({ data: kept.map((row, index) => ({ ...row, runId, seq: start + index + 1 })) });
        }
        const over = fresh.slice(kept.length).filter((row) => !counted.has(callKey(row.callId)));
        newlyDropped.push(...over.map((row) => row.callId));
        const dropped = over.length;
        if (dropped > 0) await tx.run.update({ where: { id: runId }, data: { stepsDropped: { increment: dropped } } });
      }
      for (const result of results) {
        // The first status wins: a result resent with the history, or replayed, changes nothing.
        await tx.runStep.updateMany({
          where: { runId, callId: result.callId, kind: "tool", status: null },
          data: { status: result.status },
        });
      }
    }, TX);
    if (newlyDropped.length > 0) this.rememberDropped(runId, counted, newlyDropped);
  }

  private rememberDropped(runId: string, counted: Set<string>, ids: readonly string[]): void {
    const limits = this.deps.droppedLimits ?? { perRun: DROPPED_PER_RUN, total: DROPPED_TOTAL };
    for (const id of ids) if (counted.size < limits.perRun) counted.add(callKey(id));
    this.droppedIds.delete(runId);
    this.droppedIds.set(runId, counted);
    while (this.rememberedDroppedCount() > limits.total && this.droppedIds.size > 1) {
      this.droppedIds.delete(this.droppedIds.keys().next().value as string);
    }
  }

  /** How many dropped callIds are remembered in all (tests). */
  rememberedDroppedCount(): number {
    let total = 0;
    for (const set of this.droppedIds.values()) total += set.size;
    return total;
  }
}

/** The process's writer: settings from the environment (an invalid value throws, naming it). */
export function buildRunStepWriter(
  db: PrismaClient,
  cipher: Parameters<typeof loadAgentSecretValues>[1],
  env: NodeJS.ProcessEnv = process.env,
): RunStepWriter {
  return new RunStepWriter({
    db,
    level: loadRunStepsLevel(env),
    retentionDays: loadRunStepRetentionDays(env),
    secretValues: async (agentId) =>
      (await loadAgentSecretValues(db, cipher, agentId)).flatMap((entry) => entry.values),
  });
}
