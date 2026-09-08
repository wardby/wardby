import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { JobHandle, JobResult, JobSpec, JobStatus, WorkspaceJobLauncher } from "../jobs/types.js";
import type { FinalizeChangesResult, PreparedWorkspace, VcsPrepareInput, VcsProvider } from "../vcs/types.js";
import {
  ContainerExecutor,
  RunCapabilityVault,
  type CodingSessionController,
  type ContainerExecutionStore,
  type ContainerRunSnapshot,
} from "./container.js";

const IMAGE = `registry.example/worker@sha256:${"a".repeat(64)}`;
const roots: string[] = [];

function snapshot(overrides: Partial<ContainerRunSnapshot> = {}): ContainerRunSnapshot {
  return {
    runId: "run-1",
    status: "running",
    agentKind: "coding",
    ownerId: "principal-1",
    task: "Fix the bug and test it.",
    repository: "openai/example",
    baseRef: "main",
    headRef: "reevo/run-run-1",
    provider: "codex",
    model: "gpt-5.6-luna",
    timeoutSec: 900,
    allowedEgress: [],
    protectedPaths: [".github/workflows/**", "CODEOWNERS"],
    budgetUsd: 2,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    jobHandle: null,
    provisioningClaim: null,
    proxySessionId: null,
    result: null,
    ...overrides,
  };
}

class FakeStore implements ContainerExecutionStore {
  completions: unknown[] = [];
  terminations: unknown[] = [];
  heartbeats = 0;

  constructor(public run: ContainerRunSnapshot) {}

  async load(runId: string): Promise<ContainerRunSnapshot | null> {
    return runId === this.run.runId ? structuredClone(this.run) : null;
  }

  async claimProvisioning(_runId: string, claimId: string): Promise<boolean> {
    if (this.run.jobHandle || this.run.provisioningClaim) return false;
    this.run.provisioningClaim = claimId;
    this.run.status = "running";
    return true;
  }

  async persistHandle(_runId: string, claimId: string, handle: JobHandle): Promise<void> {
    if (this.run.status !== "pending" && this.run.status !== "running") throw new Error("not_active");
    if (this.run.provisioningClaim !== claimId) throw new Error("claim_conflict");
    if (this.run.jobHandle && JSON.stringify(this.run.jobHandle) !== JSON.stringify(handle))
      throw new Error("conflict");
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
  launches = 0;
  materializations = 0;
  removals = 0;
  stops = 0;
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

  async launch(_spec: JobSpec): Promise<JobHandle> {
    this.launches += 1;
    this.events.push("launch");
    return this.handle;
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

  constructor(
    private readonly root: string,
    private readonly events: string[],
  ) {}

  async prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace> {
    this.prepared += 1;
    this.events.push("prepare");
    this.workspace = this.makeWorkspace(input);
    return this.workspace;
  }
  async recoverWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace | null> {
    return this.workspace?.runId === input.runId ? this.workspace : null;
  }
  async finalizeChanges(): Promise<FinalizeChangesResult> {
    this.finalized += 1;
    this.events.push("finalize");
    return {
      outcome: "pull_request_opened",
      repository: "openai/example",
      baseRef: "main",
      baseCommit: "a".repeat(40),
      headRef: "reevo/run-run-1",
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

  constructor(
    private readonly events: string[],
    private readonly store: FakeStore,
  ) {}

  async createSession(): Promise<{ id: string; capability: string }> {
    this.creates += 1;
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

async function harness(overrides: Partial<ContainerRunSnapshot> = {}, workerImage = IMAGE) {
  const root = await mkdtemp("/private/tmp/reevo-container-executor-");
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
    limits: { cpus: 1, memoryMb: 1024, pids: 64, diskMb: 512 },
    sleep: async () => {},
  });
  return { executor, store, jobs, vcs, sessions, capabilities, events };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ContainerExecutor", () => {
  it("accepts a content-addressed local Docker image ID", async () => {
    await expect(harness({}, `sha256:${"a".repeat(64)}`)).resolves.toBeDefined();
  });

  it("launches once, cancels spend before materialization, and persists a typed PR result", async () => {
    const created = await harness();
    await Promise.all([created.executor.start("run-1"), created.executor.start("run-1")]);

    expect(created.jobs.launches).toBe(1);
    expect(created.sessions.creates).toBe(1);
    expect(created.store.run.status).toBe("succeeded");
    expect(created.store.run.result).toMatchObject({
      outcome: "pull_request_opened",
      pullRequestNumber: 42,
      usage: { tokensIn: 100, tokensOut: 20, costUsd: 0.01 },
    });
    expect(created.events).toEqual([
      "prepare",
      "session",
      "launch",
      "cancel",
      "collect",
      "materialize",
      "finalize",
      "remove",
      "cleanup",
    ]);
    await expect(created.capabilities.get("run-1")).rejects.toThrow("coding_capability_unavailable");
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
      headRef: "reevo/run-run-1",
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
