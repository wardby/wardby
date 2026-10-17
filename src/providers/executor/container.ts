import { randomUUID } from "node:crypto";
import {
  isPackageAuditMode,
  mergePackageAuditReports,
  type PackageAuditEntry,
  type PackageAuditMode,
  type PackageAuditReport,
} from "../../coding/registry/audit-mode.js";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PrismaClient } from "#prisma";
import { withBaseCommit } from "../../coding/base-commit.js";
import { withPullRequestDescription } from "../../coding/pr-description-note.js";
import { withLinkedIssue, type LinkedIssueText } from "../../coding/linked-issue-note.js";
import { buildClaudeContext, MAX_RECORDED_SKIPS, type ClaudeContext } from "../../coding/claude-context.js";
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
import {
  budgetStoppedSummary,
  CONTINUATION_CLOSED_CATEGORY,
  CONTINUATION_CLOSED_ERROR,
} from "../../coding/continuation-wording.js";
import { budgetSentence, overrunSentence } from "../../core/budget-wording.js";
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
  MAX_CODING_INPUT_BYTES,
  isLocalRepository,
  parseCodingWorkerOutputJson,
  redactAndTruncate,
  restoredDependencyFolders,
  sanitizeDependencyCacheReport,
  type ClaudeContextFile,
  type CodingAgentOutput,
  type CodingRunResult,
  type CodingWorkerOutput,
  type DependencyCacheReport,
} from "../../coding/protocol.js";
import { parseStoredEntry } from "../llm/catalog-types.js";
import { resolveCodingEntry } from "../../core/run-pricing.js";
import { CODING_PROXY_ALIAS, CODING_PROXY_PORT, isImmutableDockerImage } from "../jobs/docker-isolation.js";
import { normalizeRegistryLockfiles } from "../../coding/registry/lockfiles.js";
import type { ProxyModelTerms, ProxyProtocol } from "../coding-proxy/types.js";
import {
  hostBudgetSentence,
  loadBudgetEvent,
  ownerBudgetSentence,
  proxyRefusalDetails,
  recordBudgetEvent,
  type BudgetEventView,
  type BudgetLimit,
} from "../../core/budget-events.js";
import type { JobHandle, JobResourceLimits, JobSpec, WorkspaceJobLauncher } from "../jobs/types.js";
import type {
  ContinuationOutcome,
  DescriptionWriteOutcome,
  FinalizeChangesDetails,
  PreparedWorkspace,
  VcsPrepareInput,
  VcsProvider,
} from "../vcs/types.js";
import type { CodingImageSelector, ExecutionRecoveryResult, Executor, PersistedExecutionHandle } from "./types.js";
import { ISSUE_KEY, ISSUE_TRACKER_NAMES, type IssueTrackerProvider } from "../issue-tracker/types.js";
import { HEARTBEAT_TIMEOUT_MS } from "../../core/timing.js";
import { collectRelatedPullRequests } from "../../core/related-pull-requests.js";
import {
  pullRequestBody,
  type DescriptionBaseline,
  type RelatedPullRequestEntry,
  type RelatedPullRequestsInput,
} from "../vcs/github.js";
import { closingIssueNumber, descriptionSha256 } from "../vcs/pr-description.js";

const containerLog = logger.child({ module: "container-executor" });
/** A logged context skip path is cut to this many characters: a refused import is reported as written. */
const MAX_LOGGED_SKIP_PATH_CHARS = 256;

/** The input path in a spec built only to ask the launcher about capacity; never written or read. */
const CAPACITY_PROBE_INPUT = "/dev/null";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);
const PROVISIONING_BACKEND = "provisioning";
/** The longest a no-change fix round's description refresh may hold up the run's terminal write. */
export const DESCRIPTION_REFRESH_TIMEOUT_MS = 60_000;
/** How many runs above a root coding run are searched for the mention that started it. */
const MAX_LINKED_ISSUE_RUN_DEPTH = 8;
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

/** The worker's dependency cache report, as CodingRunRecord columns: nothing on a run without one. */
function dependencyCacheRecord(output: CodingWorkerOutput): CodingRunRecord {
  return output.dependencyCache ? { dependencyCacheResult: output.dependencyCache } : {};
}

/** What a push records on the run: its base commit, and a pushed branch's name (a local repository). */
function pushedRecord(finalized: Awaited<ReturnType<VcsProvider["finalizeChanges"]>>): CodingRunRecord {
  return {
    baseSha: finalized.baseCommit,
    ...(finalized.outcome === "branch_pushed" ? { resultBranch: finalized.headRef } : {}),
  };
}

/** The PR body's dependency cache line: the folders restored from a snapshot (hit or nearest). */
function restoredDependenciesFor(output: CodingWorkerOutput): { restoredDependencies?: string[] } {
  const folders = restoredDependencyFolders(output.dependencyCache);
  return folders.length > 0 ? { restoredDependencies: folders } : {};
}

/** Columns on CodingRun recorded when a run completes, beyond its result JSON. */
export interface CodingRunRecord {
  /** The pushed branch of a run on a local repository. */
  resultBranch?: string;
  /** The commit the run started from. */
  baseSha?: string;
  /** The worker's dependency cache report (CodingWorkerOutput.dependencyCache), on a run that used it. */
  dependencyCacheResult?: DependencyCacheReport;
  /** This run's pull request description outcome (descriptionOutcomeLabel); absent = not attempted. */
  prDescriptionOutcome?: string;
  /** A fresh run that wrote its PR's description: the hash, on its own (root) row. */
  prDescriptionSha256?: string;
  /** With prDescriptionSha256: the run whose text the description carries (the fresh run itself). */
  prDescriptionRunId?: string;
}

/** The stored form of a description outcome: written, replaced, refreshed:<reason>, unchanged, edited_by_hand, skipped:<reason>. */
export function descriptionOutcomeLabel(outcome: DescriptionWriteOutcome): string {
  if (outcome.kind === "refreshed" || outcome.kind === "skipped") return `${outcome.kind}:${outcome.reason}`;
  return outcome.kind;
}

/** A local repository has no pull request: its runs get no description note and record no description outcome. */
function hasPullRequestDescription(run: { repository: string }): boolean {
  return !isLocalRepository(run.repository);
}

/**
 * What the root run of a legacy pull request (no recorded description hash)
 * stored, from which the description it wrote is rebuilt. Raw stored values:
 * the executor validates them.
 */
export interface LegacyDescriptionSource {
  repository: string;
  baseRef: string;
  headRef: string;
  /** The root run's final message (CodingRun.result.summary); absent = nothing to rebuild. */
  summary?: string;
  /** CodingRun.result.tests, as stored. */
  tests?: unknown;
  /** CodingRun.dependencyCacheResult, as stored. */
  dependencyCache?: unknown;
  issueProvider?: string | null;
  issueKey?: string | null;
}

/**
 * Where a continuation's pull request came from, to find the issue it was
 * opened for: the root run's tracker issue, and the mention status (issue or
 * pull request number) of the nearest run above the root that has one.
 */
export interface LinkedIssueSource {
  issueProvider?: string | null;
  issueKey?: string | null;
  hostStatus?: { provider: string; repository: string; number: number } | null;
}

/** An issue to read for a continuation's task. */
export type LinkedIssueRef =
  { provider: "github"; repository: string; number: number } | { provider: "jira"; key: string };

/** The longest reading the linked issue may hold up a continuation's launch. */
export const LINKED_ISSUE_READ_TIMEOUT_MS = 15_000;

/** The store's description baseline; `legacySource` only on a legacy pull request. */
export type StoredDescriptionBaseline = DescriptionBaseline & { legacySource?: LegacyDescriptionSource };

/** A fix round's description state: the baseline to update against, or that it could not be loaded. */
type DescriptionState = { baseline: DescriptionBaseline } | { failed: true } | null;

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
  /** Step in the delegating agent's declared merge order (CodingRun.mergeOrder); null = no order. */
  mergeOrder?: number | null;
  budgetUsd: number;
  /** The agent's own per-run budget; `budgetUsd` is less when its budget group had less left. */
  agentBudgetUsd?: number;
  /** The run's budget before the agent's allowed overrun (CodingRun.budgetBaseUsd); absent for older runs. */
  budgetBaseUsd?: number;
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
  /** The traced run's trace cap in MiB, fixed at dispatch (CodingRun.debugTraceMaxMb); null = the worker default. */
  debugTraceMaxMb?: number | null;
  /** Claude Code turn limit, fixed at dispatch (CodingRun.maxTurns); null = the worker default. */
  maxTurns?: number | null;
  /** Claude Code output tokens per reply, fixed at dispatch (CodingRun.maxOutputTokens); null = the worker default. */
  maxOutputTokens?: number | null;
  /** Load the repo's agent skills, fixed at dispatch (CodingRun.repoSkills); absent on older snapshots = true. */
  repoSkills?: boolean;
  /** Claude Code loading mode, fixed at dispatch (CodingRun.claudeBareMode); absent on older snapshots = true. */
  claudeBareMode?: boolean;
  /** Dependency cache, fixed at dispatch (CodingRun.dependencyCache); absent on older snapshots = false. */
  dependencyCache?: boolean;
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
  /**
   * The root run's record of the PR description wardby last wrote, for a fix
   * round's description update. Optional: without it fix rounds leave the
   * description alone.
   */
  pullRequestDescriptionBaseline?(rootRunId: string): Promise<StoredDescriptionBaseline>;
  /**
   * The runs that pushed to the root run's pull request (the root, then its
   * continuations whose result pushed, oldest first), for the cumulative
   * Packages section. Optional: without it the section lists this run's only.
   */
  pullRequestRunIds?(rootRunId: string): Promise<string[]>;
  /**
   * Where the root run's pull request came from (see LinkedIssueSource).
   * Optional: without it continuations get no issue text.
   */
  linkedIssueSource?(rootRunId: string): Promise<LinkedIssueSource>;
  /**
   * Compare-and-set of the root run's description hash and author run: writes
   * only while the root still records `expectedSha256` (null = none). False
   * when another write got there first.
   */
  recordPullRequestDescription?(input: {
    rootRunId: string;
    expectedSha256: string | null;
    sha256: string;
    agentTextRunId: string;
  }): Promise<boolean>;
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
  /**
   * Copies the proxy session's first budget refusal (CodingProxySession.budgetRefusal, written by the
   * proxy, which has no access to RunBudgetEvent) into the run's budget events, once per run, whatever
   * status the run ends with. A session that never recorded one adds nothing. Optional: without it no
   * event is written.
   */
  recordBudgetRefusal?(runId: string, sessionId: string): Promise<void>;
  /** The run's recorded budget refusal with names filled in, or null. Optional: without it no event is shown. */
  budgetEvent?(runId: string): Promise<{ event: BudgetEventView; agentName: string } | null>;
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
      mergeOrder: row.codingRun.mergeOrder,
      budgetUsd: Number(row.codingRun.budgetReservedUsd),
      agentBudgetUsd: Number(row.agent.budgetUsd),
      ...(row.codingRun.budgetBaseUsd == null ? {} : { budgetBaseUsd: Number(row.codingRun.budgetBaseUsd) }),
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
      debugTraceMaxMb: row.codingRun.debugTraceMaxMb,
      maxTurns: row.codingRun.maxTurns,
      maxOutputTokens: row.codingRun.maxOutputTokens,
      repoSkills: row.codingRun.repoSkills,
      claudeBareMode: row.codingRun.claudeBareMode,
      dependencyCache: row.codingRun.dependencyCache,
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
      ...(pr.mergeOrder !== undefined ? { mergeOrder: pr.mergeOrder } : {}),
    }));
  }

  async pullRequestDescriptionBaseline(rootRunId: string): Promise<StoredDescriptionBaseline> {
    const root = await this.db.codingRun.findUnique({
      where: { runId: rootRunId },
      select: {
        prDescriptionSha256: true,
        prDescriptionRunId: true,
        result: true,
        repository: true,
        baseRef: true,
        headRef: true,
        dependencyCacheResult: true,
        issueProvider: true,
        issueKey: true,
      },
    });
    if (!root) throw new Error("coding_run_not_found");
    // Legacy pull requests (no recorded author run) carry the root run's own text.
    const agentTextRunId = root.prDescriptionRunId ?? rootRunId;
    const source =
      agentTextRunId === rootRunId
        ? root.result
        : (await this.db.codingRun.findUnique({ where: { runId: agentTextRunId }, select: { result: true } }))?.result;
    const previousAgentText = storedSummary(source);
    const rootSummary = storedSummary(root.result);
    const legacySource: LegacyDescriptionSource | undefined =
      root.prDescriptionSha256 === null
        ? {
            repository: root.repository,
            baseRef: root.baseRef,
            headRef: root.headRef,
            ...(rootSummary !== undefined ? { summary: rootSummary } : {}),
            ...(storedField(root.result, "tests") !== undefined ? { tests: storedField(root.result, "tests") } : {}),
            ...(root.dependencyCacheResult != null ? { dependencyCache: root.dependencyCacheResult } : {}),
            issueProvider: root.issueProvider,
            issueKey: root.issueKey,
          }
        : undefined;
    return {
      recordedSha256: root.prDescriptionSha256,
      ...(previousAgentText !== undefined ? { previousAgentText } : {}),
      agentTextRunId,
      ...(legacySource ? { legacySource } : {}),
    };
  }

  async linkedIssueSource(rootRunId: string): Promise<LinkedIssueSource> {
    const root = await this.db.codingRun.findUnique({
      where: { runId: rootRunId },
      select: { issueProvider: true, issueKey: true, run: { select: { parentRunId: true } } },
    });
    if (!root) throw new Error("coding_run_not_found");
    // The mention that started the work is on the root's delegating run, or a run above it.
    let hostStatus: LinkedIssueSource["hostStatus"] = null;
    let parentRunId = root.run.parentRunId;
    for (let depth = 0; parentRunId && depth < MAX_LINKED_ISSUE_RUN_DEPTH; depth++) {
      const parent = await this.db.run.findUnique({
        where: { id: parentRunId },
        select: { parentRunId: true, hostStatus: { select: { provider: true, repository: true, number: true } } },
      });
      if (!parent) break;
      if (parent.hostStatus) {
        hostStatus = parent.hostStatus;
        break;
      }
      parentRunId = parent.parentRunId;
    }
    return { issueProvider: root.issueProvider, issueKey: root.issueKey, hostStatus };
  }

  async pullRequestRunIds(rootRunId: string): Promise<string[]> {
    const rows = await this.db.codingRun.findMany({
      where: { OR: [{ runId: rootRunId }, { rootCodingRunId: rootRunId }] },
      select: { runId: true, result: true },
      orderBy: { run: { startedAt: "asc" } },
    });
    const pushed = rows.filter((row) => {
      const outcome = storedField(row.result, "outcome");
      return outcome === "pull_request_opened" || outcome === "pull_request_updated";
    });
    // The root first, whatever the clock says.
    return [...pushed.filter((row) => row.runId === rootRunId), ...pushed.filter((row) => row.runId !== rootRunId)].map(
      (row) => row.runId,
    );
  }

  async recordPullRequestDescription(input: {
    rootRunId: string;
    expectedSha256: string | null;
    sha256: string;
    agentTextRunId: string;
  }): Promise<boolean> {
    const written = await this.db.codingRun.updateMany({
      where: { runId: input.rootRunId, prDescriptionSha256: input.expectedSha256 },
      data: { prDescriptionSha256: input.sha256, prDescriptionRunId: input.agentTextRunId },
    });
    return written.count === 1;
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
          ...(record.dependencyCacheResult ? { dependencyCacheResult: record.dependencyCacheResult } : {}),
          ...(record.prDescriptionOutcome ? { prDescriptionOutcome: record.prDescriptionOutcome } : {}),
          ...(record.prDescriptionSha256 && record.prDescriptionRunId
            ? { prDescriptionSha256: record.prDescriptionSha256, prDescriptionRunId: record.prDescriptionRunId }
            : {}),
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

  async recordBudgetRefusal(runId: string, sessionId: string): Promise<void> {
    const session = await this.db.codingProxySession.findUnique({
      where: { id: sessionId },
      select: { budgetRefusal: true },
    });
    // The proxy (a less-trusted role) wrote this: keep only well-formed amounts, model and turn.
    const refusal = proxyRefusalDetails(session?.budgetRefusal);
    if (!refusal) return;
    const existing = await this.db.runBudgetEvent.findFirst({
      where: { runId, details: { path: ["source"], equals: "proxy" } },
      select: { id: true },
    });
    if (existing) return;
    const coding = await this.db.codingRun.findUnique({ where: { runId }, select: { budgetLimitedBy: true } });
    await recordBudgetEvent(this.db, runId, (coding?.budgetLimitedBy ?? "run") as BudgetLimit, refusal);
  }

  budgetEvent(runId: string): Promise<{ event: BudgetEventView; agentName: string } | null> {
    return loadBudgetEvent(this.db, runId);
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
   * Called with the run id at the end of each terminal finish of a collected
   * job (succeeded, no change, budget, or failed), after the terminal write
   * and cleanup. It may run more than once for one run (a replayed or
   * duplicate finish), so it must be idempotent; a rejection or throw is
   * logged and never reaches the terminal path. composition.ts wires the
   * review-fix re-review here, so this executor imports no review logic.
   */
  onCodingRunTerminal?: (runId: string) => Promise<void> | void;
  /**
   * Loads this run's RegistryFetch ledger (composition.ts wires the Prisma
   * query) so finalizeChanges can surface installed/refused packages in the
   * PR body. Optional so tests and non-registry deployments can omit it;
   * a rejection is swallowed and treated as "nothing to report" since a
   * reporting failure must never fail the run itself.
   */
  registryReport?: (runId: string) => Promise<RegistryReport>;
  /**
   * Reads an issue's title and body for a continuation's task (composition
   * wires the review host's issue read and the issue tracker). Null when it
   * isn't an issue (a pull request number) or can't be found. Optional:
   * without it continuations get no issue text.
   */
  readLinkedIssue?: (ref: LinkedIssueRef) => Promise<{ title: string; body: string } | null>;
  /** Browse URL for an issue of a tracker provider (composition wires the issue-tracker registry); undefined when unconfigured. */
  issueUrl?: (provider: string, key: string) => string | undefined;
  /**
   * Repository authorization: every run is checked, before its workspace is
   * prepared, against the agent owner's current GitHub access (or a recorded
   * admin/grandfathered approval of this exact repository).
   */
  repoAccess: RepoAccessGate;
}

/** A run's deduplicated served packages and refusals (see summarizeRegistryFetches), and its package audit. */
export interface RegistryReport {
  packages: Array<{ ecosystem: string; name: string; version: string; acceptedAdvisories?: string[] }>;
  packageRefusals: Array<{ ecosystem: string; name: string; reason: string }>;
  /** The run's package audit mode (CodingRun.packageAuditMode); absent when it was off. */
  packageAuditMode?: PackageAuditMode;
  /** What the registry served only because of it (summarizePackageAudit entries). */
  packageAudit?: PackageAuditEntry[];
}

/** The part of a registry report the PR body reads. */
type LoadedRegistryReport = {
  packages?: RegistryReport["packages"];
  packageRefusals?: RegistryReport["packageRefusals"];
  packageAudit?: PackageAuditReport;
};

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
    await this.recordRefusal(runId, run.proxySessionId);
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
      await this.recordRefusal(runId, sessionId);
      const failure = outOfBudget ? await this.budgetFailure(runId, error) : this.failure(error);
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
          ...(outOfBudget ? { budgetSentence: await this.budgetSentence(run) } : {}),
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
  private issueFor(run: Pick<ContainerRunSnapshot, "issueProvider" | "issueKey">): {
    issue?: { key: string; url?: string; trackerName?: string };
  } {
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
    // A continuation's Related block is preserved from the current body (the description update keeps it).
    if (run.rootCodingRunId || !this.options.store.relatedPullRequests) return {};
    try {
      const earlier = await this.options.store.relatedPullRequests(run.runId);
      if (earlier.length === 0) return {};
      const { issue } = this.issueFor(run);
      return {
        related: {
          entries: [
            ...earlier,
            {
              repository: run.repository,
              self: true,
              ...(run.mergeOrder != null ? { mergeOrder: run.mergeOrder } : {}),
            },
          ],
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

  /**
   * `finished`: the run's job is done and only its push is left, which spends
   * nothing; such a run may have cost more than its limit (one reply can cost
   * more than its hold), and is still pushed.
   */
  private preflight(run: ContainerRunSnapshot, options: { finished?: boolean } = {}): VcsPrepareInput {
    try {
      if (run.status !== "pending" && run.status !== "running") throw new Error("coding_run_status_invalid");
      if (run.agentKind !== "coding" || !run.ownerId) throw new Error("coding_run_ownership_invalid");
      this.modelTerms(run);
      if (!Number.isFinite(run.budgetUsd) || run.budgetUsd <= 0 || (!options.finished && run.costUsd > run.budgetUsd)) {
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
    // Set with a success that spent past the run's base budget; says so on the host.
    let overrun: { overrunSentence?: string } = {};
    // Set when a failed job's session relayed a model-provider failure; names it on the host.
    // Only a failed job: a transient provider error the worker retried past did not end the run.
    let providerClass: ProviderFailureClass | undefined;
    // Set when finalizeChanges refused the collected diff for touching a protected path; names it on the host.
    let protectedPath: string | undefined;
    // Set when a run stopped at its budget still pushed its changes so far; says so on the host.
    let changesPushed: { pullRequestNumber?: number } | undefined;
    try {
      if (jobState !== "succeeded") {
        const collected = await this.options.jobs.collect(handle).catch(() => null);
        const reason = collected?.diagnostic ?? collected?.reason ?? jobState;
        this.emit({ stage: "collected", runId: run.runId, jobId: handle.id });
        // The worker usually fails outright when the proxy refuses a model
        // request for budget; the session records that refusal.
        if (await this.outOfBudget(sessionId)) {
          await this.recordRefusal(run.runId, sessionId);
          const failure = await this.budgetFailure(run.runId, `job_${reason}`, { issues: collected?.diagnosticIssues });
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
        await this.recordRefusal(run.runId, sessionId);
        await this.options.store.terminate(run.runId, status, failure.error, failure.audit);
        this.terminal(run, status, failure.audit);
        return;
      }
      const collected = await this.options.jobs.collect(handle);
      this.emit({ stage: "collected", runId: run.runId, jobId: handle.id });
      if (collected.reason !== "completed" || !collected.resultArtifact) throw new Error("coding_result_missing");
      const output = parseCodingWorkerOutputJson(collected.resultArtifact);
      if (output.runId !== run.runId) throw new Error("coding_result_run_mismatch");
      const current = this.requireActive(await this.requireCurrent(run.runId));
      // Finished work is delivered even when it cost more than the run's limit (one reply
      // can cost more than its hold); the status comment then says so (overrunDetails).
      if (output.outcome === "budget_exhausted") {
        this.emit({ stage: "budget_cutoff", runId: run.runId, jobId: handle.id });
        const kept = await this.keepStoppedChanges(run, handle, current, output, existingWorkspace);
        await this.recordRefusal(run.runId, sessionId);
        if (kept) {
          await this.options.store.complete(run.runId, "budget_exhausted", kept.result, kept.record);
          this.emit({ stage: kept.finalized.outcome, runId: run.runId, jobId: handle.id });
          this.terminal(kept.current, "budget_exhausted");
          changesPushed =
            kept.finalized.outcome === "branch_pushed" ? {} : { pullRequestNumber: kept.finalized.pullRequestNumber };
          finishedSummary = output.summary;
        } else {
          const latest = await this.requireCurrent(run.runId).catch(() => current);
          await this.options.store.complete(
            run.runId,
            "budget_exhausted",
            this.resultFor(output, latest, "budget_exhausted"),
            dependencyCacheRecord(output),
          );
          this.terminal(latest, "budget_exhausted");
        }
        outcome = "budget_exhausted";
        return;
      }
      if (output.outcome === "no_changes") {
        // Before complete: the terminal hook (a no-change fix round's re-review) reads the refreshed body.
        const description = await this.refreshDescriptionInTime(current, output, existingWorkspace);
        await this.recordRefusal(run.runId, sessionId);
        await this.options.store.complete(run.runId, "succeeded", this.resultFor(output, current), {
          ...dependencyCacheRecord(output),
          ...description,
        });
        this.terminal(current, "succeeded");
        outcome = "succeeded";
        overrun = this.overrunDetails(current);
        finishedSummary = output.summary;
        return;
      }

      const pushed = await this.pushChanges(run, handle, current, output, output.summary, existingWorkspace);
      const { finalized, workspace } = pushed;
      // An empty diff pushes nothing, so it refreshes the description the way a
      // worker no_changes does, before complete (the terminal hook reads the body).
      const description =
        finalized.outcome === "no_changes"
          ? await this.refreshDescriptionInTime(pushed.current, output, workspace)
          : await this.recordDescription(
              pushed.current,
              pushed.descriptionState,
              finalized.outcome === "pull_request_opened" || finalized.outcome === "pull_request_updated"
                ? finalized.description
                : undefined,
            );
      // A pushed branch (local repository) is a successful run with no pull
      // request; its branch is recorded on the run for the operator to merge.
      const result = this.resultFor(output, pushed.current, finalized.outcome, finalized);
      await this.recordRefusal(run.runId, sessionId);
      await this.options.store.complete(run.runId, "succeeded", result, {
        ...dependencyCacheRecord(output),
        ...pushedRecord(finalized),
        ...description,
      });
      if (finalized.outcome !== "no_changes") {
        this.emit({ stage: finalized.outcome, runId: run.runId, jobId: handle.id });
      }
      this.terminal(pushed.current, "succeeded");
      outcome = "succeeded";
      overrun = this.overrunDetails(pushed.current);
      finishedSummary = output.summary;
    } catch (error) {
      if (error instanceof Error && error.message === "coding_run_no_longer_active") {
        // Stopped while its result was collected: the stop already wrote the terminal row.
        containerLog.info({ runId: run.runId }, "coding run was stopped before its result was published");
      } else if (await this.outOfBudget(sessionId)) {
        await this.recordRefusal(run.runId, sessionId);
        const failure = await this.budgetFailure(run.runId, error);
        await this.options.store.terminate(run.runId, "budget_exhausted", failure.error, failure.audit);
        this.terminal(run, "budget_exhausted", failure.audit);
        outcome = "budget_exhausted";
      } else {
        await this.recordRefusal(run.runId, sessionId);
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
          ...(outcome === "succeeded" ? overrun : {}),
          ...(outcome === "budget_exhausted" ? { budgetSentence: await this.budgetSentence(run) } : {}),
          ...(outcome === "budget_exhausted" && changesPushed ? { changesPushed } : {}),
          ...(outcome === "failed" && providerClass ? { providerSentence: providerSentence(providerClass) } : {}),
          ...(outcome === "failed" && protectedPath
            ? { protectedPathSentence: protectedPathSentence(protectedPath) }
            : {}),
        });
      }
      await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
      this.emit({ stage: "cleanup", runId: run.runId, jobId: handle.id, cleanupSucceeded: true });
      await this.notifyTerminal(run.runId);
    }
  }

  /**
   * Pushes a finished job's changes: copies the job's workspace into the run's,
   * then, right before finalizeChanges pushes, checks again that the owner still
   * has access and that the run was not stopped meanwhile. Shared by a finished
   * run and one stopped at its budget; throws whatever stops the push.
   */
  private async pushChanges(
    run: ContainerRunSnapshot,
    handle: JobHandle,
    collectedFor: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    summary: string,
    existingWorkspace: PreparedWorkspace | null | undefined,
  ): Promise<{
    current: ContainerRunSnapshot;
    workspace: PreparedWorkspace;
    finalized: Awaited<ReturnType<VcsProvider["finalizeChanges"]>>;
    descriptionState: DescriptionState;
  }> {
    const preparedInput = this.preflight(collectedFor, { finished: true });
    const workspace = existingWorkspace ?? (await this.options.vcs.recoverWorkspace(preparedInput));
    if (!workspace) throw new Error("coding_workspace_lost");
    await this.options.jobs.materializeWorkspace(handle, workspace.workspacePath);
    await normalizeCollectedLockfiles(collectedFor.provider, workspace.workspacePath);
    const current = await this.requireCurrent(run.runId);
    // One more (usually cached) check right before anything is pushed: access
    // revoked while the run was working stops the push.
    await this.authorizeRepository(current, { inFlight: true });
    // And a run stopped while its result was collected (stop_run, a cancelled task) pushes nothing.
    this.requireActive(await this.requireCurrent(run.runId));
    const report = await this.pullRequestRegistryReport(current);
    const descriptionState = await this.descriptionStateFor(current);
    const finalized = await this.options.vcs.finalizeChanges(workspace, {
      summary,
      tests: output.tests,
      tag: output.tag,
      ...report,
      ...restoredDependenciesFor(output),
      ...this.issueFor(current),
      ...(await this.relatedFor(current)),
      ...(descriptionState && "baseline" in descriptionState
        ? { description: { baseline: descriptionState.baseline } }
        : {}),
    });
    return { current, workspace, finalized, descriptionState };
  }

  /**
   * A run stopped at its budget whose worker exited cleanly keeps its changes so
   * far: they are pushed as the usual draft (or branch), with a summary that says
   * the work is unfinished. Null when there was nothing to push or the push
   * failed for any reason: the run then ends out of budget without them. Throws
   * only when the run was stopped meanwhile (the stop wrote its terminal row).
   */
  private async keepStoppedChanges(
    run: ContainerRunSnapshot,
    handle: JobHandle,
    current: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    existingWorkspace: PreparedWorkspace | null | undefined,
  ): Promise<{
    current: ContainerRunSnapshot;
    finalized: Exclude<Awaited<ReturnType<VcsProvider["finalizeChanges"]>>, { outcome: "no_changes" }>;
    result: CodingRunResult;
    record: CodingRunRecord;
  } | null> {
    const summary = budgetStoppedSummary(output.summary);
    try {
      const pushed = await this.pushChanges(run, handle, current, output, summary, existingWorkspace);
      const { finalized } = pushed;
      if (finalized.outcome === "no_changes") return null;
      const description = await this.recordDescription(
        pushed.current,
        pushed.descriptionState,
        finalized.outcome === "pull_request_opened" || finalized.outcome === "pull_request_updated"
          ? finalized.description
          : undefined,
      );
      return {
        current: pushed.current,
        finalized,
        result: this.resultFor({ ...output, summary }, pushed.current, finalized.outcome, finalized),
        record: { ...dependencyCacheRecord(output), ...pushedRecord(finalized), ...description },
      };
    } catch (error) {
      if (error instanceof Error && error.message === "coding_run_no_longer_active") throw error;
      containerLog.warn(
        { runId: run.runId, reason: describeFailure(error) },
        "could not push the changes of a run stopped at its budget; it ends without them",
      );
      return null;
    }
  }

  /**
   * The pull request description a continuation run is about to replace, for
   * its task. Undefined for a fresh run or when it cannot be loaded: the run
   * goes ahead without the note.
   */
  private async currentDescriptionText(run: ContainerRunSnapshot): Promise<string | undefined> {
    const store = this.options.store;
    if (!run.rootCodingRunId || !hasPullRequestDescription(run) || !store.pullRequestDescriptionBaseline) {
      return undefined;
    }
    try {
      return (await store.pullRequestDescriptionBaseline(run.rootCodingRunId)).previousAgentText;
    } catch (err) {
      containerLog.debug({ err, runId: run.runId }, "could not load the pull request description for the task");
      return undefined;
    }
  }

  /**
   * The issue a continuation's pull request was opened for, read for its task
   * the way the first run had it: the root run's Jira issue, else the GitHub
   * issue whose mention started the work (same repository), else the issue the
   * description wardby last wrote closes (same repository). Each candidate is
   * read in turn until one is an issue. Undefined for a fresh or local run, or
   * on any failure: the run goes ahead without it.
   */
  private async linkedIssueFor(
    run: ContainerRunSnapshot,
    description: string | undefined,
  ): Promise<LinkedIssueText | undefined> {
    const store = this.options.store;
    const read = this.options.readLinkedIssue;
    if (!run.rootCodingRunId || !hasPullRequestDescription(run) || !read || !store.linkedIssueSource) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        containerLog.warn({ runId: run.runId }, "reading the linked issue timed out; continuing without it");
        resolve(undefined);
      }, LINKED_ISSUE_READ_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.readLinkedIssue(run, run.rootCodingRunId, description, read), timedOut]);
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not read the linked issue; continuing without it");
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readLinkedIssue(
    run: ContainerRunSnapshot,
    rootRunId: string,
    description: string | undefined,
    read: NonNullable<ContainerExecutorOptions["readLinkedIssue"]>,
  ): Promise<LinkedIssueText | undefined> {
    const source = await this.options.store.linkedIssueSource!(rootRunId);
    const candidates: LinkedIssueRef[] = [];
    if (source.issueProvider === "jira" && source.issueKey && ISSUE_KEY.test(source.issueKey)) {
      candidates.push({ provider: "jira", key: source.issueKey });
    }
    const status = source.hostStatus;
    if (
      status?.provider === "github" &&
      status.repository.toLowerCase() === run.repository.toLowerCase() &&
      Number.isSafeInteger(status.number) &&
      status.number > 0
    ) {
      candidates.push({ provider: "github", repository: run.repository, number: status.number });
    }
    const closed = closingIssueNumber(description, run.repository);
    if (closed !== undefined && !candidates.some((ref) => ref.provider === "github" && ref.number === closed)) {
      candidates.push({ provider: "github", repository: run.repository, number: closed });
    }
    for (const ref of candidates) {
      let issue: { title: string; body: string } | null;
      try {
        issue = await read(ref);
      } catch (err) {
        // The next candidate may still be readable.
        containerLog.warn({ err, runId: run.runId, issue: ref }, "could not read a linked issue candidate");
        continue;
      }
      if (!issue) continue;
      return ref.provider === "github"
        ? { kind: "github", number: ref.number, title: issue.title, body: issue.body }
        : { kind: "jira", key: ref.key, title: issue.title, body: issue.body };
    }
    return undefined;
  }

  /**
   * A fix round's description baseline (null: no description flow -- a fresh
   * run, or a store without it). Never throws: a load failure is recorded as
   * skipped:error and the push goes ahead without a description update.
   */
  private async descriptionStateFor(run: ContainerRunSnapshot): Promise<DescriptionState> {
    const store = this.options.store;
    if (!run.rootCodingRunId || !hasPullRequestDescription(run) || !store.pullRequestDescriptionBaseline) return null;
    let stored: StoredDescriptionBaseline;
    try {
      stored = await store.pullRequestDescriptionBaseline(run.rootCodingRunId);
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not load the pull request description baseline");
      return { failed: true };
    }
    const { legacySource, ...baseline } = stored;
    if (baseline.recordedSha256 !== null || !legacySource) return { baseline };
    const legacySha256 = await this.legacyDescriptionSha256(run.rootCodingRunId, legacySource);
    return { baseline: legacySha256 ? { ...baseline, legacySha256 } : baseline };
  }

  /**
   * A legacy pull request's description as its root run wrote it, rebuilt from
   * stored records (the final message, tests, packages, dependency cache line
   * and issue line; the Related section is not hashed), and hashed. Undefined
   * when the root stored no final message, or on any failure: the description
   * then counts as edited, the safe direction. A lock file line the root's
   * refusal warning may have carried is not stored, so such a description
   * never matches.
   */
  private async legacyDescriptionSha256(
    rootRunId: string,
    source: LegacyDescriptionSource,
  ): Promise<string | undefined> {
    if (!source.summary) return undefined;
    try {
      const tests = storedTests(source.tests);
      const restored =
        source.dependencyCache === undefined
          ? []
          : restoredDependencyFolders(sanitizeDependencyCacheReport(source.dependencyCache));
      const body = pullRequestBody({
        repository: source.repository,
        baseRef: source.baseRef,
        headRef: source.headRef,
        runId: rootRunId,
        summary: source.summary,
        ...(tests.length > 0 ? { tests } : {}),
        ...(await this.loadRegistryReport(rootRunId)),
        ...(restored.length > 0 ? { restoredDependencies: restored } : {}),
        ...this.issueFor({ issueProvider: source.issueProvider ?? null, issueKey: source.issueKey ?? null }),
      });
      return descriptionSha256(body);
    } catch (err) {
      containerLog.debug({ err, rootRunId }, "could not rebuild a legacy pull request description");
      return undefined;
    }
  }

  /**
   * The Packages section's input: on a continuation, every package installed
   * by the runs that pushed to the pull request plus this run (merged in run
   * order); refusals are this run's only, since they describe the current
   * state. A fresh run, or a failed listing, reports this run's alone.
   */
  private async pullRequestRegistryReport(run: ContainerRunSnapshot): Promise<LoadedRegistryReport> {
    const own = await this.loadRegistryReport(run.runId);
    const store = this.options.store;
    if (!run.rootCodingRunId || !hasPullRequestDescription(run) || !store.pullRequestRunIds) return own;
    let earlier: string[];
    try {
      earlier = (await store.pullRequestRunIds(run.rootCodingRunId)).filter((id) => id !== run.runId);
    } catch (err) {
      containerLog.warn(
        { err, runId: run.runId },
        "could not list the pull request's runs; listing this run's packages",
      );
      return own;
    }
    const reports = await Promise.all(earlier.map((id) => this.loadRegistryReport(id)));
    const packages = mergePackages([...reports.map((report) => report.packages ?? []), own.packages ?? []]);
    // Package audit mode is cumulative like packages: the banner stays on the
    // pull request once any of its runs had the mode.
    const packageAudit = mergePackageAuditReports([...reports.map((report) => report.packageAudit), own.packageAudit]);
    return {
      ...(packages.length > 0 ? { packages } : {}),
      ...(own.packageRefusals ? { packageRefusals: own.packageRefusals } : {}),
      ...(packageAudit ? { packageAudit } : {}),
    };
  }

  /**
   * The run's description columns for store.complete. A fresh run that wrote
   * its PR records the hash on its own (root) row; a fix round that wrote or
   * kept wardby's text compare-and-sets the root's hash. Never throws.
   */
  private async recordDescription(
    run: ContainerRunSnapshot,
    state: DescriptionState,
    outcome: DescriptionWriteOutcome | undefined,
  ): Promise<CodingRunRecord> {
    if (!hasPullRequestDescription(run)) return {};
    if (!run.rootCodingRunId) {
      return outcome?.kind === "written"
        ? { prDescriptionOutcome: "written", prDescriptionSha256: outcome.sha256, prDescriptionRunId: run.runId }
        : {};
    }
    if (!state) return {};
    if ("failed" in state) return { prDescriptionOutcome: "skipped:error" };
    if (!outcome || outcome.kind === "written") return {};
    const label = descriptionOutcomeLabel(outcome);
    if (outcome.kind !== "replaced" && outcome.kind !== "refreshed" && outcome.kind !== "unchanged") {
      return { prDescriptionOutcome: label };
    }
    const store = this.options.store;
    if (!store.recordPullRequestDescription) return { prDescriptionOutcome: label };
    try {
      const won = await store.recordPullRequestDescription({
        rootRunId: run.rootCodingRunId,
        expectedSha256: state.baseline.recordedSha256,
        sha256: outcome.sha256,
        agentTextRunId: outcome.agentTextRunId,
      });
      // A lost race leaves the root's hash as the other write left it: the next
      // round sees a mismatch and falls back to a comment, the safe direction.
      if (!won) {
        containerLog.warn(
          { runId: run.runId, rootRunId: run.rootCodingRunId },
          "pull request description hash changed meanwhile; not recorded",
        );
      }
      return { prDescriptionOutcome: label };
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not record the pull request description hash");
      return { prDescriptionOutcome: "skipped:error" };
    }
  }

  /**
   * refreshDescriptionWithoutPush, capped at DESCRIPTION_REFRESH_TIMEOUT_MS so a
   * slow host cannot hold up store.complete; a timeout is skipped:error.
   */
  private async refreshDescriptionInTime(
    run: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    existingWorkspace: PreparedWorkspace | null | undefined,
  ): Promise<CodingRunRecord> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<CodingRunRecord>((resolve) => {
      timer = setTimeout(() => {
        containerLog.warn(
          { runId: run.runId, timeoutMs: DESCRIPTION_REFRESH_TIMEOUT_MS },
          "pull request description refresh timed out",
        );
        resolve({ prDescriptionOutcome: "skipped:error" });
      }, DESCRIPTION_REFRESH_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.refreshDescriptionWithoutPush(run, output, existingWorkspace), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A fix round that changed nothing still re-derives its PR description (no
   * push). Never throws: any failure is recorded as skipped:error.
   */
  private async refreshDescriptionWithoutPush(
    run: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    existingWorkspace: PreparedWorkspace | null | undefined,
  ): Promise<CodingRunRecord> {
    const vcs = this.options.vcs;
    if (!run.rootCodingRunId || !hasPullRequestDescription(run) || !vcs.refreshPullRequestDescription) return {};
    const state = await this.descriptionStateFor(run);
    if (!state || "failed" in state) return this.recordDescription(run, state, undefined);
    try {
      const input = this.preflightForCleanup(run);
      const workspace = existingWorkspace ?? (input ? await vcs.recoverWorkspace(input) : null);
      if (!workspace) throw new Error("coding_workspace_lost");
      // The same in-flight access check a push gets: a revoked owner's run edits nothing.
      await this.authorizeRepository(run, { inFlight: true });
      const details: FinalizeChangesDetails = {
        summary: output.summary,
        tests: output.tests,
        tag: output.tag,
        ...(await this.pullRequestRegistryReport(run)),
        ...restoredDependenciesFor(output),
        ...this.issueFor(run),
        description: { baseline: state.baseline },
      };
      const outcome = await vcs.refreshPullRequestDescription(workspace, details);
      return await this.recordDescription(run, state, outcome);
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not refresh the pull request description");
      return { prDescriptionOutcome: "skipped:error" };
    }
  }

  /** Runs the onCodingRunTerminal hook; nothing it does, throws, or rejects reaches the caller. */
  private async notifyTerminal(runId: string): Promise<void> {
    const hook = this.options.onCodingRunTerminal;
    if (!hook) return;
    try {
      await hook(runId);
    } catch (err) {
      containerLog.warn({ err, runId }, "coding run terminal hook failed");
    }
  }

  /** The package report is informational: any failure loading it (a
   *  rejection, a synchronous throw, or a malformed result) yields no
   *  package section rather than failing finalization. */
  private async loadRegistryReport(runId: string): Promise<LoadedRegistryReport> {
    try {
      const report = await this.options.registryReport?.(runId);
      const packages = Array.isArray(report?.packages) ? report.packages : [];
      const packageRefusals = Array.isArray(report?.packageRefusals) ? report.packageRefusals : [];
      const packageAudit = isPackageAuditMode(report?.packageAuditMode)
        ? { mode: report.packageAuditMode, entries: Array.isArray(report.packageAudit) ? report.packageAudit : [] }
        : undefined;
      return {
        ...(packages.length > 0 ? { packages } : {}),
        ...(packageRefusals.length > 0 ? { packageRefusals } : {}),
        ...(packageAudit ? { packageAudit } : {}),
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
      // workerImageRef never replaces the Claude Code agent image (the container that holds the
      // run's key); on a Claude Code agent it selects the tool runner (claudeToolImage).
      this.claudeToolImage(selector);
      const image = this.options.claudeWorkerImage;
      if (!image) throw new Error("coding_provider_not_configured:claude-code");
      if (!isImmutableDockerImage(image)) throw new Error("coding_worker_image_invalid");
      return image;
    }
    if (selector.provider !== "codex") {
      throw new Error(`coding_provider_unsupported:${String(selector.provider)}`);
    }
    if (selector.workerImageRef !== null) {
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

  /**
   * The tool runner is what runs a Claude agent's commands, so it is what the toolchain selects —
   * unless the agent has a BYO workerImageRef, which replaces the tool runner directly (never the
   * agent image; see resolveCodingWorkerImage).
   */
  private claudeToolImage(selector: CodingImageSelector): string {
    if (!this.options.claudeToolRunnerImage) throw new Error("coding_provider_not_configured:claude-code");
    // An admin-set custom image (workerImageRef) is where this agent's commands run.
    if (selector.workerImageRef !== null) {
      if (!isImmutableDockerImage(selector.workerImageRef)) throw new Error("coding_worker_image_invalid");
      return selector.workerImageRef;
    }
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

  /**
   * Throws coding_run_no_longer_active once something else made the run terminal (a stop's
   * cancellation fence): nothing may then be pushed, opened, or rewritten on the host for it.
   */
  private requireActive(run: ContainerRunSnapshot): ContainerRunSnapshot {
    if (TERMINAL_STATUSES.has(run.status)) throw new Error("coding_run_no_longer_active");
    return run;
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
      // Only when on: every other run's spec stays exactly what it was.
      ...(run.dependencyCache ? { dependencyCache: true as const } : {}),
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
    const withCommit = withBaseCommit(run.task, workspace.baseCommit);
    const description = await this.currentDescriptionText(run);
    // The ticket first, then the description: each is cut to what's left of the task's budget.
    const task = withPullRequestDescription(
      withLinkedIssue(withCommit, await this.linkedIssueFor(run, description)),
      description,
    );
    if (withCommit === run.task && /^[0-9a-f]{40}$/.test(workspace.baseCommit)) {
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
    const build = (contextFiles: ClaudeContextFile[]) =>
      CodingTaskInputSchema.parse({
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
        // Only on a traced run whose agent sets a cap: every other run's input stays exactly what older workers expect.
        ...(run.debugTrace && run.debugTraceMaxMb ? { debugTraceMaxMb: run.debugTraceMaxMb } : {}),
        // Only when the agent sets one: every other run's input stays exactly what older workers expect.
        ...(run.maxTurns ? { maxTurns: run.maxTurns } : {}),
        // Only when the agent sets one: every other run's input stays exactly what older workers expect.
        ...(run.maxOutputTokens ? { maxOutputTokens: run.maxOutputTokens } : {}),
        // Only when off: every other run's input stays exactly what older workers expect.
        ...(run.repoSkills === false ? { repoSkills: false } : {}),
        // Only when off: every other run's input stays exactly what older workers expect.
        ...(run.claudeBareMode === false ? { claudeBareMode: false } : {}),
        // Only when on: every other run's input stays exactly what older workers expect. The volume
        // size (the job spec's limits.diskMb) bounds what the cache may restore.
        ...(run.dependencyCache
          ? { dependencyCache: true as const, diskMb: run.workspaceDiskMb ?? this.options.limits.diskMb }
          : {}),
        // Only when there are some: every other run's input stays exactly what older workers expect.
        ...(services.length > 0 ? { services: workerServices(services) } : {}),
        // Only when there is something to load: every other run's input stays exactly what older workers expect.
        ...(contextFiles.length > 0 ? { claudeContext: { files: contextFiles } } : {}),
      });
    // The content limits bound bytes, but JSON escaping can grow them up to sixfold (a control
    // character becomes \u00XX), so a hostile repository could still push input.json past
    // MAX_CODING_INPUT_BYTES and fail the launch. Drop context files from the tail (skills, then the
    // deepest imports; the root instructions go last) until the serialized input fits.
    const contextFiles = [...(claudeContext?.files ?? [])];
    const skipped = [...(claudeContext?.skipped ?? [])];
    let skippedOverflow = claudeContext?.skippedOverflow ?? 0;
    let serialized = JSON.stringify(build(contextFiles));
    while (contextFiles.length > 0 && Buffer.byteLength(serialized) > MAX_CODING_INPUT_BYTES) {
      const dropped = contextFiles.pop()!;
      if (skipped.length < MAX_RECORDED_SKIPS) skipped.push({ path: dropped.path, reason: "limit" });
      else skippedOverflow++;
      serialized = JSON.stringify(build(contextFiles));
    }
    for (const skip of skipped) {
      containerLog.warn(
        {
          event: "coding.claude_context_skipped",
          runId: run.runId,
          // A refused import is logged as written, which a repository can make arbitrarily long.
          path: skip.path.slice(0, MAX_LOGGED_SKIP_PATH_CHARS),
          reason: skip.reason,
        },
        "a repository context file was not loaded",
      );
    }
    if (skippedOverflow > 0) {
      containerLog.warn(
        { event: "coding.claude_context_skipped", runId: run.runId, overflow: skippedOverflow },
        "further repository context files were not loaded",
      );
    }
    // The run directory is 0700; world-readable mode only crosses Docker's UID boundary.
    await writeFile(temporary, serialized, { flag: "wx", mode: 0o444 });
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
    await this.recordRefusal(run.runId, run.proxySessionId);
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
    // A run another path ended (or one recovered after a crash) still gets its refusal; the copy is idempotent.
    await this.recordRefusal(run.runId, run.proxySessionId);
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
        ...(outcome === "succeeded" ? this.overrunDetails(run) : {}),
        ...(outcome === "budget_exhausted" ? { budgetSentence: await this.budgetSentence(run) } : {}),
        ...(providerClass ? { providerSentence: providerSentence(providerClass) } : {}),
        ...(unreadyServices ? { serviceSentence: serviceUnreadySentence(unreadyServices) } : {}),
        ...(protectedPathFailed ? { protectedPathSentence: protectedPathSentence(null) } : {}),
      });
    }
    await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
    this.emit({ stage: "cleanup", runId: run.runId, jobId: run.jobHandle?.id, cleanupSucceeded: true });
  }

  /**
   * Records the session's budget refusal on the run, at every ending: a run the proxy refused once may
   * still finish, fail for another reason, or be stopped. A session with no refusal adds nothing.
   * Best effort; never throws.
   */
  private async recordRefusal(runId: string, sessionId: string | null | undefined): Promise<void> {
    if (!sessionId) return;
    await this.options.store.recordBudgetRefusal?.(runId, sessionId).catch(() => undefined);
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

  /** The overrun sentence for a finished run that spent past its base budget, as status details. */
  private overrunDetails(run: ContainerRunSnapshot): { overrunSentence?: string } {
    if (run.budgetBaseUsd === undefined) return {};
    const sentence = overrunSentence(run.costUsd, run.budgetBaseUsd, run.budgetUsd);
    return sentence ? { overrunSentence: sentence } : {};
  }

  /** The host-safe sentence for a run that ran out of budget. */
  private async budgetSentence(run: ContainerRunSnapshot): Promise<string> {
    const loaded = await this.options.store.budgetEvent?.(run.runId).catch(() => null);
    if (loaded) return hostBudgetSentence(loaded.event);
    return budgetSentence({
      runBudgetUsd: run.budgetUsd,
      agentBudgetUsd: run.agentBudgetUsd ?? run.budgetUsd,
      baseBudgetUsd: run.budgetBaseUsd,
      budgetGroupName: run.budgetGroupName,
    });
  }

  /**
   * A failure the proxy's budget refusal caused. The failure itself is still
   * logged under its diagnostic id, so the operator keeps the real reason.
   */
  private async budgetFailure(
    runId: string,
    error: unknown,
    options: { issues?: string[] } = {},
  ): Promise<{ error: string; audit: CodingFailureAudit }> {
    const logged = this.failure(error, options);
    const loaded = await this.options.store.budgetEvent?.(runId).catch(() => null);
    return {
      error: loaded
        ? `coding_budget_exhausted: ${ownerBudgetSentence(loaded.event, loaded.agentName)}`
        : "coding_budget_exhausted",
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

/** A stored CodingRun result's summary (the agent-written description text), when it has one. */
function storedSummary(result: unknown): string | undefined {
  const summary = storedField(result, "summary");
  return typeof summary === "string" ? summary : undefined;
}

/** One field of a stored JSON object; undefined when it isn't an object. */
function storedField(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)[key];
}

/** Stored test results the PR body can list (command + outcome); anything else is dropped. */
function storedTests(value: unknown): Array<{ command: string; outcome: "passed" | "failed" | "skipped" }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((test) => {
    const command = storedField(test, "command");
    const outcome = storedField(test, "outcome");
    return typeof command === "string" && (outcome === "passed" || outcome === "failed" || outcome === "skipped")
      ? [{ command, outcome }]
      : [];
  });
}

/**
 * Packages from several runs' reports, in order: one entry per ecosystem +
 * name + version, first appearance first, accepted advisories merged.
 */
function mergePackages(lists: ReadonlyArray<RegistryReport["packages"]>): RegistryReport["packages"] {
  const merged = new Map<string, RegistryReport["packages"][number]>();
  for (const list of lists) {
    for (const pkg of list) {
      const key = `${pkg.ecosystem}\0${pkg.name}\0${pkg.version}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...pkg,
          ...(pkg.acceptedAdvisories ? { acceptedAdvisories: [...pkg.acceptedAdvisories] } : {}),
        });
        continue;
      }
      if (pkg.acceptedAdvisories?.length) {
        existing.acceptedAdvisories = [...new Set([...(existing.acceptedAdvisories ?? []), ...pkg.acceptedAdvisories])];
      }
    }
  }
  return [...merged.values()];
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
