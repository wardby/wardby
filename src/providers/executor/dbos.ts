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
 *
 * A stalled-but-alive owner can overlap an adopted attempt of the same run:
 * whichever records a step second loses ownership, stops at that step
 * without writing the run, and hands the SDK's conflict back so DBOS parks
 * it as a duplicate execution (see dbosStep and runInsideWorkflow).
 */

import { DBOS, Error as DbosErrors } from "@dbos-inc/dbos-sdk";
import pg from "pg";
import type { PrismaClient } from "#prisma";
import type { DbosConfig } from "../../config/providers.js";
import { RunOwnershipLostError, type StepRunner } from "../engine/types.js";
import {
  executeRun,
  failNativeRun,
  nativeRunIntegrations,
  RunCancelledError,
  type NativeRunProviders,
  type RunnerDb,
} from "../../core/runner.js";
import { markRunFailedFromExecutorError } from "../../core/dispatch.js";
import type { SelfDefectSink } from "../../core/self-defects.js";
import { prisma as defaultDb } from "../../core/db.js";
import { HEARTBEAT_INTERVAL_MS } from "../../core/timing.js";
import { logger } from "../../core/logger.js";
import { type DatabaseAuth, type PgAuthOptions, databaseAuthFromEnv, pgConnectionConfig } from "../../core/pg-auth.js";
import {
  ADOPTION_EXHAUSTED_REASON,
  decideRecovery,
  shouldGiveUpAdoption,
  versionMismatchReason,
} from "./dbos-status.js";
import type { Executor, ExecutionRecoveryResult, PersistedExecutionHandle } from "./types.js";

export const DBOS_BACKEND = "dbos";

const dbosLog = logger.child({ module: "dbos-executor" });

type Providers = NativeRunProviders;
type Db = RunnerDb & Pick<PrismaClient, "run">;

/** DBOS's own system pool size (DEFAULT_POOL_SIZE in the SDK's system_database.js); kept for ours. */
const DBOS_SYSTEM_POOL_SIZE = 10;
/** DBOS's own connect timeout when the URL sets no connect_timeout (getClientConfig in the SDK's utils.js). */
const DBOS_CONNECT_TIMEOUT_MS = 10_000;

/**
 * DBOS.setConfig input. Under password auth this is exactly what launch() always passed, and DBOS
 * opens its own pool from the URL. Under rds-iam DBOS gets a pool whose password is the IAM token;
 * DBOS then runs its migrations, queries and LISTEN through that pool and never opens a URL
 * connection (system_database.js: a custom pool skips database creation and is what every
 * connection borrows from). The pool copies what DBOS would have set on its own: size, connect
 * timeout and application_name. DBOS never ends a pool it was given — see endSystemPool().
 */
export function dbosLaunchConfig(
  config: DbosConfig,
  executorId: string,
  auth: DatabaseAuth,
  pgAuth?: PgAuthOptions,
): {
  name: string;
  systemDatabaseUrl: string;
  systemDatabaseSchemaName: string;
  executorID: string;
  runAdminServer: false;
  logLevel: "warn";
  systemDatabasePool?: pg.Pool;
} {
  const url = config.systemDatabaseUrl!;
  const launch = {
    name: "wardby",
    systemDatabaseUrl: url,
    systemDatabaseSchemaName: config.schemaName,
    executorID: executorId,
    runAdminServer: false as const,
    logLevel: "warn" as const,
  };
  if (auth !== "rds-iam") return launch;
  const connection = pgConnectionConfig(url, auth, pgAuth); // validates the URL first
  const connectTimeout = Number.parseInt(new URL(url).searchParams.get("connect_timeout") ?? "", 10);
  const pool = new pg.Pool({
    application_name: `dbos_transact_${executorId}`,
    ...connection,
    max: DBOS_SYSTEM_POOL_SIZE,
    connectionTimeoutMillis: connectTimeout ? connectTimeout * 1000 : DBOS_CONNECT_TIMEOUT_MS,
  });
  // DBOS attaches no listener to a caller's pool; an idle connection's error would otherwise crash the process.
  pool.on("error", (err) => dbosLog.warn({ err }, "DBOS system database pool error"));
  return { ...launch, systemDatabasePool: pool };
}

/** The pool launch() handed DBOS, if any. Module-level like DBOS itself: whoever shuts DBOS down ends it. */
let systemPool: pg.Pool | undefined;

async function endSystemPool(): Promise<void> {
  const pool = systemPool;
  systemPool = undefined;
  await pool?.end().catch((err: unknown) => dbosLog.warn({ err }, "failed to close the DBOS system database pool"));
}

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
 * The DBOS workflow id that drives a run: `Run.executionWorkflowId` once the
 * run's workflow was forked under a new application version, otherwise the
 * run id (a run's first workflow is started with its run id).
 */
export async function workflowIdOf(db: Pick<PrismaClient, "run">, runId: string): Promise<string> {
  const row = await db.run.findUnique({ where: { id: runId }, select: { executionWorkflowId: true } });
  return row?.executionWorkflowId ?? runId;
}

/**
 * Bind the engine's step boundary to a DBOS checkpointed step. Never
 * retried: a retry would re-spend.
 *
 * DBOS signals a cancelled workflow by throwing `DBOSWorkflowCancelledError`
 * out of the next step boundary. Translated here into a `RunCancelledError`
 * so executeRun's backstop records `cancelled` plus the operator's reason,
 * rather than `failed` plus an SDK-internal message.
 *
 * DBOS signals that another execution of this workflow recorded the step
 * first by throwing `DBOSWorkflowConflictError` after this attempt's step
 * body already ran. Translated into a `RunOwnershipLostError` (carrying the
 * discarded step's usage, if any, for the log) so executeRun's backstop stops
 * this attempt without writing the run; runInsideWorkflow turns it back into
 * the SDK error.
 */
export const dbosStep: StepRunner = async (name, fn) => {
  let ran: { value: unknown } | undefined;
  try {
    return await DBOS.runStep(
      async () => {
        const value = await fn();
        ran = { value };
        return value;
      },
      { name, retriesAllowed: false },
    );
  } catch (err) {
    if (err instanceof DbosErrors.DBOSWorkflowCancelledError) {
      const reason = cancellationReasons.get(err.workflowID);
      throw new RunCancelledError(`Run cancelled: ${reason ?? "no reason given"}`);
    }
    if (err instanceof DbosErrors.DBOSWorkflowConflictError) {
      const discardedUsage = usageOf(ran?.value);
      throw new RunOwnershipLostError(name, { cause: err, ...(discardedUsage ? { discardedUsage } : {}) });
    }
    throw err;
  }
};

/**
 * The numeric `usage` fields of a step result, if it has any (an LLM turn's
 * token counts and cost). Tool steps return a string and yield nothing.
 */
function usageOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== "object" || value === null || !("usage" in value)) return undefined;
  const usage = value.usage;
  if (typeof usage !== "object" || usage === null) return undefined;
  const numeric = Object.entries(usage).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return numeric.length > 0 ? Object.fromEntries(numeric) : undefined;
}

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
  { name: "wardby.run" },
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
      const launchConfig = dbosLaunchConfig(this.config, this.id, databaseAuthFromEnv());
      systemPool = launchConfig.systemDatabasePool;
      try {
        DBOS.setConfig(launchConfig);
        await DBOS.launch();
      } catch (err) {
        // DBOS.launch can throw after it initialized (registering the application version, starting
        // event receivers). Shut that half-launched DBOS down so the next launch() starts clean, then
        // end the pool either way: the next launch() makes a new one.
        if (activeExecutor === this) setActiveExecutor(undefined);
        if (DBOS.isInitialized()) {
          await DBOS.shutdown().catch((shutdownErr: unknown) =>
            dbosLog.warn({ err: shutdownErr }, "failed to shut down DBOS after a failed launch"),
          );
        }
        await endSystemPool();
        throw err;
      }
    }
    this.launched = true;
    dbosLog.info({ executorId: DBOS.executorID }, "DBOS executor launched");
  }

  async close(): Promise<void> {
    if (!this.launched) return;
    this.launched = false;
    if (activeExecutor === this) setActiveExecutor(undefined);
    try {
      await DBOS.shutdown({ workflowCompletionTimeoutMS: 5_000 });
    } finally {
      await endSystemPool();
    }
  }

  /** Where a run this executor marks failed files its self-defect (no-op without a configured issue tracker). */
  private get selfDefects(): SelfDefectSink {
    return { db: this.db, issueTrackers: this.providers.issueTrackers };
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
      await markRunFailedFromExecutorError(this.db, runId, err, this.selfDefects);
      throw err;
    }
  }

  async stop(runId: string, reason?: string): Promise<void> {
    // Cancellation goes through DBOS, so this process has to be launched
    // even when it never started this run (the reconciler/MCP can stop a run
    // another instance is executing).
    if (!this.launched) await this.launch();
    dbosLog.info({ runId, reason }, "cancelling durable run");
    // The terminal write comes first and is conditional (the first writer wins), so the run is
    // cancelled with the caller's reason even when its workflow runs in another process (where the
    // reason map below is empty) or has no workflow at all yet (cancelWorkflow then matches
    // nothing). The workflow's next step then throws, and its own terminal write matches no row.
    const row = await this.db.run.findUnique({ where: { id: runId }, select: { status: true } });
    if (row && (row.status === "pending" || row.status === "running")) {
      await failNativeRun(
        { runId, db: this.db, providers: this.providers, ...nativeRunIntegrations(this.providers, this.db) },
        new RunCancelledError(reason ?? "The run was cancelled."),
      );
    }
    // Recorded before the cancel so the workflow's next step boundary can
    // find it: DBOS only reports "cancelled", never why.
    // Keyed by both ids: dbosStep looks it up by the cancelled workflow's id, which is the forked
    // id for a forked run.
    const workflowId = await workflowIdOf(this.db, runId);
    if (reason) {
      cancellationReasons.set(runId, reason);
      cancellationReasons.set(workflowId, reason);
    }
    await DBOS.cancelWorkflow(workflowId);
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
        // Conditional (only a pending/running row), so a self-defect is filed only when this made the run failed.
        await markRunFailedFromExecutorError(this.db, handle.runId, decision.error, this.selfDefects);
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
    } catch (err) {
      // An ownership loss leaves the workflow body as the SDK's own conflict error, so DBOS takes
      // its duplicate-execution path: it records nothing and parks this attempt until the winner
      // records the outcome. Any other error escaping here would be recorded as the workflow's
      // outcome while the winner still runs. The runner already logged the loss.
      if (err instanceof RunOwnershipLostError) {
        throw err.cause instanceof DbosErrors.DBOSWorkflowConflictError
          ? err.cause
          : new DbosErrors.DBOSWorkflowConflictError(runId);
      }
      throw err;
    } finally {
      clearInterval(timer);
      cancellationReasons.delete(runId);
      if (DBOS.workflowID) cancellationReasons.delete(DBOS.workflowID);
    }
  }
}
