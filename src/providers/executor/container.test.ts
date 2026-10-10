import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCodingRunObserver } from "../../coding/observability.js";
import { CONTINUATION_CLOSED_ERROR } from "../../coding/continuation-wording.js";
import { MAX_CODING_INPUT_BYTES } from "../../coding/protocol.js";
import type { CodingProvider } from "../../coding/provider.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";
import { createRepoAccessGate, type RepoAccessGate } from "../../core/repo-access.js";
import { shippedCatalog } from "../llm/catalog.js";
import { SHIPPED_CATALOG_VERSION } from "../llm/catalog-shipped.js";
import { entryOf } from "../llm/catalog-types.js";
import { ReviewHostError, type HostPermission } from "../review-host/types.js";
import type { JobHandle, JobResult, JobSpec, JobStatus, WorkspaceJobLauncher } from "../jobs/types.js";
import type {
  ContinuationFinishedDetails,
  ContinuationOutcome,
  FinalizeChangesDetails,
  FinalizeChangesResult,
  PreparedWorkspace,
  VcsPrepareInput,
  VcsProvider,
} from "../vcs/types.js";
import type { RelatedPullRequestEntry } from "../vcs/github.js";
import {
  ContainerExecutor,
  RunCapabilityVault,
  describeFailure,
  normalizeCollectedLockfiles,
  type CodingSessionController,
  type ContainerExecutionStore,
  type ContainerExecutorOptions,
  type ContainerRunSnapshot,
  type ProvisioningClaim,
} from "./container.js";

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
  completions: Array<{ status: string; result: unknown; record?: { resultBranch?: string; baseSha?: string } }> = [];
  terminations: unknown[] = [];
  /** Every handle written, in order, so tests can see whether one was stored before launching. */
  persistedHandles: JobHandle[] = [];
  heartbeats = 0;
  /** Answers relatedPullRequests when set; left undefined, the store has no such method behavior. */
  related?: RelatedPullRequestEntry[] | Error;
  async relatedPullRequests(): Promise<RelatedPullRequestEntry[]> {
    if (this.related instanceof Error) throw this.related;
    return this.related ?? [];
  }

  constructor(public run: ContainerRunSnapshot) {}

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

  async complete(
    runId: string,
    status: "succeeded" | "budget_exhausted",
    result: never,
    record?: { resultBranch?: string; baseSha?: string },
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
  ): Promise<void> {
    if (runId !== this.run.runId || ["succeeded", "budget_exhausted"].includes(this.run.status)) return;
    this.run.status = status;
    this.terminations.push({ status, error, ...(audit ? { audit } : {}) });
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
  notifyStartedCalls = 0;
  lastNotifyStartedAgentName?: string;
  notifyFinishedCalls: Array<{
    outcome: ContinuationOutcome;
    summary?: string;
    agentName?: string;
    budgetSentence?: string;
    serviceSentence?: string;
    protectedPathSentence?: string;
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
    outcome: ContinuationOutcome,
    details?: ContinuationFinishedDetails,
  ): Promise<void> {
    this.notifyFinishedCalls.push({
      outcome,
      summary: details?.summary,
      agentName: details?.agentName,
      ...(details?.budgetSentence ? { budgetSentence: details.budgetSentence } : {}),
      ...(details?.providerSentence ? { providerSentence: details.providerSentence } : {}),
      ...(details?.serviceSentence ? { serviceSentence: details.serviceSentence } : {}),
      ...(details?.protectedPathSentence ? { protectedPathSentence: details.protectedPathSentence } : {}),
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

    it("notifies finished with 'budget_exhausted' when the budget is exhausted", async () => {
      const created = await harness({ budgetUsd: 0.005 });
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
