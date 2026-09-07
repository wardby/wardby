/**
 * Phase 6 `Executor`: each native run is a DBOS durable workflow whose
 * steps are the engine's LLM turns and tool calls (see StepRunner in
 * providers/engine/types.ts). DBOS records every step result in Postgres;
 * after a crash or redeploy `launch()` re-drives the workflows this
 * executor id owned, and completed steps replay from the record — no
 * repeated LLM spend for finished turns. The at-least-once window is one
 * in-flight step: a turn that was mid-stream when the process died runs
 * again on resume.
 *
 * The heartbeat is kept while the workflow runs here so the reconciler's
 * stale-heartbeat detection is unchanged; the reconciler consults
 * `recover()` (Task 6) before declaring a DBOS run lost.
 */

import { DBOS, Error as DbosErrors } from "@dbos-inc/dbos-sdk";
import type { PrismaClient } from "@prisma/client";
import type { ProviderRegistry } from "../index.js";
import type { DbosConfig } from "../../config/providers.js";
import type { StepRunner } from "../engine/types.js";
import { executeRun, RunCancelledError, type RunnerDb } from "../../core/runner.js";
import { markRunFailedFromExecutorError } from "../../core/dispatch.js";
import { prisma as defaultDb } from "../../core/db.js";
import { HEARTBEAT_INTERVAL_MS } from "../../core/timing.js";
import { logger } from "../../core/logger.js";
import {
  ADOPTION_EXHAUSTED_REASON,
  decideRecovery,
  shouldGiveUpAdoption,
  versionMismatchReason,
} from "./dbos-status.js";
import type { Executor, ExecutionRecoveryResult, PersistedExecutionHandle } from "./types.js";

export const DBOS_BACKEND = "dbos";

const dbosLog = logger.child({ module: "dbos-executor" });

type Providers = Pick<ProviderRegistry, "llm" | "engine" | "datastore" | "secrets">;
type Db = RunnerDb & Pick<PrismaClient, "run">;

/** The executor whose deps the registered workflow uses. Set by launch(). */
let activeExecutor: DbosExecutor | undefined;

/** Setter (rather than `activeExecutor = this` inline) to avoid aliasing `this` to a variable. */
function setActiveExecutor(executor: DbosExecutor | undefined): void {
  activeExecutor = executor;
}

/**
 * Cancellation reasons by run id, recorded by `stop()` so the workflow body
 * can put the operator's own words on the Run row instead of DBOS's internal
 * "workflow was cancelled" text. Module-level because `stop()` and the
 * workflow body are not guaranteed to be on the same DbosExecutor instance
 * (the reconciler can stop a run this process adopted). Cleared in
 * `runInsideWorkflow`'s finally.
 */
const cancellationReasons = new Map<string, string>();

/**
 * Bind the engine's step boundary to a DBOS checkpointed step. Never
 * retried: a retry would re-spend.
 *
 * DBOS signals a cancelled workflow by throwing `DBOSWorkflowCancelledError`
 * out of the next step boundary. Translated here into a `RunCancelledError`
 * so executeRun's backstop records `cancelled` plus the operator's reason,
 * rather than `failed` plus an SDK-internal message.
 */
const dbosStep: StepRunner = async (name, fn) => {
  try {
    return await DBOS.runStep(fn, { name, retriesAllowed: false });
  } catch (err) {
    if (err instanceof DbosErrors.DBOSWorkflowCancelledError) {
      const reason = cancellationReasons.get(err.workflowID);
      throw new RunCancelledError(`Run cancelled: ${reason ?? "no reason given"}`);
    }
    throw err;
  }
};

/**
 * Registered once at module load — DBOS requires registration before
 * launch(). The body must be deterministic between steps; everything
 * non-deterministic in executeRun/engine is inside a runStep.
 */
const runWorkflow = DBOS.registerWorkflow(
  async (runId: string): Promise<void> => {
    const self = activeExecutor;
    if (!self) throw new Error("DbosExecutor workflow invoked before launch().");
    await self.runInsideWorkflow(runId);
  },
  { name: "reevo.run" },
);

export class DbosExecutor implements Executor {
  private launched = false;
  /** Non-optional once constructed — see the constructor's DBOS_EXECUTOR_ID guard. */
  private readonly id: string;
  /**
   * Adoption attempts per run id, bounding `recover()`'s resume branch (see
   * MAX_RESUME_ATTEMPTS). In memory and per process: a restart resets it,
   * which is the right default — a restart is also the most likely thing to
   * have fixed the version/executor mismatch that made adoption fail.
   */
  private readonly resumeAttempts = new Map<string, number>();

  constructor(
    private readonly providers: Providers,
    private readonly config: DbosConfig,
    private readonly db: Db = defaultDb,
    private readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {
    if (!config.systemDatabaseUrl) {
      throw new Error("EXECUTOR=dbos requires DBOS_SYSTEM_DATABASE_URL or DATABASE_URL.");
    }
    if (!config.executorId) {
      throw new Error(
        "EXECUTOR=dbos requires DBOS_EXECUTOR_ID, unique per running process (scheduler and MCP need different values).",
      );
    }
    this.id = config.executorId;
  }

  get executorId(): string {
    return this.id;
  }

  async launch(): Promise<void> {
    if (this.launched) return;
    // DBOS is a process-wide singleton: the executor id is fixed by whoever
    // launched it first, and setConfig below is skipped for everyone after.
    // Fail loudly rather than run with an id that disagrees with reality —
    // recover()'s ownership decisions are made against DBOS.executorID.
    if (DBOS.isInitialized() && DBOS.executorID !== this.id) {
      throw new Error(
        `DBOS is already launched with executor id "${DBOS.executorID}"; ` +
          `cannot launch a second DbosExecutor with id "${this.id}" in the same process.`,
      );
    }
    setActiveExecutor(this);
    if (!DBOS.isInitialized()) {
      DBOS.setConfig({
        name: "reevo-run",
        systemDatabaseUrl: this.config.systemDatabaseUrl,
        systemDatabaseSchemaName: this.config.schemaName,
        executorID: this.id,
        runAdminServer: false,
        logLevel: "warn",
      });
      await DBOS.launch();
    }
    this.launched = true;
    dbosLog.info({ executorId: DBOS.executorID }, "DBOS executor launched");
  }

  async close(): Promise<void> {
    if (!this.launched) return;
    this.launched = false;
    if (activeExecutor === this) setActiveExecutor(undefined);
    await DBOS.shutdown({ workflowCompletionTimeoutMS: 5_000 });
  }

  async start(runId: string): Promise<void> {
    if (!this.launched) await this.launch();
    await this.db.run.updateMany({
      where: { id: runId, executionBackend: null },
      data: { executionBackend: DBOS_BACKEND },
    });
    // `workflowID: runId` alone gives the idempotency this executor needs: a
    // second `startWorkflow` call with the same id attaches to the workflow
    // already recorded under that id instead of re-running it. In this SDK
    // (4.27.6) `duplicationPolicy: "return-existing"` is a *queue* dedup
    // mechanism — it throws `DBOSInvalidWorkflowTransitionError` ("requires
    // a queueName") when passed without `queueName`/`enqueueOptions.
    // deduplicationID`, which don't apply to this non-queued, direct-start
    // workflow. See dist/src/dbos.js `#invokeSingletonWorkflow`.
    const handle = await DBOS.startWorkflow(runWorkflow, { workflowID: runId })(runId);
    try {
      await handle.getResult();
    } catch (err) {
      // executeRun's own catch backstop owns every terminal write for a run
      // whose workflow body actually reached it — this only catches a
      // workflow that failed or was cancelled *before* the body got that
      // far, leaving the row pending/running. (A cancellation that races
      // past a run's final step can leave the row's real, already-terminal
      // outcome in place instead; that's expected — the reason is in the
      // DBOS log, not here.) markRunFailedFromExecutorError's conditional
      // update only ever touches a non-terminal row, so it never clobbers
      // one executeRun already finished. It can also run a second time for
      // the same failure — dispatchRun's own `.catch` around `start()` calls
      // it too — which is harmless precisely because it is conditional and
      // idempotent: the second call matches zero rows.
      await markRunFailedFromExecutorError(this.db, runId, err);
      throw err;
    }
  }

  async stop(runId: string, reason?: string): Promise<void> {
    // Cancellation goes through DBOS, so this process has to be launched
    // even when it never started this run (the reconciler/MCP can stop a run
    // another instance is executing).
    if (!this.launched) await this.launch();
    dbosLog.info({ runId, reason }, "cancelling durable run");
    // Recorded before the cancel so the workflow's next step boundary can
    // find it: DBOS only reports "cancelled", never why.
    if (reason) cancellationReasons.set(runId, reason);
    await DBOS.cancelWorkflow(runId);
  }

  /**
   * Answer the reconciler for a stale run. Never relaunches: `resume`
   * re-drives the existing workflow from its last completed step, which is
   * the same thing launch() does for this executor's own workflows.
   */
  async recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult> {
    if (handle.backend !== DBOS_BACKEND) {
      return { state: "lost", reason: `DbosExecutor cannot recover backend "${handle.backend}".` };
    }
    if (!this.launched) await this.launch();
    const status = await DBOS.getWorkflowStatus(handle.id);
    const row = await this.db.run.findUnique({ where: { id: handle.runId }, select: { status: true } });
    const runIsTerminal = !!row && !["pending", "running"].includes(row.status);
    // DBOS.executorID, not this.config.executorId: launch() skips setConfig
    // when DBOS was already initialised elsewhere in the process, so the
    // configured id is a request, and DBOS's is the fact ownership is
    // decided on.
    const decision = decideRecovery(status, runIsTerminal, DBOS.executorID);

    switch (decision.action) {
      case "active":
        this.resumeAttempts.delete(handle.runId);
        return { state: "active" };
      case "resume": {
        // DBOS gates recovery and dequeue on application_version. A workflow
        // recorded under a different version is never dequeued here, so
        // resuming it would be an unbounded loop that holds the run
        // `running` forever: give up at once and let the reconciler reap it.
        const mismatch = versionMismatchReason(status?.applicationVersion, DBOS.applicationVersion);
        if (mismatch) {
          this.resumeAttempts.delete(handle.runId);
          dbosLog.warn({ runId: handle.runId, workflowVersion: status?.applicationVersion }, mismatch);
          return { state: "lost", reason: mismatch };
        }
        // Belt and braces for every other reason a resume can fail to take
        // (an id we can't dequeue for, a queue that never drains): bound the
        // number of adoptions of one run so the reconciler stops re-driving
        // it every pass.
        const attempts = this.resumeAttempts.get(handle.runId) ?? 0;
        if (shouldGiveUpAdoption(attempts)) {
          this.resumeAttempts.delete(handle.runId);
          dbosLog.warn({ runId: handle.runId, attempts }, "giving up on adopting orphaned durable run");
          return { state: "lost", reason: ADOPTION_EXHAUSTED_REASON };
        }
        this.resumeAttempts.set(handle.runId, attempts + 1);
        dbosLog.warn(
          { runId: handle.runId, owner: status?.executorId, attempt: attempts + 1 },
          "adopting orphaned durable run",
        );
        // `resumeWorkflow` *enqueues* the workflow for recovery; whichever
        // process dequeues it runs it, which need not be this one. So
        // "active" here means "re-driven somewhere", not "running here" —
        // and the handle below only resolves if we are the one who got it.
        const resumed = await DBOS.resumeWorkflow<void>(handle.id);
        void resumed.getResult().catch((err) => dbosLog.error({ err, runId: handle.runId }, "adopted run failed"));
        return { state: "active" };
      }
      case "terminal":
        this.resumeAttempts.delete(handle.runId);
        return { state: "terminal" };
      case "mark-failed":
        this.resumeAttempts.delete(handle.runId);
        await this.db.run.updateMany({
          where: { id: handle.runId, status: { in: ["pending", "running"] } },
          data: { status: "failed", error: decision.error, finishedAt: new Date() },
        });
        return { state: "terminal" };
      case "lost":
        this.resumeAttempts.delete(handle.runId);
        return { state: "lost", reason: decision.reason };
    }
  }

  /** Workflow body. Public only so the module-level registration can reach it. */
  async runInsideWorkflow(runId: string): Promise<void> {
    const beat = () =>
      this.db.run.update({ where: { id: runId }, data: { heartbeatAt: new Date() } }).catch(() => {
        // A missed beat only makes the reconciler look sooner; recover() answers it.
      });
    await beat();
    const timer = setInterval(() => void beat(), this.heartbeatIntervalMs);
    try {
      await executeRun(runId, this.providers, this.db, undefined, dbosStep);
    } finally {
      clearInterval(timer);
      cancellationReasons.delete(runId);
    }
  }
}
