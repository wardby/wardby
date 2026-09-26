import type { Prisma, PrismaClient, Run, RunTrigger, Task } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import {
  CODING_PROTOCOL_VERSION,
  CodingTaskInputSchema,
  normalizeGitHubRepository,
  publicCodingRunResult,
  composeCodingTask,
} from "../coding/protocol.js";
import { assertCodingProviderModel } from "../coding/provider.js";
import { effectiveBudgetForRun, MIN_RESERVATION_USD, type BudgetConstraint } from "./budget-groups.js";
import { logger } from "./logger.js";

const dispatchLog = logger.child({ module: "dispatch" });

export type DispatchDb = Pick<
  PrismaClient,
  "agent" | "run" | "runHostCheck" | "codingRun" | "task" | "webhook" | "budgetGroup" | "$transaction" | "$queryRaw"
>;

export type DispatchTx = Pick<
  Prisma.TransactionClient,
  | "agent"
  | "run"
  | "runHostCheck"
  | "codingRun"
  | "task"
  | "webhook"
  | "budgetGroup"
  | "resourceGrant"
  | "$queryRaw"
  | "$executeRawUnsafe"
>;

type DispatchAgent = Prisma.AgentGetPayload<{ include: { codingProfile: true } }>;

export interface DispatchRunOptions {
  db: DispatchDb;
  executor: Executor;
  agentId: string;
  trigger?: RunTrigger;
  codingTask?: string;
  codingBaseRef?: string;
  /**
   * Revision-in-place: the id of a prior CodingRun whose branch/PR this
   * dispatch should push a new
   * commit onto instead of opening a fresh branch. Resolved and verified
   * here against the database (same repository, and it actually reached a
   * PR-opening outcome) -- never trusted as a raw branch name, and
   * deliberately not restricted to the same agent (cross-role continuation,
   * e.g. plan -> implement on one PR, is allowed by design). Mutually
   * exclusive with `codingBaseRef`. Coding agents only.
   */
  continuesCodingRunId?: string;
  now?: Date;
  lockAgent?: boolean;
  task?: { principalId: string; ttlMs: number };
  beforePersist?: (tx: DispatchTx, agent: DispatchAgent) => Promise<boolean>;
  /**
   * Runs inside the persist transaction right after the run row is created,
   * before the executor is started — for rows that must exist before the run
   * can observe them (e.g. RunHostCheck, see core/host-events.ts).
   */
  afterPersist?: (tx: DispatchTx, run: Run) => Promise<void>;
  /**
   * Who the run is visible to besides the agent owner (Run.triggeredById,
   * resource-sharing grants spec §3.5): the trigger_agent caller, a
   * webhook's creator, a sub-agent's parent triggerer. Omit/null for
   * scheduled and host-event runs, which only the owner sees.
   */
  triggeredById?: string | null;
  /** Sub-agent dispatch (see AgentSubAgent): links this run into a run tree. */
  parentRunId?: string;
  grantedParentMemoryKeys?: string[];
  /**
   * Per-run task text for a NATIVE agent (appended to its systemPrompt at
   * load time — see runner.ts). The native equivalent of `codingTask`;
   * mutually exclusive with it, since a native run has no CodingRun.
   */
  taskOverride?: string;
  /**
   * Replaces `agent.budgetUsd` as the requested ceiling for this run's coding
   * budget reservation. The reservation is still tightened by the agent's
   * budget group and, with `parentRunId`, the run tree (see
   * src/core/budget-groups.ts), computed inside the persist transaction.
   * Ignored for native agents, which compute their own effective budget
   * inside executeRun's load step.
   */
  budgetUsdOverride?: number;
  /**
   * Default (false/undefined): fire-and-forget, matching every existing
   * caller (webhook ingress, trigger_agent, the scheduler) — none of them
   * want to block on a potentially long-running coding container. Set true
   * only when the caller genuinely wants to await the run's terminal state,
   * e.g. a sub-agent dispatch tool blocking the parent's own turn.
   */
  awaitExecution?: boolean;
}

export interface DispatchRunResult {
  run: Run;
  task?: Task;
}

/** SQLSTATEs worth retrying the persist transaction for: serialization failure, deadlock. */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

/**
 * A transient transaction conflict in the Serializable persist transaction:
 * a serialization failure (40001) or a deadlock (40P01). It arrives in one of
 * three shapes:
 * - on a model statement: P2034;
 * - on a raw statement ($queryRaw, e.g. the FOR UPDATE SKIP LOCKED below, or
 *   anything a beforePersist callback runs): P2010, with the SQLSTATE at
 *   meta.driverAdapterError.cause.originalCode under the pg driver adapter
 *   (Prisma 7) -- Prisma 6's engine put 40001 at meta.code, still accepted;
 * - at COMMIT (e.g. SSI write skew): an unwrapped DriverAdapterError, no
 *   code or meta, with the SQLSTATE at cause.originalCode.
 *
 * @internal Exported only for the real-PostgreSQL tests.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as {
    name?: unknown;
    code?: unknown;
    cause?: { originalCode?: unknown };
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (candidate.code === "P2034") return true;
  if (candidate.code === "P2010") {
    const sqlState = candidate.meta?.driverAdapterError?.cause?.originalCode;
    return (typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState)) || candidate.meta?.code === "40001";
  }
  if (candidate.name === "DriverAdapterError") {
    const sqlState = candidate.cause?.originalCode;
    return typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState);
  }
  return false;
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
 * The `Run.error` of a coding run refused at dispatch because a budget
 * constraint has nothing left: `budget_group_exhausted:<period>` or
 * `run_tree_exhausted`, then a sentence for people.
 */
export function budgetExhaustedError(constraint: BudgetConstraint): string {
  if (constraint === "run-tree") {
    return "run_tree_exhausted: the run tree's shared budget is spent; the run was not started.";
  }
  return (
    `budget_group_exhausted:${constraint}: the agent's budget group has no ${constraint} budget left ` +
    "(recorded spend plus live in-flight runs' holds have reached its cap); the run was not started."
  );
}

/**
 * Serializes grouped coding dispatches (security review I1). Under
 * Serializable, a row lock taken after the transaction's first read cannot
 * queue anything: the snapshot is already fixed, so each waiter wakes up
 * with a stale view and aborts. LOCK TABLE is the one statement that takes
 * no snapshot, so as the transaction's first statement it makes a waiter's
 * snapshot start only after the previous holder committed. SHARE ROW
 * EXCLUSIVE conflicts with itself and with writes to BudgetGroup rows, but not
 * with the ROW SHARE that foreign-key checks from Agent take, so attaching
 * agents to groups is not blocked. It serializes grouped coding dispatches
 * across all groups; each holds it only for one short transaction.
 */
const GROUP_DISPATCH_LOCK_SQL = 'LOCK TABLE "BudgetGroup" IN SHARE ROW EXCLUSIVE MODE';

/**
 * A coding run's budget reservation: the requested ceiling (override or the
 * agent's budgetUsd) tightened by its budget group and run tree, where every
 * live in-flight run's unspent hold already counts as spent. Rounded down to
 * CodingRun.budgetReservedUsd's 6 decimal places; less than that is refused.
 */
async function reserveCodingBudget(
  tx: DispatchTx,
  agent: DispatchAgent,
  now: Date,
  options: DispatchRunOptions,
): Promise<{ budgetUsd: number; refusal?: string }> {
  const effective = await effectiveBudgetForRun(tx, agent, now, options.parentRunId);
  const requested = options.budgetUsdOverride ?? Number(agent.budgetUsd);
  const budgetUsd =
    Math.floor(Math.min(requested, effective.effectiveBudgetUsd) / MIN_RESERVATION_USD) * MIN_RESERVATION_USD;
  if (budgetUsd < MIN_RESERVATION_USD && effective.exhaustedBy) {
    return { budgetUsd: 0, refusal: budgetExhaustedError(effective.exhaustedBy) };
  }
  return { budgetUsd };
}

/**
 * Attempts for the persist transaction, and the jittered backoff between
 * them, for serialization failures and deadlocks.
 *
 * @internal Exported only for the real-PostgreSQL tests.
 */
export const PERSIST_ATTEMPTS = 8;
const RETRY_BASE_MS = 20;
const RETRY_MAX_MS = 250;

function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * Persists every detached run input in one transaction, then invokes the
 * executor only after commit. A null result means the caller's transactional
 * claim was no longer valid (for example, a schedule was already claimed).
 */
export async function dispatchRun(options: DispatchRunOptions): Promise<DispatchRunResult | null> {
  const now = options.now ?? new Date();
  // Read outside the transaction only to decide whether to take the group
  // dispatch lock before the transaction's first read; everything the run is
  // built from is re-read inside. If the agent changes in between, the
  // Serializable transaction still refuses a conflicting commit.
  const preview = await options.db.agent.findUnique({
    where: { id: options.agentId },
    select: { kind: true, budgetGroupId: true },
  });
  const lockGroups = preview?.kind === "coding" && preview.budgetGroupId != null;
  const persistOnce = () =>
    options.db.$transaction(
      async (tx) => {
        if (lockGroups) await tx.$executeRawUnsafe(GROUP_DISPATCH_LOCK_SQL);
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

        if (options.taskOverride !== undefined && agent.kind !== "native") {
          throw new Error("taskOverride can only be supplied for a native agent.");
        }

        // A coding run's budget is reserved here, at dispatch (E-01): the
        // container only ever checks the run's own reservation. A native run
        // computes its effective budget in executeRun's load step instead.
        let codingBudget: { budgetUsd: number; refusal?: string } | undefined;
        if (agent.kind === "coding") {
          if (!agent.codingProfile) throw new Error(`Coding agent "${agent.id}" has no coding profile.`);
          assertCodingProviderModel(agent.codingProfile.provider, agent.model);
          codingBudget = await reserveCodingBudget(tx, agent, now, options);
        }
        const refusal = codingBudget?.refusal;

        const run = await tx.run.create({
          data: {
            agentId: agent.id,
            trigger: options.trigger ?? "manual",
            executionManaged: true,
            parentRunId: options.parentRunId,
            grantedParentMemoryKeys: options.grantedParentMemoryKeys ?? [],
            taskOverride: options.taskOverride,
            triggeredById: options.triggeredById ?? null,
            // Refused before it starts, the same terminal status (and zero
            // spend) as a native run whose budget is gone at turn 1.
            ...(refusal ? { status: "refused" as const, error: refusal, finishedAt: now } : {}),
          },
        });

        if (options.afterPersist) await options.afterPersist(tx, run);

        if (agent.kind === "coding" && agent.codingProfile && codingBudget && !refusal) {
          // Checked above too; repeated so the provider type narrows here.
          assertCodingProviderModel(agent.codingProfile.provider, agent.model);
          const request = options.codingTask ?? agent.codingProfile.defaultTask;
          if (!request) throw new Error(`Coding agent "${agent.id}" requires a task.`);
          // The worker sees only the task text, so the agent's own instructions ride in it.
          const task = composeCodingTask(agent.systemPrompt, request);
          const budgetUsd = codingBudget.budgetUsd;

          let baseRef = options.codingBaseRef ?? agent.codingProfile.baseRef;
          let headRef = `wardby/run-${run.id}`;
          let continuationOf: { runId: string } | undefined;
          let rootCodingRunId: string | undefined;
          if (options.continuesCodingRunId !== undefined) {
            if (options.codingBaseRef !== undefined) {
              throw new Error("continuesCodingRunId cannot be combined with codingBaseRef.");
            }
            const candidate = await tx.codingRun.findUnique({ where: { runId: options.continuesCodingRunId } });
            if (!candidate) throw new Error("Cannot continue an unknown coding run.");
            const root = candidate.rootCodingRunId
              ? await tx.codingRun.findUnique({ where: { runId: candidate.rootCodingRunId } })
              : candidate;
            if (!root) throw new Error("Cannot continue an unknown coding run.");
            if (
              normalizeGitHubRepository(root.repository) !== normalizeGitHubRepository(agent.codingProfile.repository)
            ) {
              throw new Error("Cannot continue a coding run from a different repository.");
            }
            const rootResult = publicCodingRunResult(root.result);
            if (rootResult?.outcome !== "pull_request_opened" && rootResult?.outcome !== "pull_request_updated") {
              throw new Error("Cannot continue a coding run that never opened a pull request.");
            }
            baseRef = root.baseRef;
            headRef = root.headRef;
            continuationOf = { runId: root.runId };
            rootCodingRunId = root.runId;
          }

          const input = CodingTaskInputSchema.parse({
            schemaVersion: CODING_PROTOCOL_VERSION,
            runId: run.id,
            repository: agent.codingProfile.repository,
            baseRef,
            headRef,
            task,
            model: agent.model,
            budgetUsd,
            deadlineAt: new Date(now.getTime() + agent.codingProfile.timeoutSec * 1000).toISOString(),
            continuationOf,
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
              protectedPaths: agent.codingProfile.protectedPaths as Prisma.InputJsonValue,
              collectExclude: agent.codingProfile.collectExclude as Prisma.InputJsonValue,
              packageAllowlist: agent.codingProfile.packageAllowlist as Prisma.InputJsonValue,
              packagePolicy: agent.codingProfile.packagePolicy as Prisma.InputJsonValue,
              workerImage,
              budgetReservedUsd: budgetUsd,
              rootCodingRunId,
              workspaceDiskMb: agent.codingProfile.workspaceDiskMb,
            },
          });
        } else if (
          agent.kind !== "coding" &&
          (options.codingTask !== undefined ||
            options.codingBaseRef !== undefined ||
            options.continuesCodingRunId !== undefined)
        ) {
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
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
    try {
      persisted = await persistOnce();
      break;
    } catch (err) {
      if (!isSerializationConflict(err) || attempt === PERSIST_ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }

  if (!persisted) return null;
  if (persisted.run.status === "refused") {
    dispatchLog.warn(
      { runId: persisted.run.id, agentId: options.agentId, reason: persisted.run.error },
      "coding run refused at dispatch: its budget constraint has nothing left",
    );
    return persisted;
  }
  const runStart = async () => {
    try {
      await options.executor.start(persisted.run.id);
    } catch (err) {
      await markRunFailedFromExecutorError(options.db, persisted.run.id, err).catch((err2) =>
        dispatchLog.error({ err: err2, runId: persisted.run.id }, "failed to persist executor start failure"),
      );
    }
  };
  if (options.awaitExecution) {
    await runStart();
  } else {
    void runStart();
  }
  return persisted;
}
