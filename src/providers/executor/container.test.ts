import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostBudgetSentence, ownerBudgetSentence, type BudgetEventView } from "../../core/budget-events.js";
import type { TopUpOutcome } from "../../core/budget-topup.js";
import { InMemoryCodingRunObserver } from "../../coding/observability.js";
import {
  budgetStoppedSummary,
  CONTINUATION_CLOSED_ERROR,
  WORKER_BUDGET_EXHAUSTED_SUMMARY,
} from "../../coding/continuation-wording.js";
import { MAX_CODING_INPUT_BYTES } from "../../coding/protocol.js";
import type { CodingProvider } from "../../coding/provider.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";
import { createRepoAccessGate, type RepoAccessGate } from "../../core/repo-access.js";
import { shippedCatalog } from "../llm/catalog.js";
import { SHIPPED_CATALOG_VERSION } from "../llm/catalog-shipped.js";
import { entryOf } from "../llm/catalog-types.js";
import { ReviewHostError, type HostPermission } from "../review-host/types.js";
import {
  JobCapacityError,
  type JobHandle,
  type JobResult,
  type JobSpec,
  type JobStatus,
  type WorkspaceJobLauncher,
} from "../jobs/types.js";
import type {
  ContinuationFinishedDetails,
  ContinuationOutcome,
  ContinuationTarget,
  DescriptionWriteOutcome,
  FinalizeChangesDetails,
  FinalizeChangesResult,
  PreparedWorkspace,
  VcsPrepareInput,
  VcsProvider,
} from "../vcs/types.js";
import { pullRequestBody, type DescriptionBaseline, type RelatedPullRequestEntry } from "../vcs/github.js";
import { descriptionSha256 } from "../vcs/pr-description.js";
import {
  CAPACITY_RETRY_BACKOFF_MS,
  ContainerExecutor,
  type CapacityRequeueOutcome,
  DESCRIPTION_REFRESH_TIMEOUT_MS,
  RunCapabilityVault,
  type LinkedIssueRef,
  type LinkedIssueSource,
  type StoredDescriptionBaseline,
  describeFailure,
  normalizeCollectedLockfiles,
  type CodingSessionController,
  type CodingRunRecord,
  type ContainerExecutionStore,
  type ContainerExecutorOptions,
  type ContainerRunSnapshot,
  type ProvisioningClaim,
} from "./container.js";
import type { RecordResult, RecordTranscriptInput, TranscriptStatus } from "../../coding/transcript/recorder.js";

/**
 * The executor's operator log, captured. The persisted run error is a bare
 * diagnostic id by design, so this log line is the only place the real reason
 * exists — which makes it worth asserting on.
 */
const logged = vi.hoisted(() => [] as { level: string; payload: Record<string, unknown>; message: string }[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at =
      (level: string) =>
      (payload: Record<string, unknown>, message?: string): void => {
        logged.push({ level, payload, message: message ?? "" });
      };
    return {
      child: () => make(),
      trace: at("trace"),
      debug: at("debug"),
      info: at("info"),
      warn: at("warn"),
      error: at("error"),
      fatal: at("fatal"),
    };
  };
  return { logger: make() };
});

/**
 * Lets a test make buildClaudeContext reject deterministically (an
 * inaccessible workspace, EACCES, ...) without touching the real filesystem;
 * every other test falls through to the real implementation.
 */
const claudeContextOverride = vi.hoisted(() => ({
  reject: undefined as Error | undefined,
}));
vi.mock("../../coding/claude-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../coding/claude-context.js")>();
  return {
    ...actual,
    buildClaudeContext: (...args: Parameters<typeof actual.buildClaudeContext>) => {
      if (claudeContextOverride.reject) return Promise.reject(claudeContextOverride.reject);
      return actual.buildClaudeContext(...args);
    },
  };
});

const IMAGE = `registry.example/worker@sha256:${"a".repeat(64)}`;
const CLAUDE_IMAGE = `registry.example/claude-worker@sha256:${"b".repeat(64)}`;
const CLAUDE_TOOL_IMAGE = `registry.example/claude-tools@sha256:${"c".repeat(64)}`;
const roots: string[] = [];
const LOCAL_REPOSITORY = "local:/srv/repos/example";

function snapshot(overrides: Partial<ContainerRunSnapshot> = {}): ContainerRunSnapshot {
  return {
    runId: "run-1",
    agentId: "agent-1",
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
    protectedPaths: [".github/workflows/**", "CODEOWNERS"],
    collectExclude: [],
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
    profileRepository: "openai/example",
    repositoryAuthorizedVia: "grandfathered",
    pricingVersion: null,
    pricingSnapshot: null,
    ...overrides,
  };
}

/**
 * The real gate against a fake GitHub where the owner ("principal-1", linked
 * as GitHub user 42) has `level` on every repository. `level` undefined = no
 * linked identity.
 */
function gateWith(
  level?: HostPermission | (() => HostPermission),
  opts: { ttlMs?: number } = {},
): { gate: RepoAccessGate; asked: string[] } {
  const asked: string[] = [];
  const linked = level !== undefined;
  const gate = createRepoAccessGate({
    db: {
      hostIdentity: {
        findUnique: async () =>
          linked ? { principalId: "principal-1", provider: "github", hostUserId: "42", login: "octo" } : null,
        updateMany: async () => ({ count: 0 }),
      },
    } as never,
    hosts: {
      github: {
        repositoryPermission: async (repository: string) => {
          asked.push(repository);
          const answer = typeof level === "function" ? level() : (level ?? "none");
          return { level: answer, login: "octo" };
        },
      } as never,
    },
    ttlMs: opts.ttlMs,
    sleep: async () => undefined,
  });
  return { gate, asked };
}

class FakeStore implements ContainerExecutionStore {
  completions: Array<{ status: string; result: unknown; record?: CodingRunRecord }> = [];
  terminations: unknown[] = [];
  /** Every handle written, in order, so tests can see whether one was stored before launching. */
  persistedHandles: JobHandle[] = [];
  heartbeats = 0;
  /** Answers relatedPullRequests when set; left undefined, the store has no such method behavior. */
  related?: RelatedPullRequestEntry[] | Error;
  /** Answers budgetEvent when set (the recorded budget refusal). */
  recordedBudgetEvent?: { event: BudgetEventView; agentName: string } | null;
  async budgetEvent(): Promise<{ event: BudgetEventView; agentName: string } | null> {
    return this.recordedBudgetEvent ?? null;
  }
  async relatedPullRequests(): Promise<RelatedPullRequestEntry[]> {
    if (this.related instanceof Error) throw this.related;
    return this.related ?? [];
  }

  /** Fix-round description store methods; tests that need them assign them. */
  pullRequestDescriptionBaseline?: (rootRunId: string) => Promise<StoredDescriptionBaseline>;
  pullRequestRunIds?: (rootRunId: string) => Promise<string[]>;
  pullRequestMarkedReady?: (rootRunId: string) => Promise<boolean>;
  linkedIssueSource?: (rootRunId: string) => Promise<LinkedIssueSource>;
  recordPullRequestDescription?: (input: {
    rootRunId: string;
    expectedSha256: string | null;
    sha256: string;
    agentTextRunId: string;
  }) => Promise<boolean>;
  /** Overrun top-ups; tests that need it assign it. */
  topUpBudget?: (runId: string) => Promise<{ outcome: TopUpOutcome; near?: boolean }>;

  constructor(public run: ContainerRunSnapshot) {}

  /** (runId, sessionId) of every recordBudgetRefusal call. */
  recordedRefusals: Array<[string, string]> = [];
  async recordBudgetRefusal(runId: string, sessionId: string): Promise<void> {
    this.recordedRefusals.push([runId, sessionId]);
  }

  async load(runId: string): Promise<ContainerRunSnapshot | null> {
    return runId === this.run.runId ? structuredClone(this.run) : null;
  }

  /** When true, the next claims report every slot taken. */
  slotsFull = false;
  /** Runs put in the queue because the cluster had no room (markQueued). */
  queuedForCapacity: string[] = [];

  async markQueued(runId: string): Promise<void> {
    this.queuedForCapacity.push(runId);
  }

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

  /** Every requeueAfterCapacityRefusal call, and what the next ones answer (null = mirror the real store). */
  requeues: Array<{ runId: string; owned: { claimId?: string; planned?: JobHandle } }> = [];
  requeueAnswer: CapacityRequeueOutcome | null = null;
  async requeueAfterCapacityRefusal(
    runId: string,
    owned: { claimId?: string; planned?: JobHandle },
  ): Promise<CapacityRequeueOutcome> {
    this.requeues.push({ runId, owned: structuredClone(owned) });
    if (this.requeueAnswer !== null) return this.requeueAnswer;
    const holdsClaim = owned.claimId !== undefined && this.run.provisioningClaim === owned.claimId;
    const holdsPlanned =
      owned.planned !== undefined && JSON.stringify(this.run.jobHandle) === JSON.stringify(owned.planned);
    if (!["pending", "running"].includes(this.run.status) || !(holdsClaim || holdsPlanned)) return "not_owned";
    // Mirrors the real store: the run waits again, with no handle and no proxy session.
    this.run.status = "pending";
    this.run.provisioningClaim = null;
    this.run.jobHandle = null;
    this.run.proxySessionId = null;
    return "requeued";
  }

  async complete(
    runId: string,
    status: "succeeded" | "budget_exhausted",
    result: never,
    record?: CodingRunRecord,
  ): Promise<void> {
    if (runId !== this.run.runId || ["succeeded", "budget_exhausted"].includes(this.run.status)) return;
    this.run.status = status;
    this.run.result = structuredClone(result);
    this.completions.push({ status, result: structuredClone(result), record: structuredClone(record) });
  }

  async terminate(
    runId: string,
    status: "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled",
    error: string,
    audit?: { failureCategory: string; diagnosticId: string },
  ): Promise<boolean> {
    // Like the real store: only a run still pending or running is changed.
    if (runId !== this.run.runId || !["pending", "running"].includes(this.run.status)) return false;
    this.run.status = status;
    this.terminations.push({ status, error, ...(audit ? { audit } : {}) });
    return true;
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
  /** Which providers this fake launcher starts services for (Kubernetes-like by default). */
  serviceProviders: CodingProvider[] = ["codex", "claude-code"];
  materializations = 0;
  removals = 0;
  stops = 0;
  lastSpec?: JobSpec;
  specs: JobSpec[] = [];
  statusValue: JobStatus = { state: "succeeded" };
  supportsServicesFor(provider: CodingProvider): boolean {
    return this.serviceProviders.includes(provider);
  }
  warmUps = 0;
  /** Set to make warmUp() throw, the way a launcher's own warmUp never does (it swallows its own failure). */
  warmUpError?: Error;
  async warmUp(): Promise<void> {
    this.warmUps += 1;
    if (this.warmUpError) throw this.warmUpError;
  }
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
  /** What hasCapacityFor answers (or throws); undefined behaves like a launcher without the check. */
  capacity?: boolean | Error;
  capacityChecks: JobSpec[] = [];
  async hasCapacityFor(spec: JobSpec): Promise<boolean> {
    this.capacityChecks.push(spec);
    if (this.capacity instanceof Error) throw this.capacity;
    return this.capacity ?? true;
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
  /** Set to give the launcher a transcript reader (it is optional on a real launcher). */
  readTranscript?: (handle: JobHandle, maxBytes: number) => Promise<string | undefined>;
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
  /** Make finalize report a pushed branch (a local repository) instead of a pull request. */
  pushBranchOnly = false;
  /** Make finalize report an empty diff (no_changes) even though the worker said changes_ready. */
  finalizeEmpty = false;
  /** The description outcome finalize reports on a pull request, when set. */
  finalizeDescription?: DescriptionWriteOutcome;
  /** The target-branch merge prepare reports on a continuation's workspace, when set. */
  targetMerge?: PreparedWorkspace["targetMerge"];
  /** The no-push description refresh; tests that need it assign it. */
  refreshPullRequestDescription?: (
    workspace: ContinuationTarget,
    details: FinalizeChangesDetails,
  ) => Promise<DescriptionWriteOutcome | undefined>;
  /** The host's draft state of a continuation's pull request; tests that need it assign it. */
  continuationPullRequestDraft?: (workspace: PreparedWorkspace) => Promise<boolean | undefined>;
  notifyStartedCalls = 0;
  lastNotifyStartedAgentName?: string;
  notifyFinishedTargets: ContinuationTarget[] = [];
  notifyFinishedCalls: Array<{
    outcome: ContinuationOutcome;
    summary?: string;
    agentName?: string;
    budgetSentence?: string;
    overrunSentence?: string;
    serviceSentence?: string;
    protectedPathSentence?: string;
    mergeSentence?: string;
    conflictMarkersSentence?: string;
    changesPushed?: { pullRequestNumber?: number };
  }> = [];

  constructor(
    private readonly root: string,
    private readonly events: string[],
  ) {}

  async prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace> {
    this.prepared += 1;
    this.lastPrepareInput = input;
    this.events.push("prepare");
    this.workspace = this.makeWorkspace(input);
    // Mirrors a real VCS provider, which always creates the workspace directory on disk: callers
    // that read a Claude Code run's repository (buildClaudeContext) need a real path to realpath().
    await mkdir(this.workspace.workspacePath, { recursive: true });
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
    if (this.finalizeEmpty) {
      return { outcome: "no_changes", repository: workspace.repository, baseRef: "main", baseCommit: "a".repeat(40) };
    }
    if (this.pushBranchOnly) {
      return {
        outcome: "branch_pushed",
        repository: workspace.repository,
        baseRef: "main",
        baseCommit: "a".repeat(40),
        headRef: workspace.headRef,
        commitSha: "b".repeat(40),
      };
    }
    return {
      outcome: workspace.continuation ? "pull_request_updated" : "pull_request_opened",
      repository: "openai/example",
      baseRef: "main",
      baseCommit: "a".repeat(40),
      headRef: workspace.headRef,
      commitSha: "b".repeat(40),
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/openai/example/pull/42",
      ...(this.finalizeDescription ? { description: structuredClone(this.finalizeDescription) } : {}),
      ...(workspace.continuation && workspace.targetMerge
        ? {
            targetMerge: {
              ref: workspace.targetMerge.ref,
              targetCommit: workspace.targetMerge.targetCommit,
              conflicts: workspace.targetMerge.conflictedPaths.length,
            },
          }
        : {}),
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
    target: ContinuationTarget,
    outcome: ContinuationOutcome,
    details?: ContinuationFinishedDetails,
  ): Promise<void> {
    this.notifyFinishedTargets.push(target);
    this.notifyFinishedCalls.push({
      outcome,
      summary: details?.summary,
      agentName: details?.agentName,
      ...(details?.budgetSentence ? { budgetSentence: details.budgetSentence } : {}),
      ...(details?.overrunSentence ? { overrunSentence: details.overrunSentence } : {}),
      ...(details?.providerSentence ? { providerSentence: details.providerSentence } : {}),
      ...(details?.serviceSentence ? { serviceSentence: details.serviceSentence } : {}),
      ...(details?.protectedPathSentence ? { protectedPathSentence: details.protectedPathSentence } : {}),
      ...(details?.mergeSentence ? { mergeSentence: details.mergeSentence } : {}),
      ...(details?.conflictMarkersSentence ? { conflictMarkersSentence: details.conflictMarkersSentence } : {}),
      ...(details?.changesPushed ? { changesPushed: details.changesPushed } : {}),
    });
    this.events.push(`notifyFinished:${outcome}`);
  }
  private makeWorkspace(input: VcsPrepareInput): PreparedWorkspace {
    return {
      id: `vcs-${input.runId}`,
      ...input,
      collectExclude: input.collectExclude ?? [],
      baseCommit: "a".repeat(40),
      workspacePath: join(this.root, input.runId, "workspace"),
      gitMetadataPath: join(this.root, input.runId, "git"),
      ...(input.continuation && this.targetMerge ? { targetMerge: structuredClone(this.targetMerge) } : {}),
    };
  }
}

class FakeSessions implements CodingSessionController {
  creates = 0;
  cancels = 0;
  /** Sessions the proxy refused a request of for budget. */
  exhausted = new Set<string>();
  /** The first upstream failure code the proxy relayed, per session. */
  upstreamFailures = new Map<string, string>();
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
  async budgetExhausted(sessionId: string): Promise<boolean> {
    return this.exhausted.has(sessionId);
  }
  async upstreamFailure(sessionId: string): Promise<string | null> {
    return this.upstreamFailures.get(sessionId) ?? null;
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
    repoAccess: gateWith().gate,
    ...extra,
  });
  return { executor, store, jobs, vcs, sessions, capabilities, events, observer, root };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

beforeEach(() => {
  logged.length = 0;
  claudeContextOverride.reject = undefined;
});

describe("ContainerExecutor", () => {
  describe("session transcripts", () => {
    const CLAUDE_RUN = { sessionResume: true, provider: "claude-code" } as const;
    async function recorded(
      overrides: Partial<ContainerRunSnapshot>,
      record: (input: RecordTranscriptInput) => Promise<RecordResult>,
      setup: (created: Awaited<ReturnType<typeof harness>>) => void = () => {},
    ) {
      const calls: RecordTranscriptInput[] = [];
      const created = await harness(
        { model: "claude-sonnet-5", workerImage: CLAUDE_IMAGE, ...overrides },
        IMAGE,
        undefined,
        { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
        {
          transcripts: {
            record: async (input) => {
              created.events.push("record");
              calls.push(input);
              return record(input);
            },
          },
        },
      );
      setup(created);
      await created.executor.start("run-1");
      return { created, calls };
    }
    const stored = async () => "stored" as const;

    it("records before the job is removed for a succeeded session-resume run", async () => {
      const { created, calls } = await recorded(CLAUDE_RUN, stored, (c) => {
        c.jobs.readTranscript = async (_handle, maxBytes) => `file:${maxBytes}`;
      });
      expect(created.store.run.status).toBe("succeeded");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ runId: "run-1", agentId: "agent-1", provider: "claude-code" });
      expect(calls[0]).not.toHaveProperty("capability");
      expect(await calls[0].read(123)).toBe("file:123");
      expect(created.events.indexOf("record")).toBeGreaterThan(-1);
      expect(created.events.indexOf("record")).toBeLessThan(created.events.indexOf("remove"));
    });

    it("records for a failed job", async () => {
      const { created, calls } = await recorded(CLAUDE_RUN, stored, (c) => {
        c.jobs.statusValue = { state: "failed" };
        c.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_failed" };
      });
      expect(created.store.run.status).toBe("failed");
      expect(calls).toHaveLength(1);
      expect(created.events.indexOf("record")).toBeLessThan(created.events.indexOf("remove"));
    });

    it("records for a budget-stopped run", async () => {
      const { created, calls } = await recorded({ ...CLAUDE_RUN, budgetUsd: 0.005 }, stored, (c) => {
        c.jobs.result.resultArtifact = JSON.stringify({
          schemaVersion: 1,
          runId: "run-1",
          outcome: "budget_exhausted",
          summary: "Ran out.",
          tests: [],
        });
        c.vcs.finalizeEmpty = true;
      });
      expect(calls).toHaveLength(1);
      expect(created.events.indexOf("record")).toBeLessThan(created.events.indexOf("remove"));
    });

    it("does not record a run without session resume", async () => {
      const { calls } = await recorded({ ...CLAUDE_RUN, sessionResume: false }, stored);
      expect(calls).toHaveLength(0);
    });

    it("hands the recorder a reader that resolves undefined when the launcher cannot read", async () => {
      const { calls } = await recorded(CLAUDE_RUN, stored);
      expect(await calls[0].read(1)).toBeUndefined();
    });

    it("logs a lost transcript row as a fixed code with the run id only", async () => {
      const { created } = await recorded(CLAUDE_RUN, async () => "row_write_failed");
      expect(created.store.run.status).toBe("succeeded");
      const line = logged.find((entry) => entry.payload.transcript === "row_write_failed");
      expect(line?.payload).toEqual({ runId: "run-1", transcript: "row_write_failed" });
    });

    it("a rejecting recorder changes nothing about the run", async () => {
      const { created } = await recorded(CLAUDE_RUN, async () => {
        throw new Error("boom");
      });
      expect(created.store.run.status).toBe("succeeded");
      expect(created.jobs.removals).toBe(1);
    });

    it("a hanging recorder is abandoned after the timeout", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const calls: RecordTranscriptInput[] = [];
        const created = await harness(
          { model: "claude-sonnet-5", workerImage: CLAUDE_IMAGE, ...CLAUDE_RUN },
          IMAGE,
          undefined,
          { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
          {
            transcripts: {
              record: (input) => {
                calls.push(input);
                return new Promise<TranscriptStatus>(() => {});
              },
            },
          },
        );
        const running = created.executor.start("run-1");
        await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 3000, interval: 5 });
        await vi.advanceTimersByTimeAsync(61_000);
        await running;
        expect(created.store.run.status).toBe("succeeded");
        expect(created.jobs.removals).toBe(1);
        expect(calls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("coding-run services", () => {
    const POSTGRES = resolvedFromDefinition(
      BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!,
    );

    async function launched(overrides: Partial<ContainerRunSnapshot>) {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return { created, input: input! };
    }

    it("tells the worker its base commit in the task", async () => {
      const { input } = await launched({});
      expect(
        (input.task as string).endsWith(
          `\n\nBase commit: ${"a".repeat(40)} (the commit this workspace was checked out at; the workspace has no git metadata).`,
        ),
      ).toBe(true);
    });

    it("appends the current PR description to a continuation's task", async () => {
      const created = await harness({ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
      let input: Record<string, unknown> | undefined;
      created.store.pullRequestDescriptionBaseline = async () => ({
        recordedSha256: null,
        previousAgentText: "Previous body",
        agentTextRunId: "root-run",
      });
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      expect(input!.task as string).toContain("your final summary replaces it");
      expect((input!.task as string).includes("Previous body")).toBe(true);
    });

    describe("the linked issue", () => {
      const ISSUE = { title: "Jokes endpoint", body: "## Acceptance\n- [ ] GET /jokes lists jokes" };

      async function continuation(
        source: LinkedIssueSource | (() => Promise<LinkedIssueSource>),
        read: (ref: LinkedIssueRef) => Promise<{ title: string; body: string } | null>,
        overrides: Partial<ContainerRunSnapshot> = {},
        extra: Partial<ContainerExecutorOptions> = {},
      ) {
        const reads: LinkedIssueRef[] = [];
        const created = await harness(
          { rootCodingRunId: "root-run", headRef: "wardby/run-root-run", ...overrides },
          IMAGE,
          undefined,
          undefined,
          {
            readLinkedIssue: async (ref) => {
              reads.push(ref);
              return read(ref);
            },
            ...extra,
          },
        );
        created.store.pullRequestDescriptionBaseline = async () => ({
          recordedSha256: null,
          previousAgentText: "Previous body. Resolves #31",
          agentTextRunId: "root-run",
        });
        created.store.linkedIssueSource = typeof source === "function" ? source : async () => source;
        let input: Record<string, unknown> | undefined;
        created.jobs.onLaunch = () => {
          input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
        };
        await created.executor.start("run-1");
        return { created, reads, task: input!.task as string };
      }

      it("reads the GitHub issue the root run's mention came from and fences it in the task", async () => {
        const { created, reads, task } = await continuation(
          { hostStatus: { provider: "github", repository: "openai/example", number: 12 } },
          async () => ISSUE,
        );
        expect(created.store.run.status).toBe("succeeded");
        expect(reads).toEqual([{ provider: "github", repository: "openai/example", number: 12 }]);
        expect(task).toContain("acceptance criteria as written are what the description's checklist should reflect");
        expect(task).toContain("`Resolves #12`");
        expect(task).toContain(
          "<untrusted_issue>\nIssue #12: Jokes endpoint\n\n## Acceptance\n- [ ] GET /jokes lists jokes\n</untrusted_issue>",
        );
        // Before the description note, so both fit and the ticket comes first.
        expect(task.indexOf("<untrusted_issue>")).toBeLessThan(task.indexOf("<untrusted_pr_description>"));
      });

      it("reads the root run's Jira issue first", async () => {
        const { reads, task } = await continuation(
          {
            issueProvider: "jira",
            issueKey: "ABC-12",
            hostStatus: { provider: "github", repository: "openai/example", number: 12 },
          },
          async () => ISSUE,
        );
        expect(reads).toEqual([{ provider: "jira", key: "ABC-12" }]);
        expect(task).toContain("<untrusted_issue>\nJira issue ABC-12: Jokes endpoint");
      });

      it("falls back to the closing keyword in the description wardby last wrote", async () => {
        // The mention was on a pull request, not an issue: the host says so and the next candidate is read.
        const { reads, task } = await continuation(
          { hostStatus: { provider: "github", repository: "openai/example", number: 40 } },
          async (ref) => (ref.provider === "github" && ref.number === 31 ? ISSUE : null),
        );
        expect(reads).toEqual([
          { provider: "github", repository: "openai/example", number: 40 },
          { provider: "github", repository: "openai/example", number: 31 },
        ]);
        expect(task).toContain("<untrusted_issue>\nIssue #31: Jokes endpoint");
      });

      it("ignores a mention status in another repository", async () => {
        const { reads } = await continuation(
          { hostStatus: { provider: "github", repository: "other/repo", number: 12 } },
          async () => null,
        );
        expect(reads).toEqual([{ provider: "github", repository: "openai/example", number: 31 }]);
      });

      it("never fails the run when the issue can't be read or the source can't be loaded", async () => {
        for (const [source, read] of [
          [
            { hostStatus: { provider: "github", repository: "openai/example", number: 12 } },
            async () => Promise.reject(new Error("github down")),
          ],
          [async () => Promise.reject(new Error("db down")), async () => ISSUE],
        ] as const) {
          const { created, task } = await continuation(source, read);
          expect(created.store.run.status).toBe("succeeded");
          expect(task).not.toContain("<untrusted_issue>");
          expect(task).toContain("<untrusted_pr_description>");
        }
      });

      it("a fresh run and a local continuation read no issue", async () => {
        const fresh = await continuation({ issueProvider: "jira", issueKey: "ABC-12" }, async () => ISSUE, {
          rootCodingRunId: null,
          headRef: "wardby/run-run-1",
        });
        expect(fresh.reads).toEqual([]);
        expect(fresh.task).not.toContain("<untrusted_issue>");
        const local = await continuation(
          { issueProvider: "jira", issueKey: "ABC-12" },
          async () => ISSUE,
          { repository: LOCAL_REPOSITORY, profileRepository: LOCAL_REPOSITORY },
          { repoAccess: { authorizeUse: async () => ({ ok: true }) } as never },
        );
        expect(local.reads).toEqual([]);
      });
    });

    it("leaves a fresh run's task without the description note", async () => {
      const { input } = await launched({});
      expect(input.task).toBe(
        `Fix the bug and test it.\n\nBase commit: ${"a".repeat(40)} (the commit this workspace was checked out at; the workspace has no git metadata).`,
      );
    });

    it("skips the note when the baseline cannot be loaded", async () => {
      const created = await harness({ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
      let input: Record<string, unknown> | undefined;
      created.store.pullRequestDescriptionBaseline = async () => {
        throw new Error("db down");
      };
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      expect(input!.task as string).not.toContain("your final summary replaces it");
    });

    it("hands the launcher the run's services and the worker only their names, versions and variables", async () => {
      const { created, input } = await launched({ services: [POSTGRES] });
      expect(created.jobs.specs[0]?.services).toEqual([POSTGRES]);
      expect(input.services).toEqual([{ name: "postgres", version: "16", testEnv: POSTGRES.testEnv }]);
    });

    it("leaves a run without services exactly as it was: no key in the spec or the input", async () => {
      const { created, input } = await launched({ services: [] });
      expect(created.jobs.specs[0]).not.toHaveProperty("services");
      expect(input).not.toHaveProperty("services");
    });

    it("fails a run with services on a launcher that can't start them", async () => {
      const created = await harness({ services: [POSTGRES] });
      created.jobs.serviceProviders = [];
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(0);
      expect(created.store.terminations).toEqual([
        expect.objectContaining({ status: "failed", audit: expect.objectContaining({ failureCategory: "preflight" }) }),
      ]);
    });

    it("fails a run whose service never became ready as service_unready, naming it on the host", async () => {
      const created = await harness({ services: [POSTGRES] });
      created.jobs.launchError = new Error("coding_service_unready:postgres");
      await created.executor.start("run-1");
      expect(created.store.terminations).toEqual([
        {
          status: "failed",
          error: expect.stringMatching(/^coding_failure_service_unready:coding_diag_/),
          audit: { failureCategory: "service_unready", diagnosticId: expect.stringMatching(/^coding_diag_/) },
        },
      ]);
      expect(created.vcs.notifyFinishedCalls).toEqual([
        {
          outcome: "failed",
          agentName: "knock-knock-implement",
          serviceSentence: "The `postgres` service didn't become ready, so the run couldn't start.",
        },
      ]);
    });

    it("words a terminal service_unready run the same way when it is cleaned up later", async () => {
      const created = await harness({ status: "failed", failureCategory: "service_unready", services: [POSTGRES] });
      await created.vcs.prepareWorkspace({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: ["CODEOWNERS"],
      });
      await created.executor.stop("run-1", "requested");
      expect(created.vcs.notifyFinishedCalls).toEqual([
        expect.objectContaining({
          outcome: "failed",
          serviceSentence: "The `postgres` service didn't become ready, so the run couldn't start.",
        }),
      ]);
    });

    it("reads the repository's declaration from the base ref through the VCS provider", async () => {
      const created = await harness();
      const asked: unknown[] = [];
      (created.vcs as FakeVcs & Pick<VcsProvider, "readRepositoryFile">).readRepositoryFile = async (input) => {
        asked.push(input);
        return 'services:\n  postgres: "16"\n';
      };
      await expect(
        created.executor.readCodingServiceDeclaration({ repository: "openai/example", baseRef: "release" }),
      ).resolves.toBe('services:\n  postgres: "16"\n');
      expect(asked).toEqual([
        { repository: "openai/example", ref: "release", path: ".wardby/services.yaml", maxBytes: 8192 },
      ]);
      expect(created.executor.supportsCodingServices("codex")).toBe(true);
    });

    it("reads no declaration when its VCS provider can't read files", async () => {
      const created = await harness();
      await expect(
        created.executor.readCodingServiceDeclaration({ repository: "openai/example", baseRef: "main" }),
      ).resolves.toBeNull();
    });

    it("asks its job launcher which providers it starts services for", async () => {
      const created = await harness();
      // Kubernetes: both providers.
      expect(created.executor.supportsCodingServices("codex")).toBe(true);
      expect(created.executor.supportsCodingServices("claude-code")).toBe(true);
      // A launcher that starts services for Codex only.
      created.jobs.serviceProviders = ["codex"];
      expect(created.executor.supportsCodingServices("codex")).toBe(true);
      expect(created.executor.supportsCodingServices("claude-code")).toBe(false);
      created.jobs.serviceProviders = [];
      expect(created.executor.supportsCodingServices("codex")).toBe(false);
    });

    it("says no services for a launcher that doesn't declare which providers it serves", async () => {
      const created = await harness();
      (created.jobs as { supportsServicesFor?: unknown }).supportsServicesFor = undefined;
      expect(created.executor.supportsCodingServices("codex")).toBe(false);
      expect(created.executor.supportsCodingServices("claude-code")).toBe(false);
    });

    it("delegates warmUp to its job launcher", async () => {
      const created = await harness();
      await created.executor.warmUp();
      expect(created.jobs.warmUps).toBe(1);
    });

    it("does nothing for warmUp when the job launcher has none", async () => {
      const created = await harness();
      (created.jobs as { warmUp?: unknown }).warmUp = undefined;
      await expect(created.executor.warmUp()).resolves.toBeUndefined();
    });

    const claudeRun = { provider: "claude-code", model: "claude-sonnet-5", workerImage: CLAUDE_IMAGE } as const;
    const claudeImages = { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE };

    it("launches a Claude Code run with services on a launcher that starts them for Claude Code", async () => {
      const created = await harness(
        { ...claudeRun, services: [POSTGRES] },
        IMAGE,
        new InMemoryCodingRunObserver(),
        claudeImages,
      );
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(1);
      expect(created.jobs.specs[0]).toMatchObject({ provider: "claude-code", services: [POSTGRES] });
    });

    it("fails a Claude Code run with services on a launcher that starts them only for Codex", async () => {
      const created = await harness(
        { ...claudeRun, services: [POSTGRES] },
        IMAGE,
        new InMemoryCodingRunObserver(),
        claudeImages,
      );
      created.jobs.serviceProviders = ["codex"];
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(0);
      expect(created.store.terminations).toEqual([
        expect.objectContaining({ status: "failed", audit: expect.objectContaining({ failureCategory: "preflight" }) }),
      ]);
    });

    it("ships CLAUDE.md and skills to a Claude Code run, and only the instructions when skills are off", async () => {
      const launched = async (repoSkills: boolean) => {
        const created = await harness(
          { ...claudeRun, repoSkills },
          IMAGE,
          new InMemoryCodingRunObserver(),
          claudeImages,
        );
        const workspace = join(created.root, "vcs", "run-1", "workspace");
        await mkdir(join(workspace, ".claude", "skills", "lint"), { recursive: true });
        await writeFile(join(workspace, "CLAUDE.md"), "Use pnpm.");
        await writeFile(join(workspace, ".claude", "skills", "lint", "SKILL.md"), "---\nname: lint\n---\n");
        let input: Record<string, unknown> | undefined;
        created.jobs.onLaunch = () => {
          input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
        };
        await created.executor.start("run-1");
        return input!;
      };
      expect((await launched(true)).claudeContext).toEqual({
        files: [
          { path: "CLAUDE.md", content: "Use pnpm." },
          { path: ".claude/skills/lint/SKILL.md", content: "---\nname: lint\n---\n" },
        ],
      });
      expect((await launched(false)).claudeContext).toEqual({ files: [{ path: "CLAUDE.md", content: "Use pnpm." }] });
    });

    it("logs one further warn line, with the overflow count, for skips beyond the first 50", async () => {
      const created = await harness(claudeRun, IMAGE, new InMemoryCodingRunObserver(), claudeImages);
      const workspace = join(created.root, "vcs", "run-1", "workspace");
      await mkdir(workspace, { recursive: true });
      // 51 distinct home-relative imports: each is refused as "outside_repo" without ever being
      // read, so this is a cheap way to drive skippedOverflow past 0 (MAX_RECORDED_SKIPS = 50).
      const imports = Array.from({ length: 51 }, (_, i) => `@~${i}`).join("\n");
      await writeFile(join(workspace, "CLAUDE.md"), imports);
      await created.executor.start("run-1");
      const skipLogs = logged.filter((entry) => entry.payload.event === "coding.claude_context_skipped");
      expect(skipLogs).toHaveLength(51);
      expect(skipLogs.filter((entry) => "overflow" in entry.payload)).toEqual([
        {
          level: "warn",
          payload: { event: "coding.claude_context_skipped", runId: "run-1", overflow: 1 },
          message: "further repository context files were not loaded",
        },
      ]);
    });

    it("drops context files from the tail, as limit skips, until the serialized input fits", async () => {
      const created = await harness(claudeRun, IMAGE, new InMemoryCodingRunObserver(), claudeImages);
      const workspace = join(created.root, "vcs", "run-1", "workspace");
      await mkdir(join(workspace, "docs"), { recursive: true });
      // Each file fits the content limits (≤ 64 KiB, ≤ 256 KiB in total), but a control character
      // serializes to six JSON bytes ("\u0001"), so the four together are ~1.5 MB of input.json.
      const filler = "\u0001".repeat(60 * 1024);
      await writeFile(join(workspace, "CLAUDE.md"), `@docs/a.md @docs/b.md @docs/c.md\n${filler}`);
      for (const name of ["a", "b", "c"]) await writeFile(join(workspace, "docs", `${name}.md`), filler);
      let input: { claudeContext?: { files: { path: string }[] } } | undefined;
      let size = 0;
      created.jobs.onLaunch = () => {
        const text = readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8");
        size = Buffer.byteLength(text);
        input = JSON.parse(text) as typeof input;
      };
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(1);
      expect(size).toBeLessThanOrEqual(MAX_CODING_INPUT_BYTES);
      expect(input!.claudeContext!.files.map((file) => file.path)).toEqual(["CLAUDE.md"]);
      expect(
        logged.filter((entry) => entry.payload.event === "coding.claude_context_skipped").map((entry) => entry.payload),
      ).toEqual([
        { event: "coding.claude_context_skipped", runId: "run-1", path: "docs/c.md", reason: "limit" },
        { event: "coding.claude_context_skipped", runId: "run-1", path: "docs/b.md", reason: "limit" },
        { event: "coding.claude_context_skipped", runId: "run-1", path: "docs/a.md", reason: "limit" },
      ]);
    });

    it("truncates a logged skip path to 256 characters", async () => {
      const created = await harness(claudeRun, IMAGE, new InMemoryCodingRunObserver(), claudeImages);
      const workspace = join(created.root, "vcs", "run-1", "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "CLAUDE.md"), `@~${"x".repeat(4096)}`);
      await created.executor.start("run-1");
      const skips = logged.filter((entry) => entry.payload.event === "coding.claude_context_skipped");
      expect(skips).toHaveLength(1);
      expect(skips[0].payload).toMatchObject({ reason: "outside_repo" });
      expect(String(skips[0].payload.path)).toHaveLength(256);
      expect(String(skips[0].payload.path).startsWith("~xxx")).toBe(true);
    });

    it("still launches a Claude Code run whose repository context could not be read, without claudeContext", async () => {
      const created = await harness(claudeRun, IMAGE, new InMemoryCodingRunObserver(), claudeImages);
      const error = new Error("permission denied") as NodeJS.ErrnoException;
      error.code = "EACCES";
      claudeContextOverride.reject = error;
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(1);
      expect(input).not.toHaveProperty("claudeContext");
      expect(logged.filter((entry) => entry.payload.event === "coding.claude_context_unavailable")).toEqual([
        {
          level: "warn",
          payload: { event: "coding.claude_context_unavailable", runId: "run-1", code: "EACCES" },
          message: "repository context could not be read; continuing without it",
        },
      ]);
    });

    it("never ships claudeContext to a Codex run", async () => {
      const created = await harness({});
      const workspace = join(created.root, "vcs", "run-1", "workspace");
      await mkdir(workspace, { recursive: true });
      await writeFile(join(workspace, "CLAUDE.md"), "x");
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      expect(input).not.toHaveProperty("claudeContext");
    });
  });

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

  it("hands the worker maxTurns only when the run has one, leaving other inputs unchanged", async () => {
    const launchedInput = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return input!;
    };
    expect(await launchedInput({ maxTurns: 120 })).toMatchObject({ runId: "run-1", maxTurns: 120 });
    expect(await launchedInput({ maxTurns: null })).not.toHaveProperty("maxTurns");
  });

  it("hands the worker maxOutputTokens only when the run has one, leaving other inputs unchanged", async () => {
    const launchedInput = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return input!;
    };
    expect(await launchedInput({ maxOutputTokens: 64_000 })).toMatchObject({ runId: "run-1", maxOutputTokens: 64_000 });
    expect(await launchedInput({ maxOutputTokens: null })).not.toHaveProperty("maxOutputTokens");
    expect(await launchedInput({})).not.toHaveProperty("maxOutputTokens");
  });

  it("hands the worker repoSkills only when the run turned skills off", async () => {
    const launchedInput = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return input!;
    };
    expect(await launchedInput({ repoSkills: false })).toMatchObject({ runId: "run-1", repoSkills: false });
    expect(await launchedInput({ repoSkills: true })).not.toHaveProperty("repoSkills");
    expect(await launchedInput({})).not.toHaveProperty("repoSkills");
  });

  it("hands the worker claudeBareMode only when the run turned bare mode off", async () => {
    const launchedInput = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return input!;
    };
    expect(await launchedInput({ claudeBareMode: false })).toMatchObject({
      runId: "run-1",
      claudeBareMode: false,
    });
    expect(await launchedInput({ claudeBareMode: true })).not.toHaveProperty("claudeBareMode");
    expect(await launchedInput({})).not.toHaveProperty("claudeBareMode");
  });

  it("hands the worker debugTrace only for a traced run, leaving other inputs unchanged", async () => {
    const launchedInput = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return input!;
    };
    const tracedInput = await launchedInput({ debugTrace: true });
    expect(tracedInput).toMatchObject({ runId: "run-1", debugTrace: true });
    const plainInput = await launchedInput({ debugTrace: false });
    expect(plainInput).not.toHaveProperty("debugTrace");
    const { debugTrace: _flag, deadlineAt: _a, ...tracedRest } = tracedInput;
    const { deadlineAt: _b, ...plainRest } = plainInput;
    expect(tracedRest).toEqual(plainRest);
  });

  it("hands the worker dependencyCache (and the launcher spec) only when the run has it on", async () => {
    const launched = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return { input: input!, spec: created.jobs.lastSpec! };
    };
    const on = await launched({ dependencyCache: true });
    // The volume size rides along, so the cache can stay inside it: the deployment default here...
    expect(on.input).toMatchObject({ dependencyCache: true, diskMb: on.spec.limits.diskMb });
    expect(on.spec.dependencyCache).toBe(true);
    // ...and the agent's own workspace size when it sets one.
    const sized = await launched({ dependencyCache: true, workspaceDiskMb: 512 });
    expect(sized.input).toMatchObject({ dependencyCache: true, diskMb: 512 });
    expect(sized.spec.limits.diskMb).toBe(512);
    for (const overrides of [{ dependencyCache: false }, {}, { workspaceDiskMb: 512 }]) {
      const off = await launched(overrides);
      expect(off.input).not.toHaveProperty("dependencyCache");
      expect(off.input).not.toHaveProperty("diskMb");
      expect(off.spec).not.toHaveProperty("dependencyCache");
    }
  });

  it("hands the worker sessionResume only when the run has it on", async () => {
    const launched = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(
        overrides.provider === "claude-code"
          ? { model: "claude-sonnet-5", workerImage: CLAUDE_IMAGE, ...overrides }
          : overrides,
        IMAGE,
        new InMemoryCodingRunObserver(),
        { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
      );
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return input!;
    };
    expect(await launched({ sessionResume: true, provider: "claude-code" })).toMatchObject({ sessionResume: true });
    expect(await launched({ sessionResume: true, provider: "codex" })).not.toHaveProperty("sessionResume");
    for (const overrides of [{ sessionResume: false }, {}]) {
      expect(await launched(overrides)).not.toHaveProperty("sessionResume");
    }
  });

  it("hands the worker debugTraceMaxMb only on a traced run that sets one", async () => {
    const launchedInput = async (overrides: Partial<ContainerRunSnapshot>) => {
      const created = await harness(overrides);
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      return input!;
    };
    expect(await launchedInput({ debugTrace: true, debugTraceMaxMb: 20 })).toMatchObject({
      debugTrace: true,
      debugTraceMaxMb: 20,
    });
    expect(await launchedInput({ debugTrace: true, debugTraceMaxMb: null })).not.toHaveProperty("debugTraceMaxMb");
    expect(await launchedInput({ debugTrace: false, debugTraceMaxMb: 20 })).not.toHaveProperty("debugTraceMaxMb");
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

  describe("model terms handed to the proxy session", () => {
    const luna = entryOf(shippedCatalog().require("gpt-5.6-luna"));

    it("passes the run's recorded catalog entry and version", async () => {
      const created = await harness({
        pricingVersion: "2026-10-04T00:00:00.000Z",
        pricingSnapshot: { ...luna, outputPerMTok: 99 },
      });
      await created.executor.start("run-1");
      expect(created.sessions.lastInput?.terms).toEqual({
        version: "2026-10-04T00:00:00.000Z",
        entry: { ...luna, outputPerMTok: 99 },
      });
    });

    const refusedForPricing = (created: Awaited<ReturnType<typeof harness>>) => {
      expect(created.store.run.status).toBe("refused");
      expect(created.vcs.prepared).toBe(0);
      expect(created.sessions.creates).toBe(0);
      expect(created.jobs.launches).toBe(0);
      expect(logged.some((entry) => String(entry.payload.reason).includes("coding_run_pricing_mismatch"))).toBe(true);
    };

    it("refuses the run before any workspace or session when the recorded entry is for another model", async () => {
      const created = await harness({ pricingVersion: "v", pricingSnapshot: { ...luna, modelId: "gpt-other" } });
      await created.executor.start("run-1");
      refusedForPricing(created);
    });

    it("refuses the run when the recorded entry belongs to the other coding provider's models", async () => {
      const sonnet = entryOf(shippedCatalog().require("claude-sonnet-5"));
      const created = await harness({ model: "claude-sonnet-5", pricingVersion: "v", pricingSnapshot: sonnet });
      await created.executor.start("run-1");
      refusedForPricing(created);
    });

    it("passes the current catalog's entry for a run from before the catalog", async () => {
      const created = await harness({ pricingVersion: null, pricingSnapshot: null });
      await created.executor.start("run-1");
      expect(created.sessions.lastInput?.terms).toEqual({ version: `shipped:${SHIPPED_CATALOG_VERSION}`, entry: luna });
    });
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

  it("records a pushed local branch as a succeeded run with resultBranch and baseSha", async () => {
    // The profile schema still names GitHub repositories only; the fake VCS stands in for a local one.
    const created = await harness();
    created.vcs.pushBranchOnly = true;
    await created.executor.start("run-1");

    expect(created.store.run.status).toBe("succeeded");
    expect(created.store.run.result).toMatchObject({
      outcome: "branch_pushed",
      headRef: "wardby/run-run-1",
      commitSha: "b".repeat(40),
    });
    expect(created.store.run.result).not.toHaveProperty("pullRequestUrl");
    expect(created.store.completions[0]?.record).toEqual({
      resultBranch: "wardby/run-run-1",
      baseSha: "a".repeat(40),
    });
    expect(created.observer.events.map((event) => event.stage)).toContain("branch_pushed");
  });

  it("records baseSha but no resultBranch for a pull request outcome", async () => {
    const created = await harness();
    await created.executor.start("run-1");
    expect(created.store.completions[0]?.record).toEqual({ baseSha: "a".repeat(40) });
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

  describe("pull request description", () => {
    const RECORDED = "a".repeat(64);
    const NEW_SHA = "c".repeat(64);
    const baseline: DescriptionBaseline = {
      recordedSha256: RECORDED,
      previousAgentText: "The original description text.",
      agentTextRunId: "root-run",
    };

    /** A fix round on root-run's PR, with the description store methods and call order recorded in events. */
    async function fixRound(
      overrides: Partial<ContainerRunSnapshot> = {},
      extra: Partial<ContainerExecutorOptions> = {},
    ) {
      const created = await harness(
        { rootCodingRunId: "root-run", headRef: "wardby/run-root-run", ...overrides },
        IMAGE,
        undefined,
        undefined,
        extra,
      );
      const recorded: unknown[] = [];
      created.store.pullRequestDescriptionBaseline = async (rootRunId) => {
        created.events.push(`baseline:${rootRunId}`);
        return structuredClone(baseline);
      };
      created.store.recordPullRequestDescription = async (input) => {
        created.events.push("record");
        recorded.push(input);
        return true;
      };
      const complete = created.store.complete.bind(created.store);
      created.store.complete = async (...args) => {
        created.events.push("complete");
        return complete(...args);
      };
      return { ...created, recorded };
    }

    function noChanges(created: Awaited<ReturnType<typeof harness>>) {
      created.jobs.result.resultArtifact = JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        outcome: "no_changes",
        summary: "Already correct.",
        tests: [],
      });
    }

    const descriptionWarnings = () =>
      logged.filter((line) => line.level === "warn" && /description/.test(line.message));

    it("fresh PR run records written hash on its own row", async () => {
      const created = await harness();
      const baselines: string[] = [];
      created.store.pullRequestDescriptionBaseline = async (rootRunId) => {
        baselines.push(rootRunId);
        return structuredClone(baseline);
      };
      created.vcs.finalizeDescription = { kind: "written", sha256: NEW_SHA };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(baselines).toEqual([]);
      expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("description");
      expect(created.store.completions[0]?.record).toEqual({
        baseSha: "a".repeat(40),
        prDescriptionOutcome: "written",
        prDescriptionSha256: NEW_SHA,
        prDescriptionRunId: "run-1",
      });
    });

    it("review_fix continuation passes the baseline and records replaced + new hash on the root", async () => {
      const created = await fixRound();
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(created.vcs.lastFinalizeDetails?.description).toEqual({ baseline });
      expect(created.recorded).toEqual([
        { rootRunId: "root-run", expectedSha256: RECORDED, sha256: NEW_SHA, agentTextRunId: "run-1" },
      ]);
      const record = created.store.completions[0]?.record;
      expect(record).toMatchObject({ prDescriptionOutcome: "replaced" });
      // The hash and author run belong to the root row, written by the compare-and-set alone.
      expect(record).not.toHaveProperty("prDescriptionSha256");
      expect(record).not.toHaveProperty("prDescriptionRunId");
      expect(created.events.filter((e) => ["baseline:root-run", "finalize", "record", "complete"].includes(e))).toEqual(
        ["baseline:root-run", "baseline:root-run", "finalize", "record", "complete"],
      );
    });

    it("records refreshed:<reason> and unchanged outcomes with the compare-and-set", async () => {
      for (const [outcome, label] of [
        [
          { kind: "refreshed", reason: "too_short", sha256: NEW_SHA, agentTextRunId: "root-run" },
          "refreshed:too_short",
        ],
        [{ kind: "unchanged", sha256: RECORDED, agentTextRunId: "root-run" }, "unchanged"],
      ] as const) {
        const created = await fixRound();
        created.vcs.finalizeDescription = outcome;
        await created.executor.start("run-1");
        expect(created.recorded).toEqual([
          { rootRunId: "root-run", expectedSha256: RECORDED, sha256: outcome.sha256, agentTextRunId: "root-run" },
        ]);
        expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: label });
      }
    });

    it("no_changes continuation refreshes the description before store.complete (call order asserted)", async () => {
      const created = await fixRound();
      noChanges(created);
      let refreshed: FinalizeChangesDetails | undefined;
      created.vcs.refreshPullRequestDescription = async (workspace, details) => {
        created.events.push("refresh");
        expect(workspace.runId).toBe("run-1");
        refreshed = details;
        return { kind: "refreshed", reason: "too_short", sha256: NEW_SHA, agentTextRunId: "root-run" };
      };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.run.result).toMatchObject({ outcome: "no_changes" });
      expect(created.vcs.finalized).toBe(0);
      expect(refreshed).toMatchObject({ summary: "Already correct.", tests: [], description: { baseline } });
      expect(created.recorded).toEqual([
        { rootRunId: "root-run", expectedSha256: RECORDED, sha256: NEW_SHA, agentTextRunId: "root-run" },
      ]);
      expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "refreshed:too_short" });
      // The terminal hook (reReviewAfterNoChangeFix) must see the new body, so all of it lands before complete.
      expect(
        created.events.filter((e) => ["baseline:root-run", "refresh", "record", "complete", "cleanup"].includes(e)),
      ).toEqual(["baseline:root-run", "baseline:root-run", "refresh", "record", "complete", "cleanup"]);
    });

    it("a refreshed description keeps the root's GitHub issue line", async () => {
      const created = await fixRound();
      noChanges(created);
      const asked: string[] = [];
      created.store.linkedIssueSource = async (rootRunId) => {
        asked.push(rootRunId);
        return { hostStatus: { provider: "github", repository: "openai/example", number: 12, issueMention: true } };
      };
      let refreshed: FinalizeChangesDetails | undefined;
      created.vcs.refreshPullRequestDescription = async (_workspace, details) => {
        refreshed = details;
        return { kind: "refreshed", reason: "too_short", sha256: NEW_SHA, agentTextRunId: "root-run" };
      };
      await created.executor.start("run-1");
      expect(refreshed?.issueNumber).toBe(12);
      expect(asked).toContain("root-run");
    });

    // A deploy drains the process that launched the run; the new one finishes it through
    // recovery, and the old process's local workspace is gone.
    it("a no_changes run finished by another process still refreshes the description and the final status", async () => {
      const handle = { backend: "fake", id: "job-1" };
      const created = await fixRound({ jobHandle: handle, proxySessionId: "session-1" });
      noChanges(created);
      created.jobs.statusValue = { state: "succeeded" };
      let refreshedOn: ContinuationTarget | undefined;
      created.vcs.refreshPullRequestDescription = async (target) => {
        refreshedOn = target;
        return { kind: "refreshed", reason: "too_short", sha256: NEW_SHA, agentTextRunId: "root-run" };
      };
      await expect(created.executor.recover({ runId: "run-1", ...handle })).resolves.toEqual({ state: "terminal" });

      const target = {
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-root-run",
        continuation: { rootRunId: "root-run" },
      };
      expect(refreshedOn).toEqual(target);
      expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "refreshed:too_short" });
      expect(created.vcs.cleaned).toBe(0);
      expect(created.vcs.notifyFinishedTargets).toEqual([target]);
      expect(created.vcs.notifyFinishedCalls).toEqual([
        expect.objectContaining({ outcome: "succeeded", summary: "Already correct." }),
      ]);
    });

    it("changes_ready continuation with an empty diff refreshes the description before store.complete", async () => {
      const created = await fixRound();
      created.vcs.finalizeEmpty = true;
      let refreshed: FinalizeChangesDetails | undefined;
      created.vcs.refreshPullRequestDescription = async (workspace, details) => {
        created.events.push("refresh");
        expect(workspace.runId).toBe("run-1");
        refreshed = details;
        return { kind: "refreshed", reason: "empty", sha256: NEW_SHA, agentTextRunId: "root-run" };
      };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.run.result).toMatchObject({ outcome: "no_changes" });
      expect(created.vcs.finalized).toBe(1);
      expect(refreshed).toMatchObject({ description: { baseline } });
      expect(created.recorded).toEqual([
        { rootRunId: "root-run", expectedSha256: RECORDED, sha256: NEW_SHA, agentTextRunId: "root-run" },
      ]);
      expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "refreshed:empty" });
      expect(
        created.events.filter((e) => ["finalize", "refresh", "record", "complete", "cleanup"].includes(e)),
      ).toEqual(["finalize", "refresh", "record", "complete", "cleanup"]);
    });

    it("a local continuation gets no description note and records no outcome", async () => {
      for (const empty of [false, true]) {
        // A stand-in gate: the real one resolves local paths against LOCAL_REPO_ROOTS on disk.
        const created = await fixRound(
          { repository: LOCAL_REPOSITORY, profileRepository: LOCAL_REPOSITORY },
          { repoAccess: { authorizeUse: async () => ({ ok: true }) } as never },
        );
        created.vcs.pushBranchOnly = true;
        created.vcs.finalizeEmpty = empty;
        let refreshes = 0;
        created.vcs.refreshPullRequestDescription = async () => {
          refreshes += 1;
          return { kind: "refreshed", reason: "empty", sha256: NEW_SHA, agentTextRunId: "root-run" };
        };
        let input: Record<string, unknown> | undefined;
        created.jobs.onLaunch = () => {
          input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
        };
        await created.executor.start("run-1");

        expect(created.store.run.status).toBe("succeeded");
        expect(input!.task as string).not.toContain("your final summary replaces it");
        expect(created.events.filter((e) => e.startsWith("baseline:"))).toEqual([]);
        expect(refreshes).toBe(0);
        expect(created.recorded).toEqual([]);
        expect(created.store.completions[0]?.record).not.toHaveProperty("prDescriptionOutcome");
      }
    });

    it("lists every package installed across the pull request's runs, refusals from this run only", async () => {
      const reports: Record<string, { packages: unknown[]; packageRefusals: unknown[] }> = {
        "root-run": {
          packages: [
            { ecosystem: "npm", name: "zod", version: "4.0.0" },
            { ecosystem: "npm", name: "vitest", version: "3.2.0", acceptedAdvisories: ["GHSA-aaaa-bbbb-cccc"] },
          ],
          packageRefusals: [{ ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" }],
        },
        "round-1": {
          packages: [
            { ecosystem: "npm", name: "zod", version: "4.0.0" },
            { ecosystem: "pypi", name: "zod", version: "4.0.0" },
          ],
          packageRefusals: [{ ecosystem: "npm", name: "is-odd", reason: "wardby_version_filtered" }],
        },
        "run-1": {
          packages: [
            { ecosystem: "npm", name: "vitest", version: "3.2.0", acceptedAdvisories: ["GHSA-dddd-eeee-ffff"] },
            { ecosystem: "npm", name: "zod", version: "4.1.0" },
          ],
          packageRefusals: [{ ecosystem: "npm", name: "is-even", reason: "wardby_package_not_allowed" }],
        },
      };
      const created = await fixRound({}, { registryReport: async (runId) => reports[runId] as never });
      created.store.pullRequestRunIds = async () => ["root-run", "round-1", "run-1"];
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");

      expect(created.vcs.lastFinalizeDetails?.packages).toEqual([
        { ecosystem: "npm", name: "zod", version: "4.0.0" },
        {
          ecosystem: "npm",
          name: "vitest",
          version: "3.2.0",
          acceptedAdvisories: ["GHSA-aaaa-bbbb-cccc", "GHSA-dddd-eeee-ffff"],
        },
        { ecosystem: "pypi", name: "zod", version: "4.0.0" },
        { ecosystem: "npm", name: "zod", version: "4.1.0" },
      ]);
      expect(created.vcs.lastFinalizeDetails?.packageRefusals).toEqual([
        { ecosystem: "npm", name: "is-even", reason: "wardby_package_not_allowed" },
      ]);
    });

    it("leaves a listing-only refusal out of the pull request description", async () => {
      const report = {
        packages: [],
        packageRefusals: [
          { ecosystem: "pypi", name: "looked-at", reason: "wardby_file_not_allowed", listingOnly: true },
          { ecosystem: "pypi", name: "needed", reason: "wardby_file_not_allowed" },
        ],
      };
      const created = await fixRound({}, { registryReport: async () => report });
      created.store.pullRequestRunIds = async () => ["run-1"];
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.packageRefusals).toEqual([
        { ecosystem: "pypi", name: "needed", reason: "wardby_file_not_allowed" },
      ]);
    });

    it("merges package audit mode across the pull request's runs, strongest mode first", async () => {
      const entry = (name: string, relation: string) => ({
        ecosystem: "npm",
        name,
        version: "1.0.0",
        size: 1,
        relation,
      });
      const reports: Record<string, unknown> = {
        "root-run": {
          packages: [],
          packageRefusals: [],
          packageAuditMode: "full",
          packageAudit: [entry("expo-dev-client", "top-level")],
        },
        "round-1": { packages: [], packageRefusals: [] },
        "run-1": {
          packages: [],
          packageRefusals: [],
          packageAuditMode: "audit",
          packageAudit: [entry("expo-dev-client", "top-level"), entry("left-pad", "unknown")],
        },
      };
      const created = await fixRound({}, { registryReport: async (runId) => reports[runId] as never });
      created.store.pullRequestRunIds = async () => ["root-run", "round-1", "run-1"];
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");

      expect(created.vcs.lastFinalizeDetails?.packageAudit).toEqual({
        mode: "full",
        entries: [entry("expo-dev-client", "top-level"), entry("left-pad", "unknown")],
      });
    });

    it("a no-change round's refresh lists the pull request's packages too", async () => {
      const created = await fixRound(
        {},
        {
          registryReport: async (runId) => ({
            packages: [{ ecosystem: "npm", name: `pkg-${runId}`, version: "1.0.0" }],
            packageRefusals: [],
          }),
        },
      );
      created.store.pullRequestRunIds = async () => ["root-run"];
      noChanges(created);
      let refreshed: FinalizeChangesDetails | undefined;
      created.vcs.refreshPullRequestDescription = async (_workspace, details) => {
        refreshed = details;
        return { kind: "unchanged", sha256: RECORDED, agentTextRunId: "root-run" };
      };
      await created.executor.start("run-1");
      expect(refreshed?.packages).toEqual([
        { ecosystem: "npm", name: "pkg-root-run", version: "1.0.0" },
        { ecosystem: "npm", name: "pkg-run-1", version: "1.0.0" },
      ]);
      expect(refreshed).not.toHaveProperty("packageRefusals");
    });

    it("a failed run listing falls back to this run's packages", async () => {
      const created = await fixRound(
        {},
        {
          registryReport: async (runId) => ({
            packages: [{ ecosystem: "npm", name: `pkg-${runId}`, version: "1.0.0" }],
            packageRefusals: [],
          }),
        },
      );
      created.store.pullRequestRunIds = async () => {
        throw new Error("db down");
      };
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");
      expect(created.store.run.status).toBe("succeeded");
      expect(created.vcs.lastFinalizeDetails?.packages).toEqual([
        { ecosystem: "npm", name: "pkg-run-1", version: "1.0.0" },
      ]);
    });

    it("a legacy pull request's baseline carries the hash of the rebuilt root description", async () => {
      const rootReport = {
        packages: [{ ecosystem: "npm", name: "zod", version: "4.0.0" }],
        packageRefusals: [],
      };
      const created = await fixRound(
        {},
        {
          registryReport: async (runId) => (runId === "root-run" ? rootReport : { packages: [], packageRefusals: [] }),
          issueUrl: (_provider, key) => `https://acme.atlassian.net/browse/${key}`,
        },
      );
      const legacySource = {
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-root-run",
        summary: "The original description text.",
        tests: [{ command: "npm test", outcome: "passed" as const }],
        dependencyCache: { projects: [{ path: ".", result: "hit" }] },
        issueProvider: "jira",
        issueKey: "ABC-12",
      };
      created.store.pullRequestDescriptionBaseline = async () => ({
        recordedSha256: null,
        previousAgentText: "The original description text.",
        agentTextRunId: "root-run",
        legacySource: legacySource,
      });
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");

      const expected = pullRequestBody({
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-root-run",
        runId: "root-run",
        summary: "The original description text.",
        tests: [{ command: "npm test", outcome: "passed" }],
        packages: rootReport.packages,
        restoredDependencies: ["."],
        issue: { key: "ABC-12", url: "https://acme.atlassian.net/browse/ABC-12", trackerName: "Jira" },
      });
      expect(expected).toContain("Resolves Jira issue");
      expect(expected).toContain("Dependency cache: restored");
      expect(created.vcs.lastFinalizeDetails?.description).toEqual({
        baseline: {
          recordedSha256: null,
          legacySha256: descriptionSha256(expected),
          previousAgentText: "The original description text.",
          agentTextRunId: "root-run",
        },
      });
      // The compare-and-set expects no hash yet (the legacy row has none).
      expect(created.recorded).toEqual([
        { rootRunId: "root-run", expectedSha256: null, sha256: NEW_SHA, agentTextRunId: "run-1" },
      ]);
    });

    it("a legacy rebuild matches a description written out by hand, as a fresh run's pull request carried it", async () => {
      const created = await fixRound(
        {},
        {
          registryReport: async (runId) =>
            runId === "root-run"
              ? { packages: [{ ecosystem: "npm", name: "zod", version: "4.0.0" }], packageRefusals: [] }
              : { packages: [], packageRefusals: [] },
          issueUrl: (_provider, key) => `https://acme.atlassian.net/browse/${key}`,
        },
      );
      created.store.pullRequestDescriptionBaseline = async () => ({
        recordedSha256: null,
        previousAgentText: "The original description text.",
        agentTextRunId: "root-run",
        legacySource: {
          repository: "openai/example",
          baseRef: "main",
          headRef: "wardby/run-root-run",
          summary: "The original description text.",
          tests: [{ command: "npm test", outcome: "passed" }],
          dependencyCache: { projects: [{ path: ".", result: "hit" }] },
          issueProvider: "jira",
          issueKey: "ABC-12",
        },
      });
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");

      // Written independently of pullRequestBody: what such a pull request's description looked like.
      const byHand = [
        "<!-- wardby:root-run -->",
        "",
        "Resolves Jira issue [ABC-12](https://acme.atlassian.net/browse/ABC-12)",
        "",
        "The original description text.",
        "",
        "**Tests:**",
        "- `npm test`: passed",
        "",
        "Dependency cache: restored `node_modules` for the repo root.",
        "",
        "<details>",
        "<summary>Packages installed during this run (1)</summary>",
        "",
        "- npm `zod@4.0.0`",
        "</details>",
      ].join("\n");
      expect(created.vcs.lastFinalizeDetails?.description?.baseline.legacySha256).toBe(descriptionSha256(byHand));
    });

    it("a legacy pull request whose root run stored no summary gets no rebuilt hash", async () => {
      const created = await fixRound();
      created.store.pullRequestDescriptionBaseline = async () => ({
        recordedSha256: null,
        agentTextRunId: "root-run",
        legacySource: { repository: "openai/example", baseRef: "main", headRef: "wardby/run-root-run" },
      });
      created.vcs.finalizeDescription = { kind: "edited_by_hand", commentPosted: true };
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.description).toEqual({
        baseline: { recordedSha256: null, agentTextRunId: "root-run" },
      });
    });

    it("a fresh no_changes run never refreshes a description", async () => {
      const created = await harness();
      noChanges(created);
      let refreshes = 0;
      created.vcs.refreshPullRequestDescription = async () => {
        refreshes += 1;
        return undefined;
      };
      await created.executor.start("run-1");
      expect(refreshes).toBe(0);
      expect(created.store.completions[0]?.record).toEqual({});
    });

    it("caps the no_changes refresh at 60 seconds, recording skipped:error", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const created = await fixRound();
        noChanges(created);
        let called!: () => void;
        const refreshStarted = new Promise<void>((resolve) => (called = resolve));
        created.vcs.refreshPullRequestDescription = () => {
          called();
          return new Promise(() => undefined);
        };
        const started = created.executor.start("run-1");
        await refreshStarted;
        await vi.advanceTimersByTimeAsync(DESCRIPTION_REFRESH_TIMEOUT_MS - 1);
        expect(created.store.completions).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await started;

        expect(DESCRIPTION_REFRESH_TIMEOUT_MS).toBe(60_000);
        expect(created.store.run.status).toBe("succeeded");
        expect(created.store.run.result).toMatchObject({ outcome: "no_changes" });
        expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "skipped:error" });
        expect(created.recorded).toEqual([]);
        expect(
          logged.filter((line) => line.level === "warn" && line.message.includes("timed out")).map((l) => l.payload),
        ).toEqual([{ runId: "run-1", timeoutMs: 60_000 }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("edited_by_hand leaves the root hash untouched and records the outcome on the run", async () => {
      const created = await fixRound();
      created.vcs.finalizeDescription = { kind: "edited_by_hand", commentPosted: true };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(created.recorded).toEqual([]);
      expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "edited_by_hand" });
    });

    it("records skipped:<reason> from the remote without a compare-and-set", async () => {
      const created = await fixRound();
      created.vcs.finalizeDescription = { kind: "skipped", reason: "too_long" };
      await created.executor.start("run-1");
      expect(created.recorded).toEqual([]);
      expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "skipped:too_long" });
    });

    it("CAS miss logs and keeps the run succeeded", async () => {
      const created = await fixRound();
      created.store.recordPullRequestDescription = async () => false;
      created.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.run.result).toMatchObject({ outcome: "pull_request_updated" });
      expect(created.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "replaced" });
      expect(descriptionWarnings()).toHaveLength(1);
    });

    it("description failure never changes the run's outcome", async () => {
      // The baseline cannot be loaded: the PR is pushed without a description update.
      const noBaseline = await fixRound();
      noBaseline.store.pullRequestDescriptionBaseline = async () => {
        throw new Error("db down");
      };
      await noBaseline.executor.start("run-1");
      expect(noBaseline.store.run.status).toBe("succeeded");
      expect(noBaseline.store.run.result).toMatchObject({ outcome: "pull_request_updated" });
      expect(noBaseline.vcs.lastFinalizeDetails).not.toHaveProperty("description");
      expect(noBaseline.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "skipped:error" });

      // The compare-and-set throws after the description was written.
      const noRecord = await fixRound();
      noRecord.vcs.finalizeDescription = { kind: "replaced", sha256: NEW_SHA, agentTextRunId: "run-1" };
      noRecord.store.recordPullRequestDescription = async () => {
        throw new Error("db down");
      };
      await noRecord.executor.start("run-1");
      expect(noRecord.store.run.status).toBe("succeeded");
      expect(noRecord.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "skipped:error" });

      // The no-push refresh throws.
      const noRefresh = await fixRound();
      noChanges(noRefresh);
      noRefresh.vcs.refreshPullRequestDescription = async () => {
        throw new Error("github down");
      };
      await noRefresh.executor.start("run-1");
      expect(noRefresh.store.run.status).toBe("succeeded");
      expect(noRefresh.store.run.result).toMatchObject({ outcome: "no_changes" });
      expect(noRefresh.store.completions[0]?.record).toMatchObject({ prDescriptionOutcome: "skipped:error" });
      expect(noRefresh.vcs.notifyFinishedCalls).toEqual([
        { outcome: "succeeded", summary: "Already correct.", agentName: "knock-knock-implement" },
      ]);

      expect(descriptionWarnings()).toHaveLength(3);
    });
  });

  describe("originating issue on the pull request", () => {
    const issueUrl = (provider: string, key: string) =>
      provider === "jira" ? `https://example.atlassian.net/browse/${key}` : undefined;

    it("passes the run's issue key and url to finalizeChanges", async () => {
      const created = await harness({ issueProvider: "jira", issueKey: "PROJ-123" }, IMAGE, undefined, undefined, {
        issueUrl,
      });
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.issue).toEqual({
        key: "PROJ-123",
        url: "https://example.atlassian.net/browse/PROJ-123",
        trackerName: "Jira",
      });
    });

    it("keeps the key but omits the url when the tracker is unconfigured or the url is not https", async () => {
      for (const extra of [{}, { issueUrl: () => "http://example.atlassian.net/browse/PROJ-123" }]) {
        const created = await harness(
          { issueProvider: "jira", issueKey: "PROJ-123" },
          IMAGE,
          undefined,
          undefined,
          extra,
        );
        await created.executor.start("run-1");
        expect(created.vcs.lastFinalizeDetails?.issue).toEqual({ key: "PROJ-123", trackerName: "Jira" });
      }
    });

    it("omits the issue for a malformed key or a run without one", async () => {
      for (const overrides of [
        { issueProvider: "jira", issueKey: "proj-1" },
        { issueProvider: null, issueKey: null },
        {},
      ]) {
        const created = await harness(overrides, IMAGE, undefined, undefined, { issueUrl });
        await created.executor.start("run-1");
        expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("issue");
      }
    });

    it("names the same-repository GitHub issue a mention on it started the run from", async () => {
      const created = await harness({});
      const asked: string[] = [];
      created.store.linkedIssueSource = async (rootRunId) => {
        asked.push(rootRunId);
        return { hostStatus: { provider: "github", repository: "OpenAI/Example", number: 12, issueMention: true } };
      };
      await created.executor.start("run-1");
      expect(asked).toEqual(["run-1"]);
      expect(created.vcs.lastFinalizeDetails?.issueNumber).toBe(12);
      expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("issue");
    });

    it("keeps the Jira issue line and names no GitHub issue for a Jira run", async () => {
      const created = await harness({ issueProvider: "jira", issueKey: "PROJ-123" }, IMAGE, undefined, undefined, {
        issueUrl,
      });
      created.store.linkedIssueSource = async () => ({
        hostStatus: { provider: "github", repository: "openai/example", number: 12, issueMention: true },
      });
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.issue).toEqual({
        key: "PROJ-123",
        url: "https://example.atlassian.net/browse/PROJ-123",
        trackerName: "Jira",
      });
      expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("issueNumber");
    });

    it("keeps the From issue line, never a tracker line, for a run recorded for a GitHub issue", async () => {
      const created = await harness({ issueProvider: "github", issueKey: "openai/example#12" });
      created.store.linkedIssueSource = async () => ({
        hostStatus: { provider: "github", repository: "openai/example", number: 12, issueMention: true },
      });
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.issueNumber).toBe(12);
      expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("issue");
    });

    it("names no issue for a pull request mention, another repository, a manual run, or a failed lookup", async () => {
      const sources: Array<() => Promise<LinkedIssueSource>> = [
        async () => ({
          hostStatus: { provider: "github", repository: "openai/example", number: 40, issueMention: false },
        }),
        async () => ({ hostStatus: { provider: "github", repository: "openai/example", number: 40 } }),
        async () => ({ hostStatus: { provider: "github", repository: "other/repo", number: 12, issueMention: true } }),
        async () => ({ hostStatus: null }),
        async () => Promise.reject(new Error("db down")),
      ];
      for (const source of sources) {
        const created = await harness({});
        created.store.linkedIssueSource = source;
        await created.executor.start("run-1");
        expect(created.store.run.status).toBe("succeeded");
        expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("issueNumber");
      }
    });
  });

  describe("related pull requests on a new pull request", () => {
    it("lists the request's earlier pull requests, then this one, with the issue", async () => {
      const created = await harness({ issueProvider: "jira", issueKey: "PROJ-13" });
      created.store.related = [{ repository: "acme/order-service", number: 2 }];
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.related).toEqual({
        entries: [
          { repository: "acme/order-service", number: 2 },
          { repository: "openai/example", self: true },
        ],
        issue: { key: "PROJ-13", trackerName: "Jira" },
      });
    });

    it("carries the run's own mergeOrder onto its self entry, alongside an ordered sibling's", async () => {
      const created = await harness({ mergeOrder: 1 });
      created.store.related = [{ repository: "acme/order-service", number: 2, mergeOrder: 2 }];
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.related).toEqual({
        entries: [
          { repository: "acme/order-service", number: 2, mergeOrder: 2 },
          { repository: "openai/example", self: true, mergeOrder: 1 },
        ],
      });
    });

    it("omits mergeOrder on the self entry when the run has none", async () => {
      const created = await harness({});
      created.store.related = [{ repository: "acme/order-service", number: 2 }];
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.related).toEqual({
        entries: [
          { repository: "acme/order-service", number: 2 },
          { repository: "openai/example", self: true },
        ],
      });
    });

    it("names a GitHub issue the request was recorded for, linked to its page", async () => {
      const created = await harness({ issueProvider: "github", issueKey: "acme/app#7" });
      created.store.related = [{ repository: "acme/order-service", number: 2 }];
      await created.executor.start("run-1");
      expect(created.vcs.lastFinalizeDetails?.related?.issue).toEqual({
        key: "acme/app#7",
        url: "https://github.com/acme/app/issues/7",
        trackerName: "GitHub",
      });
    });

    it("adds nothing for the first pull request, a continuation, or a store that fails", async () => {
      for (const [overrides, related] of [
        [{}, []],
        [{ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" }, [{ repository: "acme/x", number: 1 }]],
        [{}, new Error("db down")],
      ] as const) {
        const created = await harness(overrides);
        created.store.related = related as never;
        await created.executor.start("run-1");
        expect(created.store.run.result).toMatchObject({ pullRequestNumber: 42 });
        expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("related");
      }
    });
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

    it("tells the host when a succeeded run spent past its base budget", async () => {
      const created = await harness({ budgetUsd: 0.1, budgetBaseUsd: 0.005 });
      await created.executor.start("run-1");

      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({
        outcome: "succeeded",
        overrunSentence: "Spent $0.01, $0.01 (100%) over its $0.01 budget, within its allowed overrun.",
      });
    });

    it("adds no overrun sentence for a run without a base budget or within it", async () => {
      const none = await harness({ budgetUsd: 0.1 });
      await none.executor.start("run-1");
      expect(none.vcs.notifyFinishedCalls[0]).not.toHaveProperty("overrunSentence");

      const within = await harness({ budgetUsd: 0.1, budgetBaseUsd: 0.05 });
      await within.executor.start("run-1");
      expect(within.vcs.notifyFinishedCalls[0]).not.toHaveProperty("overrunSentence");
    });

    it("names the base budget and allowed overrun when a run with an overrun is out of budget", async () => {
      const created = await harness({ budgetUsd: 1.1, budgetBaseUsd: 1 });
      created.sessions.exhausted.add("session-1");
      created.jobs.statusValue = { state: "failed" };
      created.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_failed" };
      await created.executor.start("run-1");

      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({
        budgetSentence:
          "Out of budget: this run's $1.00 budget and its 10% allowed overrun ($1.10 in all) were used up.",
      });
    });

    it("notifies finished with 'budget_exhausted' when the budget is exhausted", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        outcome: "budget_exhausted",
        summary: "Ran out.",
        tests: [],
      });
      created.vcs.finalizeEmpty = true;
      await created.executor.start("run-1");

      expect(created.vcs.notifyStartedCalls).toBe(1);
      expect(created.vcs.notifyFinishedCalls).toEqual([
        {
          outcome: "budget_exhausted",
          agentName: "knock-knock-implement",
          budgetSentence: "Out of budget: this run's $0.01 budget was used up.",
        },
      ]);
    });

    it("ends a failed job as budget_exhausted when the proxy refused its session for budget", async () => {
      const created = await harness({ budgetUsd: 0.52, agentBudgetUsd: 3, budgetGroupName: "reviewers" });
      created.sessions.exhausted.add("session-1");
      created.jobs.statusValue = { state: "failed" };
      created.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_failed" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.terminations).toEqual([
        {
          status: "budget_exhausted",
          error: "coding_budget_exhausted",
          audit: { failureCategory: "budget", diagnosticId: expect.stringMatching(/^coding_diag_/) },
        },
      ]);
      expect(created.observer.events.find((event) => event.stage === "terminal")).toMatchObject({
        outcome: "budget_exhausted",
        failureCategory: "budget",
      });
      // The operator still gets the real reason.
      expect(logged.some((entry) => String(entry.payload.reason).includes("job_coding_stream_failed"))).toBe(true);
      expect(created.vcs.notifyFinishedCalls).toEqual([
        {
          outcome: "budget_exhausted",
          agentName: "knock-knock-implement",
          budgetSentence:
            'Out of budget: this run\'s $0.52 budget was used up (the "reviewers" budget group had only that much left of its limit).',
        },
      ]);
    });

    it("explains the recorded budget refusal in the run error and the host sentence", async () => {
      const created = await harness();
      const event: BudgetEventView = {
        kind: "refused",
        limit: "run",
        at: new Date().toISOString(),
        details: {
          source: "proxy",
          budgetUsd: 3,
          spentUsd: 2.9,
          heldReservedUsd: 0,
          heldUncertainUsd: 0,
          refusedHoldUsd: 0.4,
          model: "m",
          turn: 7,
        },
      };
      created.store.recordedBudgetEvent = { event, agentName: "knock-knock-implement" };
      created.sessions.exhausted.add("session-1");
      created.jobs.statusValue = { state: "failed" };
      created.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_failed" };
      await created.executor.start("run-1");

      expect(created.store.terminations[0]).toMatchObject({
        status: "budget_exhausted",
        error: `coding_budget_exhausted: ${ownerBudgetSentence(event, "knock-knock-implement")}`,
      });
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ budgetSentence: hostBudgetSentence(event) });
    });

    it("ends a failed job as failed when the proxy never refused its session for budget", async () => {
      const created = await harness();
      created.jobs.statusValue = { state: "failed" };
      created.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_failed" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("failed");
      expect((created.store.terminations[0] as { error: string }).error).toMatch(
        /^coding_failure_executor:coding_diag_/,
      );
      expect(created.vcs.notifyFinishedCalls).toEqual([{ outcome: "failed", agentName: "knock-knock-implement" }]);
    });

    it.each([
      ["project_spend_limit_exceeded", "quota", "The model provider refused the request: its account has reached"],
      ["rate_limit_exceeded", "rate_limited", "The model provider is rate-limiting requests."],
      ["server_error", "unavailable", "The model provider reported an outage or overload."],
      ["invalid_prompt", "rejected", "The model provider rejected the request."],
    ])("ends a failed job whose session relayed %s as a provider_%s failure", async (code, providerClass, sentence) => {
      const created = await harness();
      created.sessions.upstreamFailures.set("session-1", code);
      created.jobs.statusValue = { state: "failed" };
      created.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_agent_exited" };
      logged.length = 0;
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("failed");
      expect(created.store.terminations).toEqual([
        {
          status: "failed",
          error: `coding_provider_${providerClass}`,
          audit: { failureCategory: `provider_${providerClass}`, diagnosticId: expect.stringMatching(/^coding_diag_/) },
        },
      ]);
      expect(created.observer.events.find((event) => event.stage === "terminal")).toMatchObject({
        outcome: "failed",
        failureCategory: `provider_${providerClass}`,
      });
      // One operator line to alert on, with the raw code; the diagnostic line is still there too.
      expect(logged.filter((entry) => entry.payload.event === "coding.provider_failure")).toEqual([
        {
          level: "warn",
          payload: { event: "coding.provider_failure", runId: "run-1", class: providerClass, upstreamCode: code },
          message: expect.any(String),
        },
      ]);
      expect(logged.some((entry) => String(entry.payload.reason).includes("job_coding_stream_agent_exited"))).toBe(
        true,
      );
      expect(created.vcs.notifyFinishedCalls).toEqual([
        {
          outcome: "failed",
          agentName: "knock-knock-implement",
          providerSentence: expect.stringContaining(sentence),
        },
      ]);
      expect(JSON.stringify(created.vcs.notifyFinishedCalls)).not.toContain(code);
    });

    it("reports budget exhaustion over a provider failure when the session has both", async () => {
      const created = await harness();
      created.sessions.exhausted.add("session-1");
      created.sessions.upstreamFailures.set("session-1", "project_spend_limit_exceeded");
      created.jobs.statusValue = { state: "failed" };
      created.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_failed" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.terminations[0]).toMatchObject({ error: "coding_budget_exhausted" });
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ outcome: "budget_exhausted" });
      expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("providerSentence");
    });

    it("fails a run whose changes touched a protected path as protected_path, naming it on the host", async () => {
      const created = await harness();
      created.vcs.finalizeChanges = async () => {
        throw new Error("vcs_protected_path:CODEOWNERS");
      };
      await created.executor.start("run-1");

      expect(created.store.terminations).toEqual([
        {
          status: "failed",
          error: expect.stringMatching(/^coding_failure_protected_path:coding_diag_/),
          audit: { failureCategory: "protected_path", diagnosticId: expect.stringMatching(/^coding_diag_/) },
        },
      ]);
      expect(created.vcs.notifyFinishedCalls).toEqual([
        {
          outcome: "failed",
          agentName: "knock-knock-implement",
          protectedPathSentence:
            "its changes include `CODEOWNERS`, which this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
        },
      ]);
    });

    describe("a continuation that merged its pull request's target branch", () => {
      const TARGET = "c".repeat(40);
      const continuing = async (conflictedPaths: string[] = []) => {
        const created = await harness({ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
        created.vcs.targetMerge = { ref: "main", targetCommit: TARGET, conflictedPaths };
        let task = "";
        created.jobs.onLaunch = () => {
          task = (JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as { task: string }).task;
        };
        return { created, task: () => task };
      };

      it("tells the agent which files conflict and says what was merged on the host", async () => {
        const { created, task } = await continuing(["src/app.ts"]);
        await created.executor.start("run-1");
        expect(task()).toContain("Merge conflicts: before you started, wardby merged `main` @ ccccccc");
        expect(task()).toContain("- `src/app.ts`");
        expect(created.store.run.status).toBe("succeeded");
        expect(created.vcs.notifyFinishedCalls).toEqual([
          expect.objectContaining({
            outcome: "succeeded",
            mergeSentence: "Merged `main` @ `ccccccc` into this branch; resolved conflicts in 1 file.",
          }),
        ]);
      });

      it("pushes the merge even when the agent changed nothing", async () => {
        const { created } = await continuing();
        created.jobs.result.resultArtifact = JSON.stringify({
          schemaVersion: 1,
          runId: "run-1",
          outcome: "no_changes",
          summary: "Brought the branch up to date.",
          tests: [],
        });
        await created.executor.start("run-1");
        expect(created.vcs.finalized).toBe(1);
        expect(created.store.run.result).toMatchObject({ outcome: "pull_request_updated" });
        expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({
          mergeSentence: "Merged `main` @ `ccccccc` into this branch; no conflicts.",
        });
      });

      it("fails a run that left conflict markers as merge_conflict, naming the file on the host", async () => {
        const { created } = await continuing(["src/app.ts"]);
        created.vcs.finalizeChanges = async () => {
          throw new Error("vcs_conflict_markers_remain:src/app.ts");
        };
        await created.executor.start("run-1");
        expect(created.store.terminations).toEqual([
          {
            status: "failed",
            error: expect.stringMatching(/^coding_failure_merge_conflict:coding_diag_/),
            audit: { failureCategory: "merge_conflict", diagnosticId: expect.stringMatching(/^coding_diag_/) },
          },
        ]);
        expect(created.vcs.notifyFinishedCalls).toEqual([
          {
            outcome: "failed",
            agentName: "knock-knock-implement",
            conflictMarkersSentence:
              "`src/app.ts` still has conflict markers after merging this pull request's target branch, so none of its changes were pushed. Ask again to resolve the conflicts.",
          },
        ]);
      });

      it("adds nothing to a run with no merge", async () => {
        const created = await harness({ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
        await created.executor.start("run-1");
        expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("mergeSentence");
      });
    });

    it("classifies a continuation of a no-longer-open PR as continuation_closed, refused before any spend", async () => {
      const created = await harness({ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
      created.vcs.prepareWorkspace = async () => {
        throw new Error(CONTINUATION_CLOSED_ERROR);
      };
      await created.executor.start("run-1");
      // No session was created yet and no job was launched, so this is a
      // preflight refusal (status "refused"), not "failed" -- the category
      // must still be recognised through the PreflightError wrapper.
      expect(created.store.run.status).toBe("refused");
      expect(created.store.terminations.at(-1)).toMatchObject({
        status: "refused",
        audit: { failureCategory: "continuation_closed" },
      });
    });

    it("leaves a prepare-time github_* failure's category exactly as before (not reclassified by the continuation_closed cause-chain check)", async () => {
      const created = await harness();
      created.vcs.prepareWorkspace = async () => {
        throw new Error("github_api_unavailable", { cause: new Error("fetch failed") });
      };
      await created.executor.start("run-1");
      expect(created.store.run.status).toBe("refused");
      expect(created.store.terminations.at(-1)).toMatchObject({
        status: "refused",
        audit: { failureCategory: "workspace" },
      });
    });

    it("reports budget exhaustion over a protected-path failure when the session has both", async () => {
      const created = await harness();
      created.sessions.exhausted.add("session-1");
      created.vcs.finalizeChanges = async () => {
        throw new Error("vcs_protected_path:CODEOWNERS");
      };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ outcome: "budget_exhausted" });
      expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("protectedPathSentence");
    });

    it("words a terminal protected_path run the same way when it is cleaned up later, without naming the file", async () => {
      const created = await harness({ status: "failed", failureCategory: "protected_path" });
      await created.vcs.prepareWorkspace({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: ["CODEOWNERS"],
      });
      await created.executor.stop("run-1", "requested");
      expect(created.vcs.notifyFinishedCalls).toEqual([
        expect.objectContaining({
          outcome: "failed",
          protectedPathSentence:
            "its changes include a file this agent may not edit, so none of its changes were kept. Ask again without changing that file, or have the repository owner make that change.",
        }),
      ]);
    });

    it("does not blame the provider for a failure after the job itself succeeded", async () => {
      const created = await harness();
      // A transient provider error the worker retried past.
      created.sessions.upstreamFailures.set("session-1", "rate_limit_exceeded");
      created.jobs.result = { exitCode: 0, reason: "completed" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("failed");
      expect((created.store.terminations[0] as { error: string }).error).toMatch(/^coding_failure_/);
      expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("providerSentence");
    });

    it("still delivers finished work that went over budget only after its workspace is materialized", async () => {
      const created = await harness();
      created.jobs.materializeWorkspace = async () => {
        created.store.run.costUsd = created.store.run.budgetUsd + 0.01;
      };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(created.observer.events.some((event) => event.stage === "budget_cutoff")).toBe(false);
      expect(created.vcs.finalized).toBe(1);
      expect(created.store.recordedRefusals).toEqual([["run-1", "session-1"]]);
    });

    // The proxy cannot write budget events; the control plane copies its refusal at every ending.
    it("copies the proxy's refusal for a run that still succeeded", async () => {
      const created = await harness();
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.recordedRefusals).toEqual([["run-1", "session-1"]]);
    });

    it("copies the proxy's refusal for a run that failed for another reason", async () => {
      const created = await harness();
      created.jobs.statusValue = { state: "failed" };
      created.jobs.result = { exitCode: 1, reason: "failed", diagnostic: "coding_stream_failed" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("failed");
      expect(created.store.recordedRefusals).toEqual([["run-1", "session-1"]]);
    });

    it("copies the proxy's refusal for a stopped run and again when an ended run is cleaned up", async () => {
      const created = await harness({ proxySessionId: "session-1" });
      await created.executor.stop("run-1", "requested");
      await created.executor.stop("run-1", "requested");

      expect(created.store.run.status).toBe("cancelled");
      // The store's copy is once per run; calling it twice adds nothing.
      expect(created.store.recordedRefusals).toEqual([
        ["run-1", "session-1"],
        ["run-1", "session-1"],
      ]);
    });

    it("copies nothing for a run that never had a proxy session", async () => {
      const created = await harness();
      await created.executor.stop("run-1", "requested");

      expect(created.store.run.status).toBe("cancelled");
      expect(created.store.recordedRefusals).toEqual([]);
    });

    it("ends a run whose result could not be finalized as budget_exhausted when its session was refused", async () => {
      const created = await harness();
      created.sessions.exhausted.add("session-1");
      created.jobs.result = { exitCode: 0, reason: "completed" };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ outcome: "budget_exhausted" });
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

    it("re-notifies an already-failed provider-refused run with the provider sentence", async () => {
      const created = await harness({ status: "failed", failureCategory: "provider_quota" });
      await created.vcs.prepareWorkspace({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: ["CODEOWNERS"],
      });

      await created.executor.stop("run-1", "requested");

      expect(created.vcs.notifyFinishedCalls).toEqual([
        {
          outcome: "failed",
          agentName: "knock-knock-implement",
          providerSentence: expect.stringContaining("spending or quota limit"),
        },
      ]);
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

  describe("dependency cache report", () => {
    const report = {
      projects: [
        { path: ".", result: "hit", key: "abc", sizeBytes: 10, restoreMs: 4, rebuild: "skipped" },
        { path: "web", result: "cold", installMs: 900 },
        { path: "api", result: "nearest" },
      ],
    };
    const artifact = (outcome: string) =>
      JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        outcome,
        summary: "Fixed it.",
        tests: [],
        dependencyCache: report,
      });

    it("stores the worker's report and names the restored folders for the PR body", async () => {
      const created = await harness();
      created.jobs.result.resultArtifact = artifact("changes_ready");
      await created.executor.start("run-1");
      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.completions[0]?.record).toEqual({
        baseSha: "a".repeat(40),
        dependencyCacheResult: report,
      });
      expect(created.vcs.lastFinalizeDetails?.restoredDependencies).toEqual([".", "api"]);
      // Only in its own column: the run's result JSON is unchanged.
      expect(created.store.run.result).not.toHaveProperty("dependencyCache");
    });

    it("stores it on a no_changes run and a budget-exhausted one too", async () => {
      for (const outcome of ["no_changes", "budget_exhausted"]) {
        const created = await harness();
        created.jobs.result.resultArtifact = artifact(outcome);
        // A budget stop with changes would push them; with none it ends without a push.
        created.vcs.finalizeEmpty = true;
        await created.executor.start("run-1");
        expect(created.store.completions[0]?.record).toEqual({ dependencyCacheResult: report });
      }
    });

    it("records nothing and passes no folders on a run without a report", async () => {
      const created = await harness();
      await created.executor.start("run-1");
      expect(created.store.completions[0]?.record).toEqual({ baseSha: "a".repeat(40) });
      expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("restoredDependencies");
    });
  });

  it("loads the registry report and passes packages/refusals through to VCS finalization", async () => {
    const registryReport = vi.fn(async (runId: string) => {
      expect(runId).toBe("run-1");
      return {
        packages: [{ ecosystem: "npm", name: "@heroui/react", version: "3.2.6" }],
        packageRefusals: [{ ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" }],
      };
    });
    const created = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, { registryReport });
    created.jobs.result.resultArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "changes_ready",
      summary: "Added HeroUI.",
      tests: [],
    });

    await created.executor.start("run-1");

    expect(registryReport).toHaveBeenCalledWith("run-1");
    expect(created.vcs.lastFinalizeDetails).toMatchObject({
      packages: [{ ecosystem: "npm", name: "@heroui/react", version: "3.2.6" }],
      packageRefusals: [{ ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" }],
    });
  });

  it("treats a rejected registry report as nothing to report, never failing the run", async () => {
    const created = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, {
      registryReport: async () => {
        throw new Error("registry_report_unavailable");
      },
    });
    created.jobs.result.resultArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "changes_ready",
      summary: "Added HeroUI.",
      tests: [],
    });

    await created.executor.start("run-1");

    expect(created.store.run.status).toBe("succeeded");
    expect(created.vcs.lastFinalizeDetails).toEqual({ summary: "Added HeroUI.", tests: [] });
  });

  it.each([
    [
      "throws synchronously",
      (): Promise<never> => {
        throw new Error("sync_failure");
      },
    ],
    [
      "returns a malformed report",
      (async () => ({ packages: null, packageRefusals: "x" })) as unknown as () => Promise<never>,
    ],
  ])("never fails finalization when the registry report %s", async (_label, registryReport) => {
    const created = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, { registryReport });
    created.jobs.result.resultArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "changes_ready",
      summary: "Added HeroUI.",
      tests: [],
    });

    await created.executor.start("run-1");

    expect(created.store.run.status).toBe("succeeded");
    expect(created.vcs.lastFinalizeDetails).toEqual({ summary: "Added HeroUI.", tests: [] });
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

  it("calls onCodingRunTerminal with the run id once the run's terminal write is done", async () => {
    const seen: Array<{ runId: string; status: string }> = [];
    const created = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, {
      onCodingRunTerminal: async (runId) => {
        seen.push({ runId, status: created.store.run.status });
      },
    });
    created.jobs.result.resultArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "no_changes",
      summary: "Already correct.",
      tests: [],
    });
    await created.executor.start("run-1");
    expect(seen).toEqual([{ runId: "run-1", status: "succeeded" }]);
  });

  it("a throwing onCodingRunTerminal never changes the run's terminal state", async () => {
    const created = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, {
      onCodingRunTerminal: () => {
        throw new Error("hook failed");
      },
    });
    created.jobs.result.resultArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "no_changes",
      summary: "Already correct.",
      tests: [],
    });
    await expect(created.executor.start("run-1")).resolves.toBeUndefined();
    expect(created.store.run.status).toBe("succeeded");
    expect(created.store.run.result).toMatchObject({ outcome: "no_changes" });
  });

  describe("budget overruns and budget stops", () => {
    const stoppedArtifact = JSON.stringify({
      schemaVersion: 1,
      runId: "run-1",
      outcome: "budget_exhausted",
      summary: "Added the endpoint; tests still to write.",
      tests: [],
    });
    const PREFIX = "Stopped at its budget before finishing; the changes so far are in this draft.";

    it("delivers finished work that cost more than its limit, saying so on the host", async () => {
      const created = await harness({ budgetUsd: 1, budgetBaseUsd: 1 });
      const cancel = created.sessions.cancelSession.bind(created.sessions);
      created.sessions.cancelSession = async () => {
        await cancel();
        created.store.run.costUsd = 1.05;
      };
      await created.executor.start("run-1");

      expect(created.vcs.finalized).toBe(1);
      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.run.result).toMatchObject({ outcome: "pull_request_opened", pullRequestNumber: 42 });
      expect(created.observer.events.map((event) => event.stage)).not.toContain("budget_cutoff");
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({
        outcome: "succeeded",
        overrunSentence: "Spent $1.05, $0.05 (5%) over its $1.00 budget.",
      });
    });

    it("finishes a no-change run that cost more than its limit as succeeded", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        outcome: "no_changes",
        summary: "Already correct.",
        tests: [],
      });
      await created.executor.start("run-1");
      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.run.result).toMatchObject({ outcome: "no_changes" });
    });

    it("pushes a budget-stopped run's changes as a draft pull request it can be continued from", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = stoppedArtifact;
      await created.executor.start("run-1");

      expect(created.jobs.materializations).toBe(1);
      expect(created.vcs.finalized).toBe(1);
      expect(created.vcs.lastFinalizeDetails?.summary).toBe(`${PREFIX}\n\nAdded the endpoint; tests still to write.`);
      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.completions).toHaveLength(1);
      expect(created.store.completions[0]).toMatchObject({
        status: "budget_exhausted",
        record: { baseSha: "a".repeat(40) },
      });
      const result = created.store.run.result as { outcome: string; summary: string; pullRequestNumber: number };
      expect(result).toMatchObject({ outcome: "pull_request_opened", pullRequestNumber: 42, usage: { costUsd: 0.01 } });
      expect(result.summary.startsWith(PREFIX)).toBe(true);
      expect(result.summary).toContain("Added the endpoint; tests still to write.");
      expect(created.store.recordedRefusals).toEqual([["run-1", "session-1"]]);
      const stages = created.observer.events.map((event) => event.stage);
      expect(stages).toContain("budget_cutoff");
      expect(stages).toContain("pull_request_opened");
      expect(created.observer.metrics.snapshot().terminalOutcomes).toEqual({ budget_exhausted: 1 });
      expect(created.vcs.notifyFinishedCalls).toEqual([
        {
          outcome: "budget_exhausted",
          agentName: "knock-knock-implement",
          summary: "Added the endpoint; tests still to write.",
          budgetSentence: "Out of budget: this run's $0.01 budget was used up.",
          changesPushed: { pullRequestNumber: 42 },
        },
      ]);
    });

    it("a fresh budget-stopped draft records its task in the pull request summary", async () => {
      const created = await harness({ budgetUsd: 0.005, request: "Add a README line" });
      created.jobs.result.resultArtifact = stoppedArtifact;
      await created.executor.start("run-1");

      const expected = `${PREFIX}\n\n### Task\n\n> Add a README line\n\nAdded the endpoint; tests still to write.`;
      expect(created.vcs.lastFinalizeDetails?.summary).toBe(expected);
      expect((created.store.run.result as { summary: string }).summary).toBe(expected);
    });

    it("keeps the task in the fallback summary when a step after the push fails", async () => {
      const created = await harness({ budgetUsd: 0.005, request: "Add a README line" });
      created.jobs.result.resultArtifact = stoppedArtifact;
      const executor = created.executor as unknown as { resultFor: (...args: unknown[]) => unknown };
      const real = executor.resultFor.bind(created.executor);
      let calls = 0;
      executor.resultFor = (...args: unknown[]) => {
        calls += 1;
        if (calls === 1) throw new Error("result_build_failed");
        return real(...args);
      };
      await created.executor.start("run-1");

      expect((created.store.run.result as { summary: string }).summary).toBe(
        `${PREFIX}\n\n### Task\n\n> Add a README line`,
      );
    });

    it("a budget-stopped continuation still sends no description", async () => {
      const created = await harness({
        budgetUsd: 0.005,
        rootCodingRunId: "root-run",
        headRef: "wardby/run-root-run",
        request: "Add a README line",
      });
      created.jobs.result.resultArtifact = stoppedArtifact;
      await created.executor.start("run-1");

      expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("description");
    });

    it("a later continuation's task carries the recorded Task inside the description note", async () => {
      const created = await harness({ rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
      created.store.pullRequestDescriptionBaseline = async () => ({
        recordedSha256: null,
        previousAgentText: budgetStoppedSummary(WORKER_BUDGET_EXHAUSTED_SUMMARY, "Add a README line"),
        agentTextRunId: "root-run",
      });
      let input: Record<string, unknown> | undefined;
      created.jobs.onLaunch = () => {
        input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
      };
      await created.executor.start("run-1");
      const task = input!.task as string;
      const note = task.slice(task.indexOf("<untrusted_pr_description>"), task.indexOf("</untrusted_pr_description>"));
      expect(note).toContain("### Task\n\n> Add a README line");
    });

    it("ends a budget-stopped run without a push when it made no changes", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = stoppedArtifact;
      created.vcs.finalizeEmpty = true;
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.run.result).toMatchObject({ outcome: "budget_exhausted", usage: { costUsd: 0.01 } });
      expect(created.store.run.result).not.toHaveProperty("pullRequestNumber");
      expect((created.store.run.result as { summary: string }).summary).toBe(
        "Added the endpoint; tests still to write.",
      );
      expect(created.store.recordedRefusals).toEqual([["run-1", "session-1"]]);
      expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("changesPushed");
    });

    it("ends a budget-stopped run out of budget, not failed, when its changes cannot be pushed", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = stoppedArtifact;
      created.vcs.finalizeChanges = async () => {
        throw new Error("vcs_protected_path:x");
      };
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.terminations).toEqual([]);
      expect(created.store.run.result).toMatchObject({ outcome: "budget_exhausted" });
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ outcome: "budget_exhausted" });
      expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("changesPushed");
      expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("protectedPathSentence");
    });

    it("pushes nothing for a budget-stopped run that was stopped while its result was collected", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = stoppedArtifact;
      created.jobs.materializeWorkspace = async () => {
        created.store.run.status = "cancelled";
      };
      await created.executor.start("run-1");

      expect(created.vcs.finalized).toBe(0);
      expect(created.store.run.status).toBe("cancelled");
      expect(created.store.completions).toEqual([]);
    });

    it("pushes a budget-stopped continuation's changes to its pull request", async () => {
      const created = await harness({ budgetUsd: 0.005, rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
      created.jobs.result.resultArtifact = stoppedArtifact;
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.run.result).toMatchObject({ outcome: "pull_request_updated", pullRequestNumber: 42 });
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({
        outcome: "budget_exhausted",
        changesPushed: { pullRequestNumber: 42 },
      });
    });

    it("records the pushed outcome when a step after the push fails", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = stoppedArtifact;
      const executor = created.executor as unknown as { resultFor: (...args: unknown[]) => unknown };
      const real = executor.resultFor.bind(created.executor);
      let calls = 0;
      executor.resultFor = (...args: unknown[]) => {
        calls += 1;
        if (calls === 1) throw new Error("result_build_failed");
        return real(...args);
      };
      await created.executor.start("run-1");

      expect(created.vcs.finalized).toBe(1);
      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.run.result).toMatchObject({
        outcome: "pull_request_opened",
        pullRequestNumber: 42,
        summary: PREFIX,
        tests: [],
      });
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ changesPushed: { pullRequestNumber: 42 } });
    });

    it("still refuses to launch a run that has already spent past its limit", async () => {
      const created = await harness({ budgetUsd: 1, costUsd: 1.05 });
      await created.executor.start("run-1");

      expect(created.jobs.launches).toBe(0);
      expect(created.sessions.creates).toBe(0);
      expect(created.store.run.status).toBe("refused");
      expect(created.store.terminations[0]).toMatchObject({ audit: { failureCategory: "budget" } });
      expect(logged.some((line) => String(line.payload.reason).includes("coding_run_budget_invalid"))).toBe(true);
    });

    describe("a budget stop with the workers' own budget summary", () => {
      const workerStoppedArtifact = JSON.stringify({
        schemaVersion: 1,
        runId: "run-1",
        outcome: "budget_exhausted",
        summary: WORKER_BUDGET_EXHAUSTED_SUMMARY,
        tests: [],
      });
      const CONTINUATION = { budgetUsd: 0.005, rootCodingRunId: "root-run", headRef: "wardby/run-root-run" };

      it("leaves a continuation's pull request description untouched", async () => {
        const created = await harness(CONTINUATION);
        created.jobs.result.resultArtifact = workerStoppedArtifact;
        created.store.pullRequestDescriptionBaseline = async () => ({
          recordedSha256: "f".repeat(64),
          previousAgentText: "The original description text.",
          agentTextRunId: "root-run",
        });
        created.store.recordPullRequestDescription = async () => {
          throw new Error("must not record a description");
        };
        created.vcs.continuationPullRequestDraft = async () => true;
        created.vcs.finalizeDescription = { kind: "replaced", sha256: "e".repeat(64), agentTextRunId: "run-1" };
        await created.executor.start("run-1");

        expect(created.vcs.finalized).toBe(1);
        expect(created.vcs.lastFinalizeDetails).not.toHaveProperty("description");
        expect(created.store.run.status).toBe("budget_exhausted");
        expect(created.store.run.result).toMatchObject({ outcome: "pull_request_updated", pullRequestNumber: 42 });
        expect(created.store.completions[0]?.record).not.toHaveProperty("prDescriptionOutcome");
        expect(created.store.completions[0]?.record).not.toHaveProperty("prDescriptionSha256");
        expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({
          outcome: "budget_exhausted",
          changesPushed: { pullRequestNumber: 42 },
        });
      });

      it("starts a fresh pull request's description with the stopped note alone", async () => {
        const created = await harness({ budgetUsd: 0.005 });
        created.jobs.result.resultArtifact = workerStoppedArtifact;
        let askedDraft = false;
        created.vcs.continuationPullRequestDraft = async () => {
          askedDraft = true;
          return false;
        };
        await created.executor.start("run-1");

        expect(askedDraft).toBe(false);
        expect(created.vcs.finalized).toBe(1);
        expect(created.vcs.lastFinalizeDetails?.summary).toBe(PREFIX);
        expect(created.store.run.status).toBe("budget_exhausted");
        expect(created.store.run.result).toMatchObject({ outcome: "pull_request_opened", summary: PREFIX });
      });
    });

    describe("a continuation whose pull request is no longer a draft", () => {
      const CONTINUATION = { budgetUsd: 0.005, rootCodingRunId: "root-run", headRef: "wardby/run-root-run" };

      function expectNothingPushed(created: Awaited<ReturnType<typeof harness>>) {
        expect(created.jobs.materializations).toBe(0);
        expect(created.vcs.finalized).toBe(0);
        expect(created.store.run.status).toBe("budget_exhausted");
        expect(created.store.terminations).toEqual([]);
        expect(created.store.run.result).toMatchObject({ outcome: "budget_exhausted" });
        expect(created.store.run.result).not.toHaveProperty("pullRequestNumber");
        expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ outcome: "budget_exhausted" });
        expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("changesPushed");
      }

      it("pushes nothing when the host says it is ready for review", async () => {
        const created = await harness(CONTINUATION);
        created.jobs.result.resultArtifact = stoppedArtifact;
        created.vcs.continuationPullRequestDraft = async () => false;
        created.store.pullRequestMarkedReady = async () => false;
        await created.executor.start("run-1");
        expectNothingPushed(created);
      });

      it("falls back to wardby's mark-ready record when the host's state is unknown", async () => {
        const created = await harness(CONTINUATION);
        created.jobs.result.resultArtifact = stoppedArtifact;
        created.vcs.continuationPullRequestDraft = async () => undefined;
        const asked: string[] = [];
        created.store.pullRequestMarkedReady = async (rootRunId) => {
          asked.push(rootRunId);
          return true;
        };
        await created.executor.start("run-1");
        expect(asked).toEqual(["root-run"]);
        expectNothingPushed(created);
      });

      it("still pushes to a draft pull request", async () => {
        const host = await harness(CONTINUATION);
        host.jobs.result.resultArtifact = stoppedArtifact;
        host.vcs.continuationPullRequestDraft = async () => true;
        host.store.pullRequestMarkedReady = async () => true;
        await host.executor.start("run-1");
        expect(host.vcs.finalized).toBe(1);
        expect(host.store.run.result).toMatchObject({ outcome: "pull_request_updated", pullRequestNumber: 42 });

        const record = await harness(CONTINUATION);
        record.jobs.result.resultArtifact = stoppedArtifact;
        record.vcs.continuationPullRequestDraft = async () => undefined;
        record.store.pullRequestMarkedReady = async () => false;
        await record.executor.start("run-1");
        expect(record.vcs.finalized).toBe(1);
        expect(record.store.run.result).toMatchObject({ outcome: "pull_request_updated", pullRequestNumber: 42 });
      });
    });

    it("re-notifies a recovered budget-stopped run with the changes it pushed", async () => {
      const handle = { backend: "fake", id: "job-1" };
      const created = await harness({
        status: "budget_exhausted",
        jobHandle: handle,
        proxySessionId: "session-1",
        budgetUsd: 0.005,
        result: {
          schemaVersion: 1,
          outcome: "pull_request_opened",
          repository: "openai/example",
          baseRef: "main",
          headRef: "wardby/run-run-1",
          commitSha: "b".repeat(40),
          pullRequestUrl: "https://github.com/openai/example/pull/42",
          pullRequestNumber: 42,
          summary: PREFIX,
          tests: [],
          usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 },
        },
      });
      await created.vcs.prepareWorkspace({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: ["CODEOWNERS"],
      });
      await expect(created.executor.recover({ runId: "run-1", ...handle })).resolves.toEqual({ state: "terminal" });
      expect(created.vcs.notifyFinishedCalls).toHaveLength(1);
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({
        outcome: "budget_exhausted",
        changesPushed: { pullRequestNumber: 42 },
      });
    });

    it("re-notifies a recovered budget-stopped run that pushed nothing without changes", async () => {
      const created = await harness({
        status: "budget_exhausted",
        budgetUsd: 0.005,
        result: {
          schemaVersion: 1,
          outcome: "budget_exhausted",
          repository: "openai/example",
          baseRef: "main",
          summary: "Ran out.",
          tests: [],
          usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.01 },
        },
      });
      await created.vcs.prepareWorkspace({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: ["CODEOWNERS"],
      });
      await created.executor.start("run-1");
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ outcome: "budget_exhausted" });
      expect(created.vcs.notifyFinishedCalls[0]).not.toHaveProperty("changesPushed");
    });

    it("delivers a resumed launched run whose cost is already past its limit, as recover() does", async () => {
      const handle = { backend: "fake", id: "job-1" };
      const created = await harness({ jobHandle: handle, proxySessionId: "session-1", budgetUsd: 1, costUsd: 1.05 });
      await created.vcs.prepareWorkspace({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        protectedPaths: ["CODEOWNERS"],
      });
      await created.executor.start("run-1");

      expect(created.jobs.launches).toBe(0);
      expect(created.vcs.finalized).toBe(1);
      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.run.result).toMatchObject({ outcome: "pull_request_opened", pullRequestNumber: 42 });
    });

    it("pushes a budget-stopped local run's changes to its branch", async () => {
      const created = await harness({ budgetUsd: 0.005 });
      created.jobs.result.resultArtifact = stoppedArtifact;
      created.vcs.pushBranchOnly = true;
      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("budget_exhausted");
      expect(created.store.run.result).toMatchObject({ outcome: "branch_pushed", headRef: "wardby/run-run-1" });
      expect(created.store.completions[0]?.record).toMatchObject({ resultBranch: "wardby/run-run-1" });
      expect(created.vcs.notifyFinishedCalls[0]).toMatchObject({ changesPushed: {} });
    });
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

  it("queues a run the cluster has no room for, before claiming a slot or touching anything", async () => {
    const created = await harness({ status: "pending" });
    created.jobs.capacity = false;
    await created.executor.start("run-1");
    expect(created.store.queuedForCapacity).toEqual(["run-1"]);
    expect(created.store.run.status).toBe("pending");
    expect(created.store.run.provisioningClaim ?? null).toBeNull();
    expect(created.store.terminations).toEqual([]);
    expect(created.vcs.prepared).toBe(0);
    expect(created.sessions.creates).toBe(0);
    expect(created.jobs.launches).toBe(0);
    expect(created.jobs.capacityChecks[0]?.runId).toBe("run-1");
  });

  it("launches as usual when the cluster has room, or when the capacity check itself fails", async () => {
    for (const capacity of [true, new Error("quota api down")]) {
      const created = await harness({});
      created.jobs.capacity = capacity;
      await created.executor.start("run-1");
      expect(created.store.queuedForCapacity).toEqual([]);
      expect(created.jobs.launches).toBe(1);
    }
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

  describe("a launch the cluster refuses for capacity (namespace quota)", () => {
    async function refused() {
      const clock = { now: new Date("2026-10-18T12:00:00Z") };
      const created = await harness({ status: "pending" }, IMAGE, new InMemoryCodingRunObserver(), undefined, {
        now: () => clock.now,
      });
      created.jobs.planned = { backend: "fake", id: "planned" };
      created.jobs.launchError = new JobCapacityError("kubernetes_quota_exceeded");
      return { ...created, clock };
    }

    it("returns the run to the queue instead of failing it", async () => {
      const created = await refused();
      await created.executor.start("run-1");

      expect(created.store.terminations).toEqual([]);
      expect(created.store.requeues).toEqual([
        {
          runId: "run-1",
          owned: { claimId: expect.any(String), planned: { backend: "fake", id: "planned-run-1" } },
        },
      ]);
      expect(created.store.run).toMatchObject({ status: "pending", jobHandle: null, proxySessionId: null });
      expect(created.sessions.cancels).toBe(1);
      expect(created.vcs.cleaned).toBe(1);
      expect(created.vcs.notifyFinishedCalls).toEqual([]);
      // The launcher already removed what it created; there is no job to stop.
      expect(created.jobs.stops).toBe(0);
      expect(created.jobs.removals).toBe(0);
      await expect(created.capabilities.get("run-1")).rejects.toThrow("coding_capability_unavailable");
      expect(created.observer.events.map((event) => event.stage)).toEqual(["queued", "prepared", "queued"]);
      expect(created.observer.events.at(-1)).toMatchObject({ stage: "queued", runId: "run-1" });
    });

    it("passes only the claim when the backend has no planned handle", async () => {
      const created = await refused();
      created.jobs.planned = undefined;
      await created.executor.start("run-1");
      expect(created.store.requeues.map((call) => call.owned)).toEqual([{ claimId: expect.any(String) }]);
      expect(created.store.run.status).toBe("pending");
    });

    it("writes nothing more when the run is no longer this attempt's to requeue", async () => {
      const created = await refused();
      created.store.requeueAnswer = "not_owned";
      await created.executor.start("run-1");
      expect(created.store.requeues).toHaveLength(1);
      expect(created.store.terminations).toEqual([]);
      expect(created.store.completions).toEqual([]);
      expect(created.vcs.notifyFinishedCalls).toEqual([]);
      expect(created.observer.events.map((event) => event.stage)).toEqual(["queued", "prepared"]);
    });

    it("waits out the backoff before trying the run again, then launches it", async () => {
      const created = await refused();
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(1);
      const touched = () => ({
        prepared: created.vcs.prepared,
        cleaned: created.vcs.cleaned,
        sessions: created.sessions.creates,
        cancels: created.sessions.cancels,
        persisted: created.store.persistedHandles.length,
        heartbeats: created.store.heartbeats,
        requeues: created.store.requeues.length,
        capacityChecks: created.jobs.capacityChecks.length,
      });
      const before = touched();

      // As drainCodingQueue would, just inside the backoff: nothing is claimed or launched.
      created.jobs.launchError = undefined;
      created.clock.now = new Date(created.clock.now.getTime() + CAPACITY_RETRY_BACKOFF_MS - 1);
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(1);
      expect(created.store.run).toMatchObject({ status: "pending", provisioningClaim: null, jobHandle: null });
      expect(touched()).toEqual(before);

      // After the backoff it is tried normally, and launches now that the cluster has room.
      created.clock.now = new Date(created.clock.now.getTime() + 1);
      await created.executor.start("run-1");
      expect(created.jobs.launches).toBe(2);
      expect(created.store.run.status).toBe("succeeded");
      expect(created.store.terminations).toEqual([]);
      expect(created.sessions.creates).toBe(2);
    });

    it("removes the run's input artifact: the next attempt writes its own", async () => {
      const created = await refused();
      let written = false;
      created.jobs.onLaunch = () => {
        written = existsSync(created.jobs.lastSpec!.inputArtifact);
      };
      await created.executor.start("run-1");
      expect(written).toBe(true);
      expect(existsSync(join(created.root, "artifacts", "run-1"))).toBe(false);
    });

    it("fails the run the normal way when the session has spend recorded, removing the refused job", async () => {
      const created = await refused();
      created.store.requeueAnswer = "spend_recorded";
      await created.executor.start("run-1");
      expect(created.store.requeues).toHaveLength(1);
      expect(created.store.run.status).toBe("failed");
      expect(created.store.terminations).toHaveLength(1);
      // The planned handle names the launcher's requeued record: stopped and removed, never left to relaunch.
      expect(created.jobs.stops).toBe(1);
      expect(created.jobs.removals).toBe(1);
      expect(created.vcs.cleaned).toBe(1);
      expect(created.observer.events.map((event) => event.stage)).toEqual([
        "queued",
        "prepared",
        "stopping",
        "terminal",
        "cleanup",
      ]);
    });

    it("cleans up a refused continuation that then times out in the queue", async () => {
      const created = await refused();
      Object.assign(created.store.run, { rootCodingRunId: "root-run", headRef: "wardby/run-root-run" });
      await created.executor.start("run-1");
      expect(created.vcs.notifyStartedCalls).toBe(1);
      expect(created.store.run.status).toBe("pending");
      // drainCodingQueue failed it with coding_queue_timeout, then hands it to the executor.
      created.store.run.status = "failed";
      await created.executor.cleanupQueueTimeout("run-1");
      expect(created.vcs.notifyFinishedCalls).toEqual([{ outcome: "failed", agentName: "knock-knock-implement" }]);
      expect(created.vcs.notifyFinishedTargets[0]).toMatchObject({
        runId: "run-1",
        continuation: { rootRunId: "root-run" },
      });
      expect(existsSync(join(created.root, "artifacts", "run-1"))).toBe(false);
      // Its backoff entry is gone too: a start is no longer skipped silently.
      const before = created.observer.events.length;
      await created.executor.start("run-1");
      expect(created.observer.events.slice(before).map((event) => event.stage)).toContain("queued");
    });

    it("leaves a queue-timed-out run that never started a continuation without a host signal", async () => {
      const created = await harness({ status: "failed" });
      await created.executor.cleanupQueueTimeout("run-1");
      expect(created.vcs.notifyFinishedCalls).toEqual([]);
    });

    describe("recovery after a crash between the refusal and the requeue", () => {
      /** The launcher recorded the refusal; the store still says running with the planned handle. */
      async function crashed() {
        const planned = { backend: "fake", id: "planned-run-1" };
        const created = await harness({ status: "running", jobHandle: planned, proxySessionId: "session-1" });
        created.jobs.statusValue = { state: "pending", capacityRefused: true };
        await mkdir(join(created.root, "artifacts", "run-1"), { recursive: true });
        await writeFile(join(created.root, "artifacts", "run-1", "input.json"), "{}");
        return { ...created, planned };
      }

      it("finishes the requeue instead of reporting the run active forever", async () => {
        const created = await crashed();
        await expect(created.executor.recover({ runId: "run-1", ...created.planned })).resolves.toEqual({
          state: "active",
        });
        expect(created.store.requeues).toEqual([{ runId: "run-1", owned: { planned: created.planned } }]);
        expect(created.store.run).toMatchObject({ status: "pending", jobHandle: null, proxySessionId: null });
        expect(created.store.terminations).toEqual([]);
        expect(created.store.heartbeats).toBe(0);
        expect(created.jobs.stops).toBe(0);
        expect(created.vcs.notifyFinishedCalls).toEqual([]);
        expect(existsSync(join(created.root, "artifacts", "run-1"))).toBe(false);
        expect(created.observer.events.map((event) => event.stage)).toEqual(["queued"]);
      });

      it("ends the run as lost when the session has spend recorded", async () => {
        const created = await crashed();
        created.store.requeueAnswer = "spend_recorded";
        const recovered = await created.executor.recover({ runId: "run-1", ...created.planned });
        expect(recovered.state).toBe("lost");
        expect(created.store.run.status).toBe("lost");
        expect(created.jobs.stops).toBe(1);
        expect(created.jobs.removals).toBe(1);
      });

      it("reports a run another path already requeued or ended without touching it", async () => {
        const created = await crashed();
        created.store.requeueAnswer = "not_owned";
        await expect(created.executor.recover({ runId: "run-1", ...created.planned })).resolves.toEqual({
          state: "active",
        });
        expect(created.store.terminations).toEqual([]);
        expect(existsSync(join(created.root, "artifacts", "run-1"))).toBe(true);
      });
    });

    it("still fails the run when the store cannot requeue", async () => {
      const created = await refused();
      (created.store as { requeueAfterCapacityRefusal?: unknown }).requeueAfterCapacityRefusal = undefined;
      await created.executor.start("run-1");
      expect(created.store.run.status).toBe("failed");
      expect(created.store.terminations).toHaveLength(1);
    });
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

  // A launch is one long await: on a real cluster the pod cannot be scheduled until an
  // autoscaler has built a node for it, which took ~2 minutes on GKE Autopilot's gVisor
  // pool. The reconciler declares any run lost whose heartbeat is older than
  // HEARTBEAT_TIMEOUT_MS, so without beating during the launch a perfectly healthy run is
  // killed and its pod deleted underneath the launch that is still running (measured
  // 2026-09-23: lost at 60s, then the interrupted launch failed 32s later). Counting beats
  // only WHILE launch is in flight is the whole point — the poll loop afterwards beats
  // either way, so a total count would pass with the bug present.
  it("beats the heartbeat while a slow launch is provisioning", async () => {
    const created = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, { heartbeatIntervalMs: 5 });
    let beatsDuringLaunch = 0;
    const inner = created.jobs.launch.bind(created.jobs);
    created.jobs.launch = async (spec) => {
      const before = created.store.heartbeats;
      await new Promise((r) => setTimeout(r, 80));
      beatsDuringLaunch = created.store.heartbeats - before;
      return inner(spec);
    };
    await created.executor.start("run-1");
    expect(beatsDuringLaunch).toBeGreaterThan(0);
  });

  it("stops beating once the launch returns, leaving the poll loop in charge", async () => {
    const created = await harness({}, IMAGE, new InMemoryCodingRunObserver(), undefined, { heartbeatIntervalMs: 5 });
    await created.executor.start("run-1");
    const settled = created.store.heartbeats;
    await new Promise((r) => setTimeout(r, 40));
    expect(created.store.heartbeats).toBe(settled);
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

  it("leaves a run that finished while stop was loading it alone: no cancel event, no job kill, no failed comment", async () => {
    const handle = { backend: "fake", id: "job-1" };
    const created = await harness({ jobHandle: handle, proxySessionId: "session-1" });
    const load = created.store.load.bind(created.store);
    created.store.load = async (runId: string) => {
      const snapshot = await load(runId);
      // The run commits succeeded between stop() loading it and fencing it.
      created.store.run.status = "succeeded";
      return snapshot;
    };
    await created.executor.stop("run-1", "stop_run");
    expect(created.store.run.status).toBe("succeeded");
    expect(created.store.terminations).toHaveLength(0);
    expect(created.vcs.notifyFinishedCalls).toHaveLength(0);
    expect(created.jobs.stops).toBe(0);
    expect(created.sessions.cancels).toBe(0);
  });

  it("stops a run queued for a slot: cancelled before it ever launches, and a later start launches nothing", async () => {
    const created = await harness({ status: "pending" });
    created.store.slotsFull = true;
    await created.executor.start("run-1");
    expect(created.store.run.status).toBe("pending");
    expect(created.jobs.launches).toBe(0);

    await created.executor.stop("run-1", "stop_run");
    expect(created.store.run.status).toBe("cancelled");
    expect(created.jobs.stops).toBe(0);

    // The queue drain starting it afterwards finds it terminal.
    created.store.slotsFull = false;
    await created.executor.start("run-1");
    expect(created.jobs.launches).toBe(0);
    expect(created.store.run.status).toBe("cancelled");
  });

  it("pushes nothing and opens no pull request when the run was stopped while its result was collected", async () => {
    const created = await harness();
    const collect = created.jobs.collect.bind(created.jobs);
    created.jobs.collect = async () => {
      // A stop_run from another process lands here: the cancellation fence is written first.
      created.store.run.status = "cancelled";
      return collect();
    };
    await created.executor.start("run-1");
    expect(created.vcs.finalized).toBe(0);
    expect(created.events).not.toContain("finalize");
    expect(created.store.completions).toEqual([]);
    expect(created.store.run.status).toBe("cancelled");
    expect(created.store.terminations).toEqual([]);
    expect(created.jobs.removals).toBe(1);
  });
});

describe("resolveCodingToolImage", () => {
  const CLAUDE_PY_TOOL_IMAGE = `registry.example/claude-tools-python@sha256:${"e".repeat(64)}`;
  const claudeHarness = (extra: Partial<ContainerExecutorOptions> = {}) =>
    harness(
      {},
      IMAGE,
      new InMemoryCodingRunObserver(),
      { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
      { claudeToolRunnerImages: { "node-python": { "3.12": CLAUDE_PY_TOOL_IMAGE } }, ...extra },
    );
  const claude = (toolchain: string, toolchainVersion: string | null) => ({
    provider: "claude-code" as const,
    toolchain,
    toolchainVersion,
    workerImageRef: null,
  });

  it("gives Claude's node toolchain the plain tool runner", async () => {
    const { executor } = await claudeHarness();
    expect(executor.resolveCodingToolImage?.(claude("node", null))).toBe(CLAUDE_TOOL_IMAGE);
  });

  it("gives Claude's node-python 3.12 toolchain its Python tool runner, with the same agent image", async () => {
    const { executor } = await claudeHarness();
    expect(executor.resolveCodingToolImage?.(claude("node-python", "3.12"))).toBe(CLAUDE_PY_TOOL_IMAGE);
    expect(executor.resolveCodingWorkerImage?.(claude("node-python", "3.12"))).toBe(CLAUDE_IMAGE);
  });

  it("refuses a Claude toolchain that has no tool-runner image", async () => {
    const { executor } = await claudeHarness();
    for (const selector of [claude("node-python", "2.7"), claude("node-python", null), claude("node", "20")]) {
      expect(() => executor.resolveCodingToolImage?.(selector)).toThrow("coding_toolchain_unsupported:claude-code");
      expect(() => executor.resolveCodingWorkerImage?.(selector)).toThrow("coding_toolchain_unsupported:claude-code");
    }
    const { executor: withoutPython } = await claudeHarness({ claudeToolRunnerImages: {} });
    expect(() => withoutPython.resolveCodingToolImage?.(claude("node-python", "3.12"))).toThrow(
      "coding_toolchain_unsupported:claude-code",
    );
  });

  it("has no tool-runner image for Codex", async () => {
    const { executor } = await claudeHarness();
    expect(
      executor.resolveCodingToolImage?.({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      }),
    ).toBeNull();
  });

  const CUSTOM_IMAGE = `registry.example/my-tools@sha256:${"f".repeat(64)}`;

  it("runs a Claude agent's commands in its workerImageRef, keeping the standard agent image", async () => {
    const { executor } = await claudeHarness();
    const selector = { ...claude("node", null), workerImageRef: CUSTOM_IMAGE };
    expect(executor.resolveCodingToolImage?.(selector)).toBe(CUSTOM_IMAGE);
    expect(executor.resolveCodingWorkerImage?.(selector)).toBe(CLAUDE_IMAGE);
  });

  it("uses the custom image whatever the toolchain says", async () => {
    const { executor } = await claudeHarness();
    const selector = { ...claude("node-python", "2.7"), workerImageRef: CUSTOM_IMAGE };
    expect(executor.resolveCodingToolImage?.(selector)).toBe(CUSTOM_IMAGE);
    expect(executor.resolveCodingWorkerImage?.(selector)).toBe(CLAUDE_IMAGE);
  });

  it("refuses a mutable custom image reference for Claude", async () => {
    const { executor } = await claudeHarness();
    const selector = { ...claude("node", null), workerImageRef: "registry.example/my-tools:latest" };
    expect(() => executor.resolveCodingToolImage?.(selector)).toThrow("coding_worker_image_invalid");
  });

  it("returns a Codex workerImageRef unchanged from resolveCodingWorkerImage, with no tool-runner image", async () => {
    const { executor } = await claudeHarness();
    const selector = {
      provider: "codex" as const,
      toolchain: "node",
      toolchainVersion: null,
      workerImageRef: CUSTOM_IMAGE,
    };
    expect(executor.resolveCodingWorkerImage?.(selector)).toBe(CUSTOM_IMAGE);
    expect(executor.resolveCodingToolImage?.(selector)).toBeNull();
  });

  it("launches a Claude run with the tool-runner image fixed on it at dispatch", async () => {
    const created = await harness(
      { provider: "claude-code", model: "claude-sonnet-5", workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_PY_TOOL_IMAGE },
      IMAGE,
      new InMemoryCodingRunObserver(),
      { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
    );
    await created.executor.start("run-1");
    expect(created.jobs.lastSpec).toMatchObject({ image: CLAUDE_IMAGE, toolImage: CLAUDE_PY_TOOL_IMAGE });
  });

  it("refuses a tool-runner image entry that is not an immutable digest", async () => {
    await expect(
      claudeHarness({ claudeToolRunnerImages: { "node-python": { "3.12": "claude-tools:latest" } } }),
    ).rejects.toThrow();
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
      repoAccess: gateWith().gate,
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
      repoAccess: gateWith().gate,
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

  it("refuses a Codex run with coding_provider_not_configured:codex when no Codex worker image is set", async () => {
    const { executor } = await harness(
      {},
      IMAGE,
      new InMemoryCodingRunObserver(),
      { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
      { workerImage: undefined },
    );
    expect(() =>
      executor.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      }),
    ).toThrow(/^coding_provider_not_configured:codex$/);
  });

  it("still resolves an agent's BYO image and toolchain images for Codex without CODING_WORKER_IMAGE", async () => {
    const pythonImage = `registry.example/worker-python@sha256:${"b".repeat(64)}`;
    const byo = `registry.example/byo@sha256:${"e".repeat(64)}`;
    const { executor } = await harness(
      {},
      IMAGE,
      new InMemoryCodingRunObserver(),
      { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
      { workerImage: undefined, additionalWorkerImages: { "node-python": { "3.12": pythonImage } } },
    );
    expect(
      executor.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: byo,
      }),
    ).toBe(byo);
    expect(
      executor.resolveCodingWorkerImage?.({
        provider: "codex",
        toolchain: "node-python",
        toolchainVersion: "3.12",
        workerImageRef: null,
      }),
    ).toBe(pythonImage);
    expect(
      executor.resolveCodingWorkerImage?.({
        provider: "claude-code",
        toolchain: "node",
        toolchainVersion: null,
        workerImageRef: null,
      }),
    ).toBe(CLAUDE_IMAGE);
  });

  it("constructs with only the Claude Code images and still rejects a mutable Claude image", async () => {
    const claudeOnly = await harness(
      {},
      IMAGE,
      new InMemoryCodingRunObserver(),
      { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE },
      { workerImage: undefined },
    );
    expect(claudeOnly.executor).toBeInstanceOf(ContainerExecutor);
    await expect(
      harness(
        {},
        IMAGE,
        new InMemoryCodingRunObserver(),
        { workerImage: "claude:latest", toolImage: CLAUDE_TOOL_IMAGE },
        { workerImage: undefined },
      ),
    ).rejects.toThrow("coding_worker_image_invalid");
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
          repoAccess: gateWith().gate,
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

describe("jobSpec without a Codex worker image", () => {
  it("refuses a Codex run with no snapshotted image before launching", async () => {
    const { executor, jobs, store } = await harness(
      { workerImage: null },
      IMAGE,
      new InMemoryCodingRunObserver(),
      undefined,
      {
        workerImage: undefined,
      },
    );
    await executor.start("run-1");
    expect(jobs.lastSpec).toBeUndefined();
    expect(store.run.status).not.toBe("running");
    // Persisted as a configuration (preflight) failure; the log carries the real code.
    expect((store.terminations[0] as { error: string }).error).toMatch(/^coding_failure_preflight:/);
    expect(logged.some((entry) => String(entry.payload.reason).includes("coding_provider_not_configured:codex"))).toBe(
      true,
    );
  });

  it("launches a Codex run with its snapshotted image", async () => {
    const byo = `registry.example/byo@sha256:${"e".repeat(64)}`;
    const { executor, jobs } = await harness({ workerImage: byo }, IMAGE, new InMemoryCodingRunObserver(), undefined, {
      workerImage: undefined,
    });
    await executor.start("run-1");
    expect(jobs.lastSpec?.image).toBe(byo);
  });
});

describe("collection exclusions", () => {
  it("passes the run's collection exclusions to the job spec", async () => {
    const created = await harness({ collectExclude: ["web/dist"] });
    await created.executor.start("run-1");
    expect(created.jobs.lastSpec?.collectExclude).toEqual({
      names: expect.arrayContaining(["node_modules", ".venv"]),
      paths: ["web/dist"],
    });
  });
});

describe("failure diagnostics", () => {
  it("logs the real reason and cause chain next to the diagnostic id the run persists", async () => {
    const created = await harness();
    const token = `ghp_${"a".repeat(36)}`;
    created.vcs.prepareWorkspace = () => {
      // The shape that hid this bug: an opaque outer message whose real cause
      // (and a credential in it) only lives on `cause`.
      throw new Error("github_api_unavailable", { cause: new Error(`fetch failed for ${token}`) });
    };

    await created.executor.start("run-1");

    // Exactly the live symptom this bug produced: refused before launch.
    expect(created.store.run.status).toBe("refused");
    const persisted = (created.store.terminations[0] as { error: string }).error;
    const diagnosticId = persisted.split(":")[1];
    expect(diagnosticId).toMatch(/^coding_diag_/);

    const warning = logged.find((entry) => entry.level === "warn" && entry.payload.diagnosticId === diagnosticId);
    expect(warning, "the failure must be logged against the same diagnostic id").toBeDefined();
    const reason = String(warning?.payload.reason);
    expect(reason).toContain("github_api_unavailable");
    expect(reason).toContain("fetch failed");
    // The reason is an operator log line, not the agent-facing error: it may
    // not carry a credential that happened to land in an error message.
    expect(reason).not.toContain(token);
    expect(reason).toContain("[REDACTED]");
    expect(JSON.stringify(logged)).not.toContain(token);
  });

  it.each([
    ["github_pull_request_not_draft", "github"],
    ["github_api_error:422:ABCD", "github"],
    ["github_api_unavailable", "github"],
    ["vcs_head_ref_conflict", "workspace"],
    ["git_push_failed", "workspace"],
    ["vcs_protected_path:CODEOWNERS", "protected_path"],
    ["vcs_protected_path_invalid", "workspace"],
    ["local_branch_conflict: the branch moved in the local repository since the run started", "workspace"],
    ["local_repo_not_allowed: repository is outside the configured local roots", "workspace"],
    ["local_ref_not_found: branch wardby/run-1 does not exist in the local repository", "workspace"],
    [
      "vcs_github_not_configured: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY to run coding agents on GitHub repositories",
      "preflight",
    ],
  ])("categorizes a post-push %s failure by its prefix, as %s", async (message, category) => {
    // A GitHub API failure after the push used to be reported as
    // "workspace": the category substring-matched "git" in "github_".
    const created = await harness();
    created.vcs.finalizeChanges = async () => {
      throw new Error(message);
    };

    await created.executor.start("run-1");

    expect(created.store.run.status).toBe("failed");
    const persisted = (created.store.terminations.at(-1) as { error: string }).error;
    expect(persisted).toMatch(new RegExp(`^coding_failure_${category}:coding_diag_`));
    expect(created.observer.events.find((event) => event.stage === "terminal")).toMatchObject({
      outcome: "failed",
      failureCategory: category,
    });
  });

  it.each(["docker_tool_runner_not_ready", "kubernetes_tool_runner_failed", "kubernetes_tool_runner_unready"])(
    "files a Claude tool runner that failed to start (%s) under the same category on both launchers",
    async (message) => {
      const created = await harness();
      created.jobs.launchError = new Error(message);

      await created.executor.start("run-1");

      expect(created.store.run.status).toBe("failed");
      expect(created.observer.events.find((event) => event.stage === "terminal")).toMatchObject({
        outcome: "failed",
        failureCategory: "job",
      });
    },
  );

  it("logs which output-schema fields a failed worker rejected, next to the diagnostic id", async () => {
    const created = await harness();
    created.jobs.statusValue = { state: "failed" };
    created.jobs.result = {
      exitCode: 1,
      reason: "failed",
      diagnostic: "coding_output_invalid",
      diagnosticIssues: ["tag:invalid_string", "tests.0.command:custom"],
    };

    await created.executor.start("run-1");

    expect(created.store.run.status).toBe("failed");
    const persisted = (created.store.terminations[0] as { error: string }).error;
    // The persisted, agent-facing error stays opaque; only the operator log names the fields.
    expect(persisted).not.toContain("tag");
    const warning = logged.find(
      (entry) => entry.level === "warn" && entry.payload.diagnosticId === persisted.split(":")[1],
    );
    expect(String(warning?.payload.reason)).toContain("job_coding_output_invalid");
    expect(warning?.payload.issues).toEqual(["tag:invalid_string", "tests.0.command:custom"]);
  });

  it("does not raise operator signal when a run is cancelled on purpose", async () => {
    const created = await harness();

    await created.executor.stop("run-1");

    expect(created.store.run.status).toBe("cancelled");
    // A user asking to stop is not a failure: the diagnostic id is still
    // logged (an operator may have to correlate it), but never at warn.
    expect(logged.filter((entry) => entry.level === "warn")).toEqual([]);
    const persisted = (created.store.terminations[0] as { error: string }).error;
    const line = logged.find((entry) => entry.payload.diagnosticId === persisted.split(":")[1]);
    expect(line?.level).toBe("info");
    expect(line?.message).toContain("cancelled");
  });

  it.each([
    "the request was canceled",
    "session cancelled by upstream",
    "rpc error: code = Canceled desc = context canceled",
  ])("still warns for a genuine failure whose message merely says %j", async (message) => {
    // "cancel" is routine phrasing for gRPC, Kubernetes, Docker and aborted
    // HTTP, and failureCategory substring-matches it — so cancellation must
    // come from the caller, never from the message, or these go silent.
    const created = await harness();
    created.vcs.prepareWorkspace = () => {
      throw new Error(message);
    };

    await created.executor.start("run-1");

    expect(created.store.run.status).toBe("refused");
    const warning = logged.find((entry) => entry.level === "warn");
    expect(String(warning?.payload.reason)).toContain(message);
    expect(logged.filter((entry) => entry.level === "info")).toEqual([]);
  });

  it("describeFailure keeps the cause chain, redacts token-shaped values, and stops recursing", () => {
    const token = `ghp_${"b".repeat(36)}`;
    expect(describeFailure(new Error(`boom ${token}`))).toBe("boom [REDACTED]");
    expect(describeFailure(new Error("outer", { cause: new Error("inner") }))).toBe("outer <- inner");
    expect(describeFailure("plain string")).toBe("plain string");
    expect(describeFailure({ not: "an error" })).toBe("unknown");

    let deepest: Error = new Error("bottom");
    for (let level = 0; level < 8; level += 1) deepest = new Error(`level${level}`, { cause: deepest });
    const described = describeFailure(deepest);
    expect(described.endsWith("…")).toBe(true);
    expect(described.split(" <- ").length).toBe(6);
  });
});

describe("ContainerExecutor repository authorization (H5-1/C3-2)", () => {
  it("refuses, before any clone, a run whose owner lost write access (category repo_access)", async () => {
    const { gate, asked } = gateWith("read");
    const created = await harness({ repositoryAuthorizedVia: "host_permission" }, IMAGE, undefined, undefined, {
      repoAccess: gate,
    });
    await created.executor.start("run-1");
    expect(asked).toEqual(["openai/example"]);
    expect(created.store.run.status).toBe("refused");
    expect((created.store.terminations[0] as { error: string }).error).toMatch(
      /^coding_failure_repo_access:coding_diag_/,
    );
    expect(created.vcs.prepared).toBe(0);
    expect(created.jobs.launches).toBe(0);
    expect(created.sessions.creates).toBe(0);
  });

  it("runs a grandfathered or admin-approved profile without asking GitHub", async () => {
    for (const via of ["grandfathered", "admin"]) {
      const { gate, asked } = gateWith();
      const created = await harness({ repositoryAuthorizedVia: via }, IMAGE, undefined, undefined, {
        repoAccess: gate,
      });
      await created.executor.start("run-1");
      expect(created.store.run.status, via).toBe("succeeded");
      expect(asked).toEqual([]);
    }
  });

  it("re-checks a host_permission profile and runs it when the owner still has write", async () => {
    const { gate, asked } = gateWith("maintain");
    const created = await harness({ repositoryAuthorizedVia: "host_permission" }, IMAGE, undefined, undefined, {
      repoAccess: gate,
    });
    await created.executor.start("run-1");
    expect(created.store.run.status).toBe("succeeded");
    expect(asked).toEqual(["openai/example"]);
  });

  it("re-checks the run's repository when the profile's repository changed after dispatch", async () => {
    const stale = { profileRepository: "openai/elsewhere", repositoryAuthorizedVia: "grandfathered" };
    const denied = gateWith();
    const refused = await harness(stale, IMAGE, undefined, undefined, { repoAccess: denied.gate });
    await refused.executor.start("run-1");
    expect(refused.store.run.status).toBe("refused");
    expect(refused.vcs.prepared).toBe(0);

    const allowed = gateWith("write");
    const ran = await harness(stale, IMAGE, undefined, undefined, { repoAccess: allowed.gate });
    await ran.executor.start("run-1");
    expect(ran.store.run.status).toBe("succeeded");
    expect(allowed.asked).toEqual(["openai/example"]);
  });

  it("refuses a profile that was never authorized, and one with no profile left", async () => {
    for (const overrides of [
      { repositoryAuthorizedVia: null },
      { profileRepository: null, repositoryAuthorizedVia: null },
    ]) {
      const created = await harness(overrides, IMAGE, undefined, undefined, { repoAccess: gateWith().gate });
      await created.executor.start("run-1");
      expect(created.store.run.status).toBe("refused");
      expect(created.vcs.prepared).toBe(0);
    }
  });
});

describe("ContainerExecutor in-flight repository re-checks (M-1, M-2)", () => {
  it("re-checks the owner's access right before the final push, and refuses the push if it is gone", async () => {
    let calls = 0;
    const { gate, asked } = gateWith(() => (calls++ === 0 ? "write" : "read"), { ttlMs: 0 });
    const created = await harness({ repositoryAuthorizedVia: "host_permission" }, IMAGE, undefined, undefined, {
      repoAccess: gate,
    });
    await created.executor.start("run-1");
    expect(asked).toEqual(["openai/example", "openai/example"]);
    expect(created.jobs.launches).toBe(1);
    expect(created.vcs.finalized).toBe(0);
    expect(created.store.run.status).toBe("failed");
    expect((created.store.terminations[0] as { error: string }).error).toMatch(/^coding_failure_repo_access:/);
  });

  it("pushes when the pre-push re-check passes (served from the cache)", async () => {
    const { gate, asked } = gateWith("write");
    const created = await harness({ repositoryAuthorizedVia: "host_permission" }, IMAGE, undefined, undefined, {
      repoAccess: gate,
    });
    await created.executor.start("run-1");
    expect(created.store.run.status).toBe("succeeded");
    expect(created.vcs.finalized).toBe(1);
    expect(asked).toEqual(["openai/example"]);
  });

  it("retries a transient GitHub error once for a launched run, then fails it as repo_access_unavailable", async () => {
    const { gate, asked } = gateWith(() => {
      throw new ReviewHostError("host_api_error", "github_api_error:503");
    });
    const created = await harness(
      {
        repositoryAuthorizedVia: "host_permission",
        jobHandle: { backend: "fake", id: "job-1" },
        proxySessionId: "session-1",
      },
      IMAGE,
      undefined,
      undefined,
      { repoAccess: gate },
    );
    await created.executor.start("run-1");
    expect(asked).toHaveLength(2);
    expect(created.store.run.status).toBe("failed");
    expect((created.store.terminations[0] as { error: string }).error).toMatch(
      /^coding_failure_repo_access_unavailable:/,
    );
  });

  it("does not retry before launch: a transient error refuses the run (strict)", async () => {
    const { gate, asked } = gateWith(() => {
      throw new ReviewHostError("host_api_error", "github_api_error:503");
    });
    const created = await harness({ repositoryAuthorizedVia: "host_permission" }, IMAGE, undefined, undefined, {
      repoAccess: gate,
    });
    await created.executor.start("run-1");
    expect(asked).toHaveLength(1);
    expect(created.store.run.status).toBe("refused");
    expect((created.store.terminations[0] as { error: string }).error).toMatch(/^coding_failure_repo_access:/);
  });
});

describe("normalizeCollectedLockfiles", () => {
  const lock = (resolved: string) =>
    `{\n  "packages": {\n    "node_modules/pkg": {\n      "resolved": "${resolved}"\n    }\n  }\n}\n`;
  const PROXIED = "http://wardby-proxy:8787/registry/npm/-/tarball/pkg/1.0.0";

  it("rewrites registry-proxy URLs in a Claude run's collected lockfiles", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wardby-claude-collect-"));
    roots.push(workspace);
    await writeFile(join(workspace, "package-lock.json"), lock(PROXIED));
    expect(await normalizeCollectedLockfiles("claude-code", workspace)).toEqual(["package-lock.json"]);
    expect(await readFile(join(workspace, "package-lock.json"), "utf8")).not.toContain("wardby-proxy");
  });

  it("leaves a Codex run's workspace to its driver", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "wardby-codex-collect-"));
    roots.push(workspace);
    await writeFile(join(workspace, "package-lock.json"), lock(PROXIED));
    expect(await normalizeCollectedLockfiles("codex", workspace)).toEqual([]);
    expect(await readFile(join(workspace, "package-lock.json"), "utf8")).toContain("wardby-proxy");
  });
});

describe("overrun from available room", () => {
  const claudeRun = { provider: "claude-code", model: "claude-sonnet-5", workerImage: CLAUDE_IMAGE } as const;
  const claudeImages = { workerImage: CLAUDE_IMAGE, toolImage: CLAUDE_TOOL_IMAGE };

  async function launched(overrides: Partial<ContainerRunSnapshot>, claude = false) {
    const created = await harness(overrides, IMAGE, new InMemoryCodingRunObserver(), claude ? claudeImages : undefined);
    let input: Record<string, unknown> | undefined;
    created.jobs.onLaunch = () => {
      input = JSON.parse(readFileSync(created.jobs.lastSpec!.inputArtifact, "utf8")) as Record<string, unknown>;
    };
    return { created, input: () => input! };
  }

  it("gives the Claude Code worker the run's limit as its own budget stop; the proxy session gets the grant", async () => {
    const { created, input } = await launched(
      { ...claudeRun, budgetUsd: 1, budgetBaseUsd: 1, budgetLimitUsd: 1.5 },
      true,
    );
    await created.executor.start("run-1");
    // The worker turns input.budgetUsd into the SDK's maxBudgetUsd (claude-coding-worker/sdk.ts).
    expect(input().budgetUsd).toBe(1.5);
    expect(created.sessions.lastInput?.budgetUsd).toBe(1);
  });

  it("an old run without a limit gives the worker its reservation, as before", async () => {
    const { created, input } = await launched({ ...claudeRun, budgetUsd: 1.5, budgetBaseUsd: 1 }, true);
    await created.executor.start("run-1");
    expect(input().budgetUsd).toBe(1.5);
    expect(created.sessions.lastInput?.budgetUsd).toBe(1.5);
  });

  it("asks for top-ups while the job runs, for Codex and Claude Code alike, and stops asking once refused", async () => {
    for (const provider of ["codex", "claude-code"] as const) {
      const overrides = provider === "codex" ? {} : claudeRun;
      const { created } = await launched(
        { ...overrides, budgetUsd: 1, budgetBaseUsd: 1, budgetLimitUsd: 1.5 },
        provider === "claude-code",
      );
      const asked: string[] = [];
      const answers: TopUpOutcome[] = ["not_needed", "granted", "unavailable"];
      created.store.topUpBudget = async (runId: string) => {
        asked.push(runId);
        return { outcome: answers.shift() ?? "not_needed" };
      };
      let polls = 0;
      created.jobs.status = async () => (++polls < 6 ? { state: "running" } : { state: "succeeded" });
      await created.executor.start("run-1");
      expect(asked).toEqual(["run-1", "run-1", "run-1"]);
    }
  });

  it("polls at most every second while the run is near its grant", async () => {
    const sleeps: number[] = [];
    const created = await harness(
      { budgetUsd: 1, budgetBaseUsd: 1, budgetLimitUsd: 1.5 },
      IMAGE,
      undefined,
      undefined,
      {
        pollMinMs: 4_000,
        pollMaxMs: 5_000,
        sleep: async (ms: number) => {
          sleeps.push(ms);
        },
      },
    );
    const near = [false, true, true, false];
    created.store.topUpBudget = async () => ({ outcome: "not_needed", near: near.shift() ?? false });
    let polls = 0;
    created.jobs.status = async () => (++polls < 5 ? { state: "running" } : { state: "succeeded" });
    await created.executor.start("run-1");
    expect(sleeps).toEqual([4_000, 1_000, 1_000, 1_500]);
  });

  it("never asks for a top-up for a run without a limit", async () => {
    const { created } = await launched({ budgetUsd: 1, budgetBaseUsd: 1 });
    let asked = 0;
    created.store.topUpBudget = async () => {
      asked += 1;
      return { outcome: "granted" };
    };
    let polls = 0;
    created.jobs.status = async () => (++polls < 4 ? { state: "running" } : { state: "succeeded" });
    await created.executor.start("run-1");
    expect(asked).toBe(0);
  });
});
