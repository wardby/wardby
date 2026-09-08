import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PrismaClient } from "@prisma/client";
import { CodingProfileSchema } from "../../coding/profile.js";
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
import { isImmutableDockerImage } from "../jobs/docker-isolation.js";
import type { JobHandle, JobResourceLimits, JobSpec, WorkspaceJobLauncher } from "../jobs/types.js";
import type { PreparedWorkspace, VcsPrepareInput, VcsProvider } from "../vcs/types.js";
import type { ExecutionRecoveryResult, Executor, PersistedExecutionHandle } from "./types.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);
const PROVISIONING_BACKEND = "provisioning";

export interface ContainerRunSnapshot {
  runId: string;
  status: string;
  agentKind: string;
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
  budgetUsd: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  jobHandle: JobHandle | null;
  provisioningClaim: string | null;
  proxySessionId: string | null;
  result: unknown;
}

export interface ContainerExecutionStore {
  load(runId: string): Promise<ContainerRunSnapshot | null>;
  claimProvisioning(runId: string, claimId: string): Promise<boolean>;
  persistHandle(runId: string, claimId: string, handle: JobHandle): Promise<void>;
  heartbeat(runId: string): Promise<void>;
  complete(runId: string, status: "succeeded" | "budget_exhausted", result: CodingRunResult): Promise<void>;
  terminate(runId: string, status: "failed" | "refused" | "lost" | "cancelled", error: string): Promise<void>;
}

export class PrismaContainerExecutionStore implements ContainerExecutionStore {
  constructor(private readonly db: PrismaClient) {}

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
    };
  }

  async claimProvisioning(runId: string, claimId: string): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      const claimed = await tx.codingRun.updateMany({
        where: {
          runId,
          jobBackend: null,
          jobHandle: null,
          run: { status: { in: ["pending", "running"] } },
        },
        data: { jobBackend: PROVISIONING_BACKEND, jobHandle: claimId },
      });
      if (claimed.count === 0) return false;
      await tx.run.update({
        where: { id: runId },
        data: { status: "running", heartbeatAt: new Date() },
      });
      return true;
    });
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

  async terminate(runId: string, status: "failed" | "refused" | "lost" | "cancelled", error: string): Promise<void> {
    await this.db.run.updateMany({
      where: { id: runId, status: { in: ["pending", "running"] } },
      data: { status, error, finishedAt: new Date(), heartbeatAt: new Date() },
    });
  }
}

export interface CodingSessionController {
  createSession(input: {
    runId: string;
    credentialRef: string;
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
  credentialRef: string;
  limits: JobResourceLimits;
  pollMinMs?: number;
  pollMaxMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
}

class PreflightError extends Error {}

export class ContainerExecutor implements Executor {
  private readonly artifactRoot: string;
  private readonly active = new Map<string, Promise<void>>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(private readonly options: ContainerExecutorOptions) {
    this.artifactRoot = resolve(options.artifactRoot);
    if (this.artifactRoot === resolve("/")) throw new Error("coding_artifact_root_invalid");
    if (!isImmutableDockerImage(options.workerImage)) {
      throw new Error("coding_worker_image_invalid");
    }
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,199}$/.test(options.credentialRef)) {
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
  }

  async start(runId: string): Promise<void> {
    const current = this.active.get(runId);
    if (current) return current;
    const execution = this.execute(runId).finally(() => this.active.delete(runId));
    this.active.set(runId, execution);
    return execution;
  }

  async stop(runId: string, reason = "cancelled"): Promise<void> {
    const run = await this.options.store.load(runId);
    if (!run) return;
    if (TERMINAL_STATUSES.has(run.status)) return this.cleanupTerminal(run);
    // Persist the cancellation fence first so a concurrent finisher cannot publish.
    await this.options.store.terminate(runId, "cancelled", "coding_run_cancelled");
    if (run.proxySessionId) await this.options.sessions.cancelSession(run.proxySessionId).catch(() => undefined);
    if (run.jobHandle) {
      await this.options.jobs.stop(run.jobHandle, reason).catch(() => undefined);
      await this.options.jobs.remove(run.jobHandle).catch(() => undefined);
    }
    this.options.capabilities.delete(runId);
    const input = this.preflightForCleanup(run);
    const workspace = input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null;
    if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
    await rm(this.artifactPath(runId), { recursive: true, force: true }).catch(() => undefined);
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
        if (!(await this.options.store.claimProvisioning(runId, claimId))) return;
      }
      try {
        workspace = await this.options.vcs.recoverWorkspace(prepared);
        if (!workspace && handle) throw new Error("coding_workspace_lost");
        if (!workspace) workspace = await this.options.vcs.prepareWorkspace(prepared);
      } catch (error) {
        if (!spendEnabled && !handle) throw new PreflightError(safeError(error), { cause: error });
        throw error;
      }

      if (!handle) {
        if (sessionId) throw new Error("coding_ambiguous_provisioning");
        const beforeSession = await this.requireCurrent(runId);
        if (TERMINAL_STATUSES.has(beforeSession.status)) throw new Error("coding_run_no_longer_active");
        const deadlineAt = new Date(this.now().getTime() + run.timeoutSec * 1_000);
        const session = await this.options.sessions.createSession({
          runId,
          credentialRef: this.options.credentialRef,
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
      }

      let delay = this.options.pollMinMs ?? 250;
      const maximumDelay = this.options.pollMaxMs ?? 5_000;
      for (;;) {
        const status = await this.options.jobs.status(handle);
        if (status.state !== "pending" && status.state !== "running") {
          await this.finishTerminal(run, handle, status.state, workspace, sessionId);
          return;
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
      await this.options.store.terminate(runId, status, safeError(error));
      if (handle) await this.options.jobs.remove(handle).catch(() => undefined);
      if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
    }
  }

  private preflight(run: ContainerRunSnapshot): VcsPrepareInput {
    try {
      if (run.status !== "pending" && run.status !== "running") throw new Error("coding_run_status_invalid");
      if (run.agentKind !== "coding" || !run.ownerId) throw new Error("coding_run_ownership_invalid");
      getModelPricing(run.model);
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
      if (run.headRef !== `reevo/run-${run.runId}`) throw new Error("coding_head_ref_invalid");
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
      });
      return {
        runId: run.runId,
        repository: profile.repository,
        baseRef: profile.baseRef,
        headRef: run.headRef,
        protectedPaths: profile.protectedPaths,
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
    try {
      if (jobState !== "succeeded") {
        const collected = await this.options.jobs.collect(handle).catch(() => null);
        const reason = collected?.diagnostic ?? collected?.reason ?? jobState;
        await this.options.store.terminate(run.runId, jobState === "lost" ? "lost" : "failed", `coding_job_${reason}`);
        return;
      }
      const collected = await this.options.jobs.collect(handle);
      if (collected.reason !== "completed" || !collected.resultArtifact) throw new Error("coding_result_missing");
      const output = parseCodingAgentOutputJson(collected.resultArtifact);
      if (output.runId !== run.runId) throw new Error("coding_result_run_mismatch");
      let current = await this.requireCurrent(run.runId);
      if (current.costUsd > current.budgetUsd || output.outcome === "budget_exhausted") {
        await this.options.store.complete(
          run.runId,
          "budget_exhausted",
          this.resultFor(output, current, "budget_exhausted"),
        );
        return;
      }
      if (output.outcome === "no_changes") {
        await this.options.store.complete(run.runId, "succeeded", this.resultFor(output, current));
        return;
      }

      const preparedInput = this.preflight(current);
      const workspace = existingWorkspace ?? (await this.options.vcs.recoverWorkspace(preparedInput));
      if (!workspace) throw new Error("coding_workspace_lost");
      await this.options.jobs.materializeWorkspace(handle, workspace.workspacePath);
      current = await this.requireCurrent(run.runId);
      if (current.costUsd > current.budgetUsd) {
        await this.options.store.complete(
          run.runId,
          "budget_exhausted",
          this.resultFor(output, current, "budget_exhausted"),
        );
        return;
      }
      const finalized = await this.options.vcs.finalizeChanges(workspace);
      const result = this.resultFor(output, current, finalized.outcome, finalized);
      await this.options.store.complete(run.runId, "succeeded", result);
    } catch (error) {
      await this.options.store.terminate(run.runId, "failed", safeError(error));
    } finally {
      await this.options.jobs.remove(handle).catch(() => undefined);
      const input = this.preflightForCleanup(run);
      const workspace =
        existingWorkspace ?? (input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null);
      if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
      await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private resultFor(
    output: CodingAgentOutput,
    run: ContainerRunSnapshot,
    forcedOutcome?: "pull_request_opened" | "no_changes" | "budget_exhausted",
    finalized?: Awaited<ReturnType<VcsProvider["finalizeChanges"]>>,
  ): CodingRunResult {
    const outcome = forcedOutcome ?? (output.outcome === "budget_exhausted" ? "budget_exhausted" : "no_changes");
    return CodingRunResultSchema.parse({
      schemaVersion: CODING_PROTOCOL_VERSION,
      outcome,
      repository: run.repository,
      baseRef: run.baseRef,
      ...(outcome === "pull_request_opened" && finalized?.outcome === "pull_request_opened"
        ? {
            headRef: finalized.headRef,
            commitSha: finalized.commitSha,
            pullRequestUrl: finalized.pullRequestUrl,
            pullRequestNumber: finalized.pullRequestNumber,
          }
        : {}),
      summary: output.summary,
      tests: output.tests,
      usage: { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd },
    });
  }

  private async requireCurrent(runId: string): Promise<ContainerRunSnapshot> {
    const current = await this.options.store.load(runId);
    if (!current) throw new Error("coding_run_not_found");
    return current;
  }

  private jobSpec(run: ContainerRunSnapshot, inputArtifact: string): JobSpec {
    return {
      kind: "coding-agent",
      runId: run.runId,
      image: this.options.workerImage,
      inputArtifact,
      timeoutSec: run.timeoutSec,
      limits: { ...this.options.limits },
      labels: {},
    };
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
    };
  }

  private async abandon(run: ContainerRunSnapshot, reason: string): Promise<void> {
    await this.options.store.terminate(run.runId, "lost", reason);
    if (run.proxySessionId) await this.options.sessions.cancelSession(run.proxySessionId).catch(() => undefined);
    if (run.jobHandle) {
      await this.options.jobs.stop(run.jobHandle, reason).catch(() => undefined);
      await this.options.jobs.collect(run.jobHandle).catch(() => undefined);
      await this.options.jobs.remove(run.jobHandle).catch(() => undefined);
    }
    const input = this.preflightForCleanup(run);
    const workspace = input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null;
    if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
    await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
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
    if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
    await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
  }
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  return `coding_executor:${redactTokenShapedValues(message)
    .replace(/[^A-Za-z0-9_.:-]/g, "_")
    .slice(0, 200)}`;
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
