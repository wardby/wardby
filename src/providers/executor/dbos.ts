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
 * it as a duplicate execution (see dbosStep and runInsideWorkflow). After a
 * takeover the fork has its own workflow id, so the two never share a step:
 * the original stops the same way when it meets the takeover's cancel
 * (dbosStepFor), and its start() handle writes nothing.
 */

import { DBOS, Error as DbosErrors } from "@dbos-inc/dbos-sdk";
import pg from "pg";
import type { PrismaClient } from "#prisma";
import type { DbosConfig } from "../../config/providers.js";
import { RunOwnershipLostError, StepReplayMismatchError, type StepRunner } from "../engine/types.js";
import {
  executeRun,
  failNativeRun,
  loseNativeRun,
  nativeRunIntegrations,
  RunCancelledError,
  type NativeRunProviders,
  type RunnerDb,
} from "../../core/runner.js";
import { markRunFailedFromExecutorError } from "../../core/dispatch.js";
import type { SelfDefectSink } from "../../core/self-defects.js";
import { prisma as defaultDb } from "../../core/db.js";
import { HEARTBEAT_INTERVAL_MS } from "../../core/timing.js";
import { DRIVABLE } from "../../core/run-status.js";
import { logger } from "../../core/logger.js";
import { type DatabaseAuth, type PgAuthOptions, databaseAuthFromEnv, pgConnectionConfig } from "../../core/pg-auth.js";
import {
  ADOPTION_EXHAUSTED_REASON,
  STEPS_CHANGED_REASON,
  decideRecovery,
  decideTakeover,
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
 *
 * DBOS signals that a replay reached a step whose recorded name differs (the
 * run was recorded by a release whose steps differ, e.g. after a takeover
 * fork) by throwing `DBOSUnexpectedStepError`. Translated into a
 * `StepReplayMismatchError`, which executeRun's backstop settles as `lost`
 * (runInsideWorkflow does it for a mismatch at the load step, which is outside
 * that backstop).
 */
export const dbosStep: StepRunner = (name, fn) => runDbosStep(name, fn);

/**
 * dbosStep for one run's workflow body. A cancellation of a workflow the run no longer names in
 * `executionWorkflowId` is not a stop: recover() took the run over (forked it) and cancelled this,
 * the forked-from workflow, while its owner was still alive. That attempt stops like one that lost
 * a step's checkpoint (RunOwnershipLostError: no terminal write), so the fork, not a reasonless
 * "cancelled" from the original, settles the run. takeOver records the fork's id before it
 * cancels, so the original always reads the new id by the time it sees the cancel.
 */
export function dbosStepFor(db: Pick<PrismaClient, "run">, runId: string): StepRunner {
  const supersedes = async (cancelledWorkflowId: string): Promise<boolean> => {
    // A failed read falls back to an ordinary cancellation, as before this check existed.
    const current = await workflowIdOf(db, runId).catch(() => cancelledWorkflowId);
    return current !== cancelledWorkflowId;
  };
  return (name, fn) => runDbosStep(name, fn, supersedes);
}

async function runDbosStep<T>(
  name: string,
  fn: () => Promise<T>,
  supersededBy?: (cancelledWorkflowId: string) => Promise<boolean>,
): Promise<T> {
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
      if (await supersededBy?.(err.workflowID)) throw new RunOwnershipLostError(name, { cause: err });
      const reason = cancellationReasons.get(err.workflowID);
      throw new RunCancelledError(`Run cancelled: ${reason ?? "no reason given"}`);
    }
    if (err instanceof DbosErrors.DBOSWorkflowConflictError) {
      const discardedUsage = usageOf(ran?.value);
      throw new RunOwnershipLostError(name, { cause: err, ...(discardedUsage ? { discardedUsage } : {}) });
    }
    if (err instanceof DbosErrors.DBOSUnexpectedStepError) throw new StepReplayMismatchError(name, { cause: err });
    throw err;
  }
}

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
 *
 * Replay constraints. A run's workflow is replayed both by a same-version
 * resume and, when recover() takes a waiting lead over after a deploy, by a
 * fork that runs this body under the *new* release against steps the *old*
 * release recorded (see decideTakeover). So:
 * - Code between steps must stay deterministic and safe to repeat: it runs
 *   again on every replay, now possibly under newer code.
 * - Step names and their order must only change in ways a replay can still
 *   follow; a replay that meets a different recorded name ends the run lost
 *   with STEPS_CHANGED_REASON (executeRun's backstop, or runInsideWorkflow).
 * - New code must accept step outputs recorded by the previous release (the
 *   `turn:N:llm` TurnResult, tool results). A release that changes a recorded
 *   shape keeps reading the old one, or a takeover fails at that step (lost).
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
      //
      // A workflow that recover() took over (forked, then cancelled) no longer drives the run: the
      // fork does, and settles it. Its rejection is the takeover's cancel, not the run's failure.
      if ((await workflowIdOf(this.db, runId).catch(() => runId)) !== runId) {
        // The error's name only: this path adds no message text to any output.
        const error = err instanceof Error ? err.name : typeof err;
        dbosLog.info({ runId, error }, "the run's original workflow ended after a takeover; its fork drives the run");
        return;
      }
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
    // The cancel runs even when that settle throws (a host or issue update failing after the
    // write): a cancelled row whose workflow kept going would keep spending.
    try {
      const row = await this.db.run.findUnique({ where: { id: runId }, select: { status: true } });
      if (row && (row.status === "pending" || row.status === "running")) {
        await failNativeRun(
          { runId, db: this.db, providers: this.providers, ...nativeRunIntegrations(this.providers, this.db) },
          new RunCancelledError(reason ?? "The run was cancelled."),
        );
      }
    } finally {
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
        // `running` forever. Instead it is forked under this version when it
        // is only waiting on durable children, and otherwise given up at once
        // so the reconciler reaps it (takeOver).
        const mismatch = versionMismatchReason(status?.applicationVersion, DBOS.applicationVersion);
        if (mismatch) return this.takeOver(handle, mismatch, status?.applicationVersion);
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

  /**
   * A workflow recorded under another application version: fork it under this one when it is only
   * waiting on durable children (decideTakeover), otherwise answer lost with the mismatch. The
   * fork counts as an adoption attempt, so repeated failed takeovers of one run end lost too.
   */
  private async takeOver(
    handle: PersistedExecutionHandle,
    mismatch: string,
    workflowVersion: string | undefined,
  ): Promise<ExecutionRecoveryResult> {
    const steps = (await DBOS.listWorkflowSteps(handle.id)) ?? [];
    const children = await this.db.run.findMany({
      where: { parentRunId: handle.runId, status: { in: [...DRIVABLE] } },
      select: { status: true, nativeExecutionMode: true, agent: { select: { kind: true } } },
    });
    const decision = decideTakeover(
      steps.map((s) => ({ functionID: s.functionID, name: s.name, output: s.output })),
      children.map((c) => ({ status: c.status, kind: c.agent.kind, nativeExecutionMode: c.nativeExecutionMode })),
      mismatch,
    );
    if (decision.action === "lost") {
      this.resumeAttempts.delete(handle.runId);
      dbosLog.warn({ runId: handle.runId, workflowVersion }, mismatch);
      return { state: "lost", reason: decision.reason };
    }
    const attempts = this.resumeAttempts.get(handle.runId) ?? 0;
    if (shouldGiveUpAdoption(attempts)) {
      this.resumeAttempts.delete(handle.runId);
      dbosLog.warn({ runId: handle.runId, attempts }, "giving up on taking over durable run");
      return { state: "lost", reason: ADOPTION_EXHAUSTED_REASON };
    }
    this.resumeAttempts.set(handle.runId, attempts + 1);
    // Deterministic, so a takeover that forked but never recorded the fork (the run write below
    // failed, or the process died) is finished by the next pass rather than forked a second time:
    // two workflows driving one run would each spend on every turn. DBOS inserts a fork's row with
    // a plain INSERT (bulkForkWorkflows in the SDK's system_database.js), so a repeated id would
    // fail on the key: look first, and treat a lost race the same way.
    const forkedId = `${handle.id}@${DBOS.applicationVersion}`;
    if (!(await DBOS.getWorkflowStatus(forkedId))) {
      try {
        await DBOS.forkWorkflow<void>(handle.id, decision.startStep, {
          newWorkflowID: forkedId,
          applicationVersion: DBOS.applicationVersion,
        });
      } catch (err) {
        if (!(await DBOS.getWorkflowStatus(forkedId))) throw err;
      }
    }
    const forked = DBOS.retrieveWorkflow<void>(forkedId);
    await this.db.run.update({ where: { id: handle.runId }, data: { executionWorkflowId: forkedId } });
    // So nothing can dequeue the original again (it stays recorded as forked from).
    await DBOS.cancelWorkflow(handle.id).catch((err: unknown) =>
      dbosLog.warn({ err, runId: handle.runId }, "could not cancel the forked-from workflow"),
    );
    dbosLog.info(
      { runId: handle.runId, from: handle.id, to: forkedId, startStep: decision.startStep, workflowVersion },
      "run taken over under this application version",
    );
    void forked.getResult().catch((err) => dbosLog.error({ err, runId: handle.runId }, "taken-over run failed"));
    return { state: "active" };
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
      await executeRun(runId, this.providers, this.db, undefined, dbosStepFor(this.db, runId));
    } catch (err) {
      // An ownership loss leaves the workflow body as the SDK's own conflict error, so DBOS takes
      // its duplicate-execution path: it records nothing and parks this attempt until the winner
      // records the outcome. Any other error escaping here would be recorded as the workflow's
      // outcome while the winner still runs. The runner already logged the loss. A forked-from
      // workflow's own cancellation (dbosStepFor) goes back as itself: DBOS parks that too.
      if (err instanceof RunOwnershipLostError) {
        throw err.cause instanceof DbosErrors.DBOSWorkflowConflictError ||
          err.cause instanceof DbosErrors.DBOSWorkflowCancelledError
          ? err.cause
          : new DbosErrors.DBOSWorkflowConflictError(DBOS.workflowID ?? runId);
      }
      // A replay met a step the recorded run does not have at the load step, ahead of executeRun's
      // backstop (which settles a mismatch in any later step itself).
      if (err instanceof StepReplayMismatchError) {
        dbosLog.warn({ err, runId }, "replay no longer matches the recorded run");
        // The same settle as executeRun's backstop: lost (first writer wins), its children stopped.
        await loseNativeRun(
          { runId, db: this.db, providers: this.providers, ...nativeRunIntegrations(this.providers, this.db) },
          STEPS_CHANGED_REASON,
        );
        return;
      }
      throw err;
    } finally {
      clearInterval(timer);
      cancellationReasons.delete(runId);
      if (DBOS.workflowID) cancellationReasons.delete(DBOS.workflowID);
    }
  }
}
