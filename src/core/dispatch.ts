import type { Prisma, PrismaClient, Run, RunTrigger, Task } from "@prisma/client";
import type { Executor } from "../providers/executor/types.js";
import { CODING_PROTOCOL_VERSION, CodingTaskInputSchema } from "../coding/protocol.js";
import { assertCodingProviderModel } from "../coding/provider.js";
import { logger } from "./logger.js";

const dispatchLog = logger.child({ module: "dispatch" });

export type DispatchDb = Pick<
  PrismaClient,
  "agent" | "run" | "codingRun" | "task" | "webhook" | "$transaction" | "$queryRaw"
>;

type DispatchTx = Pick<Prisma.TransactionClient, "agent" | "run" | "codingRun" | "task" | "webhook" | "$queryRaw">;

type DispatchAgent = Prisma.AgentGetPayload<{ include: { codingProfile: true } }>;

export interface DispatchRunOptions {
  db: DispatchDb;
  executor: Executor;
  agentId: string;
  trigger?: RunTrigger;
  codingTask?: string;
  codingBaseRef?: string;
  now?: Date;
  lockAgent?: boolean;
  task?: { principalId: string; ttlMs: number };
  beforePersist?: (tx: DispatchTx, agent: DispatchAgent) => Promise<boolean>;
}

export interface DispatchRunResult {
  run: Run;
  task?: Task;
}

function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { code?: unknown; meta?: { code?: unknown } };
  return candidate.code === "P2034" || (candidate.code === "P2010" && candidate.meta?.code === "40001");
}

/**
 * Record an executor-level failure on a run that never reached a terminal
 * state itself. Deliberately idempotent: the same failure can arrive twice —
 * DbosExecutor.start() calls this when the workflow handle rejects, and
 * dispatchRun's `.catch` around that same `start()` call calls it again — and
 * the conditional `updateMany` makes the second call match zero rows rather
 * than overwrite whatever landed in between.
 */
export async function markRunFailedFromExecutorError(
  db: Pick<DispatchDb, "run">,
  runId: string,
  err: unknown,
): Promise<void> {
  await db.run.updateMany({
    where: { id: runId, status: { in: ["pending", "running"] } },
    data: {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    },
  });
}

/**
 * Persists every detached run input in one transaction, then invokes the
 * executor only after commit. A null result means the caller's transactional
 * claim was no longer valid (for example, a schedule was already claimed).
 */
export async function dispatchRun(options: DispatchRunOptions): Promise<DispatchRunResult | null> {
  const now = options.now ?? new Date();
  const persistOnce = () =>
    options.db.$transaction(
      async (tx) => {
        if (options.lockAgent) {
          const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Agent" WHERE "id" = ${options.agentId} FOR UPDATE SKIP LOCKED
      `;
          if (locked.length === 0) return null;
        }

        const agent = await tx.agent.findUnique({
          where: { id: options.agentId },
          include: { codingProfile: true },
        });
        if (!agent) throw new Error(`Unknown agent "${options.agentId}".`);
        if (options.beforePersist && !(await options.beforePersist(tx, agent))) return null;

        const run = await tx.run.create({
          data: {
            agentId: agent.id,
            trigger: options.trigger ?? "manual",
            executionManaged: true,
          },
        });

        if (agent.kind === "coding") {
          if (!agent.codingProfile) throw new Error(`Coding agent "${agent.id}" has no coding profile.`);
          assertCodingProviderModel(agent.codingProfile.provider, agent.model);
          const task = options.codingTask ?? agent.codingProfile.defaultTask;
          if (!task) throw new Error(`Coding agent "${agent.id}" requires a task.`);
          const headRef = `reevo/run-${run.id}`;
          const input = CodingTaskInputSchema.parse({
            schemaVersion: CODING_PROTOCOL_VERSION,
            runId: run.id,
            repository: agent.codingProfile.repository,
            baseRef: options.codingBaseRef ?? agent.codingProfile.baseRef,
            headRef,
            task,
            model: agent.model,
            budgetUsd: Number(agent.budgetUsd),
            deadlineAt: new Date(now.getTime() + agent.codingProfile.timeoutSec * 1000).toISOString(),
          });
          const workerImage = options.executor.resolveCodingWorkerImage?.({
            provider: agent.codingProfile.provider,
            toolchain: agent.codingProfile.toolchain,
            toolchainVersion: agent.codingProfile.toolchainVersion,
            workerImageRef: agent.codingProfile.workerImageRef,
          });
          await tx.codingRun.create({
            data: {
              runId: run.id,
              task: input.task,
              repository: input.repository,
              baseRef: input.baseRef,
              headRef: input.headRef,
              provider: agent.codingProfile.provider,
              model: input.model,
              timeoutSec: agent.codingProfile.timeoutSec,
              allowedEgress: agent.codingProfile.allowedEgress as Prisma.InputJsonValue,
              protectedPaths: agent.codingProfile.protectedPaths as Prisma.InputJsonValue,
              workerImage,
              budgetReservedUsd: agent.budgetUsd,
            },
          });
        } else if (options.codingTask !== undefined || options.codingBaseRef !== undefined) {
          throw new Error("Coding overrides cannot be supplied for a native agent.");
        }

        const task = options.task
          ? await tx.task.create({
              data: {
                kind: "run",
                runId: run.id,
                principalId: options.task.principalId,
                status: "working",
                ttlAt: new Date(now.getTime() + options.task.ttlMs),
              },
            })
          : undefined;
        return { run, task };
      },
      { isolationLevel: "Serializable" },
    );

  let persisted: DispatchRunResult | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      persisted = await persistOnce();
      break;
    } catch (err) {
      if (!isSerializationConflict(err) || attempt === 2) throw err;
    }
  }

  if (!persisted) return null;
  try {
    void options.executor
      .start(persisted.run.id)
      .catch((err) => markRunFailedFromExecutorError(options.db, persisted.run.id, err))
      .catch((err) => dispatchLog.error({ err, runId: persisted.run.id }, "failed to persist executor start failure"));
  } catch (err) {
    await markRunFailedFromExecutorError(options.db, persisted.run.id, err);
  }
  return persisted;
}
