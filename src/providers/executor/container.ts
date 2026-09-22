import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { CodingProfileSchema } from "../../coding/profile.js";
import { codingRunObserver, type CodingRunObserver } from "../../coding/observability.js";
import {
  CODING_PROTOCOL_VERSION,
  CodingRunResultSchema,
  CodingTaskInputSchema,
  parseCodingAgentOutputJson,
  redactTokenShapedValues,
  type CodingAgentOutput,
  type CodingRunResult,
} from "../../coding/protocol.js";
import { getModelPricing } from "../llm/pricing.js";
import { getAnthropicPricing } from "../llm/pricing-anthropic.js";
import { isImmutableDockerImage } from "../jobs/docker-isolation.js";
import type { ProxyProtocol } from "../coding-proxy/types.js";
import type { JobHandle, JobResourceLimits, JobSpec, WorkspaceJobLauncher } from "../jobs/types.js";
import type { PreparedWorkspace, VcsPrepareInput, VcsProvider } from "../vcs/types.js";
import type { CodingImageSelector, ExecutionRecoveryResult, Executor, PersistedExecutionHandle } from "./types.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);
const PROVISIONING_BACKEND = "provisioning";
/** Serializes concurrency-slot claims across replicas. Distinct from the OAuth client lock (7412901). */
const CODING_SLOT_LOCK_SQL = "SELECT 1 AS locked FROM pg_advisory_xact_lock(7412902)";

/**
 * Private sentinel thrown inside claimProvisioning's $transaction callback
 * when the Run has already left pending/running (e.g. drainCodingQueue
 * committed a coding_queue_timeout failure between the CodingRun claim
 * update and the Run status flip). Throwing aborts the whole transaction --
 * including the CodingRun claim -- so the claim is never left behind on a
 * run that just got revived as "running"; the catch outside the
 * transaction turns it into a plain "unavailable" result.
 */
class RunNoLongerActiveError extends Error {}

function proxyProtocol(provider: string): ProxyProtocol {
  if (provider === "codex") return "openai-responses";
  if (provider === "claude-code") return "anthropic-messages";
  throw new Error("coding_provider_unsupported");
}

export interface ContainerRunSnapshot {
  runId: string;
  status: string;
  agentKind: string;
  /** Human-readable agent name (e.g. "knock-knock-implement") -- surfaced in continuation status notifications. */
  agentName: string;
  ownerId: string | null;
  task: string;
  repository: string;
  baseRef: string;
  headRef: string;
  provider: string;
  model: string;
  timeoutSec: number;
  allowedEgress: unknown;
  protectedPaths: unknown;
  /** Revision-in-place: set when this run continues another run's branch/PR. See preflight(). */
  rootCodingRunId: string | null;
  budgetUsd: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  jobHandle: JobHandle | null;
  provisioningClaim: string | null;
  proxySessionId: string | null;
  result: unknown;
  workerImage: string | null;
  workspaceDiskMb: number | null;
}

/**
 * claimed: this caller owns provisioning. unavailable: someone else does, or
 * the run is no longer active. queued: every concurrency slot is taken, or
 * the free ones belong to older queued runs; the run stays pending with
 * CodingRun.queuedAt set until drainCodingQueue starts it.
 */
export type ProvisioningClaim = "claimed" | "unavailable" | "queued";

export interface ContainerExecutionStore {
  load(runId: string): Promise<ContainerRunSnapshot | null>;
  claimProvisioning(runId: string, claimId: string): Promise<ProvisioningClaim>;
  persistHandle(runId: string, claimId: string, handle: JobHandle): Promise<void>;
  heartbeat(runId: string): Promise<void>;
  complete(runId: string, status: "succeeded" | "budget_exhausted", result: CodingRunResult): Promise<void>;
  terminate(
    runId: string,
    status: "failed" | "refused" | "lost" | "cancelled",
    error: string,
    audit?: CodingFailureAudit,
  ): Promise<void>;
}

export interface CodingFailureAudit {
  failureCategory: string;
  diagnosticId: string;
}

export class PrismaContainerExecutionStore implements ContainerExecutionStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly options: { maxConcurrent?: number } = {},
  ) {}

  async load(runId: string): Promise<ContainerRunSnapshot | null> {
    const row = await this.db.run.findUnique({
      where: { id: runId },
      include: { agent: true, codingRun: { include: { proxySession: true } } },
    });
    if (!row?.codingRun) return null;
    return {
      runId: row.id,
      status: row.status,
      agentKind: row.agent.kind,
      agentName: row.agent.name,
      ownerId: row.agent.ownerId,
      task: row.codingRun.task,
      repository: row.codingRun.repository,
      baseRef: row.codingRun.baseRef,
      headRef: row.codingRun.headRef,
      provider: row.codingRun.provider,
      model: row.codingRun.model,
      timeoutSec: row.codingRun.timeoutSec,
      allowedEgress: row.codingRun.allowedEgress,
      protectedPaths: row.codingRun.protectedPaths,
      rootCodingRunId: row.codingRun.rootCodingRunId,
      budgetUsd: Number(row.codingRun.budgetReservedUsd),
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: Number(row.costUsd),
      jobHandle:
        row.codingRun.jobBackend && row.codingRun.jobBackend !== PROVISIONING_BACKEND && row.codingRun.jobHandle
          ? { backend: row.codingRun.jobBackend, id: row.codingRun.jobHandle }
          : null,
      provisioningClaim: row.codingRun.jobBackend === PROVISIONING_BACKEND ? (row.codingRun.jobHandle ?? null) : null,
      proxySessionId: row.codingRun.proxySession?.id ?? null,
      result: row.codingRun.result,
      workerImage: row.codingRun.workerImage,
      workspaceDiskMb: row.codingRun.workspaceDiskMb,
    };
  }

  async claimProvisioning(runId: string, claimId: string): Promise<ProvisioningClaim> {
    try {
      return await this.db.$transaction(async (tx) => {
        const { maxConcurrent } = this.options;
        if (maxConcurrent !== undefined) {
          // Slot usage is derived from run state, never a separate counter: a
          // run that finishes, fails, is stopped, or is reconciled to lost stops
          // counting, so a crashed replica cannot leak a slot.
          await tx.$queryRawUnsafe(CODING_SLOT_LOCK_SQL);
          const active = await tx.codingRun.count({
            where: { jobBackend: { not: null }, run: { status: { in: ["pending", "running"] } } },
          });
          // Oldest first (spec §6): a free slot belongs to the queued runs
          // ahead of this one, not to whichever claim reaches the lock first.
          // Without this a fresh dispatch could take a slot freed with no
          // immediate drain (stopped from another replica, say) and starve
          // older queued runs into coding_queue_timeout. A run not yet queued
          // is behind every queued run; queued runs order by (queuedAt,
          // runId), the same order drainCodingQueue starts them in.
          const self = await tx.codingRun.findUnique({ where: { runId }, select: { queuedAt: true } });
          const selfQueuedAt = self?.queuedAt ?? null;
          const queuedAhead = await tx.codingRun.count({
            where: {
              runId: { not: runId },
              queuedAt: { not: null },
              jobBackend: null,
              run: { status: "pending" },
              ...(selfQueuedAt
                ? { OR: [{ queuedAt: { lt: selfQueuedAt } }, { queuedAt: selfQueuedAt, runId: { lt: runId } }] }
                : {}),
            },
          });
          if (active + queuedAhead >= maxConcurrent) {
            const queued = await tx.codingRun.updateMany({
              where: { runId, jobBackend: null, queuedAt: null, run: { status: "pending" } },
              data: { queuedAt: new Date() },
            });
            if (queued.count === 1) return "queued";
            const alreadyQueued = await tx.codingRun.count({
              where: { runId, jobBackend: null, queuedAt: { not: null }, run: { status: "pending" } },
            });
            return alreadyQueued === 1 ? "queued" : "unavailable";
          }
        }
        const claimed = await tx.codingRun.updateMany({
          where: {
            runId,
            jobBackend: null,
            jobHandle: null,
            run: { status: { in: ["pending", "running"] } },
          },
          data: { jobBackend: PROVISIONING_BACKEND, jobHandle: claimId, queuedAt: null },
        });
        if (claimed.count === 0) return "unavailable";
        const started = await tx.run.updateMany({
          where: { id: runId, status: { in: ["pending", "running"] } },
          data: { status: "running", heartbeatAt: new Date() },
        });
        if (started.count === 0) {
          // The Run left pending/running between the CodingRun claim above and
          // here (e.g. drainCodingQueue's coding_queue_timeout failure landed
          // mid-claim). Abort the whole transaction so the CodingRun claim
          // rolls back too, rather than reviving a run that just failed.
          throw new RunNoLongerActiveError();
        }
        return "claimed";
      });
    } catch (err) {
      if (err instanceof RunNoLongerActiveError) return "unavailable";
      throw err;
    }
  }

  async persistHandle(runId: string, claimId: string, handle: JobHandle): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const coding = await tx.codingRun.findUnique({ where: { runId }, include: { run: true } });
      if (!coding) throw new Error("coding_run_not_found");
      if (coding.run.status !== "pending" && coding.run.status !== "running") {
        throw new Error("coding_run_not_active");
      }
      if (coding.jobBackend || coding.jobHandle) {
        if (coding.jobBackend === handle.backend && coding.jobHandle === handle.id) return;
        if (coding.jobBackend !== PROVISIONING_BACKEND || coding.jobHandle !== claimId) {
          throw new Error("coding_job_handle_conflict");
        }
      }
      const persisted = await tx.codingRun.updateMany({
        where: { runId, jobBackend: PROVISIONING_BACKEND, jobHandle: claimId },
        data: { jobBackend: handle.backend, jobHandle: handle.id },
      });
      if (persisted.count !== 1) throw new Error("coding_job_handle_conflict");
      await tx.run.update({
        where: { id: runId },
        data: { status: "running", heartbeatAt: new Date() },
      });
    });
  }

  async heartbeat(runId: string): Promise<void> {
    await this.db.run.updateMany({
      where: { id: runId, status: "running" },
      data: { heartbeatAt: new Date() },
    });
  }

  async complete(runId: string, status: "succeeded" | "budget_exhausted", result: CodingRunResult): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const run = await tx.run.findUnique({ where: { id: runId }, include: { codingRun: true } });
      if (!run?.codingRun) throw new Error("coding_run_not_found");
      if (TERMINAL_STATUSES.has(run.status)) {
        if (run.codingRun.result && stableJson(run.codingRun.result) === stableJson(result)) return;
        throw new Error("coding_run_terminal_conflict");
      }
      await tx.codingRun.update({
        where: { runId },
        data: { result, resultSchema: CODING_PROTOCOL_VERSION },
      });
      await tx.run.update({
        where: { id: runId },
        data: {
          status,
          finalText: result.summary,
          finishedAt: new Date(),
          heartbeatAt: new Date(),
          error: null,
        },
      });
    });
  }

  async terminate(
    runId: string,
    status: "failed" | "refused" | "lost" | "cancelled",
    error: string,
    audit?: CodingFailureAudit,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const updated = await tx.run.updateMany({
        where: { id: runId, status: { in: ["pending", "running"] } },
        data: { status, error, finishedAt: new Date(), heartbeatAt: new Date() },
      });
      if (updated.count && audit) {
        await tx.codingRun.update({
          where: { runId },
          data: { failureCategory: audit.failureCategory, diagnosticId: audit.diagnosticId },
        });
      }
    });
  }
}

export interface CodingSessionController {
  createSession(input: {
    runId: string;
    credentialRef: string;
    protocol: ProxyProtocol;
    allowedModels: string[];
    deadlineAt: Date;
    budgetUsd: number;
  }): Promise<{ id: string; capability: string }>;
  cancelSession(sessionId: string): Promise<void>;
}

/** Plain capabilities live only for the short provisioning window. */
export class RunCapabilityVault {
  private readonly values = new Map<string, string>();

  set(runId: string, capability: string): void {
    if (this.values.has(runId)) throw new Error("coding_capability_exists");
    this.values.set(runId, capability);
  }

  async get(runId: string): Promise<string> {
    const capability = this.values.get(runId);
    if (!capability) throw new Error("coding_capability_unavailable");
    return capability;
  }

  delete(runId: string): void {
    this.values.delete(runId);
  }
}

export interface ContainerExecutorOptions {
  store: ContainerExecutionStore;
  jobs: WorkspaceJobLauncher;
  vcs: VcsProvider;
  sessions: CodingSessionController;
  capabilities: RunCapabilityVault;
  artifactRoot: string;
  workerImage: string;
  /** Additional toolchains beyond the "node" baseline (workerImage). Keyed by toolchain, then version. */
  additionalWorkerImages?: Record<string, Record<string, string>>;
  credentialRef: string;
  claudeWorkerImage?: string;
  claudeToolRunnerImage?: string;
  anthropicCredentialRef?: string;
  limits: JobResourceLimits;
  pollMinMs?: number;
  pollMaxMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  observer?: CodingRunObserver;
  /**
   * Called after a run this process executed reaches a terminal status,
   * so a waiting run can take the freed concurrency slot right away rather
   * than on the next scheduler tick. Never called for a run that was queued.
   */
  onSlotReleased?: () => void;
}

class PreflightError extends Error {}

export class ContainerExecutor implements Executor {
  private readonly artifactRoot: string;
  private readonly active = new Map<string, Promise<void>>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly observer: CodingRunObserver;
  private readonly startedAt = new Map<string, number>();

  constructor(private readonly options: ContainerExecutorOptions) {
    this.artifactRoot = resolve(options.artifactRoot);
    if (this.artifactRoot === resolve("/")) throw new Error("coding_artifact_root_invalid");
    if (!isImmutableDockerImage(options.workerImage)) {
      throw new Error("coding_worker_image_invalid");
    }
    for (const versions of Object.values(options.additionalWorkerImages ?? {})) {
      for (const image of Object.values(versions)) {
        if (!isImmutableDockerImage(image)) throw new Error("coding_worker_image_invalid");
      }
    }
    for (const image of [options.claudeWorkerImage, options.claudeToolRunnerImage]) {
      if (image !== undefined && !isImmutableDockerImage(image)) throw new Error("coding_worker_image_invalid");
    }
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(options.credentialRef)) {
      throw new Error("coding_credential_ref_invalid");
    }
    if (
      options.anthropicCredentialRef !== undefined &&
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(options.anthropicCredentialRef)
    ) {
      throw new Error("coding_credential_ref_invalid");
    }
    const { cpus, memoryMb, pids, diskMb } = options.limits;
    if (
      !Number.isFinite(cpus) ||
      cpus <= 0 ||
      !Number.isSafeInteger(memoryMb) ||
      memoryMb <= 0 ||
      !Number.isSafeInteger(pids) ||
      pids <= 0 ||
      !Number.isSafeInteger(diskMb) ||
      diskMb <= 0
    ) {
      throw new Error("coding_resource_limits_invalid");
    }
    this.sleep =
      options.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.now = options.now ?? (() => new Date());
    this.observer = options.observer ?? codingRunObserver;
  }

  async start(runId: string): Promise<void> {
    const current = this.active.get(runId);
    if (current) return current;
    this.startedAt.set(runId, this.now().getTime());
    this.emit({ stage: "queued", runId });
    const execution = this.execute(runId).finally(async () => {
      this.active.delete(runId);
      if (!this.options.onSlotReleased) return;
      const after = await this.options.store.load(runId).catch(() => null);
      if (after && TERMINAL_STATUSES.has(after.status)) this.options.onSlotReleased();
    });
    this.active.set(runId, execution);
    return execution;
  }

  async stop(runId: string, reason = "cancelled"): Promise<void> {
    const run = await this.options.store.load(runId);
    if (!run) return;
    if (TERMINAL_STATUSES.has(run.status)) return this.cleanupTerminal(run);
    this.emit({ stage: "stopping", runId, jobId: run.jobHandle?.id });
    // Persist the cancellation fence first so a concurrent finisher cannot publish.
    const failure = this.failure("cancelled");
    await this.options.store.terminate(runId, "cancelled", failure.error, failure.audit);
    this.terminal(run, "cancelled", failure.audit);
    if (run.proxySessionId) await this.options.sessions.cancelSession(run.proxySessionId).catch(() => undefined);
    if (run.jobHandle) {
      await this.options.jobs.stop(run.jobHandle, reason).catch(() => undefined);
      await this.options.jobs.remove(run.jobHandle).catch(() => undefined);
    }
    this.options.capabilities.delete(runId);
    const input = this.preflightForCleanup(run);
    const workspace = input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null;
    if (workspace) {
      await this.options.vcs.cleanup(workspace).catch(() => undefined);
      await this.options.vcs.notifyContinuationFinished?.(workspace, "failed", { agentName: run.agentName });
    }
    await rm(this.artifactPath(runId), { recursive: true, force: true }).catch(() => undefined);
    this.emit({ stage: "cleanup", runId, jobId: run.jobHandle?.id, cleanupSucceeded: true });
  }

  async recover(handle: PersistedExecutionHandle): Promise<ExecutionRecoveryResult> {
    const run = await this.options.store.load(handle.runId);
    if (!run) return { state: "lost", reason: "coding_run_not_found" };
    if (TERMINAL_STATUSES.has(run.status)) {
      await this.cleanupTerminal(run);
      return { state: "terminal" };
    }
    if (handle.backend === PROVISIONING_BACKEND || run.provisioningClaim) {
      await this.abandon(run, "coding_ambiguous_provisioning");
      return { state: "lost", reason: "coding_ambiguous_provisioning" };
    }
    if (!run.jobHandle || run.jobHandle.backend !== handle.backend || run.jobHandle.id !== handle.id) {
      await this.abandon(run, "coding_job_handle_mismatch");
      return { state: "lost", reason: "coding_job_handle_mismatch" };
    }
    let status;
    try {
      status = await this.options.jobs.status(run.jobHandle);
    } catch {
      await this.abandon(run, "coding_job_status_unavailable");
      return { state: "lost", reason: "coding_job_status_unavailable" };
    }
    if (status.state === "pending" || status.state === "running") {
      await this.options.store.heartbeat(run.runId);
      return { state: "active" };
    }
    await this.finishTerminal(run, run.jobHandle, status.state);
    const finished = await this.options.store.load(run.runId);
    return finished && TERMINAL_STATUSES.has(finished.status)
      ? { state: "terminal" }
      : { state: "lost", reason: "coding_recovery_incomplete" };
  }

  private async execute(runId: string): Promise<void> {
    let run = await this.options.store.load(runId);
    if (!run) throw new Error("coding_run_not_found");
    if (TERMINAL_STATUSES.has(run.status)) return this.cleanupTerminal(run);
    let workspace: PreparedWorkspace | null = null;
    let sessionId = run.proxySessionId;
    let handle = run.jobHandle;
    let claimId: string | null = null;
    let spendEnabled = Boolean(sessionId);
    try {
      const prepared = this.preflight(run);
      if (!handle) {
        if (run.provisioningClaim) return;
        claimId = randomUUID();
        // "queued": every slot is taken; the run stays pending and
        // drainCodingQueue starts it when one frees. "unavailable": another
        // process owns provisioning, or the run is no longer active.
        if ((await this.options.store.claimProvisioning(runId, claimId)) !== "claimed") return;
      }
      try {
        workspace = await this.options.vcs.recoverWorkspace(prepared);
        if (!workspace && handle) throw new Error("coding_workspace_lost");
        if (!workspace) workspace = await this.options.vcs.prepareWorkspace(prepared);
        this.emit({ stage: "prepared", runId });
      } catch (error) {
        if (!spendEnabled && !handle) throw new PreflightError(safeError(error), { cause: error });
        throw error;
      }
      await this.options.vcs.notifyContinuationStarted?.(workspace, { agentName: run.agentName });

      if (!handle) {
        if (sessionId) throw new Error("coding_ambiguous_provisioning");
        const beforeSession = await this.requireCurrent(runId);
        if (TERMINAL_STATUSES.has(beforeSession.status)) throw new Error("coding_run_no_longer_active");
        const deadlineAt = new Date(this.now().getTime() + run.timeoutSec * 1_000);
        const session = await this.options.sessions.createSession({
          runId,
          credentialRef: this.credentialRef(run.provider),
          protocol: proxyProtocol(run.provider),
          allowedModels: [run.model],
          deadlineAt,
          budgetUsd: run.budgetUsd,
        });
        spendEnabled = true;
        sessionId = session.id;
        this.options.capabilities.set(runId, session.capability);
        const inputArtifact = await this.writeInput(run, deadlineAt);
        const beforeLaunch = await this.requireCurrent(runId);
        if (TERMINAL_STATUSES.has(beforeLaunch.status)) throw new Error("coding_run_no_longer_active");
        handle = await this.options.jobs.launch(this.jobSpec(run, inputArtifact));
        await this.options.store.persistHandle(runId, claimId!, handle);
        this.options.capabilities.delete(runId);
        this.emit({ stage: "launched", runId, jobId: handle.id, budgetReservedUsd: run.budgetUsd });
      }

      let delay = this.options.pollMinMs ?? 250;
      const maximumDelay = this.options.pollMaxMs ?? 5_000;
      let observedRunning = false;
      for (;;) {
        const status = await this.options.jobs.status(handle);
        if (status.state !== "pending" && status.state !== "running") {
          await this.finishTerminal(run, handle, status.state, workspace, sessionId);
          return;
        }
        if (status.state === "running" && !observedRunning) {
          observedRunning = true;
          this.emit({ stage: "running", runId, jobId: handle.id });
        }
        await this.options.store.heartbeat(runId);
        await this.sleep(delay);
        delay = Math.min(maximumDelay, Math.max(delay + 1, Math.ceil(delay * 1.5)));
        run = (await this.options.store.load(runId)) ?? run;
        if (TERMINAL_STATUSES.has(run.status)) return;
      }
    } catch (error) {
      this.options.capabilities.delete(runId);
      if (sessionId) await this.options.sessions.cancelSession(sessionId).catch(() => undefined);
      if (handle) await this.options.jobs.stop(handle, "executor_failure").catch(() => undefined);
      const status = !spendEnabled && error instanceof PreflightError ? "refused" : "failed";
      const failure = this.failure(error);
      this.emit({
        stage: "stopping",
        runId,
        jobId: handle?.id,
        failureCategory: failure.audit.failureCategory,
        diagnosticId: failure.audit.diagnosticId,
      });
      await this.options.store.terminate(runId, status, failure.error, failure.audit);
      this.terminal(run, status, failure.audit);
      if (handle) await this.options.jobs.remove(handle).catch(() => undefined);
      if (workspace) {
        await this.options.vcs.cleanup(workspace).catch(() => undefined);
        await this.options.vcs.notifyContinuationFinished?.(workspace, "failed", { agentName: run.agentName });
      }
      this.emit({ stage: "cleanup", runId, jobId: handle?.id, cleanupSucceeded: true });
    }
  }

  private preflight(run: ContainerRunSnapshot): VcsPrepareInput {
    try {
      if (run.status !== "pending" && run.status !== "running") throw new Error("coding_run_status_invalid");
      if (run.agentKind !== "coding" || !run.ownerId) throw new Error("coding_run_ownership_invalid");
      if (run.provider === "codex") getModelPricing(run.model);
      else if (run.provider === "claude-code") getAnthropicPricing(run.model);
      else throw new Error("coding_provider_unsupported");
      if (!Number.isFinite(run.budgetUsd) || run.budgetUsd <= 0 || run.costUsd > run.budgetUsd) {
        throw new Error("coding_run_budget_invalid");
      }
      const profile = CodingProfileSchema.parse({
        provider: run.provider,
        repository: run.repository,
        baseRef: run.baseRef,
        defaultTask: null,
        timeoutSec: run.timeoutSec,
        allowedEgress: run.allowedEgress,
        protectedPaths: run.protectedPaths,
      });
      const expectedHeadRunId = run.rootCodingRunId ?? run.runId;
      if (run.headRef !== `wardby/run-${expectedHeadRunId}`) throw new Error("coding_head_ref_invalid");
      const continuationOf = run.rootCodingRunId ? { runId: run.rootCodingRunId } : undefined;
      CodingTaskInputSchema.parse({
        schemaVersion: CODING_PROTOCOL_VERSION,
        runId: run.runId,
        repository: profile.repository,
        baseRef: profile.baseRef,
        headRef: run.headRef,
        task: run.task,
        model: run.model,
        budgetUsd: run.budgetUsd,
        deadlineAt: new Date(this.now().getTime() + run.timeoutSec * 1_000).toISOString(),
        continuationOf,
      });
      return {
        runId: run.runId,
        repository: profile.repository,
        baseRef: profile.baseRef,
        headRef: run.headRef,
        protectedPaths: profile.protectedPaths,
        continuation: run.rootCodingRunId ? { rootRunId: run.rootCodingRunId } : undefined,
      };
    } catch (error) {
      throw new PreflightError(safeError(error), { cause: error });
    }
  }

  private async finishTerminal(
    run: ContainerRunSnapshot,
    handle: JobHandle,
    jobState: "succeeded" | "failed" | "stopped" | "lost",
    existingWorkspace?: PreparedWorkspace | null,
    existingSessionId?: string | null,
  ): Promise<void> {
    const sessionId = existingSessionId ?? run.proxySessionId;
    if (sessionId) await this.options.sessions.cancelSession(sessionId).catch(() => undefined);
    // For notifyContinuationFinished in the `finally` below -- defaults to
    // "failed" and is only flipped right before an actual success return.
    let outcome: "succeeded" | "failed" = "failed";
    let finishedSummary: string | undefined;
    try {
      if (jobState !== "succeeded") {
        const collected = await this.options.jobs.collect(handle).catch(() => null);
        const reason = collected?.diagnostic ?? collected?.reason ?? jobState;
        this.emit({ stage: "collected", runId: run.runId, jobId: handle.id });
        const status = jobState === "lost" ? "lost" : "failed";
        const failure = this.failure(`job_${reason}`);
        await this.options.store.terminate(run.runId, status, failure.error, failure.audit);
        this.terminal(run, status, failure.audit);
        return;
      }
      const collected = await this.options.jobs.collect(handle);
      this.emit({ stage: "collected", runId: run.runId, jobId: handle.id });
      if (collected.reason !== "completed" || !collected.resultArtifact) throw new Error("coding_result_missing");
      const output = parseCodingAgentOutputJson(collected.resultArtifact);
      if (output.runId !== run.runId) throw new Error("coding_result_run_mismatch");
      let current = await this.requireCurrent(run.runId);
      if (current.costUsd > current.budgetUsd || output.outcome === "budget_exhausted") {
        this.emit({ stage: "budget_cutoff", runId: run.runId, jobId: handle.id });
        await this.options.store.complete(
          run.runId,
          "budget_exhausted",
          this.resultFor(output, current, "budget_exhausted"),
        );
        this.terminal(current, "budget_exhausted");
        return;
      }
      if (output.outcome === "no_changes") {
        await this.options.store.complete(run.runId, "succeeded", this.resultFor(output, current));
        this.terminal(current, "succeeded");
        outcome = "succeeded";
        finishedSummary = output.summary;
        return;
      }

      const preparedInput = this.preflight(current);
      const workspace = existingWorkspace ?? (await this.options.vcs.recoverWorkspace(preparedInput));
      if (!workspace) throw new Error("coding_workspace_lost");
      await this.options.jobs.materializeWorkspace(handle, workspace.workspacePath);
      current = await this.requireCurrent(run.runId);
      if (current.costUsd > current.budgetUsd) {
        this.emit({ stage: "budget_cutoff", runId: run.runId, jobId: handle.id });
        await this.options.store.complete(
          run.runId,
          "budget_exhausted",
          this.resultFor(output, current, "budget_exhausted"),
        );
        this.terminal(current, "budget_exhausted");
        return;
      }
      const finalized = await this.options.vcs.finalizeChanges(workspace, {
        summary: output.summary,
        tests: output.tests,
        tag: output.tag,
      });
      const result = this.resultFor(output, current, finalized.outcome, finalized);
      await this.options.store.complete(run.runId, "succeeded", result);
      if (finalized.outcome === "pull_request_opened" || finalized.outcome === "pull_request_updated") {
        this.emit({ stage: finalized.outcome, runId: run.runId, jobId: handle.id });
      }
      this.terminal(current, "succeeded");
      outcome = "succeeded";
      finishedSummary = output.summary;
    } catch (error) {
      const failure = this.failure(error);
      await this.options.store.terminate(run.runId, "failed", failure.error, failure.audit);
      this.terminal(run, "failed", failure.audit);
    } finally {
      await this.options.jobs.remove(handle).catch(() => undefined);
      const input = this.preflightForCleanup(run);
      const workspace =
        existingWorkspace ?? (input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null);
      if (workspace) {
        await this.options.vcs.cleanup(workspace).catch(() => undefined);
        await this.options.vcs.notifyContinuationFinished?.(workspace, outcome, {
          summary: finishedSummary,
          agentName: run.agentName,
        });
      }
      await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
      this.emit({ stage: "cleanup", runId: run.runId, jobId: handle.id, cleanupSucceeded: true });
    }
  }

  private resultFor(
    output: CodingAgentOutput,
    run: ContainerRunSnapshot,
    forcedOutcome?: "pull_request_opened" | "pull_request_updated" | "no_changes" | "budget_exhausted",
    finalized?: Awaited<ReturnType<VcsProvider["finalizeChanges"]>>,
  ): CodingRunResult {
    const outcome = forcedOutcome ?? (output.outcome === "budget_exhausted" ? "budget_exhausted" : "no_changes");
    return CodingRunResultSchema.parse({
      schemaVersion: CODING_PROTOCOL_VERSION,
      outcome,
      repository: run.repository,
      baseRef: run.baseRef,
      ...((outcome === "pull_request_opened" || outcome === "pull_request_updated") &&
      (finalized?.outcome === "pull_request_opened" || finalized?.outcome === "pull_request_updated")
        ? {
            headRef: finalized.headRef,
            commitSha: finalized.commitSha,
            pullRequestUrl: finalized.pullRequestUrl,
            pullRequestNumber: finalized.pullRequestNumber,
          }
        : {}),
      summary: output.summary,
      tests: output.tests,
      tag: output.tag,
      usage: { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd },
    });
  }

  resolveCodingWorkerImage(selector: CodingImageSelector): string {
    if (selector.provider === "claude-code") {
      if (selector.toolchain !== "node" || selector.toolchainVersion !== null) {
        throw new Error("coding_toolchain_unsupported:claude-code");
      }
      const image = selector.workerImageRef ?? this.options.claudeWorkerImage;
      if (!image || !this.options.claudeToolRunnerImage) throw new Error("coding_provider_not_configured:claude-code");
      if (!isImmutableDockerImage(image) || !isImmutableDockerImage(this.options.claudeToolRunnerImage)) {
        throw new Error("coding_worker_image_invalid");
      }
      return image;
    }
    if (selector.provider !== "codex") {
      throw new Error(`coding_provider_unsupported:${String(selector.provider)}`);
    }
    if (selector.workerImageRef) {
      if (!isImmutableDockerImage(selector.workerImageRef)) throw new Error("coding_worker_image_invalid");
      return selector.workerImageRef;
    }
    if (selector.toolchain === "node") return this.options.workerImage;
    const versions = this.options.additionalWorkerImages?.[selector.toolchain];
    const image = selector.toolchainVersion ? versions?.[selector.toolchainVersion] : undefined;
    if (!image) {
      throw new Error(
        `No worker image for toolchain "${selector.toolchain}" version "${selector.toolchainVersion ?? "(none)"}" — refusing to guess. Add it to additionalWorkerImages.`,
      );
    }
    return image;
  }

  private async requireCurrent(runId: string): Promise<ContainerRunSnapshot> {
    const current = await this.options.store.load(runId);
    if (!current) throw new Error("coding_run_not_found");
    return current;
  }

  private jobSpec(run: ContainerRunSnapshot, inputArtifact: string): JobSpec {
    const provider = run.provider === "claude-code" ? "claude-code" : "codex";
    if (provider === "claude-code" && (!run.workerImage || !this.options.claudeToolRunnerImage)) {
      throw new Error("coding_provider_not_configured:claude-code");
    }
    return {
      kind: "coding-agent",
      runId: run.runId,
      provider,
      image: run.workerImage ?? this.options.workerImage,
      ...(provider === "claude-code" ? { toolImage: this.options.claudeToolRunnerImage } : {}),
      inputArtifact,
      timeoutSec: run.timeoutSec,
      limits: { ...this.options.limits, ...(run.workspaceDiskMb ? { diskMb: run.workspaceDiskMb } : {}) },
      labels: {},
    };
  }

  private credentialRef(provider: string): string {
    if (provider === "codex") return this.options.credentialRef;
    if (provider === "claude-code" && this.options.anthropicCredentialRef) return this.options.anthropicCredentialRef;
    throw new Error("coding_provider_not_configured:claude-code");
  }

  private async writeInput(run: ContainerRunSnapshot, deadlineAt: Date): Promise<string> {
    await mkdir(this.artifactRoot, { recursive: true, mode: 0o700 });
    const rootReal = await realpath(this.artifactRoot);
    const directory = resolve(rootReal, run.runId);
    if (!directory.startsWith(`${rootReal}${sep}`)) throw new Error("coding_artifact_path_invalid");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== directory) throw new Error("coding_artifact_path_invalid");
    const destination = join(directory, "input.json");
    const temporary = join(directory, `.input-${randomUUID()}.tmp`);
    const input = CodingTaskInputSchema.parse({
      schemaVersion: CODING_PROTOCOL_VERSION,
      runId: run.runId,
      repository: run.repository,
      baseRef: run.baseRef,
      headRef: run.headRef,
      task: run.task,
      model: run.model,
      budgetUsd: run.budgetUsd,
      deadlineAt: deadlineAt.toISOString(),
      continuationOf: run.rootCodingRunId ? { runId: run.rootCodingRunId } : undefined,
    });
    // The run directory is 0700; world-readable mode only crosses Docker's UID boundary.
    await writeFile(temporary, JSON.stringify(input), { flag: "wx", mode: 0o444 });
    await rename(temporary, destination);
    return destination;
  }

  private artifactPath(runId: string): string {
    return resolve(this.artifactRoot, runId);
  }

  private preflightForCleanup(run: ContainerRunSnapshot): VcsPrepareInput | null {
    if (!Array.isArray(run.protectedPaths) || !run.protectedPaths.every((path) => typeof path === "string"))
      return null;
    return {
      runId: run.runId,
      repository: run.repository,
      baseRef: run.baseRef,
      headRef: run.headRef,
      protectedPaths: run.protectedPaths,
      continuation: run.rootCodingRunId ? { rootRunId: run.rootCodingRunId } : undefined,
    };
  }

  private async abandon(run: ContainerRunSnapshot, reason: string): Promise<void> {
    const failure = this.failure(reason);
    await this.options.store.terminate(run.runId, "lost", failure.error, failure.audit);
    this.terminal(run, "lost", failure.audit);
    if (run.proxySessionId) await this.options.sessions.cancelSession(run.proxySessionId).catch(() => undefined);
    if (run.jobHandle) {
      await this.options.jobs.stop(run.jobHandle, reason).catch(() => undefined);
      await this.options.jobs.collect(run.jobHandle).catch(() => undefined);
      await this.options.jobs.remove(run.jobHandle).catch(() => undefined);
    }
    const input = this.preflightForCleanup(run);
    const workspace = input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null;
    if (workspace) {
      await this.options.vcs.cleanup(workspace).catch(() => undefined);
      await this.options.vcs.notifyContinuationFinished?.(workspace, "failed", { agentName: run.agentName });
    }
    await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
    this.emit({ stage: "cleanup", runId: run.runId, jobId: run.jobHandle?.id, cleanupSucceeded: true });
  }

  private async cleanupTerminal(run: ContainerRunSnapshot): Promise<void> {
    if (run.proxySessionId) await this.options.sessions.cancelSession(run.proxySessionId).catch(() => undefined);
    if (run.jobHandle) {
      const status = await this.options.jobs.status(run.jobHandle).catch(() => null);
      if (status?.state === "pending" || status?.state === "running") {
        await this.options.jobs.stop(run.jobHandle, "terminal_cleanup").catch(() => undefined);
      }
      await this.options.jobs.collect(run.jobHandle).catch(() => undefined);
      await this.options.jobs.remove(run.jobHandle).catch(() => undefined);
    }
    const input = this.preflightForCleanup(run);
    const workspace = input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null;
    if (workspace) {
      await this.options.vcs.cleanup(workspace).catch(() => undefined);
      // Safety-net retry for an already-terminal run recovered later (e.g.
      // a crash between an earlier store.complete/terminate and this
      // notification actually firing) -- safe to call again because
      // notifyContinuationFinished is find-and-update-or-no-op, never
      // find-or-create.
      await this.options.vcs.notifyContinuationFinished?.(
        workspace,
        run.status === "succeeded" ? "succeeded" : "failed",
        { agentName: run.agentName },
      );
    }
    await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
    this.emit({ stage: "cleanup", runId: run.runId, jobId: run.jobHandle?.id, cleanupSucceeded: true });
  }

  private emit(event: Parameters<CodingRunObserver["emit"]>[0]): void {
    try {
      this.observer.emit(event);
    } catch {
      // Telemetry cannot change a run's security or terminal behavior.
    }
  }

  private terminal(
    run: ContainerRunSnapshot,
    outcome: "succeeded" | "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled",
    audit?: CodingFailureAudit,
  ): void {
    this.emit({
      stage: "terminal",
      runId: run.runId,
      jobId: run.jobHandle?.id,
      outcome,
      failureCategory: audit?.failureCategory,
      diagnosticId: audit?.diagnosticId,
      durationMs: this.duration(run.runId),
      budgetActualUsd: run.costUsd,
      ...(run.provider === "codex" || run.provider === "claude-code"
        ? { workerProvider: run.provider, proxyProtocol: proxyProtocol(run.provider) }
        : {}),
    });
  }

  private failure(error: unknown): { error: string; audit: CodingFailureAudit } {
    const category = failureCategory(error);
    const diagnosticId = `coding_diag_${randomUUID()}`;
    return { error: `coding_failure_${category}:${diagnosticId}`, audit: { failureCategory: category, diagnosticId } };
  }

  private duration(runId: string): number | undefined {
    const startedAt = this.startedAt.get(runId);
    return startedAt === undefined ? undefined : Math.max(0, this.now().getTime() - startedAt);
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  return `coding_executor:${redactTokenShapedValues(message)
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 200)}`;
}

function failureCategory(error: unknown): string {
  const message = safeError(error);
  if (message.includes("preflight") || message.includes("ownership") || message.includes("image")) return "preflight";
  if (message.includes("budget")) return "budget";
  if (message.includes("artifact") || message.includes("result")) return "artifact";
  if (message.includes("workspace") || message.includes("git") || message.includes("vcs")) return "workspace";
  if (message.includes("job") || message.includes("container")) return "job";
  if (message.includes("cancel")) return "cancelled";
  return "executor";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
