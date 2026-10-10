import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PrismaClient } from "#prisma";
import { withBaseCommit } from "../../coding/base-commit.js";
import { buildClaudeContext, type ClaudeContext } from "../../coding/claude-context.js";
import { normalizeCollectExclusions } from "../../coding/collect-exclude.js";
import { codingProviderForModelProvider, type CodingProvider } from "../../coding/provider.js";
import { CodingProfileSchema } from "../../coding/profile.js";
import { parseStoredServices, storedServiceNames, workerServices } from "../../coding/services/catalog.js";
import { MAX_SERVICE_DECLARATION_BYTES, SERVICE_DECLARATION_PATH } from "../../coding/services/declaration.js";
import {
  SERVICE_UNREADY_CATEGORY,
  SERVICE_UNREADY_ERROR,
  serviceUnreadyName,
  serviceUnreadySentence,
} from "../../coding/services/wording.js";
import {
  PROTECTED_PATH_CATEGORY,
  protectedPathFromError,
  protectedPathSentence,
} from "../../coding/protected-path-wording.js";
import { CONTINUATION_CLOSED_CATEGORY, CONTINUATION_CLOSED_ERROR } from "../../coding/continuation-wording.js";
import { budgetSentence } from "../../core/budget-wording.js";
import { fileSelfDefect } from "../../core/self-defects.js";
import { isTransactionUnavailable } from "../../core/dispatch.js";
import { CONTENDED_TX_MAX_WAIT_MS } from "../../core/timing.js";
import type { IssueTrackerRegistry } from "../issue-tracker/types.js";
import {
  classifyProviderFailure,
  providerClassOfCategory,
  providerSentence,
  type ProviderFailureClass,
} from "../../core/provider-wording.js";
import { logger } from "../../core/logger.js";
import { requiredLevel, type RepoAccessGate } from "../../core/repo-access.js";
import { ensurePrivateDirectory } from "../../core/private-directory.js";
import { codingRunObserver, type CodingRunObserver } from "../../coding/observability.js";
import {
  CODING_PROTOCOL_VERSION,
  CodingRunResultSchema,
  CodingTaskInputSchema,
  parseCodingAgentOutputJson,
  redactAndTruncate,
  type CodingAgentOutput,
  type CodingRunResult,
} from "../../coding/protocol.js";
import { parseStoredEntry } from "../llm/catalog-types.js";
import { resolveCodingEntry } from "../../core/run-pricing.js";
import { CODING_PROXY_ALIAS, CODING_PROXY_PORT, isImmutableDockerImage } from "../jobs/docker-isolation.js";
import { normalizeRegistryLockfiles } from "../../coding/registry/lockfiles.js";
import type { ProxyModelTerms, ProxyProtocol } from "../coding-proxy/types.js";
import type { JobHandle, JobResourceLimits, JobSpec, WorkspaceJobLauncher } from "../jobs/types.js";
import type { ContinuationOutcome, PreparedWorkspace, VcsPrepareInput, VcsProvider } from "../vcs/types.js";
import type { CodingImageSelector, ExecutionRecoveryResult, Executor, PersistedExecutionHandle } from "./types.js";
import { ISSUE_KEY, ISSUE_TRACKER_NAMES, type IssueTrackerProvider } from "../issue-tracker/types.js";
import { HEARTBEAT_TIMEOUT_MS } from "../../core/timing.js";
import { collectRelatedPullRequests } from "../../core/related-pull-requests.js";
import type { RelatedPullRequestEntry, RelatedPullRequestsInput } from "../vcs/github.js";

const containerLog = logger.child({ module: "container-executor" });

/** The input path in a spec built only to ask the launcher about capacity; never written or read. */
const CAPACITY_PROBE_INPUT = "/dev/null";
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

/**
 * Claude Code's commands run in its tool runner, which never reports back through the agent, so the
 * host rewrites registry-proxy download URLs in collected lockfiles itself (the Codex driver does it
 * in the worker). Best effort and symlink-safe (lockfiles.ts); a Codex workspace is left alone.
 */
export async function normalizeCollectedLockfiles(provider: string, workspacePath: string): Promise<string[]> {
  if (provider !== "claude-code") return [];
  return normalizeRegistryLockfiles({
    workspace: workspacePath,
    proxyBaseUrl: `http://${CODING_PROXY_ALIAS}:${CODING_PROXY_PORT}`,
  });
}

/** Columns on CodingRun recorded when a run completes, beyond its result JSON. */
export interface CodingRunRecord {
  /** The pushed branch of a run on a local repository. */
  resultBranch?: string;
  /** The commit the run started from. */
  baseSha?: string;
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
  protectedPaths: unknown;
  /** Stored per-agent collection paths; see src/coding/collect-exclude.ts. */
  collectExclude: unknown;
  /** Revision-in-place: set when this run continues another run's branch/PR. See preflight(). */
  rootCodingRunId: string | null;
  /** The issue that triggered this run (CodingRun.issueProvider/issueKey); null when none. */
  issueProvider?: string | null;
  issueKey?: string | null;
  budgetUsd: number;
  /** The agent's own per-run budget; `budgetUsd` is less when its budget group had less left. */
  agentBudgetUsd?: number;
  budgetGroupName?: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  jobHandle: JobHandle | null;
  provisioningClaim: string | null;
  proxySessionId: string | null;
  result: unknown;
  workerImage: string | null;
  /** Claude's tool-runner image, resolved at dispatch (CodingRun.toolImage); null on older rows and Codex runs. */
  toolImage?: string | null;
  workspaceDiskMb: number | null;
  /** Admin-requested debug trace, fixed at dispatch (CodingRun.debugTrace). */
  debugTrace?: boolean;
  /** Claude Code turn limit, fixed at dispatch (CodingRun.maxTurns); null = the worker default. */
  maxTurns?: number | null;
  /** Load the repo's agent skills, fixed at dispatch (CodingRun.repoSkills); absent on older snapshots = true. */
  repoSkills?: boolean;
  /** Claude Code loading mode, fixed at dispatch (CodingRun.claudeBareMode); absent on older snapshots = true. */
  claudeBareMode?: boolean;
  /** Coding-run services resolved at dispatch (CodingRun.services); parsed with parseStoredServices. */
  services?: unknown;
  /** The terminal failure category, once the run has one (CodingRun.failureCategory). */
  failureCategory?: string | null;
  /** The agent's CURRENT coding-profile repository (null if the profile is gone); may differ from `repository`. */
  profileRepository: string | null;
  /** How the profile's repository was authorized (CodingAgentProfile.repositoryAuthorizedVia). */
  repositoryAuthorizedVia: string | null;
  /** The run's catalog entry recorded at dispatch (Run.pricingSnapshot); null on runs from before the catalog. */
  pricingVersion: string | null;
  pricingSnapshot: unknown;
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
  /**
   * Puts a pending, unclaimed run in the coding queue (sets CodingRun.queuedAt if unset), for a run
   * the cluster has no room for yet. drainCodingQueue retries it when a run ends and on each
   * scheduler tick, until CODING_QUEUE_TIMEOUT_SEC.
   */
  markQueued?(runId: string): Promise<void>;
  persistHandle(runId: string, claimId: string, handle: JobHandle): Promise<void>;
  heartbeat(runId: string): Promise<void>;
  /**
   * The pull requests already opened for the same request as this run (same
   * top-level run tree or tracked issue), in dispatch order, for the new PR's
   * Related pull requests section. Optional: without it no section is written.
   */
  relatedPullRequests?(runId: string): Promise<RelatedPullRequestEntry[]>;
  complete(
    runId: string,
    status: "succeeded" | "budget_exhausted",
    result: CodingRunResult,
    record?: CodingRunRecord,
  ): Promise<void>;
  terminate(
    runId: string,
    status: "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled",
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
    private readonly options: {
      maxConcurrent?: number;
      /** Configured issue trackers: a coding run this store ends failed/lost/budget_exhausted files a self-defect. */
      issueTrackers?: IssueTrackerRegistry;
    } = {},
  ) {}

  /** Best effort (bounded, never throws): only called by the write that made the row terminal, so it files once. */
  private async selfDefect(run: {
    id: string;
    agentId: string;
    status: string;
    error: string | null;
    finishedAt: Date;
  }) {
    if (this.hasTrackers) await fileSelfDefect(this.db, this.options.issueTrackers, run);
  }

  /** An empty registry (no Jira site configured) means no self-defect queries at all. */
  private get hasTrackers(): boolean {
    return Object.values(this.options.issueTrackers ?? {}).some(Boolean);
  }

  async load(runId: string): Promise<ContainerRunSnapshot | null> {
    const row = await this.db.run.findUnique({
      where: { id: runId },
      include: {
        agent: { include: { codingProfile: true, budgetGroup: { select: { name: true } } } },
        codingRun: { include: { proxySession: true } },
      },
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
      protectedPaths: row.codingRun.protectedPaths,
      collectExclude: row.codingRun.collectExclude,
      rootCodingRunId: row.codingRun.rootCodingRunId,
      issueProvider: row.codingRun.issueProvider,
      issueKey: row.codingRun.issueKey,
      budgetUsd: Number(row.codingRun.budgetReservedUsd),
      agentBudgetUsd: Number(row.agent.budgetUsd),
      budgetGroupName: row.agent.budgetGroup?.name ?? null,
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
      toolImage: row.codingRun.toolImage,
      workspaceDiskMb: row.codingRun.workspaceDiskMb,
      debugTrace: row.codingRun.debugTrace,
      maxTurns: row.codingRun.maxTurns,
      repoSkills: row.codingRun.repoSkills,
      claudeBareMode: row.codingRun.claudeBareMode,
      services: row.codingRun.services,
      failureCategory: row.codingRun.failureCategory,
      profileRepository: row.agent.codingProfile?.repository ?? null,
      repositoryAuthorizedVia: row.agent.codingProfile?.repositoryAuthorizedVia ?? null,
      pricingVersion: row.pricingVersion,
      pricingSnapshot: row.pricingSnapshot,
    };
  }

  async relatedPullRequests(runId: string): Promise<RelatedPullRequestEntry[]> {
    const group = await collectRelatedPullRequests(this.db, runId);
    // Every PR of the request so far, merged/closed ones included (listed as context).
    return group.pullRequests.map((pr) => ({
      repository: pr.repository,
      number: pr.number,
      ...(pr.state ? { state: pr.state } : {}),
    }));
  }

  async claimProvisioning(runId: string, claimId: string): Promise<ProvisioningClaim> {
    try {
      return await this.db.$transaction(
        async (tx) => {
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
        },
        { maxWait: CONTENDED_TX_MAX_WAIT_MS },
      );
    } catch (err) {
      if (err instanceof RunNoLongerActiveError) return "unavailable";
      // A burst of claims queued on the slot lock left no connection in time.
      // Nothing was claimed: wait in the coding queue (drainCodingQueue starts
      // it, oldest first) instead of failing a run that only needed to wait.
      if (isTransactionUnavailable(err)) {
        await this.markQueued(runId);
        return "queued";
      }
      throw err;
    }
  }

  async markQueued(runId: string): Promise<void> {
    await this.db.codingRun.updateMany({
      where: { runId, jobBackend: null, jobHandle: null, queuedAt: null, run: { status: "pending" } },
      data: { queuedAt: new Date() },
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

  async complete(
    runId: string,
    status: "succeeded" | "budget_exhausted",
    result: CodingRunResult,
    record: CodingRunRecord = {},
  ): Promise<void> {
    const finishedAt = new Date();
    const finished = await this.db.$transaction(async (tx) => {
      const run = await tx.run.findUnique({ where: { id: runId }, include: { codingRun: true } });
      if (!run?.codingRun) throw new Error("coding_run_not_found");
      if (TERMINAL_STATUSES.has(run.status)) {
        if (run.codingRun.result && stableJson(run.codingRun.result) === stableJson(result)) return null;
        throw new Error("coding_run_terminal_conflict");
      }
      await tx.codingRun.update({
        where: { runId },
        data: {
          result,
          resultSchema: CODING_PROTOCOL_VERSION,
          ...(record.resultBranch ? { resultBranch: record.resultBranch } : {}),
          ...(record.baseSha ? { baseSha: record.baseSha } : {}),
        },
      });
      await tx.run.update({
        where: { id: runId },
        data: {
          status,
          finalText: result.summary,
          finishedAt,
          heartbeatAt: new Date(),
          error: null,
        },
      });
      return { id: runId, agentId: run.agentId };
    });
    if (finished && status === "budget_exhausted") {
      await this.selfDefect({ ...finished, status, error: null, finishedAt });
    }
  }

  async terminate(
    runId: string,
    status: "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled",
    error: string,
    audit?: CodingFailureAudit,
  ): Promise<void> {
    const finishedAt = new Date();
    const agentId = await this.db.$transaction(async (tx) => {
      const updated = await tx.run.updateMany({
        where: { id: runId, status: { in: ["pending", "running"] } },
        data: { status, error, finishedAt, heartbeatAt: new Date() },
      });
      if (!updated.count) return null;
      if (audit) {
        await tx.codingRun.update({
          where: { runId },
          data: { failureCategory: audit.failureCategory, diagnosticId: audit.diagnosticId },
        });
      }
      if (!this.hasTrackers) return null;
      const row = await tx.run.findUnique({ where: { id: runId }, select: { agentId: true } });
      return row?.agentId ?? null;
    });
    // After commit, so the failure category is readable; cancelled/refused are skipped inside fileSelfDefect.
    if (agentId) await this.selfDefect({ id: runId, agentId, status, error, finishedAt });
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
    /** The run's catalog entry; the proxy prices and shapes the run's requests from it. */
    terms?: ProxyModelTerms;
  }): Promise<{ id: string; capability: string }>;
  cancelSession(sessionId: string): Promise<void>;
  /** Whether the proxy refused a request of this session for budget. */
  budgetExhausted?(sessionId: string): Promise<boolean>;
  /** The code of the first model-provider failure the proxy relayed for this session, if any. */
  upstreamFailure?(sessionId: string): Promise<string | null>;
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
  /**
   * The Codex worker for the "node" toolchain (CODING_WORKER_IMAGE). Optional on a Claude-only
   * deployment: a Codex run without an agent BYO image is then refused with
   * coding_provider_not_configured:codex, as Claude Code is without its images.
   */
  workerImage?: string;
  /** Additional toolchains beyond the "node" baseline (workerImage). Keyed by toolchain, then version. */
  additionalWorkerImages?: Record<string, Record<string, string>>;
  credentialRef: string;
  claudeWorkerImage?: string;
  claudeToolRunnerImage?: string;
  /**
   * Claude tool-runner images for toolchains beyond the "node" baseline (claudeToolRunnerImage),
   * keyed by toolchain, then version -- the same shape as additionalWorkerImages. Claude's agent
   * image is the same for every toolchain; only the tool runner, which runs the commands, differs.
   */
  claudeToolRunnerImages?: Record<string, Record<string, string>>;
  anthropicCredentialRef?: string;
  limits: JobResourceLimits;
  /** Operator ceiling (MiB) on CodingRun.workspaceDiskMb; see coding_workspace_disk_exceeds_limit in jobSpec. */
  maxDiskMb: number;
  pollMinMs?: number;
  pollMaxMs?: number;
  /** How often to beat the heartbeat during a long launch; defaults to a third of the reconciler's timeout. */
  heartbeatIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  observer?: CodingRunObserver;
  /**
   * Called after a run this process executed reaches a terminal status,
   * so a waiting run can take the freed concurrency slot right away rather
   * than on the next scheduler tick. Never called for a run that was queued.
   */
  onSlotReleased?: () => void;
  /**
   * Loads this run's RegistryFetch ledger (composition.ts wires the Prisma
   * query) so finalizeChanges can surface installed/refused packages in the
   * PR body. Optional so tests and non-registry deployments can omit it;
   * a rejection is swallowed and treated as "nothing to report" since a
   * reporting failure must never fail the run itself.
   */
  registryReport?: (runId: string) => Promise<RegistryReport>;
  /** Browse URL for an issue of a tracker provider (composition wires the issue-tracker registry); undefined when unconfigured. */
  issueUrl?: (provider: string, key: string) => string | undefined;
  /**
   * Repository authorization: every run is checked, before its workspace is
   * prepared, against the agent owner's current GitHub access (or a recorded
   * admin/grandfathered approval of this exact repository).
   */
  repoAccess: RepoAccessGate;
}

/** A run's deduplicated served packages and refusals (see summarizeRegistryFetches). */
export interface RegistryReport {
  packages: Array<{ ecosystem: string; name: string; version: string }>;
  packageRefusals: Array<{ ecosystem: string; name: string; reason: string }>;
}

class PreflightError extends Error {}

/** A refusal by repository authorization; its message is the failure category's prefix (repo_access_*). */
class RepoAccessError extends PreflightError {}

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
    if (options.workerImage !== undefined && !isImmutableDockerImage(options.workerImage)) {
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
    for (const versions of Object.values(options.claudeToolRunnerImages ?? {})) {
      for (const image of Object.values(versions)) {
        if (!isImmutableDockerImage(image)) throw new Error("coding_worker_image_invalid");
      }
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
    const failure = this.failure("cancelled", { cancelled: true });
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
        // No room in the cluster yet (the namespace quota): wait in the queue rather than claim a
        // slot and then fail when the API server refuses the job.
        if (!(await this.fitsCluster(run))) return;
        claimId = randomUUID();
        // "queued": every slot is taken; the run stays pending and
        // drainCodingQueue starts it when one frees. "unavailable": another
        // process owns provisioning, or the run is no longer active.
        if ((await this.options.store.claimProvisioning(runId, claimId)) !== "claimed") return;
      }
      // A launched run (recovered after a restart) is in flight: a transient
      // host error is retried once before it is stopped.
      await this.authorizeRepository(run, { inFlight: Boolean(handle) });
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
          terms: this.modelTerms(run),
        });
        spendEnabled = true;
        sessionId = session.id;
        this.options.capabilities.set(runId, session.capability);
        const inputArtifact = await this.writeInput(run, deadlineAt, workspace);
        const beforeLaunch = await this.requireCurrent(runId);
        if (TERMINAL_STATUSES.has(beforeLaunch.status)) throw new Error("coding_run_no_longer_active");
        const spec = this.jobSpec(run, inputArtifact);
        // Backends whose handle is derivable (Kubernetes) persist it first, so a crash between the
        // launch and the write still leaves a handle `abandon()` can stop and remove the run with.
        const planned = this.options.jobs.plannedHandle?.(spec);
        if (planned) await this.options.store.persistHandle(runId, claimId!, planned);
        handle = await this.whileHeartbeating(runId, () => this.options.jobs.launch(spec));
        if (planned && (planned.backend !== handle.backend || planned.id !== handle.id)) {
          throw new Error("coding_job_handle_mismatch");
        }
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
      const outOfBudget = spendEnabled && (await this.outOfBudget(sessionId));
      const status = outOfBudget
        ? "budget_exhausted"
        : !spendEnabled && error instanceof PreflightError
          ? "refused"
          : "failed";
      const failure = outOfBudget ? this.budgetFailure(error) : this.failure(error);
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
      // A service sidecar that never became ready (kubernetes.ts waitForKeeper) is named on the host.
      const unreadyService = outOfBudget ? null : serviceUnreadyName(error);
      const protectedPath = outOfBudget ? null : protectedPathFromError(error);
      if (workspace) {
        await this.options.vcs.cleanup(workspace).catch(() => undefined);
        await this.options.vcs.notifyContinuationFinished?.(workspace, outOfBudget ? "budget_exhausted" : "failed", {
          agentName: run.agentName,
          ...(outOfBudget ? { budgetSentence: this.budgetSentence(run) } : {}),
          ...(unreadyService ? { serviceSentence: serviceUnreadySentence([unreadyService]) } : {}),
          ...(protectedPath ? { protectedPathSentence: protectedPathSentence(protectedPath) } : {}),
        });
      }
      this.emit({ stage: "cleanup", runId, jobId: handle?.id, cleanupSucceeded: true });
    }
  }

  /**
   * Runs `work` while keeping the run's heartbeat fresh.
   *
   * `jobs.launch` is one long await that legitimately takes minutes on a real
   * cluster — the pod cannot be scheduled until an autoscaler has created a node
   * for it — and nothing inside it beats the heartbeat. Meanwhile the reconciler
   * sweeps any run whose heartbeat is older than HEARTBEAT_TIMEOUT_MS and
   * declares it lost, which deletes the job out from under the launch that is
   * still running. The launch then fails on its own pod having vanished, so a
   * single healthy run produces two failures and neither names the real cause.
   *
   * Measured on GKE Autopilot (2026-09-23): a scheduled run whose pod was
   * waiting on a cold gVisor node pool was declared lost at exactly 60s, and the
   * launch it had interrupted failed 32s later with
   * `kubernetes_isolation_unsupported:timeout`. This never appeared on kind,
   * where a pod is scheduled in seconds and the heartbeat gap stays well inside
   * the timeout. The gap is what is wrong, not the timeout: a run that is
   * provisioning IS alive, and the executor is the only thing that knows it.
   *
   * Failures to beat are swallowed on purpose. A missed beat costs at worst the
   * recovery this exists to prevent, while throwing here would fail a launch
   * that is otherwise healthy.
   */
  private async whileHeartbeating<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const interval = this.options.heartbeatIntervalMs ?? Math.floor(HEARTBEAT_TIMEOUT_MS / 3);
    const timer = setInterval(() => {
      void this.options.store.heartbeat(runId).catch(() => undefined);
    }, interval);
    // Never hold the process open for a heartbeat: shutdown should not wait on one.
    timer.unref?.();
    try {
      return await work();
    } finally {
      clearInterval(timer);
    }
  }

  /**
   * The run may use its repository only if the agent's current owner still
   * has write on it, or the profile's approval (admin or grandfathered)
   * covers exactly this repository. A profile changed since dispatch no
   * longer covers the run's repository, so that falls back to the owner's
   * access. Throws RepoAccessError (refused before anything is cloned).
   */
  private async authorizeRepository(run: ContainerRunSnapshot, opts: { inFlight: boolean }): Promise<void> {
    const sameRepository = run.profileRepository !== null && run.profileRepository === run.repository;
    const decision = await this.options.repoAccess.authorizeUse({
      ownerId: run.ownerId,
      provider: "github",
      repository: run.repository,
      required: requiredLevel("coding"),
      authorizedVia: sameRepository ? run.repositoryAuthorizedVia : "host_permission",
      retryTransient: opts.inFlight,
    });
    if (!decision.ok) throw new RepoAccessError(`repo_access_${decision.reason}`);
  }

  /** The originating issue for the PR title/body: control-plane data from the CodingRun row, key re-validated. */
  private issueFor(run: ContainerRunSnapshot): { issue?: { key: string; url?: string; trackerName?: string } } {
    const { issueProvider, issueKey } = run;
    if (!issueProvider || !issueKey || !ISSUE_KEY.test(issueKey)) return {};
    let url: string | undefined;
    try {
      url = this.options.issueUrl?.(issueProvider, issueKey);
    } catch {
      url = undefined;
    }
    const trackerName = Object.hasOwn(ISSUE_TRACKER_NAMES, issueProvider)
      ? ISSUE_TRACKER_NAMES[issueProvider as IssueTrackerProvider]
      : undefined;
    return {
      issue: {
        key: issueKey,
        ...(url?.startsWith("https://") ? { url } : {}),
        ...(trackerName ? { trackerName } : {}),
      },
    };
  }

  /** The new PR's Related pull requests input: earlier PRs of the same request, then this one. Never throws. */
  private async relatedFor(run: ContainerRunSnapshot): Promise<{ related?: RelatedPullRequestsInput }> {
    // A continuation pushes onto an existing PR, whose body is never rewritten here.
    if (run.rootCodingRunId || !this.options.store.relatedPullRequests) return {};
    try {
      const earlier = await this.options.store.relatedPullRequests(run.runId);
      if (earlier.length === 0) return {};
      const { issue } = this.issueFor(run);
      return {
        related: {
          entries: [...earlier, { repository: run.repository, self: true }],
          ...(issue ? { issue } : {}),
        },
      };
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not list the request's related pull requests");
      return {};
    }
  }

  /** The run's stored model terms; a run from before the catalog resolves them from the current catalog. */
  private modelTerms(run: ContainerRunSnapshot): ProxyModelTerms {
    if (run.provider !== "codex" && run.provider !== "claude-code") throw new Error("coding_provider_unsupported");
    const stored = parseStoredEntry(run.pricingSnapshot);
    if (stored && run.pricingVersion) {
      if (stored.modelId !== run.model || codingProviderForModelProvider(stored.provider) !== run.provider) {
        throw new Error("coding_run_pricing_mismatch");
      }
      return { version: run.pricingVersion, entry: stored };
    }
    const entry = resolveCodingEntry(run.provider, run.model);
    return { version: entry.priceVersion, entry: parseStoredEntry(entry)! };
  }

  private preflight(run: ContainerRunSnapshot): VcsPrepareInput {
    try {
      if (run.status !== "pending" && run.status !== "running") throw new Error("coding_run_status_invalid");
      if (run.agentKind !== "coding" || !run.ownerId) throw new Error("coding_run_ownership_invalid");
      this.modelTerms(run);
      if (!Number.isFinite(run.budgetUsd) || run.budgetUsd <= 0 || run.costUsd > run.budgetUsd) {
        throw new Error("coding_run_budget_invalid");
      }
      const profile = CodingProfileSchema.parse({
        provider: run.provider,
        repository: run.repository,
        baseRef: run.baseRef,
        defaultTask: null,
        timeoutSec: run.timeoutSec,
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
        collectExclude: [...normalizeCollectExclusions(run.collectExclude).paths],
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
    // "failed" and is only flipped right before a success or out-of-budget return.
    let outcome: ContinuationOutcome = "failed";
    let finishedSummary: string | undefined;
    // Set when a failed job's session relayed a model-provider failure; names it on the host.
    // Only a failed job: a transient provider error the worker retried past did not end the run.
    let providerClass: ProviderFailureClass | undefined;
    // Set when finalizeChanges refused the collected diff for touching a protected path; names it on the host.
    let protectedPath: string | undefined;
    try {
      if (jobState !== "succeeded") {
        const collected = await this.options.jobs.collect(handle).catch(() => null);
        const reason = collected?.diagnostic ?? collected?.reason ?? jobState;
        this.emit({ stage: "collected", runId: run.runId, jobId: handle.id });
        // The worker usually fails outright when the proxy refuses a model
        // request for budget; the session records that refusal.
        if (await this.outOfBudget(sessionId)) {
          const failure = this.budgetFailure(`job_${reason}`, { issues: collected?.diagnosticIssues });
          await this.options.store.terminate(run.runId, "budget_exhausted", failure.error, failure.audit);
          this.terminal(run, "budget_exhausted", failure.audit);
          outcome = "budget_exhausted";
          return;
        }
        const status = jobState === "lost" ? "lost" : "failed";
        const provider = status === "failed" ? await this.providerFailure(sessionId) : null;
        const failure = provider
          ? this.providerFailureOf(run, provider, `job_${reason}`, { issues: collected?.diagnosticIssues })
          : this.failure(`job_${reason}`, { issues: collected?.diagnosticIssues });
        providerClass = provider?.class;
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
        outcome = "budget_exhausted";
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
      await normalizeCollectedLockfiles(current.provider, workspace.workspacePath);
      current = await this.requireCurrent(run.runId);
      if (current.costUsd > current.budgetUsd) {
        this.emit({ stage: "budget_cutoff", runId: run.runId, jobId: handle.id });
        await this.options.store.complete(
          run.runId,
          "budget_exhausted",
          this.resultFor(output, current, "budget_exhausted"),
        );
        this.terminal(current, "budget_exhausted");
        outcome = "budget_exhausted";
        return;
      }
      // One more (usually cached) check right before anything is pushed: access
      // revoked while the run was working stops the push.
      await this.authorizeRepository(current, { inFlight: true });
      const report = await this.loadRegistryReport(run.runId);
      const finalized = await this.options.vcs.finalizeChanges(workspace, {
        summary: output.summary,
        tests: output.tests,
        tag: output.tag,
        ...report,
        ...this.issueFor(current),
        ...(await this.relatedFor(current)),
      });
      // A pushed branch (local repository) is a successful run with no pull
      // request; its branch is recorded on the run for the operator to merge.
      const result = this.resultFor(output, current, finalized.outcome, finalized);
      await this.options.store.complete(run.runId, "succeeded", result, {
        baseSha: finalized.baseCommit,
        ...(finalized.outcome === "branch_pushed" ? { resultBranch: finalized.headRef } : {}),
      });
      if (
        finalized.outcome === "pull_request_opened" ||
        finalized.outcome === "pull_request_updated" ||
        finalized.outcome === "branch_pushed"
      ) {
        this.emit({ stage: finalized.outcome, runId: run.runId, jobId: handle.id });
      }
      this.terminal(current, "succeeded");
      outcome = "succeeded";
      finishedSummary = output.summary;
    } catch (error) {
      if (await this.outOfBudget(sessionId)) {
        const failure = this.budgetFailure(error);
        await this.options.store.terminate(run.runId, "budget_exhausted", failure.error, failure.audit);
        this.terminal(run, "budget_exhausted", failure.audit);
        outcome = "budget_exhausted";
      } else {
        const failure = this.failure(error);
        await this.options.store.terminate(run.runId, "failed", failure.error, failure.audit);
        this.terminal(run, "failed", failure.audit);
        protectedPath = protectedPathFromError(error) ?? undefined;
      }
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
          ...(outcome === "budget_exhausted" ? { budgetSentence: this.budgetSentence(run) } : {}),
          ...(outcome === "failed" && providerClass ? { providerSentence: providerSentence(providerClass) } : {}),
          ...(outcome === "failed" && protectedPath
            ? { protectedPathSentence: protectedPathSentence(protectedPath) }
            : {}),
        });
      }
      await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
      this.emit({ stage: "cleanup", runId: run.runId, jobId: handle.id, cleanupSucceeded: true });
    }
  }

  /** The package report is informational: any failure loading it (a
   *  rejection, a synchronous throw, or a malformed result) yields no
   *  package section rather than failing finalization. */
  private async loadRegistryReport(
    runId: string,
  ): Promise<{ packages?: RegistryReport["packages"]; packageRefusals?: RegistryReport["packageRefusals"] }> {
    try {
      const report = await this.options.registryReport?.(runId);
      const packages = Array.isArray(report?.packages) ? report.packages : [];
      const packageRefusals = Array.isArray(report?.packageRefusals) ? report.packageRefusals : [];
      return {
        ...(packages.length > 0 ? { packages } : {}),
        ...(packageRefusals.length > 0 ? { packageRefusals } : {}),
      };
    } catch {
      return {};
    }
  }

  private resultFor(
    output: CodingAgentOutput,
    run: ContainerRunSnapshot,
    forcedOutcome?: CodingRunResult["outcome"],
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
        : outcome === "branch_pushed" && finalized?.outcome === "branch_pushed"
          ? { headRef: finalized.headRef, commitSha: finalized.commitSha }
          : {}),
      summary: output.summary,
      tests: output.tests,
      tag: output.tag,
      usage: { tokensIn: run.tokensIn, tokensOut: run.tokensOut, costUsd: run.costUsd },
    });
  }

  resolveCodingWorkerImage(selector: CodingImageSelector): string {
    if (selector.provider === "claude-code") {
      this.claudeToolImage(selector);
      const image = selector.workerImageRef ?? this.options.claudeWorkerImage;
      if (!image) throw new Error("coding_provider_not_configured:claude-code");
      if (!isImmutableDockerImage(image)) throw new Error("coding_worker_image_invalid");
      return image;
    }
    if (selector.provider !== "codex") {
      throw new Error(`coding_provider_unsupported:${String(selector.provider)}`);
    }
    if (selector.workerImageRef) {
      if (!isImmutableDockerImage(selector.workerImageRef)) throw new Error("coding_worker_image_invalid");
      return selector.workerImageRef;
    }
    if (selector.toolchain === "node") {
      if (!this.options.workerImage) throw new Error("coding_provider_not_configured:codex");
      return this.options.workerImage;
    }
    const versions = this.options.additionalWorkerImages?.[selector.toolchain];
    const image = selector.toolchainVersion ? versions?.[selector.toolchainVersion] : undefined;
    if (!image) {
      throw new Error(
        `No worker image for toolchain "${selector.toolchain}" version "${selector.toolchainVersion ?? "(none)"}" — refusing to guess. Add it to additionalWorkerImages.`,
      );
    }
    return image;
  }

  /** Claude's tool-runner image for the agent's toolchain, at dispatch (Executor.resolveCodingToolImage); null for Codex. */
  resolveCodingToolImage(selector: CodingImageSelector): string | null {
    return selector.provider === "claude-code" ? this.claudeToolImage(selector) : null;
  }

  /** The tool runner is what runs a Claude agent's commands, so it is what the toolchain selects. */
  private claudeToolImage(selector: CodingImageSelector): string {
    if (!this.options.claudeToolRunnerImage) throw new Error("coding_provider_not_configured:claude-code");
    const image =
      selector.toolchain === "node" && selector.toolchainVersion === null
        ? this.options.claudeToolRunnerImage
        : selector.toolchainVersion !== null
          ? this.options.claudeToolRunnerImages?.[selector.toolchain]?.[selector.toolchainVersion]
          : undefined;
    if (!image) throw new Error("coding_toolchain_unsupported:claude-code");
    if (!isImmutableDockerImage(image)) throw new Error("coding_worker_image_invalid");
    return image;
  }

  /** Coding-run services: the repository's declaration at its base ref (Executor.readCodingServiceDeclaration). */
  async readCodingServiceDeclaration(input: { repository: string; baseRef: string }): Promise<string | null> {
    if (!this.options.vcs.readRepositoryFile) return null;
    return this.options.vcs.readRepositoryFile({
      repository: input.repository,
      ref: input.baseRef,
      path: SERVICE_DECLARATION_PATH,
      maxBytes: MAX_SERVICE_DECLARATION_BYTES,
    });
  }

  /** One repository file at the run's base ref (Executor.readCodingRepositoryFile). */
  async readCodingRepositoryFile(input: {
    repository: string;
    baseRef: string;
    path: string;
    maxBytes: number;
  }): Promise<string | null> {
    if (!this.options.vcs.readRepositoryFile) return null;
    return this.options.vcs.readRepositoryFile({
      repository: input.repository,
      ref: input.baseRef,
      path: input.path,
      maxBytes: input.maxBytes,
    });
  }

  /** The job launcher decides (Kubernetes and Docker start services for both providers). */
  supportsCodingServices(provider: CodingProvider): boolean {
    return this.options.jobs.supportsServicesFor?.(provider) === true;
  }

  /** Delegates to the job launcher's own warm-up (Executor.warmUp); a no-op for a launcher without one. */
  async warmUp(): Promise<void> {
    await this.options.jobs.warmUp?.();
  }

  private async requireCurrent(runId: string): Promise<ContainerRunSnapshot> {
    const current = await this.options.store.load(runId);
    if (!current) throw new Error("coding_run_not_found");
    return current;
  }

  /**
   * False when the launcher reports this run's job would not fit the cluster right now; the run
   * is then queued and drainCodingQueue retries it. Launchers and stores without the hooks, and
   * any error, answer true: the launch stays the authority.
   */
  private async fitsCluster(run: ContainerRunSnapshot): Promise<boolean> {
    const { jobs, store } = this.options;
    if (!jobs.hasCapacityFor || !store.markQueued) return true;
    const fits = await jobs.hasCapacityFor(this.jobSpec(run, CAPACITY_PROBE_INPUT)).catch(() => true);
    if (fits) return true;
    await store.markQueued(run.runId);
    this.emit({ stage: "queued", runId: run.runId });
    return false;
  }

  private jobSpec(run: ContainerRunSnapshot, inputArtifact: string): JobSpec {
    const provider = run.provider === "claude-code" ? "claude-code" : "codex";
    if (provider === "claude-code" && (!run.workerImage || !this.options.claudeToolRunnerImage)) {
      throw new Error("coding_provider_not_configured:claude-code");
    }
    // Runs keep the image they were dispatched with; one without it needs the deployment default.
    const image = run.workerImage ?? this.options.workerImage;
    if (!image) throw new Error("coding_provider_not_configured:codex");
    if (run.workspaceDiskMb && run.workspaceDiskMb > this.options.maxDiskMb) {
      throw new Error("coding_workspace_disk_exceeds_limit");
    }
    const services = parseStoredServices(run.services);
    // Dispatch refuses services this deployment can't start; this is the backstop.
    if (services.length > 0 && !this.supportsCodingServices(provider)) {
      throw new Error("coding_services_unsupported_launcher");
    }
    return {
      kind: "coding-agent",
      runId: run.runId,
      provider,
      image,
      // A run keeps the tool image it was dispatched with; rows from before CodingRun.toolImage use the default.
      ...(provider === "claude-code" ? { toolImage: run.toolImage ?? this.options.claudeToolRunnerImage } : {}),
      inputArtifact,
      timeoutSec: run.timeoutSec,
      limits: { ...this.options.limits, ...(run.workspaceDiskMb ? { diskMb: run.workspaceDiskMb } : {}) },
      labels: {},
      collectExclude: normalizeCollectExclusions(run.collectExclude),
      ...(services.length > 0 ? { services } : {}),
    };
  }

  private credentialRef(provider: string): string {
    if (provider === "codex") return this.options.credentialRef;
    if (provider === "claude-code" && this.options.anthropicCredentialRef) return this.options.anthropicCredentialRef;
    throw new Error("coding_provider_not_configured:claude-code");
  }

  private async writeInput(run: ContainerRunSnapshot, deadlineAt: Date, workspace: PreparedWorkspace): Promise<string> {
    await ensurePrivateDirectory(this.artifactRoot);
    const rootReal = await realpath(this.artifactRoot);
    const directory = resolve(rootReal, run.runId);
    if (!directory.startsWith(`${rootReal}${sep}`)) throw new Error("coding_artifact_path_invalid");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== directory) throw new Error("coding_artifact_path_invalid");
    const destination = join(directory, "input.json");
    const temporary = join(directory, `.input-${randomUUID()}.tmp`);
    const services = parseStoredServices(run.services);
    const task = withBaseCommit(run.task, workspace.baseCommit);
    if (task === run.task && /^[0-9a-f]{40}$/.test(workspace.baseCommit)) {
      containerLog.warn(
        { event: "coding.base_commit_omitted", runId: run.runId },
        "the coding task left no room for the base commit line",
      );
    }
    // A repository context read must never fail a run ("the run never fails because of context"):
    // any fs error (an inaccessible workspace, EACCES, ...) is logged once and swallowed, leaving
    // claudeContext null, exactly as if the run had nothing to load.
    let claudeContext: ClaudeContext | null = null;
    if (run.provider === "claude-code") {
      try {
        claudeContext = await buildClaudeContext(workspace.workspacePath, { skills: run.repoSkills !== false });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        containerLog.warn(
          { event: "coding.claude_context_unavailable", runId: run.runId, ...(code ? { code } : {}) },
          "repository context could not be read; continuing without it",
        );
      }
    }
    for (const skip of claudeContext?.skipped ?? []) {
      containerLog.warn(
        { event: "coding.claude_context_skipped", runId: run.runId, path: skip.path, reason: skip.reason },
        "a repository context file was not loaded",
      );
    }
    if (claudeContext && claudeContext.skippedOverflow > 0) {
      containerLog.warn(
        { event: "coding.claude_context_skipped", runId: run.runId, overflow: claudeContext.skippedOverflow },
        "further repository context files were not loaded",
      );
    }
    const input = CodingTaskInputSchema.parse({
      schemaVersion: CODING_PROTOCOL_VERSION,
      runId: run.runId,
      repository: run.repository,
      baseRef: run.baseRef,
      headRef: run.headRef,
      task,
      model: run.model,
      budgetUsd: run.budgetUsd,
      deadlineAt: deadlineAt.toISOString(),
      continuationOf: run.rootCodingRunId ? { runId: run.rootCodingRunId } : undefined,
      // Only when true: an untraced run's input stays exactly what older workers expect.
      ...(run.debugTrace ? { debugTrace: true } : {}),
      // Only when the agent sets one: every other run's input stays exactly what older workers expect.
      ...(run.maxTurns ? { maxTurns: run.maxTurns } : {}),
      // Only when off: every other run's input stays exactly what older workers expect.
      ...(run.repoSkills === false ? { repoSkills: false } : {}),
      // Only when off: every other run's input stays exactly what older workers expect.
      ...(run.claudeBareMode === false ? { claudeBareMode: false } : {}),
      // Only when there are some: every other run's input stays exactly what older workers expect.
      ...(services.length > 0 ? { services: workerServices(services) } : {}),
      // Only when there is something to load: every other run's input stays exactly what older workers expect.
      ...(claudeContext && claudeContext.files.length > 0 ? { claudeContext: { files: claudeContext.files } } : {}),
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
    let collectExclude: string[];
    try {
      collectExclude = [...normalizeCollectExclusions(run.collectExclude).paths];
    } catch {
      return null;
    }
    return {
      runId: run.runId,
      repository: run.repository,
      baseRef: run.baseRef,
      headRef: run.headRef,
      protectedPaths: run.protectedPaths,
      collectExclude,
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
      const outcome: ContinuationOutcome =
        run.status === "succeeded" ? "succeeded" : run.status === "budget_exhausted" ? "budget_exhausted" : "failed";
      const providerClass = run.status === "failed" ? providerClassOfCategory(run.failureCategory) : null;
      const unreadyServices =
        run.status === "failed" && run.failureCategory === SERVICE_UNREADY_CATEGORY
          ? storedServiceNames(run.services)
          : null;
      // No path survives to the stored run (only the category does -- see
      // protected-path-wording.ts), so this can only ever use the pathless sentence.
      const protectedPathFailed = run.status === "failed" && run.failureCategory === PROTECTED_PATH_CATEGORY;
      await this.options.vcs.notifyContinuationFinished?.(workspace, outcome, {
        agentName: run.agentName,
        ...(outcome === "budget_exhausted" ? { budgetSentence: this.budgetSentence(run) } : {}),
        ...(providerClass ? { providerSentence: providerSentence(providerClass) } : {}),
        ...(unreadyServices ? { serviceSentence: serviceUnreadySentence(unreadyServices) } : {}),
        ...(protectedPathFailed ? { protectedPathSentence: protectedPathSentence(null) } : {}),
      });
    }
    await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
    this.emit({ stage: "cleanup", runId: run.runId, jobId: run.jobHandle?.id, cleanupSucceeded: true });
  }

  /** Whether the proxy refused this run's session for budget. Never throws. */
  private async outOfBudget(sessionId: string | null | undefined): Promise<boolean> {
    if (!sessionId || !this.options.sessions.budgetExhausted) return false;
    return this.options.sessions.budgetExhausted(sessionId).catch(() => false);
  }

  /** The model-provider failure the proxy relayed for this run's session, classified. Never throws. */
  private async providerFailure(
    sessionId: string | null | undefined,
  ): Promise<{ class: ProviderFailureClass; code: string } | null> {
    if (!sessionId || !this.options.sessions.upstreamFailure) return null;
    const code = await this.options.sessions.upstreamFailure(sessionId).catch(() => null);
    return code ? { class: classifyProviderFailure(code), code } : null;
  }

  /**
   * A failure the model provider's refusal caused. The persisted error names
   * the class only; the raw upstream code (a fixed identifier, never a message)
   * goes to one operator line an alert can key on, and the failure itself is
   * still logged under its diagnostic id.
   */
  private providerFailureOf(
    run: ContainerRunSnapshot,
    provider: { class: ProviderFailureClass; code: string },
    error: unknown,
    options: { issues?: string[] } = {},
  ): { error: string; audit: CodingFailureAudit } {
    const logged = this.failure(error, options);
    containerLog.warn(
      { event: "coding.provider_failure", runId: run.runId, class: provider.class, upstreamCode: provider.code },
      "the model provider refused this coding run's requests",
    );
    return {
      error: `coding_provider_${provider.class}`,
      audit: { failureCategory: `provider_${provider.class}`, diagnosticId: logged.audit.diagnosticId },
    };
  }

  /** The host-safe sentence for a run that ran out of budget. */
  private budgetSentence(run: ContainerRunSnapshot): string {
    return budgetSentence({
      runBudgetUsd: run.budgetUsd,
      agentBudgetUsd: run.agentBudgetUsd ?? run.budgetUsd,
      budgetGroupName: run.budgetGroupName,
    });
  }

  /**
   * A failure the proxy's budget refusal caused. The failure itself is still
   * logged under its diagnostic id, so the operator keeps the real reason.
   */
  private budgetFailure(
    error: unknown,
    options: { issues?: string[] } = {},
  ): { error: string; audit: CodingFailureAudit } {
    const logged = this.failure(error, options);
    return {
      error: "coding_budget_exhausted",
      audit: { failureCategory: "budget", diagnosticId: logged.audit.diagnosticId },
    };
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

  /**
   * `cancelled` is passed by the one caller that knows — stop(). It is never
   * inferred from the message: `failureCategory` substring-matches, and
   * "cancel"/"Canceled" is routine phrasing in gRPC, Kubernetes, Docker and
   * aborted-HTTP errors ("rpc error: code = Canceled desc = context canceled"),
   * so inferring it would silence exactly the genuine failures this log exists
   * to surface.
   */
  private failure(
    error: unknown,
    options: { cancelled?: boolean; issues?: string[] } = {},
  ): { error: string; audit: CodingFailureAudit } {
    const category = failureCategory(error);
    const diagnosticId = `coding_diag_${randomUUID()}`;
    // The persisted error is deliberately opaque (it reaches the agent owner),
    // so the operator needs the real reason somewhere: the control-plane log,
    // keyed by the same diagnostic id. Token-shaped values are redacted, and a
    // cause chain is kept because the outer message is often just a wrapper.
    // A user asking to stop is not a failure, so it gets the same id at info.
    // `issues` names only which output-schema fields failed (see SAFE_CODING_OUTPUT_ISSUE).
    const line = {
      diagnosticId,
      category,
      reason: describeFailure(error),
      ...(options.issues ? { issues: options.issues } : {}),
    };
    if (options.cancelled === true) containerLog.info(line, "coding run cancelled; the persisted error is its id only");
    else containerLog.warn(line, "coding run failed; the persisted error is the diagnostic id only");
    return { error: `coding_failure_${category}:${diagnosticId}`, audit: { failureCategory: category, diagnosticId } };
  }

  private duration(runId: string): number | undefined {
    const startedAt = this.startedAt.get(runId);
    return startedAt === undefined ? undefined : Math.max(0, this.now().getTime() - startedAt);
  }
}

/** Operator-facing failure text: the message plus its cause chain, redacted. */
export function describeFailure(error: unknown, depth = 0): string {
  if (depth > 4) return "…";
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown";
  const redacted = redactAndTruncate(message, 500);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause === undefined || cause === null ? redacted : `${redacted} <- ${describeFailure(cause, depth + 1)}`;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "unknown";
  return `coding_executor:${redactAndTruncate(message, 200).replace(/[^A-Za-z0-9_.:-]/g, "_")}`;
}

/**
 * Error-code prefixes that name their category outright, checked before the
 * substring heuristics below. Those heuristics filed every `github_*` error
 * (a failed PR lookup or create after the push, a token mint) under
 * "workspace" because "github" contains "git".
 */
const CATEGORY_BY_PREFIX: ReadonlyArray<readonly [prefix: string, category: string]> = [
  // Claude Code reached the agent's turn limit (codingProfile.maxTurns) before finishing.
  ["job_coding_turn_limit", "turn_limit"],
  // A service sidecar never became ready (src/providers/jobs/kubernetes.ts).
  [SERVICE_UNREADY_ERROR, SERVICE_UNREADY_CATEGORY],
  // Services on a launcher that can't start them: refused at dispatch, failed here as a backstop.
  ["coding_services_unsupported", "preflight"],
  // Claude Code's tool runner failed to start or never became ready: the same category on both launchers.
  ["docker_tool_runner_", "job"],
  ["kubernetes_tool_runner_", "job"],
  // Checked first: the host could not be asked (after one retry), not a lost permission.
  ["repo_access_check_unavailable", "repo_access_unavailable"],
  ["repo_access_", "repo_access"],
  ["github_", "github"],
  // Checked before the generic "vcs_" fallback: the collected diff touched a
  // path this agent may not edit, not a generic workspace/git failure.
  ["vcs_protected_path:", PROTECTED_PATH_CATEGORY],
  // A continuation whose pull request was merged or closed: nothing pushed (coding/continuation-wording.ts).
  [CONTINUATION_CLOSED_ERROR, CONTINUATION_CLOSED_CATEGORY],
  // A provider whose worker images this deployment doesn't configure (codex or claude-code): configuration.
  ["coding_provider_not_configured", "preflight"],
  // A GitHub repository on a server with no GitHub App: configuration, like an unsupported service.
  ["vcs_github_not_configured", "preflight"],
  ["vcs_", "workspace"],
  // Local repositories (LocalRepoError codes): the same family as the vcs_ errors.
  ["local_", "workspace"],
  ["git_", "workspace"],
];

/**
 * Whether `error` or something in its `cause` chain (bounded depth, in case a
 * cycle somehow formed) is -- or wraps -- an error whose own message starts
 * with `prefix`.
 */
function causeChainStartsWith(error: unknown, prefix: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    const raw = current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (raw.startsWith(prefix)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

function failureCategory(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const [prefix, category] of CATEGORY_BY_PREFIX) {
    if (raw.startsWith(prefix)) return category;
  }
  // A continuation whose pull request is no longer open can fail before a
  // session or job exists (assertContinuationOpen, called at the top of
  // prepareWorkspace) -- that failure is re-thrown as a PreflightError whose
  // own message is `safeError(error)`, a sanitized wrapper that no longer
  // starts with CONTINUATION_CLOSED_ERROR (see the `!spendEnabled && !handle`
  // branch above). The real, un-wrapped error survives on `cause`. Only this
  // one category is looked up through the cause chain this way -- every
  // other prefix above keeps matching only the top-level message, exactly as
  // before, so no other prepare-time failure's category changes here.
  if (causeChainStartsWith(error, CONTINUATION_CLOSED_ERROR)) return CONTINUATION_CLOSED_CATEGORY;
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
