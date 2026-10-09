/**
 * The Executor for sandbox-mode native runs (docs/native-sandbox.md). Phase 1's
 * RoutingExecutor sends every run whose snapshot says `sandbox` here.
 *
 * - start: creates the run's gateway session (pinning the run and recording
 *   `native-sandbox` as its backend before any worker exists), launches the
 *   worker, and returns. Whichever gateway replica serves the worker's
 *   `finish` makes the terminal write; this executor only watches for a
 *   worker that exits without one, and for its deadline.
 * - stop: ends the session (every further gateway call is refused), kills the
 *   worker, records the run cancelled, and stops its open delegations.
 * - recover: answers the reconciler from the worker's container state, and
 *   never launches one.
 * - launch: the janitor removes workers whose runs have ended.
 */

import { logger } from "../core/logger.js";
import {
  failNativeRun,
  nativeRunIntegrations,
  RunCancelledError,
  NATIVE_SANDBOX_BACKEND,
  type NativeRunFinishContext,
  type NativeRunProviders,
  type RunnerDb,
} from "../core/runner.js";
import type { ExecutionRecoveryResult, Executor, PersistedExecutionHandle } from "../providers/executor/types.js";
import { nativeRunLabel } from "./docker-isolation.js";
import type { NativeWorkerState } from "./docker-launcher.js";
import { startSandboxRun, type DetachedWorkerLauncher, type WorkerHandle } from "./launch.js";
import { NATIVE_SANDBOX_CAPACITY } from "./kubernetes-launcher.js";
import { PrismaGatewayLedger, type GatewayLedgerDb } from "./ledger.js";

const executorLog = logger.child({ module: "native-sandbox-executor" });

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";

/** What the executor needs from a worker launcher (DockerNativeWorkerLauncher, or a test double). */
export interface ManagedWorkerLauncher extends DetachedWorkerLauncher {
  handle(runId: string): WorkerHandle;
  inspect(runId: string): Promise<NativeWorkerState>;
  kill(runId: string): Promise<void>;
  remove(runId: string): Promise<void>;
  listWorkers(): Promise<{ name: string; runHash: string }[]>;
  removeByWorkerName(name: string): Promise<void>;
  /** The URL workers dial, when only the launcher can know it (a Kubernetes Service's ClusterIP). */
  resolveGatewayUrl?(): Promise<string>;
  /** Background upkeep the long-lived process runs from the executor's `launch()` (the warm pool's). */
  start?(): Promise<void>;
}

export interface NativeSandboxExecutorOptions {
  db: RunnerDb & GatewayLedgerDb;
  /** The server's providers: the run's load, and its terminal writes when the worker cannot make them. */
  providers: NativeRunProviders;
  launcher: ManagedWorkerLauncher;
  /** What workers dial: the gateway's alias on their run network. */
  gatewayUrl: string;
  /** NATIVE_SANDBOX_MAX_CONCURRENT: a start past this many active sessions fails with native_sandbox_capacity. */
  maxConcurrent?: number;
  now?: () => number;
}

export const NATIVE_SANDBOX_WORKER_EXITED = "native_sandbox_worker_exited";
export const NATIVE_SANDBOX_DEADLINE = "native_sandbox_deadline_exceeded";

export class NativeSandboxExecutor implements Executor {
  private readonly ledger: PrismaGatewayLedger;
  private readonly watching = new Map<string, ReturnType<typeof setTimeout> | undefined>();
  private readonly deadlineKilled = new Set<string>();

  constructor(private readonly options: NativeSandboxExecutorOptions) {
    this.ledger = new PrismaGatewayLedger(options.db);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private finishContext(runId: string): NativeRunFinishContext {
    const { db, providers } = this.options;
    return { runId, db, providers, ...nativeRunIntegrations(providers, db) };
  }

  async start(runId: string): Promise<void> {
    const { db, providers, launcher, gatewayUrl } = this.options;
    // A second start (a retried dispatch) attaches to the run's worker; it never launches another.
    const existing = await db.nativeGatewaySession.findUnique({ where: { runId }, select: { deadlineAt: true } });
    if (existing) {
      this.watch(runId, launcher.handle(runId), existing.deadlineAt);
      return;
    }
    // Fail fast rather than queue (a warm pool's job): every replica counts the same sessions, and a
    // near-simultaneous start that overshoots by one is still bounded by the cluster's ResourceQuota.
    const cap = this.options.maxConcurrent;
    if (cap !== undefined && (await db.nativeGatewaySession.count({ where: { status: "active" } })) >= cap) {
      throw new Error(
        `${NATIVE_SANDBOX_CAPACITY}: ${cap} sandbox runs are already active (NATIVE_SANDBOX_MAX_CONCURRENT).`,
      );
    }
    let outcome: Awaited<ReturnType<typeof startSandboxRun>>;
    try {
      const url = launcher.resolveGatewayUrl ? await launcher.resolveGatewayUrl() : gatewayUrl;
      outcome = await startSandboxRun({ runId, providers, db, gatewayUrl: url, launcher });
    } catch (err) {
      // A concurrent start won the race for the run's one session: attach to its worker.
      if (!isUniqueViolation(err)) {
        // The launch failed after the session was created (e.g. isolation could not be proven):
        // end the session so nothing can use its capability; the caller fails the run.
        await this.endSession(runId, "cancelled").catch(() => {});
        throw err;
      }
      const raced = await db.nativeGatewaySession.findUniqueOrThrow({ where: { runId }, select: { deadlineAt: true } });
      this.watch(runId, launcher.handle(runId), raced.deadlineAt);
      return;
    }
    if (outcome.kind === "ended") return;
    const session = await db.nativeGatewaySession.findUniqueOrThrow({
      where: { id: outcome.sessionId },
      select: { deadlineAt: true },
    });
    this.watch(runId, outcome.handle, session.deadlineAt);
  }

  /** Watches one worker in this process: its exit, and its deadline. */
  private watch(runId: string, handle: WorkerHandle, deadlineAt: Date): void {
    if (this.watching.has(runId)) return;
    const msLeft = deadlineAt.getTime() - this.now();
    const timer =
      msLeft > 0
        ? setTimeout(() => {
            this.deadlineKilled.add(runId);
            handle.kill();
          }, msLeft)
        : undefined;
    if (msLeft <= 0) {
      this.deadlineKilled.add(runId);
      handle.kill();
    }
    this.watching.set(runId, timer);
    void handle.exited
      .then((code) => this.onWorkerExit(runId, code))
      .catch((err: unknown) => executorLog.error({ err, runId }, "watching a native sandbox worker failed"));
  }

  private async onWorkerExit(runId: string, exitCode: number | null): Promise<void> {
    const timer = this.watching.get(runId);
    if (timer) clearTimeout(timer);
    this.watching.delete(runId);
    const { db } = this.options;
    const run = await db.run.findUnique({ where: { id: runId }, select: { status: true } });
    if (run && (run.status === "pending" || run.status === "running")) {
      // The worker ended without its `finish`: nothing will write a result for it, so this does.
      const reason = this.deadlineKilled.has(runId)
        ? `${NATIVE_SANDBOX_DEADLINE}: the sandbox run passed its deadline and its worker was stopped.`
        : `${NATIVE_SANDBOX_WORKER_EXITED}: the sandbox worker exited (code ${exitCode ?? "unknown"}) without a result.`;
      await failNativeRun(this.finishContext(runId), new Error(reason));
    }
    this.deadlineKilled.delete(runId);
    await this.endSession(runId, "finished");
    await this.options.launcher.remove(runId).catch((err: unknown) => {
      executorLog.warn({ err, runId }, "removing a native sandbox worker failed; the janitor will retry");
    });
  }

  private async endSession(runId: string, status: "finished" | "cancelled"): Promise<string | undefined> {
    const session = await this.options.db.nativeGatewaySession.findUnique({ where: { runId }, select: { id: true } });
    if (session) await this.ledger.endSession(session.id, status);
    return session?.id;
  }

  async stop(runId: string, reason?: string): Promise<void> {
    // Recorded first, before the session ends or the worker is killed: either of those makes the
    // worker exit, and its exit watcher must then find the run already ended (and leave it
    // cancelled) rather than record the exit as a failure.
    await failNativeRun(this.finishContext(runId), new RunCancelledError(reason ?? "The run was cancelled."));
    const sessionId = await this.endSession(runId, "cancelled");
    await this.options.launcher.kill(runId).catch(() => {});
    if (sessionId) {
      // Its delegations' children belong to the server's executor; a child left running would
      // spend on behalf of a parent that no longer waits for it.
      for (const child of await this.ledger.openDelegationChildren(sessionId)) {
        await this.options.providers.executor?.stop(child, "parent run cancelled").catch((err: unknown) => {
          executorLog.warn({ err, runId, child }, "failed to stop a cancelled sandbox run's child");
        });
      }
    }
    await this.options.launcher.remove(runId).catch(() => {});
  }

  async recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult> {
    if (handle.backend !== NATIVE_SANDBOX_BACKEND) {
      return { state: "lost", reason: `NativeSandboxExecutor cannot recover backend "${handle.backend}".` };
    }
    const runId = handle.runId;
    const { db, launcher } = this.options;
    const [state, run, session] = await Promise.all([
      launcher.inspect(runId),
      db.run.findUnique({ where: { id: runId }, select: { status: true } }),
      db.nativeGatewaySession.findUnique({ where: { runId }, select: { status: true, deadlineAt: true } }),
    ]);
    const runEnded = !run || !(run.status === "pending" || run.status === "running");
    if (state.state === "running") {
      if (runEnded) {
        await launcher.kill(runId).catch(() => {});
        await launcher.remove(runId).catch(() => {});
        return { state: "terminal" };
      }
      // Re-attach (a restarted server): watch its exit and deadline from here.
      if (session) this.watch(runId, launcher.handle(runId), session.deadlineAt);
      return { state: "active" };
    }
    if (state.state === "exited") {
      await this.onWorkerExit(runId, state.exitCode);
      return { state: "terminal" };
    }
    if (runEnded || session?.status === "finished") return { state: "terminal" };
    return {
      state: "lost",
      reason: "native_sandbox_worker_lost: the run's sandbox worker is gone and left no result; it was not relaunched.",
    };
  }

  /** Startup janitor: removes worker containers whose runs have ended or passed their deadline. Starts the warm pool. */
  async launch(): Promise<void> {
    await this.sweep().catch((err: unknown) => executorLog.warn({ err }, "native sandbox janitor failed"));
    await this.options.launcher
      .start?.()
      .catch((err: unknown) => executorLog.warn({ err }, "native warm pool failed to start"));
  }

  async sweep(): Promise<number> {
    const { db, launcher } = this.options;
    const workers = await launcher.listWorkers();
    if (workers.length === 0) return 0;
    const sessions = await db.nativeGatewaySession.findMany({
      select: { runId: true, status: true, deadlineAt: true, run: { select: { status: true } } },
    });
    // Docker labels carry the full run hash; Kubernetes label values carry its first 40 characters.
    const labelled = sessions.map((s) => ({ hash: nativeRunLabel(s.runId), session: s }));
    let removed = 0;
    for (const worker of workers) {
      const session = labelled.find((l) => l.hash.startsWith(worker.runHash))?.session;
      const live =
        session &&
        session.status === "active" &&
        session.deadlineAt.getTime() > this.now() &&
        (session.run.status === "pending" || session.run.status === "running");
      if (live) continue;
      await launcher.removeByWorkerName(worker.name);
      removed += 1;
    }
    return removed;
  }
}
