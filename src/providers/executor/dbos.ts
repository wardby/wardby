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

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { PrismaClient } from "@prisma/client";
import type { ProviderRegistry } from "../index.js";
import type { DbosConfig } from "../../config/providers.js";
import type { StepRunner } from "../engine/types.js";
import { executeRun, type RunnerDb } from "../../core/runner.js";
import { markRunFailedFromExecutorError } from "../../core/dispatch.js";
import { prisma as defaultDb } from "../../core/db.js";
import { HEARTBEAT_INTERVAL_MS } from "../../core/timing.js";
import { logger } from "../../core/logger.js";
import { decideRecovery } from "./dbos-status.js";
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

/** Bind the engine's step boundary to a DBOS checkpointed step. Never retried: a retry would re-spend. */
const dbosStep: StepRunner = (name, fn) => DBOS.runStep(fn, { name, retriesAllowed: false });

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

  constructor(
    private readonly providers: Providers,
    private readonly config: DbosConfig,
    private readonly db: Db = defaultDb,
    private readonly heartbeatIntervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {
    if (!config.systemDatabaseUrl) {
      throw new Error("EXECUTOR=dbos requires DBOS_SYSTEM_DATABASE_URL or DATABASE_URL.");
    }
  }

  get executorId(): string {
    return this.config.executorId;
  }

  async launch(): Promise<void> {
    if (this.launched) return;
    setActiveExecutor(this);
    if (!DBOS.isInitialized()) {
      DBOS.setConfig({
        name: "reevo-run",
        systemDatabaseUrl: this.config.systemDatabaseUrl,
        systemDatabaseSchemaName: this.config.schemaName,
        executorID: this.config.executorId,
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
      // one executeRun already finished.
      await markRunFailedFromExecutorError(this.db, runId, err);
      throw err;
    }
  }

  async stop(runId: string, reason?: string): Promise<void> {
    dbosLog.info({ runId, reason }, "cancelling durable run");
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
    const decision = decideRecovery(status, runIsTerminal, this.config.executorId);

    switch (decision.action) {
      case "active":
        return { state: "active" };
      case "resume": {
        dbosLog.warn({ runId: handle.runId, owner: status?.executorId }, "adopting orphaned durable run");
        const resumed = await DBOS.resumeWorkflow<void>(handle.id);
        void resumed.getResult().catch((err) => dbosLog.error({ err, runId: handle.runId }, "adopted run failed"));
        return { state: "active" };
      }
      case "terminal":
        return { state: "terminal" };
      case "mark-failed":
        await this.db.run.updateMany({
          where: { id: handle.runId, status: { in: ["pending", "running"] } },
          data: { status: "failed", error: decision.error, finishedAt: new Date() },
        });
        return { state: "terminal" };
      case "lost":
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
    }
  }
}
