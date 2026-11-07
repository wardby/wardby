/**
 * The one writer of RunStep rows. Every source hands it batches (RunStepSink). Before anything is
 * stored, each step's text is redacted by exact value against the run's agent secret values (every
 * attached secret, readable or brokered, and every attached MCP server's secrets: the same source the
 * transcript recorder uses), then by token shape, then cut (stepSummary). A batch whose run's secret
 * values can't be read writes nothing (fail closed). One run's batches are written in arrival order,
 * under a row lock on the run, so seq has no gaps or duplicates whichever process writes. Log lines
 * carry the run id, a fixed event code and an error's name: never text, never an error's message.
 */
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

export type RunStepWriterDb = Pick<PrismaClient, "run" | "runStep" | "$transaction">;

export interface RunStepWriterDeps {
  db: RunStepWriterDb;
  /** Every secret value of the agent (already with JSON-escaped forms); rejects when any can't be read. */
  secretValues: (agentId: string) => Promise<string[]>;
  level: RunStepsLevel;
  retentionDays: number;
  /** Tests only; MAX_RUN_STEPS otherwise. */
  maxSteps?: number;
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

  constructor(private readonly deps: RunStepWriterDeps) {}

  record(runId: string, batch: RunStepBatch): Promise<void> {
    if (effectiveRunStepsLevel(this.deps.level) === "off") return Promise.resolve();
    if (batch.steps.length === 0 && batch.results.length === 0) return Promise.resolve();
    const previous = this.queues.get(runId) ?? Promise.resolve();
    const next = previous
      .then(() => this.write(runId, batch))
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

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  private async write(runId: string, batch: RunStepBatch): Promise<void> {
    const { db } = this.deps;
    const run = await db.run.findUnique({ where: { id: runId }, select: { agentId: true } });
    if (!run) return;
    const steps = uniqueByCallId(batch.steps);
    // Read fresh for every batch (never cached: a rotated or newly attached secret must be covered).
    // Rejects (and the batch is dropped) when the values can't be read: never an unredacted write.
    const values = steps.length > 0 ? await this.deps.secretValues(run.agentId) : [];
    const at = this.now();
    const expiresAt = new Date(at.getTime() + this.deps.retentionDays * DAY_MS);
    const rows = steps.map((step) => ({
      kind: step.kind,
      tool: step.kind === "tool" ? safeToolName(step.tool, values) : null,
      callId: step.callId,
      summary: stepSummary(step, values),
      at,
      expiresAt,
    }));
    const results = batch.results.filter((r) => STEP_CALL_ID.test(r.callId) && STEP_STATUS.test(r.status));
    const maxSteps = this.deps.maxSteps ?? MAX_RUN_STEPS;
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
        const dropped = fresh.length - kept.length;
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
