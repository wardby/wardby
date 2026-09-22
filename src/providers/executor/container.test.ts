import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCodingRunObserver } from "../../coding/observability.js";
import type { JobHandle, JobResult, JobSpec, JobStatus, WorkspaceJobLauncher } from "../jobs/types.js";
import type {
  FinalizeChangesDetails,
  FinalizeChangesResult,
  PreparedWorkspace,
  VcsPrepareInput,
  VcsProvider,
} from "../vcs/types.js";
import {
  ContainerExecutor,
  RunCapabilityVault,
  type CodingSessionController,
  type ContainerExecutionStore,
  type ContainerExecutorOptions,
  type ContainerRunSnapshot,
  type ProvisioningClaim,
} from "./container.js";

const IMAGE = `registry.example/worker@sha256:${"a".repeat(64)}`;
const CLAUDE_IMAGE = `registry.example/claude-worker@sha256:${"b".repeat(64)}`;
const CLAUDE_TOOL_IMAGE = `registry.example/claude-tools@sha256:${"c".repeat(64)}`;
const roots: string[] = [];

function snapshot(overrides: Partial<ContainerRunSnapshot> = {}): ContainerRunSnapshot {
  return {
    runId: "run-1",
    status: "running",
    agentKind: "coding",
    agentName: "knock-knock-implement",
    ownerId: "principal-1",
    task: "Fix the bug and test it.",
    repository: "openai/example",
    baseRef: "main",
    headRef: "wardby/run-run-1",
    provider: "codex",
    model: "gpt-5.6-luna",
    timeoutSec: 900,
    allowedEgress: [],
    protectedPaths: [".github/workflows/**", "CODEOWNERS"],
    rootCodingRunId: null,
    budgetUsd: 2,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    jobHandle: null,
    provisioningClaim: null,
    proxySessionId: null,
    result: null,
    workerImage: null,
    workspaceDiskMb: null,
    ...overrides,
  };
}

class FakeStore implements ContainerExecutionStore {
  completions: unknown[] = [];
  terminations: unknown[] = [];
  /** Every handle written, in order, so tests can see whether one was stored before launching. */
  persistedHandles: JobHandle[] = [];
  heartbeats = 0;

  constructor(public run: ContainerRunSnapshot) {}

  async load(runId: string): Promise<ContainerRunSnapshot | null> {
    return runId === this.run.runId ? structuredClone(this.run) : null;
  }

  /** When true, the next claims report every slot taken. */
  slotsFull = false;

  async claimProvisioning(_runId: string, claimId: string): Promise<ProvisioningClaim> {
    if (this.run.jobHandle || this.run.provisioningClaim) return "unavailable";
    if (this.slotsFull) return "queued";
    this.run.provisioningClaim = claimId;
    this.run.status = "running";
    return "claimed";
  }

  async persistHandle(_runId: string, claimId: string, handle: JobHandle): Promise<void> {
    if (this.run.status !== "pending" && this.run.status !== "running") throw new Error("not_active");
    // Mirrors the real store: re-persisting the same handle is a no-op, even once the claim is gone.
    if (this.run.jobHandle) {
      if (JSON.stringify(this.run.jobHandle) !== JSON.stringify(handle)) throw new Error("conflict");
      this.persistedHandles.push(structuredClone(handle));
      return;
    }
    if (this.run.provisioningClaim !== claimId) throw new Error("claim_conflict");
    this.persistedHandles.push(structuredClone(handle));
    this.run.jobHandle = structuredClone(handle);
    this.run.provisioningClaim = null;
    this.run.status = "running";
  }

  async heartbeat(): Promise<void> {
    this.heartbeats += 1;
  }

  async complete(runId: string, status: "succeeded" | "budget_exhausted", result: never): Promise<void> {
    if (runId !== this.run.runId || ["succeeded", "budget_exhausted"].includes(this.run.status)) return;
    this.run.status = status;
    this.run.result = structuredClone(result);
    this.completions.push({ status, result: structuredClone(result) });
  }

  async terminate(runId: string, status: "failed" | "refused" | "lost" | "cancelled", error: string): Promise<void> {
    if (runId !== this.run.runId || ["succeeded", "budget_exhausted"].includes(this.run.status)) return;
    this.run.status = status;
    this.terminations.push({ status, error });
  }
}

class FakeJobs implements WorkspaceJobLauncher {
  readonly handle = { backend: "fake", id: "job-1" };
  /** Set to mimic a backend (Kubernetes) whose handle is known before the cluster is touched. */
  planned?: JobHandle;
  /** Set to make launch() fail the way a crash-prone provisioning would. */
  launchError?: Error;
  /** Runs at the start of launch(), so a test can observe what was already persisted. */
  onLaunch?: () => void;
  launches = 0;
  materializations = 0;
  removals = 0;
  stops = 0;
  lastSpec?: JobSpec;
  specs: JobSpec[] = [];
  statusValue: JobStatus = { state: "succeeded" };
  result: JobResult = {
    exitCode: 0,
    reason: "completed",
    resultArtifact: JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "changes_ready",
      summary: "Fixed it.",
      tests: [{ command: "npm test", outcome: "passed" }],
    }),
  };

  constructor(private readonly events: string[]) {}

  plannedHandle(spec: JobSpec): JobHandle | undefined {
    return this.planned ? { ...this.planned, id: `${this.planned.id}-${spec.runId}` } : undefined;
  }
  async launch(spec: JobSpec): Promise<JobHandle> {
    this.launches += 1;
    this.lastSpec = spec;
    this.specs.push(spec);
    this.events.push("launch");
    this.onLaunch?.();
    if (this.launchError) throw this.launchError;
    return this.plannedHandle(spec) ?? this.handle;
  }
  async status(): Promise<JobStatus> {
    return this.statusValue;
  }
  async collect(): Promise<JobResult> {
    this.events.push("collect");
    return this.result;
  }
  async stop(): Promise<void> {
    this.stops += 1;
  }
  async remove(): Promise<void> {
    this.removals += 1;
    this.events.push("remove");
  }
  async materializeWorkspace(): Promise<void> {
    this.materializations += 1;
    this.events.push("materialize");
  }
}

class FakeVcs implements VcsProvider {
  prepared = 0;
  finalized = 0;
  cleaned = 0;
  workspace: PreparedWorkspace | null = null;
  lastFinalizeDetails?: FinalizeChangesDetails;
  lastPrepareInput?: VcsPrepareInput;
  notifyStartedCalls = 0;
  lastNotifyStartedAgentName?: string;
  notifyFinishedCalls: Array<{ outcome: "succeeded" | "failed"; summary?: string; agentName?: string }> = [];

  constructor(
    private readonly root: string,
    private readonly events: string[],
  ) {}

  async prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace> {
    this.prepared += 1;
    this.lastPrepareInput = input;
    this.events.push("prepare");
    this.workspace = this.makeWorkspace(input);
    return this.workspace;
  }
  async recoverWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace | null> {
    return this.workspace?.runId === input.runId ? this.workspace : null;
  }
  async finalizeChanges(
    workspace: PreparedWorkspace,
    details?: FinalizeChangesDetails,
  ): Promise<FinalizeChangesResult> {
    this.finalized += 1;
    this.lastFinalizeDetails = details;
    this.events.push("finalize");
    return {
      outcome: workspace.continuation ? "pull_request_updated" : "pull_request_opened",
      repository: "openai/example",
      baseRef: "main",
      baseCommit: "a".repeat(40),
      headRef: workspace.headRef,
      commitSha: "b".repeat(40),
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/openai/example/pull/42",
    };
  }
  async cleanup(): Promise<void> {
    this.cleaned += 1;
    this.events.push("cleanup");
    this.workspace = null;
  }
  async notifyContinuationStarted(_workspace: PreparedWorkspace, details?: { agentName?: string }): Promise<void> {
    this.notifyStartedCalls += 1;
    this.lastNotifyStartedAgentName = details?.agentName;
    this.events.push("notifyStarted");
  }
  async notifyContinuationFinished(
    _workspace: PreparedWorkspace,
    outcome: "succeeded" | "failed",
    details?: { summary?: string; agentName?: string },
  ): Promise<void> {
    this.notifyFinishedCalls.push({ outcome, summary: details?.summary, agentName: details?.agentName });
    this.events.push(`notifyFinished:${outcome}`);
  }
  private makeWorkspace(input: VcsPrepareInput): PreparedWorkspace {
    return {
      id: `vcs-${input.runId}`,
      ...input,
      baseCommit: "a".repeat(40),
      workspacePath: join(this.root, input.runId, "workspace"),
      gitMetadataPath: join(this.root, input.runId, "git"),
    };
  }
}

class FakeSessions implements CodingSessionController {
  creates = 0;
  cancels = 0;
  lastInput?: Parameters<CodingSessionController["createSession"]>[0];

  constructor(
    private readonly events: string[],
    private readonly store: FakeStore,
  ) {}

  async createSession(input: Parameters<CodingSessionController["createSession"]>[0]): Promise<{
    id: string;
    capability: string;
  }> {
    this.creates += 1;
    this.lastInput = input;
    this.events.push("session");
    this.store.run.proxySessionId = "session-1";
    return { id: "session-1", capability: `rrp_${"x".repeat(32)}` };
  }
  async cancelSession(): Promise<void> {
    this.cancels += 1;
    this.events.push("cancel");
    this.store.run.tokensIn = 100;
    this.store.run.tokensOut = 20;
    this.store.run.costUsd = 0.01;
  }
}

async function harness(
  overrides: Partial<ContainerRunSnapshot> = {},
  workerImage = IMAGE,
  observer = new InMemoryCodingRunObserver(),
  claude?: { workerImage: string; toolImage: string },
  extra: Partial<ContainerExecutorOptions> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "wardby-container-executor-"));
  roots.push(root);
  const events: string[] = [];
  const store = new FakeStore(snapshot(overrides));
  const jobs = new FakeJobs(events);
  const vcs = new FakeVcs(join(root, "vcs"), events);
  const sessions = new FakeSessions(events, store);
  const capabilities = new RunCapabilityVault();
  const executor = new ContainerExecutor({
    store,
    jobs,
    vcs,
    sessions,
    capabilities,
    artifactRoot: join(root, "artifacts"),
    workerImage,
    credentialRef: "env:OPENAI_API_KEY",
    ...(claude
      ? {
          claudeWorkerImage: claude.workerImage,
          claudeToolRunnerImage: claude.toolImage,
          anthropicCredentialRef: "env:ANTHROPIC_API_KEY",
        }
      : {}),
    limits: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 512 },
    maxDiskMb: 8192,
    sleep: async () => {},
    observer,
    ...extra,
  });
  return { executor, store, jobs, vcs, sessions, capabilities, events, observer };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ContainerExecutor", () => {
  it("calls onSlotReleased once after a run reaches a terminal status, never for a queued run", async () => {
    let releases = 0;
    const onSlotReleased = () => {
      releases += 1;
    };
    const finished = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, { onSlotReleased });
    await finished.executor.start("run-1");
    expect(["succeeded", "failed", "budget_exhausted"]).toContain(finished.store.run.status);
    expect(releases).toBe(1);

    releases = 0;
    const queued = await harness({ status: "pending" }, IMAGE, new InMemoryCodingRunObserver(), undefined, {
      onSlotReleased,
    });
    queued.store.slotsFull = true;
    await queued.executor.start("run-1");
    expect(queued.store.run.status).toBe("pending");
    expect(releases).toBe(0);
  });

  it("sizes the job's workspace from the run's per-agent workspaceDiskMb", async () => {
    const created = await harness({ workspaceDiskMb: 8192 });
    await created.executor.start("run-1");
    expect(created.jobs.specs[0]?.limits.diskMb).toBe(8192);
  });

  it("falls back to the deployment's default disk size", async () => {
    const created = await harness();
    await created.executor.start("run-1");
    expect(created.jobs.specs[0]?.limits.diskMb).toBe(512);
  });

  it("allows a workspaceDiskMb exactly at the operator's maxDiskMb ceiling", async () => {
    const created = await harness({ workspaceDiskMb: 8192 }, IMAGE, new InMemoryCodingRunObserver(), undefined, {
      maxDiskMb: 8192,
    });
    await created.executor.start("run-1");
    expect(created.jobs.specs[0]?.limits.diskMb).toBe(8192);
    expect(created.store.run.status).not.toBe("failed");
  });

  it("rejects a workspaceDiskMb over the operator's maxDiskMb ceiling as a normal failed run", async () => {
    const created = await harness({ workspaceDiskMb: 8193 }, IMAGE, new InMemoryCodingRunObserver(), undefined, {
      maxDiskMb: 8192,
    });
    await created.executor.start("run-1");
    expect(created.jobs.launches).toBe(0);
    expect(created.store.run.status).toBe("failed");
    expect(created.store.run.result).toBeNull();
    expect(created.store.terminations).toEqual([
      expect.objectContaining({ status: "failed", error: expect.stringContaining("coding_failure_workspace:") }),
    ]);
  });

  it("accepts a content-addressed local Docker image ID", async () => {
    await expect(harness({}, `sha256:${"a".repeat(64)}`)).resolves.toBeDefined();
  });

  it("launches once, cancels spend before materialization, and persists a typed PR result", async () => {
    const created = await harness();
    await Promise.all([created.executor.start("run-1"), created.executor.start("run-1")]);

    expect(created.jobs.launches).toBe(1);
    expect(created.sessions.creates).toBe(1);
    expect(created.sessions.lastInput).toMatchObject({ protocol: "openai-responses" });
    expect(created.store.run.status).toBe("succeeded");
    expect(created.store.run.result).toMatchObject({
      outcome: "pull_request_opened",
      pullRequestNumber: 42,
      usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.01 },
    });
    expect(created.events).toEqual([
      "prepare",
      "notifyStarted",
      "session",
      "launch",
      "cancel",
      "collect",
      "materialize",
      "finalize",
      "remove",
      "cleanup",
      "notifyFinished:succeeded",
    ]);
    await expect(created.capabilities.get("run-1")).rejects.toThrow("coding_capability_unavailable");
    expect(created.observer.events.map((event) => event.stage)).toEqual([
      "queued",
      "prepared",
      "launched",
      "collected",
      "pull_request_opened",
      "terminal",
      "cleanup",
    ]);
    expect(created.observer.events.every((event) => JSON.stringify(event).includes("Fix the bug") === false)).toBe(
      true,
    );
    expect(created.observer.metrics.snapshot()).toMatchObject({
      terminalOutcomes: { succeeded: 1 },
      activeJobs: 0,
      budgetReservedUsd: 2,
      budgetActualUsd: 0.01,
    });
  });

  it("revision-in-place: threads continuation through to the VCS layer and persists pull_request_updated", async () => {
    const created = await harness({ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
    await created.executor.start("run-1");

    expect(created.vcs.lastPrepareInput).toMatchObject({
      headRef: "wardby/run-root-run",
      continuation: { rootRunId: "root-run" },
    });
    expect(created.store.run.result).toMatchObject({ outcome: "pull_request_updated", pullRequestNumber: 42 });
    expect(created.observer.events.map((event) => event.stage)).toContain("pull_request_updated");
    expect(created.vcs.notifyStartedCalls).toBe(1);
    expect(created.vcs.notifyFinishedCalls).toEqual([
      { outcome: "succeeded", summary: "Fixed it.", agentName: "knock-knock-implement" },
    ]);
  });

  describe("continuation status notifications (notifyContinuationStarted/Finished lifecycle hooks)", () => {
    it("notifies started once workspace is obtained, and finished with 'succeeded' on the success path", async () => {
      const created = await harness();
      await created.executor.start("run-1");

      expect(created.vcs.notifyStartedCalls).toBe(1);
      expect(created.vcs.lastNotifyStartedAgentName).toBe("knock-knock-implement");
      expect(created.vcs.notifyFinishedCalls).toEqual([
        { outcome: "succeeded", summary: "Fixed it.", agentName: "knock-knock-implement" },
      ]);
    });

    it("notifies finished with 'failed' when the budget is exhausted", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      await created.executor.start("run-1");

      expect(created.vcs.notifyStartedCalls).toBe(1);
      expect(created.vcs.notifyFinishedCalls).toEqual([{ outcome: "failed", agentName: "knock-knock-implement" }]);
    });

    it("notifies finished with 'failed' when the underlying job fails", async () => {
      const created = await harness();
      created.jobs.statusValue = { state: "failed" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("failed");
      expect(created.vcs.notifyStartedCalls).toBe(1);
      expect(created.vcs.notifyFinishedCalls).toEqual([{ outcome: "failed", agentName: "knock-knock-implement" }]);
    });

    it("never notifies started when the run is refused before a workspace exists", async () => {
      const created = await harness({ ownerId: null });
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("refused");
      expect(created.vcs.notifyStartedCalls).toBe(0);
      expect(created.vcs.notifyFinishedCalls).toHaveLength(0);
    });

    it("notifies finished with 'failed' when stopped mid-run", async () => {
      const handle = { backend: "fake", id: "job-1" };
      const created = await harness({ jobHandle: handle, proxySessionId: "session-1" });
      await created.vcs.prepareWorkspace({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: ["CODEOWNERS"],
      });

      await created.executor.stop("run-1", "requested");

      expect(created.store.run.status).toBe("cancelled");
      expect(created.vcs.notifyFinishedCalls).toEqual([{ outcome: "failed", agentName: "knock-knock-implement" }]);
    });
  });

  it("routes Claude through its dedicated proxy credential and composite job spec", async () => {
    const created = await harness(
      { provider: "claude-code", model: "claude-sonnet-5", workerImage: CLAUDE_IMAGE },
      IMAGE,
      new InMemoryCodingRunObserver(),
      { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
    );
    await created.executor.start("run-1");
    expect(created.sessions.lastInput).toMatchObject({
      credentialRef: "env:ANTHROPIC_API_KEY",
      protocol: "anthropic-messages",
      allowedModels: ["claude-sonnet-5"],
    });
    expect(created.jobs.lastSpec).toMatchObject({
      provider: "claude-code",
      image: CLAUDE_IMAGE,
      toolImage: CLAUDE_TOOL_IMAGE,
    });
    expect(created.observer.events.find((event) => event.stage === "terminal")).toMatchObject({
      workerProvider: "claude-code",
      proxyProtocol: "anthropic-messages",
    });
  });

  it("passes the worker's summary, tests, and tag through to VCS finalization and the persisted result", async () => {
    const created = await harness();
    created.jobs.result.resultArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "changes_ready",
      summary: "Fixed it.",
      tests: [{ command: "npm test", outcome: "passed" }],
      tag: "JIRA-123",
    });

    await created.executor.start("run-1");

    expect(created.vcs.lastFinalizeDetails).toEqual({
      summary: "Fixed it.",
      tests: [{ command: "npm test", outcome: "passed" }],
      tag: "JIRA-123",
    });
    expect(created.store.run.result).toMatchObject({ tag: "JIRA-123" });
  });

  it("skips materialization and VCS finalization for a no-change output", async () => {
    const created = await harness();
    created.jobs.result.resultArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "no_changes",
      summary: "Already correct.",
      tests: [],
    });
    await created.executor.start("run-1");
    expect(created.jobs.materializations).toBe(0);
    expect(created.vcs.finalized).toBe(0);
    expect(created.store.run.result).toMatchObject({ outcome: "no_changes" });
  });

  it("stops before VCS finalization when authoritative usage exceeds the budget", async () => {
    const created = await harness({ budgetUsd: 0.005 });
    await created.executor.start("run-1");
    expect(created.jobs.materializations).toBe(0);
    expect(created.vcs.finalized).toBe(0);
    expect(created.store.run.status).toBe("budget_exhausted");
    expect(created.store.run.result).toMatchObject({ outcome: "budget_exhausted", usage: { costUsd: 0.01 } });
    expect(created.observer.events.map((event) => event.stage)).toContain("budget_cutoff");
    expect(created.observer.metrics.snapshot().terminalOutcomes).toEqual({ budget_exhausted: 1 });
  });

  it("refuses invalid ownership before creating a workspace, session, or job", async () => {
    const created = await harness({ ownerId: null });
    await created.executor.start("run-1");
    expect(created.store.run.status).toBe("refused");
    expect(created.vcs.prepared).toBe(0);
    expect(created.sessions.creates).toBe(0);
    expect(created.jobs.launches).toBe(0);
  });

  it("never relaunches an ambiguous session without a durable job handle", async () => {
    const created = await harness({ proxySessionId: "existing-session" });
    await created.executor.start("run-1");
    expect(created.jobs.launches).toBe(0);
    expect(created.sessions.creates).toBe(0);
    expect(created.sessions.cancels).toBe(1);
    expect(created.store.run.status).toBe("failed");
  });

  it("does not duplicate work owned by another durable provisioning claim", async () => {
    const created = await harness({ provisioningClaim: "other-process" });
    await created.executor.start("run-1");
    expect(created.vcs.prepared).toBe(0);
    expect(created.sessions.creates).toBe(0);
    expect(created.jobs.launches).toBe(0);
    expect(created.store.run.status).toBe("running");
  });

  it("leaves a run pending, with no workspace, session, or job, when every slot is taken", async () => {
    const created = await harness({ status: "pending" });
    created.store.slotsFull = true;
    await created.executor.start("run-1");
    expect(created.store.run.status).toBe("pending");
    expect(created.vcs.prepared).toBe(0);
    expect(created.sessions.creates).toBe(0);
    expect(created.jobs.launches).toBe(0);
  });

  it("persists a derivable handle before launching, and again after, idempotently", async () => {
    const created = await harness({ status: "pending" });
    created.jobs.planned = { backend: "fake", id: "planned" };
    let persistedWhenLaunchStarted: unknown;
    created.jobs.onLaunch = () => void (persistedWhenLaunchStarted = created.store.run.jobHandle);
    await created.executor.start("run-1");
    // The cluster is only touched once a handle exists to clean it up with.
    expect(persistedWhenLaunchStarted).toEqual({ backend: "fake", id: "planned-run-1" });
    expect(created.store.persistedHandles).toEqual([
      { backend: "fake", id: "planned-run-1" },
      { backend: "fake", id: "planned-run-1" },
    ]);
    expect(created.store.run.jobHandle).toEqual({ backend: "fake", id: "planned-run-1" });
  });

  it("keeps a persisted handle when a derivable launch throws, so recovery can clean the backend up", async () => {
    const created = await harness({ status: "pending" });
    created.jobs.planned = { backend: "fake", id: "planned" };
    created.jobs.launchError = new Error("kubernetes_pod_start_timeout");
    await created.executor.start("run-1");
    expect(created.store.run.status).toBe("failed");
    const handle = created.store.run.jobHandle;
    expect(handle).toEqual({ backend: "fake", id: "planned-run-1" });

    // A replica that crashed instead of failing cleanly finds the handle and removes the run's objects.
    const crashed = await harness({ jobHandle: handle, proxySessionId: "session-1" });
    crashed.jobs.statusValue = { state: "running" };
    await expect(crashed.executor.recover({ runId: "run-1", backend: "fake", id: "other" })).resolves.toEqual({
      state: "lost",
      reason: "coding_job_handle_mismatch",
    });
    expect(crashed.jobs.stops).toBe(1);
    expect(crashed.jobs.removals).toBe(1);
  });

  it("without a planned handle (Docker) persists only after launch", async () => {
    const created = await harness({ status: "pending" });
    let persistedWhenLaunchStarted: unknown = "unset";
    created.jobs.onLaunch = () => void (persistedWhenLaunchStarted = created.store.run.jobHandle);
    await created.executor.start("run-1");
    expect(created.jobs.plannedHandle(created.jobs.lastSpec!)).toBeUndefined();
    expect(persistedWhenLaunchStarted).toBeNull();
    expect(created.store.persistedHandles).toEqual([{ backend: "fake", id: "job-1" }]);
  });

  it("fails closed when a launch returns a handle other than the one already persisted", async () => {
    const created = await harness({ status: "pending" });
    created.jobs.planned = { backend: "fake", id: "planned" };
    created.jobs.launch = async (spec) => {
      created.jobs.launches += 1;
      created.jobs.lastSpec = spec;
      return { backend: "fake", id: "something-else" };
    };
    await created.executor.start("run-1");
    expect(created.store.run.status).toBe("failed");
    expect(created.store.terminations.at(-1)).toMatchObject({ status: "failed" });
  });

  it("never relaunches a stale provisioning claim during recovery", async () => {
    const created = await harness({ provisioningClaim: "dead-process", proxySessionId: "session-1" });
    await expect(
      created.executor.recover({ runId: "run-1", backend: "provisioning", id: "dead-process" }),
    ).resolves.toEqual({ state: "lost", reason: "coding_ambiguous_provisioning" });
    expect(created.sessions.creates).toBe(0);
    expect(created.sessions.cancels).toBe(1);
    expect(created.jobs.launches).toBe(0);
    expect(created.store.run.status).toBe("lost");
  });

  it("recovers an active persisted job without relaunching it", async () => {
    const handle = { backend: "fake", id: "job-1" };
    const created = await harness({ jobHandle: handle, proxySessionId: "session-1" });
    created.jobs.statusValue = { state: "running" };
    await expect(created.executor.recover({ runId: "run-1", ...handle })).resolves.toEqual({ state: "active" });
    expect(created.jobs.launches).toBe(0);
    expect(created.store.heartbeats).toBe(1);
  });

  it("stops spend, the job, and the trusted workspace idempotently", async () => {
    const handle = { backend: "fake", id: "job-1" };
    const created = await harness({ jobHandle: handle, proxySessionId: "session-1" });
    await created.vcs.prepareWorkspace({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "wardby/run-run-1",
      protectedPaths: ["CODEOWNERS"],
    });
    await created.executor.stop("run-1", "requested");
    await created.executor.stop("run-1", "requested");
    expect(created.store.run.status).toBe("cancelled");
    expect(created.sessions.cancels).toBe(2);
    expect(created.jobs.stops).toBe(1);
    expect(created.jobs.removals).toBe(2);
    expect(created.vcs.cleaned).toBe(1);
  });
});

describe("resolveCodingWorkerImage", () => {
  it("returns the node baseline (options.workerImage) for toolchain=node", async () => {
    const { executor } = await harness();
    expect(
      executor.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      }),
    ).toBe(IMAGE);
  });

  it("resolves an additional toolchain/version from additionalWorkerImages", async () => {
    const pythonImage = `registry.example/worker-python@sha256:${"b".repeat(64)}`;
    const root = await mkdtemp(join(tmpdir(), "wardby-container-executor-"));
    roots.push(root);
    const direct = new ContainerExecutor({
      store: new FakeStore(snapshot({})),
      jobs: new FakeJobs([]),
      vcs: new FakeVcs(join(root, "vcs"), []),
      sessions: new FakeSessions([], new FakeStore(snapshot({}))),
      capabilities: new RunCapabilityVault(),
      artifactRoot: join(root, "artifacts"),
      workerImage: IMAGE,
      additionalWorkerImages: { "node-python": { "3.12": pythonImage } },
      credentialRef: "env:OPENAI_API_KEY",
      limits: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 512 },
      maxDiskMb: 8192,
      sleep: async () => {},
    });
    expect(
      direct.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node-python",
        toolchainVersion: "3.12",
        workerImageRef: null,
      }),
    ).toBe(pythonImage);
  });

  it("workerImageRef short-circuits the matrix entirely when set", async () => {
    const byo = `registry.example/byo@sha256:${"c".repeat(64)}`;
    const { executor } = await harness();
    expect(
      executor.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: byo,
      }),
    ).toBe(byo);
  });

  it("throws on a malformed workerImageRef", async () => {
    const { executor } = await harness();
    expect(() =>
      executor.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: "not-a-digest",
      }),
    ).toThrow(/coding_worker_image_invalid/);
  });

  it("throws on an unknown toolchain", async () => {
    const { executor } = await harness();
    expect(() =>
      executor.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node-php",
        toolchainVersion: "8.3",
        workerImageRef: null,
      }),
    ).toThrow(/No worker image/);
  });

  it("throws on a known toolchain with an unknown version", async () => {
    const pythonImage = `registry.example/worker-python@sha256:${"b".repeat(64)}`;
    const root = await mkdtemp(join(tmpdir(), "wardby-container-executor-"));
    roots.push(root);
    const direct = new ContainerExecutor({
      store: new FakeStore(snapshot({})),
      jobs: new FakeJobs([]),
      vcs: new FakeVcs(join(root, "vcs"), []),
      sessions: new FakeSessions([], new FakeStore(snapshot({}))),
      capabilities: new RunCapabilityVault(),
      artifactRoot: join(root, "artifacts"),
      workerImage: IMAGE,
      additionalWorkerImages: { "node-python": { "3.12": pythonImage } },
      credentialRef: "env:OPENAI_API_KEY",
      limits: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 512 },
      maxDiskMb: 8192,
      sleep: async () => {},
    });
    expect(() =>
      direct.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node-python",
        toolchainVersion: "2.7",
        workerImageRef: null,
      }),
    ).toThrow(/No worker image/);
  });

  it("fails closed for Claude Code even when a BYO image is supplied", async () => {
    const { executor } = await harness();
    expect(() =>
      executor.resolveCodingWorkerImage?.({
        provider: "claude-code",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: `registry.example/byo@sha256:${"c".repeat(64)}`,
      }),
    ).toThrow(/coding_provider_not_configured:claude-code/);
  });

  it("resolves Claude only when the immutable agent and tool images are configured", async () => {
    const { executor } = await harness({}, IMAGE, new InMemoryCodingRunObserver(), {
      workerImage: CLAUDE_IMAGE,
      toolImage: CLAUDE_TOOL_IMAGE,
    });
    expect(
      executor.resolveCodingWorkerImage?.({
        provider: "claude-code",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      }),
    ).toBe(CLAUDE_IMAGE);
  });

  it("constructor throws if any additionalWorkerImages entry is not an immutable digest", async () => {
    const root = await mkdtemp(join(tmpdir(), "wardby-container-executor-"));
    roots.push(root);
    expect(
      () =>
        new ContainerExecutor({
          store: new FakeStore(snapshot({})),
          jobs: new FakeJobs([]),
          vcs: new FakeVcs(join(root, "vcs"), []),
          sessions: new FakeSessions([], new FakeStore(snapshot({}))),
          capabilities: new RunCapabilityVault(),
          artifactRoot: join(root, "artifacts"),
          workerImage: IMAGE,
          additionalWorkerImages: { "node-python": { "3.12": "wardby-coding-worker:latest" } },
          credentialRef: "env:OPENAI_API_KEY",
          limits: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 512 },
          maxDiskMb: 8192,
          sleep: async () => {},
        }),
    ).toThrow("coding_worker_image_invalid");
  });
});

describe("jobSpec image selection", () => {
  it("jobSpec uses the run's snapshotted workerImage over the deployment default", async () => {
    const pythonImage = `registry.example/worker-python@sha256:${"d".repeat(64)}`;
    const { executor, jobs } = await harness({ workerImage: pythonImage });
    await executor.start("run-1");
    expect(jobs.lastSpec?.image).toBe(pythonImage);
  });

  it("jobSpec falls back to the deployment default when the run has no snapshotted workerImage", async () => {
    const { executor, jobs } = await harness({ workerImage: null });
    await executor.start("run-1");
    expect(jobs.lastSpec?.image).toBe(IMAGE);
  });
});
