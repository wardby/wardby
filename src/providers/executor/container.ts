import { randomUUID } from "node:crypto";
import type { RunStepsLevel } from "../../core/run-steps/config.js";
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
import type { RunTranscriptRecorder } from "../../coding/transcript/recorder.js";
import { withBaseCommit, withExtraRepositories, type GitHistoryWording } from "../../coding/base-commit.js";
import { mcpTokenHash, mintMcpToken } from "../../coding/mcp-token.js";
import { isCodexCoding, type McpToolPin } from "../../core/mcp-tools.js";
import { CODING_MCP_GATEWAY_UNAVAILABLE } from "../../core/power.js";
import { codeProviderOf } from "../../coding/code-host.js";
import { withPullRequestDescription } from "../../coding/pr-description-note.js";
import { withLinkedIssue, type LinkedIssueText } from "../../coding/linked-issue-note.js";
import { withOriginalRequest } from "../../coding/original-request-note.js";
import { originalRequestOf } from "../../core/request-text.js";
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
  WORKER_BUDGET_EXHAUSTED_SUMMARY,
} from "../../coding/continuation-wording.js";
import {
  CONFLICT_MARKERS_ERROR_PREFIX,
  MERGE_CONFLICT_CATEGORY,
  TARGET_MERGE_CATEGORY,
  TARGET_MERGE_FAILED_ERROR,
  conflictMarkersPathFromError,
  conflictMarkersSentence,
  mergeSentence,
  withTargetMerge,
} from "../../coding/merge-wording.js";
import { budgetSentence, overrunSentence } from "../../core/budget-wording.js";
import { fileSelfDefect } from "../../core/self-defects.js";
import { emitRunCompletedEvent } from "../../core/workflow-run-events.js";
import { isTransactionUnavailable } from "../../core/dispatch.js";
import { topUpCodingBudget, type TopUpOutcome } from "../../core/budget-topup.js";
import { CONTENDED_TX_MAX_WAIT_MS } from "../../core/timing.js";
import type { IssueTrackerRegistry } from "../issue-tracker/types.js";
import {
  classifyProviderFailure,
  providerClassOfCategory,
  providerSentence,
  type ProviderFailureClass,
} from "../../core/provider-wording.js";
import { logger } from "../../core/logger.js";
import {
  requiredLevel,
  type AuthorizeUseInput,
  type RepoAccessDecision,
  type RepoAccessGate,
} from "../../core/repo-access.js";
import { ensurePrivateDirectory } from "../../core/private-directory.js";
import { codingRunObserver, type CodingRunObserver } from "../../coding/observability.js";
import {
  cappedClaudeCommandTimeouts,
  DEFAULT_CLAUDE_COMMAND_TIMEOUT_MS,
  type ClaudeCommandTimeouts,
} from "../../coding/command-timeouts.js";
import {
  CODING_PROTOCOL_VERSION,
  CodingRunResultSchema,
  CodingTaskInputSchema,
  MAX_CODING_INPUT_BYTES,
  RESERVED_REPOSITORY_NAME,
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
  type GitHistoryInput,
  type PullRequestNote,
} from "../../coding/protocol.js";
import { parseStoredEntry } from "../llm/catalog-types.js";
import { resolveCodingEntry } from "../../core/run-pricing.js";
import { CODING_PROXY_ALIAS, CODING_PROXY_PORT, isImmutableDockerImage } from "../jobs/docker-isolation.js";
import { normalizeRegistryLockfiles } from "../../coding/registry/lockfiles.js";
import { warningRefusals } from "../../coding/registry/report.js";
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
import {
  JobCapacityError,
  type JobHandle,
  type JobRepositoryMount,
  type JobResourceLimits,
  type JobSpec,
  type WorkspaceJobLauncher,
} from "../jobs/types.js";
import type {
  ContinuationOutcome,
  ContinuationTarget,
  DescriptionWriteOutcome,
  FinalizeChangesDetails,
  PreparedReadOnlyCopy,
  PreparedWorkspace,
  ReadOnlyCopyInput,
  VcsPrepareInput,
  VcsProvider,
} from "../vcs/types.js";
import { countWorkspaceEntries } from "../vcs/git.js";
import type { CodingImageSelector, ExecutionRecoveryResult, Executor, PersistedExecutionHandle } from "./types.js";
import { ISSUE_KEY, issueReference } from "../issue-tracker/types.js";
import { HEARTBEAT_TIMEOUT_MS } from "../../core/timing.js";
import { isTestOutcome, type TestOutcome } from "../../coding/test-outcomes.js";
import { collectRelatedPullRequests } from "../../core/related-pull-requests.js";
import { isIssueMentionTask } from "../../core/host-status.js";
import {
  pullRequestBody,
  type DescriptionBaseline,
  type RelatedPullRequestEntry,
  type RelatedPullRequestsInput,
} from "../vcs/github.js";
import { closingIssueNumber, descriptionSha256 } from "../vcs/pr-description.js";

const containerLog = logger.child({ module: "container-executor" });

/** A transcript read and store must not hold up the job's removal for long. */
const TRANSCRIPT_RECORD_TIMEOUT_MS = 60_000;
/** A logged context skip path is cut to this many characters: a refused import is reported as written. */
const MAX_LOGGED_SKIP_PATH_CHARS = 256;

/** The input path in a spec built only to ask the launcher about capacity; never written or read. */
const CAPACITY_PROBE_INPUT = "/dev/null";
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);
const PROVISIONING_BACKEND = "provisioning";
/** The longest a no-change fix round's description refresh may hold up the run's terminal write. */
export const DESCRIPTION_REFRESH_TIMEOUT_MS = 60_000;
/**
 * After the cluster refuses a run's launch for capacity, how long this executor leaves the run
 * waiting in the queue before trying it again (drainCodingQueue starts it every tick meanwhile).
 */
export const CAPACITY_RETRY_BACKOFF_MS = 60_000;
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
/** Private sentinel: rolls back requeueAfterCapacityRefusal's transaction with the outcome it carries. */
class NotRequeuedError extends Error {
  constructor(readonly outcome: Exclude<CapacityRequeueOutcome, "requeued">) {
    super(outcome);
  }
}

/**
 * What requeueAfterCapacityRefusal did: "requeued" the run waits in the queue again; "not_owned"
 * the attempt no longer owns the run (another took it, or it ended), and nothing changed;
 * "spend_recorded" its proxy session has spend against it, so nothing changed and the caller
 * fails the run instead.
 */
export type CapacityRequeueOutcome = "requeued" | "not_owned" | "spend_recorded";

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

type FinalizeResult = Awaited<ReturnType<VcsProvider["finalizeChanges"]>>;

/** The last step of a merge order: every writer keeps CodingRun.mergeOrder within 1-99. */
const MAX_MERGE_ORDER = 99;

/** A run with any writable extra repository: the control plane collects and diffs each writable one itself (#537). */
function hasWritableExtras(run: Pick<ContainerRunSnapshot, "repositories">): boolean {
  return run.repositories.some((extra) => extra.access === "write");
}

/** The driver's note for one repository's pull request; `workspace` names the default repository. */
function pullRequestNoteFor(output: CodingAgentOutput, name: string): PullRequestNote | undefined {
  return output.pullRequests?.find((note) => note.name === name);
}

/** The description outcome finalizeChanges reported, when it opened or updated a pull request. */
function descriptionOutcomeOf(finalized: FinalizeResult): DescriptionWriteOutcome | undefined {
  return finalized.outcome === "pull_request_opened" || finalized.outcome === "pull_request_updated"
    ? finalized.description
    : undefined;
}

/**
 * The run as one writable extra's publish sees it: that repository and base, and a continuation only
 * when the extra's branch already exists (otherwise its pull request is a new one).
 */
function extraView(run: ContainerRunSnapshot, extra: RunRepositorySnapshot): ContainerRunSnapshot {
  return {
    ...run,
    repository: extra.repository,
    baseRef: extra.baseRef ?? run.baseRef,
    rootCodingRunId: extra.continuesBranch ? run.rootCodingRunId : null,
  };
}

/** One writable repository of a run with several, in publish order; `error` once it failed. */
interface RepositorySlot {
  /** RESERVED_REPOSITORY_NAME for the default repository, else the row's name. */
  name: string;
  extra?: RunRepositorySnapshot;
  workspace?: PreparedWorkspace;
  error?: unknown;
}

/** What finalizeChanges did for one repository of a run with several. */
interface RepositoryPublish {
  slot: RepositorySlot & { workspace: PreparedWorkspace };
  finalized: FinalizeResult;
  /** The run as reloaded right before this repository's push. */
  current: ContainerRunSnapshot;
  /** The same, as this repository's publish saw it (extraView for an extra). */
  view: ContainerRunSnapshot;
  /** The driver's output with this repository's own description and title. */
  agentOutput: CodingWorkerOutput;
  descriptionState: DescriptionState;
  /** Its step in the merge order, should it publish alongside another of the run's repositories. */
  mergeOrder: number;
  /** Its step should it be the run's only push: what a run with one repository records (null = none). */
  soleMergeOrder: number | null;
}

const isNoLongerActive = (error: unknown) => error instanceof Error && error.message === "coding_run_no_longer_active";

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
  /** The default repository's step in the merge order, set by a run with several repositories that had none. */
  mergeOrder?: number;
}

/** How one writable repository of a run with several ended up (#537); `<code>` is the failure category. */
export type RepositoryPublishStatus = "published" | "no_changes" | `failed(${string})`;

/** What a run with several repositories records on one writable extra's row (CodingRunRepository). */
export interface ExtraPublishRecord {
  id: string;
  name: string;
  result: CodingRunResult | null;
  pullRequestNumber: number | null;
  resultBranch: string | null;
  baseSha: string | null;
  mergeOrder: number | null;
  prDescriptionSha256?: string;
  prDescriptionRunId?: string;
  prDescriptionOutcome?: string;
}

/**
 * A run's error when some of its repositories published and others failed: each repository's status,
 * in publish order. A failure is named by its fixed category only, never its message, so nothing the
 * model or a host wrote reaches Run.error.
 */
export function partiallyPublishedError(
  statuses: ReadonlyArray<{ name: string; status: RepositoryPublishStatus }>,
): string {
  return `partially_published: ${statuses.map((s) => `${s.name}: ${s.status}`).join("; ")}`;
}

/** The failure category of a run some of whose repositories published and others failed. */
export const PARTIALLY_PUBLISHED_CATEGORY = "partially_published";

/** CodingRun columns from a CodingRunRecord (complete and completePartially). */
function codingRunRecordData(record: CodingRunRecord) {
  return {
    ...(record.resultBranch ? { resultBranch: record.resultBranch } : {}),
    ...(record.baseSha ? { baseSha: record.baseSha } : {}),
    ...(record.dependencyCacheResult ? { dependencyCacheResult: record.dependencyCacheResult } : {}),
    ...(record.prDescriptionOutcome ? { prDescriptionOutcome: record.prDescriptionOutcome } : {}),
    ...(record.prDescriptionSha256 && record.prDescriptionRunId
      ? { prDescriptionSha256: record.prDescriptionSha256, prDescriptionRunId: record.prDescriptionRunId }
      : {}),
    ...(record.mergeOrder != null ? { mergeOrder: record.mergeOrder } : {}),
  };
}

/** Writes each extra's outcome on its own row of the run (never another run's row). */
async function writeExtraRecords(
  tx: Pick<PrismaClient, "codingRunRepository">,
  runId: string,
  extras: readonly ExtraPublishRecord[],
): Promise<void> {
  for (const extra of extras) {
    await tx.codingRunRepository.updateMany({
      where: { id: extra.id, runId, name: extra.name },
      data: {
        ...(extra.result ? { result: extra.result } : {}),
        ...(extra.pullRequestNumber != null ? { pullRequestNumber: extra.pullRequestNumber } : {}),
        ...(extra.resultBranch ? { resultBranch: extra.resultBranch } : {}),
        ...(extra.baseSha ? { baseSha: extra.baseSha } : {}),
        ...(extra.mergeOrder != null ? { mergeOrder: extra.mergeOrder } : {}),
        ...(extra.prDescriptionOutcome ? { prDescriptionOutcome: extra.prDescriptionOutcome } : {}),
        ...(extra.prDescriptionSha256 && extra.prDescriptionRunId
          ? { prDescriptionSha256: extra.prDescriptionSha256, prDescriptionRunId: extra.prDescriptionRunId }
          : {}),
      },
    });
  }
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
 * A budget-stopped run's stored result names what its kept changes became
 * (see keepStoppedChanges): the `changesPushed` detail for its status comment,
 * or nothing when it pushed nothing.
 */
function storedChangesPushed(result: unknown): { changesPushed?: { pullRequestNumber?: number } } {
  const parsed = CodingRunResultSchema.safeParse(result);
  if (!parsed.success) return {};
  const stored = parsed.data;
  if (stored.outcome === "branch_pushed") return { changesPushed: {} };
  if (stored.outcome === "pull_request_opened" || stored.outcome === "pull_request_updated") {
    return { changesPushed: { pullRequestNumber: stored.pullRequestNumber } };
  }
  return {};
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
  /** `issueMention`: that run was started by a mention on an issue (isIssueMentionTask), not on a pull request. */
  hostStatus?: { provider: string; repository: string; number: number; issueMention?: boolean } | null;
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

/** One of a coding run's extra repositories (a CodingRunRepository row, #537), with its link as it is now. */
export interface RunRepositorySnapshot {
  id: string;
  position: number;
  name: string;
  access: "read" | "write";
  /** Fetched as a git remote in the run's history instead of mounted as a folder (CodingRunRepository.asRemote, #536). */
  asRemote: boolean;
  /** False when the stored access is neither "read" nor "write": such a row is refused, never treated as read. */
  accessKnown: boolean;
  provider: string;
  repository: string;
  requestedRef: string | null;
  resolvedSha: string | null;
  baseRef: string | null;
  headRef: string | null;
  linkId: string | null;
  /** The row's link still exists with the same access and no triggers (a coding-set link). */
  linkExists: boolean;
  linkAuthorizedVia: string | null;
  /** A writable row whose branch already exists from the root or an earlier continuation (pullRequestNumber or resultBranch set on a same-name row). */
  continuesBranch: boolean;
  pullRequestNumber: number | null;
  mergeOrder: number | null;
  result: unknown;
}

/** Every workspace a run prepared: the default repository's, each writable extra's by name, and the read-only copies. */
/**
 * What writeInput needs to put git history into a run's input (#536): the `gitHistory` input key as it
 * is written, and the facts the task text states (depth or full, the remote refs and their commits).
 * Both come from the prepared workspaces. Left out, the input and task are exactly what a run without
 * history gets.
 */
export interface GitHistoryForInput {
  input: GitHistoryInput;
  wording: GitHistoryWording;
}

export interface RunWorkspaces {
  main: PreparedWorkspace;
  writable: Map<string, PreparedWorkspace>;
  readOnly: PreparedReadOnlyCopy[];
}

function isRunWorkspaces(value: PreparedWorkspace | RunWorkspaces | null | undefined): value is RunWorkspaces {
  return Boolean(value && "main" in value && "writable" in value);
}

/**
 * A job's extra repositories, in the run's order, each at the path the VCS prepared it at (a
 * writable extra's workspace, or a read row's copy). Only name, access and that path: nothing else
 * of the row (and no credential) reaches the launcher. Throws coding_workspace_lost for a row with
 * no prepared folder.
 */
function jobRepositories(
  rows: readonly RunRepositorySnapshot[],
  workspaces: RunWorkspaces | null,
): JobRepositoryMount[] {
  return rows.map((row) => {
    const prepared =
      row.access === "read"
        ? workspaces?.readOnly.find((copy) => copy.name === row.name)
        : workspaces?.writable.get(row.name);
    if (!prepared) throw new Error("coding_workspace_lost");
    return { name: row.name, access: row.access, hostPath: prepared.workspacePath };
  });
}

/** How many extra repositories are prepared at once. */
const EXTRA_PREPARE_CONCURRENCY = 3;

/**
 * Maps `items` through `work`, at most `limit` at a time, in input order. On a failure no new item
 * starts, the ones already running are waited for (so nothing is still being written when the caller
 * cleans up), and then the first failure is thrown.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const lane = async (): Promise<void> => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index]);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failure) throw failure.error;
  return results;
}

export interface ContainerRunSnapshot {
  /** The run's extra repositories in position order (CodingRunRepository); [] for a single-repository run. */
  repositories: RunRepositorySnapshot[];
  /** Run.runStepsLevel, fixed at dispatch; absent on older snapshots = summary. */
  runStepsLevel?: RunStepsLevel | null;
  runId: string;
  agentId: string;
  status: string;
  agentKind: string;
  /** Human-readable agent name (e.g. "knock-knock-implement") -- surfaced in continuation status notifications. */
  agentName: string;
  ownerId: string | null;
  task: string;
  /** The run's raw request (no standing instructions); absent on older runs. */
  request?: string;
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
  /**
   * The most the run may spend through overrun top-ups (CodingRun.budgetLimitUsd); `budgetUsd` is
   * what it has been granted so far. Absent for older runs and runs without an allowed overrun.
   */
  budgetLimitUsd?: number;
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
  /** Session resume, fixed at dispatch (CodingRun.sessionResume); absent on older snapshots = false. */
  sessionResume?: boolean;
  /** Git history depth, fixed at dispatch (CodingRun.gitHistoryDepth); null with gitHistoryFull false = history off. */
  gitHistoryDepth?: number | null;
  /** Full git history, fixed at dispatch (CodingRun.gitHistoryFull); absent on older snapshots = false. */
  gitHistoryFull?: boolean;
  /** Coding-run services resolved at dispatch (CodingRun.services); parsed with parseStoredServices. */
  services?: unknown;
  /** The terminal failure category, once the run has one (CodingRun.failureCategory). */
  failureCategory?: string | null;
  /** The agent's CURRENT coding-profile repository (null if the profile is gone); may differ from `repository`. */
  profileRepository: string | null;
  /** How the profile's repository was authorized (CodingAgentProfile.repositoryAuthorizedVia). */
  repositoryAuthorizedVia: string | null;
  /** The run's repository was chosen from the agent's list (CodingRun.viaRepositoryLink). */
  viaRepositoryLink: boolean;
  /** How the agent's current write link for the run's repository was authorized; null when there is none. */
  repositoryLinkAuthorizedVia: string | null;
  /** The agent's write link for the run's repository still exists (always false for a run not made via a link). */
  repositoryLinkExists: boolean;
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
  /**
   * Returns a run whose launch the backend refused for capacity (JobCapacityError) to the coding
   * queue: pending, no job handle, no proxy session, and queuedAt the run's dispatch time, so it
   * keeps its place and CODING_QUEUE_TIMEOUT_SEC still counts from when it first waited. Only while
   * the caller still owns it (the provisioning claim, or the planned handle it persisted — all
   * recovery has after a crash), and only when its session has no spend; otherwise it changes
   * nothing and says why. Optional: without it the refused run fails.
   */
  requeueAfterCapacityRefusal?(
    runId: string,
    owned: { claimId?: string; planned?: JobHandle },
  ): Promise<CapacityRequeueOutcome>;
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
  pullRequestDescriptionBaseline?(rootRunId: string, name?: string): Promise<StoredDescriptionBaseline>;
  /**
   * The runs that pushed to the root run's pull request (the root, then its
   * continuations whose result pushed, oldest first), for the cumulative
   * Packages section. Optional: without it the section lists this run's only.
   */
  pullRequestRunIds?(rootRunId: string): Promise<string[]>;
  /**
   * Whether wardby marked the root run's pull request ready for review
   * (CodingRun.markedReadyAt; with `name`, the root's row of that extra
   * repository). Optional: the fallback when the host's draft state is
   * unknown; without it the pull request counts as a draft.
   */
  pullRequestMarkedReady?(rootRunId: string, name?: string): Promise<boolean>;
  /**
   * Where the root run's pull request came from (see LinkedIssueSource).
   * Optional: without it continuations get no issue text.
   */
  linkedIssueSource?(rootRunId: string): Promise<LinkedIssueSource>;
  /**
   * The stored task (Run.taskOverride) of the event-started lead that delegated
   * this run: only for a run a lead started with delegate_to_* (trigger
   * "subagent") whose parent was started by a host or issue event. Null
   * otherwise. Optional: without it the run gets no original request.
   */
  delegatingEventTask?(runId: string): Promise<string | null>;
  /**
   * Compare-and-set of the root run's description hash and author run: writes
   * only while the root still records `expectedSha256` (null = none). False
   * when another write got there first. With `name`, the root's row of that
   * extra repository (CodingRunRepository) instead of the root run itself.
   */
  recordPullRequestDescription?(input: {
    rootRunId: string;
    expectedSha256: string | null;
    sha256: string;
    agentTextRunId: string;
    name?: string;
  }): Promise<boolean>;
  /** `extras`: a run with several repositories records each writable extra's outcome on its own row. */
  complete(
    runId: string,
    status: "succeeded" | "budget_exhausted",
    result: CodingRunResult,
    record?: CodingRunRecord,
    extras?: ExtraPublishRecord[],
  ): Promise<void>;
  /**
   * Ends a run with several repositories some of which published and others failed: failed, with
   * `error` (partiallyPublishedError) and `audit` (partially_published). What did publish is recorded
   * as complete records it: the default repository's result on the run, each extra's on its row.
   */
  completePartially(
    runId: string,
    input: {
      mainResult: CodingRunResult | null;
      record: CodingRunRecord;
      extras: ExtraPublishRecord[];
      error: string;
      audit: CodingFailureAudit;
    },
  ): Promise<void>;
  terminate(
    runId: string,
    status: "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled",
    error: string,
    audit?: CodingFailureAudit,
  ): Promise<boolean>;
  /**
   * Copies the proxy session's first budget refusal (CodingProxySession.budgetRefusal, written by the
   * proxy, which has no access to RunBudgetEvent) into the run's budget events, once per run, whatever
   * status the run ends with. A session that never recorded one adds nothing. Optional: without it no
   * event is written.
   */
  recordBudgetRefusal?(runId: string, sessionId: string): Promise<void>;
  /** The run's recorded budget refusal with names filled in, or null. Optional: without it no event is shown. */
  budgetEvent?(runId: string): Promise<{ event: BudgetEventView; agentName: string } | null>;
  /**
   * Grants a run with an overrun limit one top-up when it is close to its grant and its budget group
   * and run tree have room (budget-topup.ts). Optional: without it a run stops at its base.
   */
  topUpBudget?(runId: string): Promise<{ outcome: TopUpOutcome; near?: boolean }>;
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
    const link = row.codingRun.viaRepositoryLink
      ? await this.db.agentRepository.findFirst({
          where: {
            agentId: row.agentId,
            repository: row.codingRun.repository,
            access: "write",
            triggers: { isEmpty: true },
          },
          select: { authorizedVia: true },
        })
      : null;
    const repositories = await this.loadRepositories(runId, row.agentId, row.codingRun.rootCodingRunId);
    return {
      repositories,
      runId: row.id,
      runStepsLevel: row.runStepsLevel,
      agentId: row.agentId,
      status: row.status,
      agentKind: row.agent.kind,
      agentName: row.agent.name,
      ownerId: row.agent.ownerId,
      task: row.codingRun.task,
      ...(row.codingRun.request ? { request: row.codingRun.request } : {}),
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
      ...(row.codingRun.budgetLimitUsd == null ? {} : { budgetLimitUsd: Number(row.codingRun.budgetLimitUsd) }),
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
      sessionResume: row.codingRun.sessionResume,
      gitHistoryDepth: row.codingRun.gitHistoryDepth,
      gitHistoryFull: row.codingRun.gitHistoryFull,
      services: row.codingRun.services,
      failureCategory: row.codingRun.failureCategory,
      profileRepository: row.agent.codingProfile?.repository ?? null,
      repositoryAuthorizedVia: row.agent.codingProfile?.repositoryAuthorizedVia ?? null,
      viaRepositoryLink: row.codingRun.viaRepositoryLink,
      repositoryLinkExists: link !== null,
      repositoryLinkAuthorizedVia: link?.authorizedVia ?? null,
      pricingVersion: row.pricingVersion,
      pricingSnapshot: row.pricingSnapshot,
    };
  }

  /**
   * The run's extra repositories (#537), each with whether its link is still a coding-set link of
   * the agent (same id, same access, no triggers) and, for a continuation, whether a writable row's
   * branch already exists from the root or an earlier continuation of the same tree (never this run
   * itself: once it publishes, its own rows carry a branch too, and a reload must not change how it
   * names a branch it created off its base).
   */
  private async loadRepositories(
    runId: string,
    agentId: string,
    rootId: string | null,
  ): Promise<RunRepositorySnapshot[]> {
    const rows = await this.db.codingRunRepository.findMany({ where: { runId }, orderBy: { position: "asc" } });
    if (rows.length === 0) return [];
    const linkIds = rows.flatMap((r) => (r.linkId ? [r.linkId] : []));
    const links =
      linkIds.length > 0
        ? await this.db.agentRepository.findMany({
            where: { id: { in: linkIds }, agentId },
            select: { id: true, access: true, triggers: true, authorizedVia: true },
          })
        : [];
    const branchRows = rootId
      ? await this.db.codingRunRepository.findMany({
          where: {
            codingRun: { OR: [{ runId: rootId }, { rootCodingRunId: rootId }] },
            runId: { not: runId },
            OR: [{ pullRequestNumber: { not: null } }, { resultBranch: { not: null } }],
          },
          select: { name: true },
        })
      : [];
    return rows.map((r) => {
      const link = links.find((l) => l.id === r.linkId && l.access === r.access && l.triggers.length === 0);
      return {
        id: r.id,
        position: r.position,
        name: r.name,
        access: r.access === "write" ? "write" : "read",
        accessKnown: r.access === "read" || r.access === "write",
        asRemote: r.asRemote,
        provider: r.provider,
        repository: r.repository,
        requestedRef: r.requestedRef,
        resolvedSha: r.resolvedSha,
        baseRef: r.baseRef,
        headRef: r.headRef,
        linkId: r.linkId,
        linkExists: Boolean(link),
        linkAuthorizedVia: link?.authorizedVia ?? null,
        continuesBranch: r.access === "write" && branchRows.some((b) => b.name === r.name),
        pullRequestNumber: r.pullRequestNumber,
        mergeOrder: r.mergeOrder,
        result: r.result,
      };
    });
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

  async pullRequestMarkedReady(rootRunId: string, name?: string): Promise<boolean> {
    if (name !== undefined) {
      const row = await this.db.codingRunRepository.findUnique({
        where: { runId_name: { runId: rootRunId, name } },
        select: { markedReadyAt: true },
      });
      return Boolean(row?.markedReadyAt);
    }
    const root = await this.db.codingRun.findUnique({ where: { runId: rootRunId }, select: { markedReadyAt: true } });
    return Boolean(root?.markedReadyAt);
  }

  async pullRequestDescriptionBaseline(rootRunId: string, name?: string): Promise<StoredDescriptionBaseline> {
    if (name !== undefined) return this.repositoryDescriptionBaseline(rootRunId, name);
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

  /**
   * The baseline of an extra repository's pull request: the root run's row of that name. Rows are
   * newer than recorded description hashes, so there is never a legacy description to rebuild.
   */
  private async repositoryDescriptionBaseline(rootRunId: string, name: string): Promise<StoredDescriptionBaseline> {
    const row = await this.db.codingRunRepository.findUnique({
      where: { runId_name: { runId: rootRunId, name } },
      select: { prDescriptionSha256: true, prDescriptionRunId: true, result: true },
    });
    if (!row) throw new Error("coding_run_not_found");
    const agentTextRunId = row.prDescriptionRunId ?? rootRunId;
    const source =
      agentTextRunId === rootRunId
        ? row.result
        : (
            await this.db.codingRunRepository.findUnique({
              where: { runId_name: { runId: agentTextRunId, name } },
              select: { result: true },
            })
          )?.result;
    const previousAgentText = storedSummary(source);
    return {
      recordedSha256: row.prDescriptionSha256,
      ...(previousAgentText !== undefined ? { previousAgentText } : {}),
      agentTextRunId,
    };
  }

  async delegatingEventTask(runId: string): Promise<string | null> {
    const row = await this.db.run.findUnique({ where: { id: runId }, select: { trigger: true, parentRunId: true } });
    if (row?.trigger !== "subagent" || !row.parentRunId) return null;
    const parent = await this.db.run.findUnique({
      where: { id: row.parentRunId },
      select: { trigger: true, taskOverride: true },
    });
    return parent?.trigger === "host_event" ? parent.taskOverride : null;
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
        select: {
          parentRunId: true,
          taskOverride: true,
          hostStatus: { select: { provider: true, repository: true, number: true } },
        },
      });
      if (!parent) break;
      if (parent.hostStatus) {
        const { provider, repository, number } = parent.hostStatus;
        hostStatus = {
          provider,
          repository,
          number,
          issueMention: provider === "github" && isIssueMentionTask(parent.taskOverride, repository, number),
        };
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
    name?: string;
  }): Promise<boolean> {
    if (input.name !== undefined) {
      const row = await this.db.codingRunRepository.updateMany({
        where: { runId: input.rootRunId, name: input.name, prDescriptionSha256: input.expectedSha256 },
        data: { prDescriptionSha256: input.sha256, prDescriptionRunId: input.agentTextRunId },
      });
      return row.count === 1;
    }
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

  async requeueAfterCapacityRefusal(
    runId: string,
    owned: { claimId?: string; planned?: JobHandle },
  ): Promise<CapacityRequeueOutcome> {
    const holds = [
      ...(owned.claimId ? [{ jobBackend: PROVISIONING_BACKEND, jobHandle: owned.claimId }] : []),
      ...(owned.planned ? [{ jobBackend: owned.planned.backend, jobHandle: owned.planned.id }] : []),
    ];
    if (holds.length === 0) return "not_owned";
    try {
      return await this.db.$transaction(async (tx): Promise<CapacityRequeueOutcome> => {
        const run = await tx.run.findUnique({ where: { id: runId }, select: { startedAt: true } });
        if (!run) return "not_owned";
        // queuedAt is the dispatch time, not now: claimProvisioning clears it on every claim, and a
        // fresh value per refusal would keep a run the cluster refuses forever from timing out.
        const released = await tx.codingRun.updateMany({
          where: { runId, OR: holds, run: { status: { in: ["pending", "running"] } } },
          data: { jobBackend: null, jobHandle: null, queuedAt: run.startedAt },
        });
        if (released.count !== 1) return "not_owned";
        // The pod never started, so its session served no request. A run has one session, and the
        // next attempt creates its own: drop this one, but never one with spend recorded against it.
        const session = await tx.codingProxySession.findUnique({
          where: { runId },
          select: { id: true, _count: { select: { requests: true } } },
        });
        if (session && session._count.requests > 0) throw new NotRequeuedError("spend_recorded");
        if (session) await tx.codingProxySession.delete({ where: { id: session.id } });
        const waiting = await tx.run.updateMany({
          where: { id: runId, status: { in: ["pending", "running"] } },
          data: { status: "pending", heartbeatAt: null },
        });
        // Ended (stopped, say) since the release above: roll the release back too.
        if (waiting.count !== 1) throw new NotRequeuedError("not_owned");
        return "requeued";
      });
    } catch (err) {
      if (err instanceof NotRequeuedError) return err.outcome;
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

  async complete(
    runId: string,
    status: "succeeded" | "budget_exhausted",
    result: CodingRunResult,
    record: CodingRunRecord = {},
    extras?: ExtraPublishRecord[],
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
        data: { result, resultSchema: CODING_PROTOCOL_VERSION, ...codingRunRecordData(record) },
      });
      if (extras) await writeExtraRecords(tx, runId, extras);
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
    // Only the write that made the row terminal emits (never throws).
    if (finished) await emitRunCompletedEvent(this.db, runId);
  }

  async completePartially(
    runId: string,
    input: {
      mainResult: CodingRunResult | null;
      record: CodingRunRecord;
      extras: ExtraPublishRecord[];
      error: string;
      audit: CodingFailureAudit;
    },
  ): Promise<void> {
    const finishedAt = new Date();
    const agentId = await this.db.$transaction(async (tx) => {
      const ended = await tx.run.updateMany({
        where: { id: runId, status: { in: ["pending", "running"] } },
        data: { status: "failed", error: input.error, finishedAt, heartbeatAt: new Date() },
      });
      if (!ended.count) return null;
      await tx.codingRun.update({
        where: { runId },
        data: {
          ...(input.mainResult ? { result: input.mainResult, resultSchema: CODING_PROTOCOL_VERSION } : {}),
          ...codingRunRecordData(input.record),
          failureCategory: input.audit.failureCategory,
          diagnosticId: input.audit.diagnosticId,
        },
      });
      await writeExtraRecords(tx, runId, input.extras);
      const row = await tx.run.findUnique({ where: { id: runId }, select: { agentId: true } });
      return row?.agentId ?? null;
    });
    if (!agentId) return;
    await this.selfDefect({ id: runId, agentId, status: "failed", error: input.error, finishedAt });
    await emitRunCompletedEvent(this.db, runId);
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

  topUpBudget(runId: string): Promise<{ outcome: TopUpOutcome; near?: boolean }> {
    return topUpCodingBudget(this.db, runId);
  }

  async terminate(
    runId: string,
    status: "failed" | "refused" | "lost" | "budget_exhausted" | "cancelled",
    error: string,
    audit?: CodingFailureAudit,
  ): Promise<boolean> {
    const finishedAt = new Date();
    let changed = false;
    const agentId = await this.db.$transaction(async (tx) => {
      const updated = await tx.run.updateMany({
        where: { id: runId, status: { in: ["pending", "running"] } },
        data: { status, error, finishedAt, heartbeatAt: new Date() },
      });
      if (!updated.count) return null;
      changed = true;
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
    if (changed) await emitRunCompletedEvent(this.db, runId);
    return changed;
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
    /** The run's pinned MCP tools; set with mcpTokenHash, only when the agent has at least one. */
    mcpTools?: McpToolPin[];
    /** The hash of the run's MCP token (src/coding/mcp-token.ts); the token itself stays in the vault. */
    mcpTokenHash?: string;
    /** The run's run-steps level (Run.runStepsLevel); the proxy reads tool output only at detail. */
    runStepsLevel?: RunStepsLevel;
  }): Promise<{ id: string; capability: string }>;
  cancelSession(sessionId: string): Promise<void>;
  /** Whether the proxy refused a request of this session for budget. */
  budgetExhausted?(sessionId: string): Promise<boolean>;
  /** The code of the first model-provider failure the proxy relayed for this session, if any. */
  upstreamFailure?(sessionId: string): Promise<string | null>;
}

/**
 * Plain capabilities live only for the short provisioning window. A run with MCP tools keeps its
 * MCP token here too, next to the capability, so the launcher delivers it the same way; both are
 * deleted together.
 */
export class RunCapabilityVault {
  private readonly values = new Map<string, string>();
  private readonly mcpTokens = new Map<string, string>();

  set(runId: string, capability: string): void {
    if (this.values.has(runId)) throw new Error("coding_capability_exists");
    this.values.set(runId, capability);
  }

  async get(runId: string): Promise<string> {
    const capability = this.values.get(runId);
    if (!capability) throw new Error("coding_capability_unavailable");
    return capability;
  }

  setMcpToken(runId: string, token: string): void {
    if (this.mcpTokens.has(runId)) throw new Error("coding_mcp_token_exists");
    this.mcpTokens.set(runId, token);
  }

  /** The run's MCP token; undefined for a run without MCP tools (and once the launch is over). */
  async mcpToken(runId: string): Promise<string | undefined> {
    return this.mcpTokens.get(runId);
  }

  delete(runId: string): void {
    this.values.delete(runId);
    this.mcpTokens.delete(runId);
  }
}

export interface ContainerExecutorOptions {
  /** Session resume: stores a run's transcript before its job is removed. Absent = never captured. */
  transcripts?: Pick<RunTranscriptRecorder, "record">;
  store: ContainerExecutionStore;
  jobs: WorkspaceJobLauncher;
  vcs: VcsProvider;
  sessions: CodingSessionController;
  capabilities: RunCapabilityVault;
  /**
   * The agent's MCP tool pins (composition wires loadMcpToolPins; [] when WARDBY_MCP_SERVERS=off).
   * Absent = no coding run gets MCP tools. A run with pins gets an MCP token, delivered as
   * WARDBY_MCP_TOKEN; one without gets neither. `readOnlyOnly` comes from the run's dispatched
   * provider (isCodexCoding(run.provider)), never the agent's current profile.
   */
  mcpToolPins?: (agentId: string, options: { readOnlyOnly: boolean }) => Promise<McpToolPin[]>;
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
  /**
   * Claude Code runs' per-command time limits (CODING_BASH_DEFAULT_TIMEOUT_MS / CODING_BASH_MAX_TIMEOUT_MS),
   * capped per run at its timeoutSec in jobSpec; DEFAULT_CLAUDE_COMMAND_TIMEOUT_MS for both when absent.
   */
  claudeCommandTimeouts?: ClaudeCommandTimeouts;
  pollMinMs?: number;
  pollMaxMs?: number;
  /** How often to beat the heartbeat during a long launch; defaults to a third of the reconciler's timeout. */
  heartbeatIntervalMs?: number;
  /**
   * The entry cap over every prepared repository of a run with several (throws
   * vcs_workspace_entry_limit). Test hook; defaults to countWorkspaceEntries.
   */
  countEntries?: (paths: string[]) => Promise<void>;
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
/** The poll interval, at most, while a run with an overrun limit is near its grant. */
export const TOP_UP_NEAR_POLL_MS = 1_000;

export interface RegistryReport {
  packages: Array<{ ecosystem: string; name: string; version: string; acceptedAdvisories?: string[] }>;
  packageRefusals: Array<{ ecosystem: string; name: string; reason: string; listingOnly?: boolean }>;
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

/** An extra repository row with no resolved commit (or a writable one without its refs): refused before any clone. */
export const CODING_REPOSITORY_UNRESOLVED_ERROR = "coding_repository_unresolved";

/**
 * A stored row the executor cannot trust is refused (fail closed): an access that is neither read nor
 * write, or a writable row on another branch than the run's, which is the one it would be pushed to.
 */
function assertRowWellFormed(run: ContainerRunSnapshot, extra: RunRepositorySnapshot): void {
  if (!extra.accessKnown) throw new PreflightError(CODING_REPOSITORY_UNRESOLVED_ERROR);
  // A writable row without its branch is never pushed (dispatch always stores the run's).
  if (extra.access === "write" && extra.headRef !== run.headRef) {
    throw new PreflightError(CODING_REPOSITORY_UNRESOLVED_ERROR);
  }
}

/** A refusal by repository authorization; its message is the failure category's prefix (repo_access_*). */
class RepoAccessError extends PreflightError {}

export class ContainerExecutor implements Executor {
  private readonly artifactRoot: string;
  private readonly active = new Map<string, Promise<void>>();
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly observer: CodingRunObserver;
  private readonly startedAt = new Map<string, number>();
  /**
   * When the cluster last refused each queued run's launch for capacity (this.now() ms). Per
   * process: another replica's drain may start the run again inside the backoff.
   */
  private readonly capacityRefusedAt = new Map<string, number>();

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
    // Refused for capacity a moment ago: keep its place and clock in the queue, untouched.
    if (this.inCapacityBackoff(runId)) return;
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
    // Persist the cancellation fence first so a concurrent finisher cannot publish.
    const failure = this.failure("cancelled", { cancelled: true });
    // False when the run reached a terminal status after the load above: its finisher owns the
    // cleanup and the continuation comment (recover() cleans up any terminal run the reconciler sees
    // later), so stopping now would overwrite a good outcome. "stopping" is emitted only once this
    // stop owns the run, so it is always followed by its terminal and cleanup events.
    if (!(await this.options.store.terminate(runId, "cancelled", failure.error, failure.audit))) return;
    this.emit({ stage: "stopping", runId, jobId: run.jobHandle?.id });
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
    if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
    const target = workspace ?? this.continuationTargetOf(run);
    if (target) await this.options.vcs.notifyContinuationFinished?.(target, "failed", { agentName: run.agentName });
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
    if (status.state === "pending" && status.capacityRefused && this.options.store.requeueAfterCapacityRefusal) {
      return this.finishCapacityRequeue(run, run.jobHandle);
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
    // Every workspace held once the default one is ready (the extras are added as each is prepared).
    let workspaces: RunWorkspaces | null = null;
    let sessionId = run.proxySessionId;
    let handle = run.jobHandle;
    let claimId: string | null = null;
    let planned: JobHandle | undefined;
    let spendEnabled = Boolean(sessionId);
    try {
      // A launched run resumed after a restart is checked the way recover() checks it: its cost so
      // far may be past the limit (a reply can cost more than its hold), and it is still delivered.
      const prepared = this.preflight(run, { launched: Boolean(handle) });
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
      // A slow clone (large repository, cold host) outlives HEARTBEAT_TIMEOUT_MS just as a launch can.
      const toPrepare = run;
      // A launched run's job already has its read-only copies; only its writable extras are recovered.
      const pending = run.repositories.filter((extra) => !(handle && extra.access === "read"));
      workspace = await this.whileHeartbeating(runId, async () => {
        // Every repository is authorized, and every extra row checked, before anything is cloned.
        await this.authorizeRepository(toPrepare, { inFlight: Boolean(handle) });
        await this.authorizeExtras(toPrepare, { inFlight: Boolean(handle) });
        for (const extra of pending) this.extraPreflight(toPrepare, extra);
        try {
          const found = await this.options.vcs.recoverWorkspace(prepared);
          if (!found && handle) throw new Error("coding_workspace_lost");
          const ready = found ?? (await this.options.vcs.prepareWorkspace(prepared));
          if (pending.length === 0) this.emit({ stage: "prepared", runId });
          return ready;
        } catch (error) {
          if (!spendEnabled && !handle) throw new PreflightError(safeError(error), { cause: error });
          throw error;
        }
      });
      if (pending.length > 0) {
        const held: RunWorkspaces = { main: workspace, writable: new Map(), readOnly: [] };
        workspaces = held;
        const [extrasRun, launched] = [run, Boolean(handle)];
        await this.whileHeartbeating(runId, async () => {
          try {
            await this.prepareExtras(extrasRun, pending, held, launched);
          } catch (error) {
            if (!spendEnabled && !launched) throw new PreflightError(safeError(error), { cause: error });
            throw error;
          }
        });
        this.emit({ stage: "prepared", runId });
      }
      await this.options.vcs.notifyContinuationStarted?.(workspace, { agentName: run.agentName });

      if (!handle) {
        if (sessionId) throw new Error("coding_ambiguous_provisioning");
        const beforeSession = await this.requireCurrent(runId);
        if (TERMINAL_STATUSES.has(beforeSession.status)) throw new Error("coding_run_no_longer_active");
        const deadlineAt = new Date(this.now().getTime() + run.timeoutSec * 1_000);
        // The agent's MCP tools, pinned for the run; only a run with some gets a token. The token is
        // never logged: only its hash goes to the session, the value only into the vault.
        // A Codex run's shell commands can read the token, so it gets read-only tools only; decided by
        // the provider the run was dispatched with, which is what jobSpec launches. A failed read fails
        // the run with a fixed code (the cause goes to the operator log only, redacted).
        let mcpTools: McpToolPin[];
        try {
          mcpTools =
            (await this.options.mcpToolPins?.(run.agentId, { readOnlyOnly: isCodexCoding(run.provider) })) ?? [];
        } catch (error) {
          throw new Error(MCP_PINS_UNAVAILABLE_ERROR, { cause: error });
        }
        const mcpToken = mcpTools.length > 0 ? mintMcpToken() : undefined;
        const session = await this.options.sessions.createSession({
          runId,
          credentialRef: this.credentialRef(run.provider),
          protocol: proxyProtocol(run.provider),
          allowedModels: [run.model],
          deadlineAt,
          budgetUsd: run.budgetUsd,
          terms: this.modelTerms(run),
          ...(mcpToken ? { mcpTools, mcpTokenHash: mcpTokenHash(mcpToken) } : {}),
          ...(run.runStepsLevel ? { runStepsLevel: run.runStepsLevel } : {}),
        });
        spendEnabled = true;
        sessionId = session.id;
        this.options.capabilities.set(runId, session.capability);
        if (mcpToken) this.options.capabilities.setMcpToken(runId, mcpToken);
        const [inputRun, inputWorkspaces] = [run, workspaces ?? { main: workspace, writable: new Map(), readOnly: [] }];
        const inputArtifact = await this.whileHeartbeating(runId, () =>
          this.writeInput(inputRun, deadlineAt, inputWorkspaces),
        );
        const beforeLaunch = await this.requireCurrent(runId);
        if (TERMINAL_STATUSES.has(beforeLaunch.status)) throw new Error("coding_run_no_longer_active");
        const spec = this.jobSpec(run, inputArtifact, workspaces, { mcpTools: Boolean(mcpToken) });
        // Backends whose handle is derivable (Kubernetes) persist it first, so a crash between the
        // launch and the write still leaves a handle `abandon()` can stop and remove the run with.
        planned = this.options.jobs.plannedHandle?.(spec);
        if (planned) await this.options.store.persistHandle(runId, claimId!, planned);
        handle = await this.whileHeartbeating(runId, () => this.options.jobs.launch(spec));
        if (planned && (planned.backend !== handle.backend || planned.id !== handle.id)) {
          throw new Error("coding_job_handle_mismatch");
        }
        await this.options.store.persistHandle(runId, claimId!, handle);
        this.capacityRefusedAt.delete(runId);
        this.options.capabilities.delete(runId);
        this.emit({ stage: "launched", runId, jobId: handle.id, budgetReservedUsd: run.budgetUsd });
      }

      let delay = this.options.pollMinMs ?? 250;
      const maximumDelay = this.options.pollMaxMs ?? 5_000;
      let observedRunning = false;
      // Overrun from available room: asked on each poll until it is granted in full or refused once.
      let asksForTopUps = run.budgetLimitUsd !== undefined && run.budgetLimitUsd > run.budgetUsd;
      for (;;) {
        const status = await this.options.jobs.status(handle);
        if (status.state !== "pending" && status.state !== "running") {
          await this.finishTerminal(run, handle, status.state, workspaces ?? workspace, sessionId);
          return;
        }
        if (status.state === "running" && !observedRunning) {
          observedRunning = true;
          this.emit({ stage: "running", runId, jobId: handle.id });
        }
        await this.options.store.heartbeat(runId);
        if (asksForTopUps && this.options.store.topUpBudget) {
          const topUp = await this.options.store.topUpBudget(runId).catch((error: unknown) => {
            containerLog.warn({ runId, error: safeError(error) }, "coding run top-up failed; asking again next poll");
            return { outcome: "not_needed" as const, near: true };
          });
          if (topUp.outcome === "unavailable" || topUp.outcome === "closed") asksForTopUps = false;
          // Near its grant: poll often, so the next step lands before a request no longer fits.
          else if (topUp.near) delay = Math.min(delay, TOP_UP_NEAR_POLL_MS);
        }
        await this.sleep(delay);
        delay = Math.min(maximumDelay, Math.max(delay + 1, Math.ceil(delay * 1.5)));
        run = (await this.options.store.load(runId)) ?? run;
        if (TERMINAL_STATUSES.has(run.status)) return;
      }
    } catch (error) {
      this.options.capabilities.delete(runId);
      if (error instanceof JobCapacityError && claimId && this.options.store.requeueAfterCapacityRefusal) {
        // The cluster has no room for the pod (Kubernetes: the namespace quota): the run waits in
        // the queue again rather than failing. The launcher already removed what it created, so
        // there is no job to stop; nothing ran, so the session is dropped with the claim and a
        // fresh one is made on the next attempt.
        if (sessionId) await this.options.sessions.cancelSession(sessionId).catch(() => undefined);
        const requeued = await this.options.store.requeueAfterCapacityRefusal(runId, {
          claimId,
          ...(planned ? { planned } : {}),
        });
        if (requeued !== "spend_recorded") {
          if (workspace) await this.cleanupWorkspaces(run, workspaces ?? workspace);
          if (requeued === "requeued") {
            // The next attempt writes its own input; this one names a session that is gone.
            await rm(this.artifactPath(runId), { recursive: true, force: true }).catch(() => undefined);
            this.recordCapacityRefusal(runId);
            this.emit({ stage: "queued", runId });
            containerLog.info({ runId }, "coding run waiting for capacity: the cluster refused its pod");
          }
          return;
        }
        // Spend against a pod that never started: fail it like any launch error, and stop and remove
        // the launcher's record through the planned handle so the run is never launched again.
        if (planned) handle = planned;
      }
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
        await this.cleanupWorkspaces(run, workspaces ?? workspace);
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
    // Checked first: a local repository is otherwise authorized by the trusted roots alone.
    if (run.viaRepositoryLink && !run.repositoryLinkExists) throw new RepoAccessError("repo_access_not_authorized");
    const sameRepository = run.profileRepository !== null && run.profileRepository === run.repository;
    const authorizedVia = run.viaRepositoryLink
      ? run.repositoryLinkAuthorizedVia
      : sameRepository
        ? run.repositoryAuthorizedVia
        : "host_permission";
    const decision = await this.options.repoAccess.authorizeUse({
      ownerId: run.ownerId,
      provider: codeProviderOf(run.repository),
      repository: run.repository,
      required: requiredLevel("coding"),
      authorizedVia,
      retryTransient: opts.inFlight,
    });
    if (!decision.ok) throw new RepoAccessError(`repo_access_${decision.reason}`);
  }

  /**
   * Every extra repository through the same gate, read rows included: the GitHub allowlist is a
   * hard limit for every row, whatever its stamp, and it may have narrowed since the root run, so a
   * continuation is checked again too. A row whose link is gone (or changed access, or gained a
   * trigger) is not authorized. Throws RepoAccessError for the first denied row.
   */
  private async authorizeExtras(run: ContainerRunSnapshot, opts: { inFlight: boolean; only?: string }): Promise<void> {
    for (const extra of run.repositories) {
      // `only` scopes the check to one row by name: one row's denial must not fail every publish.
      if (opts.only !== undefined && extra.name !== opts.only) continue;
      assertRowWellFormed(run, extra);
      if (!extra.linkExists) throw new RepoAccessError("repo_access_not_authorized");
      const decision = await this.options.repoAccess.authorizeUse({
        ownerId: run.ownerId,
        provider: extra.provider,
        repository: extra.repository,
        required: requiredLevel(extra.access === "read" ? "coding_read" : "coding"),
        authorizedVia: extra.linkAuthorizedVia,
        retryTransient: opts.inFlight,
      });
      if (!decision.ok) throw new RepoAccessError(`repo_access_${decision.reason}`);
    }
  }

  /**
   * What one extra repository is prepared from. A read row is one commit's files (no branch, no
   * protected paths, nothing collected). A write row is a workspace in its own slot on the run's
   * branch, with the run's protected paths and collection exclusions; in a continuation it continues
   * the branch only when an earlier run of the tree already made it, and otherwise creates the
   * root's branch name off its base. Throws PreflightError("coding_repository_unresolved") for a row
   * dispatch never resolved.
   */
  private extraPreflight(
    run: ContainerRunSnapshot,
    extra: RunRepositorySnapshot,
  ): { kind: "read"; input: ReadOnlyCopyInput } | { kind: "write"; input: VcsPrepareInput } {
    assertRowWellFormed(run, extra);
    if (!extra.resolvedSha) throw new PreflightError(CODING_REPOSITORY_UNRESOLVED_ERROR);
    if (extra.access === "read") {
      return {
        kind: "read",
        input: { runId: run.runId, name: extra.name, repository: extra.repository, commit: extra.resolvedSha },
      };
    }
    if (!extra.baseRef || !extra.headRef) throw new PreflightError(CODING_REPOSITORY_UNRESOLVED_ERROR);
    // The run's own protected paths and exclusions, validated the way the default repository's are.
    const main = this.preflight(run, { launched: true });
    const root = run.rootCodingRunId;
    return {
      kind: "write",
      input: {
        runId: run.runId,
        repository: extra.repository,
        baseRef: extra.baseRef,
        headRef: run.headRef,
        protectedPaths: main.protectedPaths,
        collectExclude: main.collectExclude,
        slot: { name: extra.name },
        continuation: extra.continuesBranch && root ? { rootRunId: root } : undefined,
        ...(root && !extra.continuesBranch ? { branchRunId: root } : {}),
      },
    };
  }

  /**
   * The extras beside the prepared default workspace, EXTRA_PREPARE_CONCURRENCY at a time, each added
   * to `held` as soon as it is ready so a failure part way still cleans up what was made. A launched
   * run's writable extras must still be there (coding_workspace_lost otherwise), as its default one
   * must. Then the entry cap over every repository together, for a run being prepared fresh.
   */
  private async prepareExtras(
    run: ContainerRunSnapshot,
    pending: readonly RunRepositorySnapshot[],
    held: RunWorkspaces,
    launched: boolean,
  ): Promise<void> {
    const vcs = this.options.vcs;
    await mapWithConcurrency(pending, EXTRA_PREPARE_CONCURRENCY, async (extra) => {
      const plan = this.extraPreflight(run, extra);
      if (plan.kind === "read") {
        if (!vcs.prepareReadOnlyCopy) throw new Error("vcs_read_only_unsupported");
        held.readOnly.push(await vcs.prepareReadOnlyCopy(plan.input));
        return;
      }
      const found = await vcs.recoverWorkspace(plan.input);
      if (!found && launched) throw new Error("coding_workspace_lost");
      held.writable.set(extra.name, found ?? (await vcs.prepareWorkspace(plan.input)));
    });
    if (launched) return;
    await (this.options.countEntries ?? countWorkspaceEntries)([
      held.main.workspacePath,
      ...[...held.writable.values()].map((w) => w.workspacePath),
      ...held.readOnly.map((c) => c.workspacePath),
    ]);
  }

  /**
   * Removes a run's workspaces. Held ones are removed one by one (each removal is idempotent, so
   * order does not matter), then the default workspace, recovered from the run when not held.
   * Removing the default workspace removes the whole run directory, extras and read-only copies
   * included, so a run whose extras are not held here (a recovered or terminal run) needs nothing
   * more. Never throws. Returns the default workspace, when there was one.
   */
  private async cleanupWorkspaces(
    run: ContainerRunSnapshot,
    held: PreparedWorkspace | RunWorkspaces | null | undefined,
  ): Promise<PreparedWorkspace | null> {
    const vcs = this.options.vcs;
    if (isRunWorkspaces(held)) {
      for (const extra of held.writable.values()) await vcs.cleanup(extra).catch(() => undefined);
      for (const copy of held.readOnly) await vcs.cleanupReadOnlyCopy?.(copy).catch(() => undefined);
    }
    let main = isRunWorkspaces(held) ? held.main : (held ?? null);
    if (!main) {
      const input = this.preflightForCleanup(run);
      main = input ? await vcs.recoverWorkspace(input).catch(() => null) : null;
    }
    if (main) await vcs.cleanup(main).catch(() => undefined);
    return main;
  }

  /**
   * The CodingRun's recorded issue as the Related section shows it (a Jira or
   * GitHub issue): control-plane data from the CodingRun row, key re-validated.
   */
  private recordedIssue(
    run: Pick<ContainerRunSnapshot, "issueProvider" | "issueKey">,
  ): { key: string; url?: string; trackerName?: string } | undefined {
    const { issueProvider, issueKey } = run;
    if (!issueProvider || !issueKey) return undefined;
    return issueReference(issueProvider, issueKey, (key) => this.options.issueUrl?.(issueProvider, key));
  }

  /**
   * The originating tracker issue for the PR title/body. A GitHub issue is not
   * one: its line comes from issueSourceFor (`From issue #N`).
   */
  private issueFor(run: Pick<ContainerRunSnapshot, "issueProvider" | "issueKey">): {
    issue?: { key: string; url?: string; trackerName?: string };
  } {
    if (run.issueProvider === "github") return {};
    const issue = this.recordedIssue(run);
    return issue ? { issue } : {};
  }

  /**
   * The PR title/body's originating issue, whichever system it is in: the
   * CodingRun's tracker issue (issueFor), else the GitHub issue in the same
   * repository whose mention started the run tree (`From issue #N`). Read from
   * the root run, so a continuation's rebuilt body keeps the root's line.
   * Never throws: a failed lookup gives no issue line.
   */
  private async issueSourceFor(
    run: Pick<ContainerRunSnapshot, "runId" | "rootCodingRunId" | "repository" | "issueProvider" | "issueKey">,
  ): Promise<{ issue?: { key: string; url?: string; trackerName?: string }; issueNumber?: number }> {
    const tracker = this.issueFor(run);
    if (tracker.issue || !this.options.store.linkedIssueSource) return tracker;
    try {
      const status = (await this.options.store.linkedIssueSource(run.rootCodingRunId ?? run.runId)).hostStatus;
      if (
        status?.provider === "github" &&
        status.issueMention === true &&
        status.repository.toLowerCase() === run.repository.toLowerCase() &&
        Number.isSafeInteger(status.number) &&
        status.number > 0
      ) {
        return { issueNumber: status.number };
      }
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not find the issue the run came from");
    }
    return {};
  }

  /**
   * The new PR's Related pull requests input: earlier PRs of the same request, then `alsoPublished`
   * (the PRs this run already opened in its other repositories), then this one (`self`: the default
   * repository unless an extra's is given). Never throws.
   */
  private async relatedFor(
    run: ContainerRunSnapshot,
    alsoPublished: ReadonlyArray<{ repository: string; number: number; mergeOrder?: number }> = [],
    self: { repository: string; mergeOrder?: number | null } = {
      repository: run.repository,
      mergeOrder: run.mergeOrder,
    },
  ): Promise<{ related?: RelatedPullRequestsInput }> {
    // A continuation's Related block is preserved from the current body (the description update keeps it).
    if (run.rootCodingRunId || !this.options.store.relatedPullRequests) return {};
    try {
      const stored = await this.options.store.relatedPullRequests(run.runId);
      const listed = new Set(stored.map((pr) => `${pr.repository.toLowerCase()}#${pr.number}`));
      const earlier = [
        ...stored,
        ...alsoPublished.filter((pr) => !listed.has(`${pr.repository.toLowerCase()}#${pr.number}`)),
      ];
      if (earlier.length === 0) return {};
      const issue = this.recordedIssue(run);
      return {
        related: {
          entries: [
            ...earlier,
            {
              repository: self.repository,
              self: true,
              ...(self.mergeOrder != null ? { mergeOrder: self.mergeOrder } : {}),
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
   * `launched`: the run's job was already launched (it is running, or done and
   * only its push is left). The cost check applies only before launch: one
   * reply can cost more than its hold, so a launched run may already be past
   * its limit, and its finished work is still delivered.
   */
  private preflight(run: ContainerRunSnapshot, options: { launched?: boolean } = {}): VcsPrepareInput {
    try {
      if (run.status !== "pending" && run.status !== "running") throw new Error("coding_run_status_invalid");
      if (run.agentKind !== "coding" || !run.ownerId) throw new Error("coding_run_ownership_invalid");
      this.modelTerms(run);
      if (!Number.isFinite(run.budgetUsd) || run.budgetUsd <= 0 || (!options.launched && run.costUsd > run.budgetUsd)) {
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
    heldWorkspaces?: PreparedWorkspace | RunWorkspaces | null,
    existingSessionId?: string | null,
  ): Promise<void> {
    const existingWorkspace = isRunWorkspaces(heldWorkspaces) ? heldWorkspaces.main : heldWorkspaces;
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
    // Set when a continuation's merge of its target branch left conflict markers behind; names the file on the host.
    let conflictMarkersPath: string | undefined;
    // Set with a success whose push merged the pull request's target branch; says what on the host.
    let merged: { mergeSentence?: string } = {};
    // Set when a run stopped at its budget still pushed its changes so far; says so on the host.
    let changesPushed: { pullRequestNumber?: number; repository?: string } | undefined;
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
      if (output.outcome === "budget_exhausted" && hasWritableExtras(current)) {
        this.emit({ stage: "budget_cutoff", runId: run.runId, jobId: handle.id });
        const kept = await this.keepStoppedChangesAll(handle, current, output, heldWorkspaces);
        await this.recordRefusal(run.runId, sessionId);
        const latest = await this.requireCurrent(run.runId).catch(() => kept.current);
        await this.options.store.complete(
          run.runId,
          "budget_exhausted",
          kept.main?.result ?? this.resultFor(output, latest, "budget_exhausted"),
          kept.main?.record ?? dependencyCacheRecord(output),
          kept.extras,
        );
        for (const pushed of kept.pushed) this.emit({ stage: pushed.outcome, runId: run.runId, jobId: handle.id });
        this.terminal(latest, "budget_exhausted");
        // Kept changes in any writable repository are reported: the default repository's first, else
        // the first extra's (named by its repository, since the comment is on the default one's PR).
        const reported = kept.main?.finalized ?? kept.pushed[0];
        if (reported) {
          changesPushed =
            reported.outcome === "branch_pushed"
              ? {}
              : {
                  pullRequestNumber: reported.pullRequestNumber,
                  ...(kept.main ? {} : { repository: reported.repository }),
                };
        }
        if (kept.main) {
          const mainFinalized = kept.main.finalized;
          if (mainFinalized.outcome === "pull_request_updated" && mainFinalized.targetMerge) {
            merged = { mergeSentence: mergeSentence(mainFinalized.targetMerge) };
          }
        }
        if (kept.pushed.length > 0) finishedSummary = output.summary;
        outcome = "budget_exhausted";
        return;
      }
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
          if (kept.finalized.outcome === "pull_request_updated" && kept.finalized.targetMerge) {
            merged = { mergeSentence: mergeSentence(kept.finalized.targetMerge) };
          }
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
      // Several repositories: each writable one is collected and diffed here, whatever the worker said.
      if (hasWritableExtras(current)) {
        const published = await this.publishAll(run, handle, current, output, heldWorkspaces, sessionId);
        outcome = published.outcome;
        if (published.outcome === "succeeded") {
          overrun = this.overrunDetails(published.current);
          const mainFinalized = published.main;
          if (mainFinalized?.outcome === "pull_request_updated" && mainFinalized.targetMerge) {
            merged = { mergeSentence: mergeSentence(mainFinalized.targetMerge) };
          }
          finishedSummary = output.summary;
        }
        return;
      }
      // A workspace that merged its target branch has that merge to push even when the agent changed nothing.
      if (output.outcome === "no_changes" && !(await this.mergedTargetBranch(current, existingWorkspace))) {
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
      if (finalized.outcome === "pull_request_updated" && finalized.targetMerge) {
        merged = { mergeSentence: mergeSentence(finalized.targetMerge) };
      }
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
        conflictMarkersPath = conflictMarkersPathFromError(error) ?? undefined;
      }
    } finally {
      if (run.sessionResume) await this.recordTranscript(run, handle);
      await this.options.jobs.remove(handle).catch(() => undefined);
      const workspace = await this.cleanupWorkspaces(run, heldWorkspaces);
      // A run another process launched has no workspace here; its pull request still gets the final status.
      const target = workspace ?? this.continuationTargetOf(run);
      if (target) {
        await this.options.vcs.notifyContinuationFinished?.(target, outcome, {
          summary: finishedSummary,
          agentName: run.agentName,
          ...(outcome === "succeeded" ? { ...merged, ...overrun } : {}),
          ...(outcome === "budget_exhausted" ? { budgetSentence: await this.budgetSentence(run) } : {}),
          ...(outcome === "budget_exhausted" && changesPushed ? { changesPushed, ...merged } : {}),
          ...(outcome === "failed" && providerClass ? { providerSentence: providerSentence(providerClass) } : {}),
          ...(outcome === "failed" && protectedPath
            ? { protectedPathSentence: protectedPathSentence(protectedPath) }
            : {}),
          ...(outcome === "failed" && conflictMarkersPath
            ? { conflictMarkersSentence: conflictMarkersSentence(conflictMarkersPath) }
            : {}),
        });
      }
      await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
      this.emit({ stage: "cleanup", runId: run.runId, jobId: handle.id, cleanupSucceeded: true });
      await this.notifyTerminal(run.runId);
    }
  }

  /** Whether the run's workspace merged its pull request's target branch (PreparedWorkspace.targetMerge). */
  private async mergedTargetBranch(
    run: ContainerRunSnapshot,
    existingWorkspace: PreparedWorkspace | null | undefined,
  ): Promise<boolean> {
    if (!run.rootCodingRunId) return false;
    if (existingWorkspace) return Boolean(existingWorkspace.targetMerge);
    try {
      return Boolean((await this.options.vcs.recoverWorkspace(this.preflight(run, { launched: true })))?.targetMerge);
    } catch {
      return false;
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
    options: { keepDescription?: boolean } = {},
  ): Promise<{
    current: ContainerRunSnapshot;
    workspace: PreparedWorkspace;
    finalized: Awaited<ReturnType<VcsProvider["finalizeChanges"]>>;
    descriptionState: DescriptionState;
  }> {
    const preparedInput = this.preflight(collectedFor, { launched: true });
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
    // keepDescription: a continuation's existing description is left as it is (no update, no proposal).
    const descriptionState = options.keepDescription ? null : await this.descriptionStateFor(current);
    const finalized = await this.options.vcs.finalizeChanges(workspace, {
      summary,
      tests: output.tests,
      tag: output.tag,
      ...report,
      ...restoredDependenciesFor(output),
      ...(await this.issueSourceFor(current)),
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
   * the work is unfinished. A fresh pull request's description starts with that
   * summary; a continuation leaves its pull request's description alone (the
   * status comment says the run stopped), and pushes nothing onto a pull request
   * that is no longer a draft. Null when there was nothing to push or the push
   * failed or was skipped for any reason: the run then ends out of budget without
   * them. Once pushed, the pushed outcome is always returned. Throws only when the
   * run was stopped meanwhile (the stop wrote its terminal row).
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
    const summary = budgetStoppedSummary(output.summary, current.request);
    const continuesPullRequest = Boolean(current.rootCodingRunId) && hasPullRequestDescription(current);
    let pushed: Awaited<ReturnType<ContainerExecutor["pushChanges"]>>;
    try {
      let workspace = existingWorkspace;
      if (continuesPullRequest) {
        workspace ??= await this.options.vcs.recoverWorkspace(this.preflight(current, { launched: true }));
        if (!workspace) throw new Error("coding_workspace_lost");
        if (!(await this.continuationStillDraft(current, workspace))) {
          containerLog.info(
            { runId: run.runId },
            "a run stopped at its budget pushes nothing onto a pull request that is no longer a draft",
          );
          return null;
        }
      }
      pushed = await this.pushChanges(run, handle, current, output, summary, workspace, {
        keepDescription: continuesPullRequest,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "coding_run_no_longer_active") throw error;
      containerLog.warn(
        { runId: run.runId, reason: describeFailure(error) },
        "could not push the changes of a run stopped at its budget; it ends without them",
      );
      return null;
    }
    const { finalized } = pushed;
    if (finalized.outcome === "no_changes") return null;
    // Pushed: from here on the run records the pushed outcome whatever else fails.
    const description = await this.recordDescription(
      pushed.current,
      pushed.descriptionState,
      finalized.outcome === "pull_request_opened" || finalized.outcome === "pull_request_updated"
        ? finalized.description
        : undefined,
    ).catch((): CodingRunRecord => ({}));
    let result: CodingRunResult;
    try {
      result = this.resultFor({ ...output, summary }, pushed.current, finalized.outcome, finalized);
    } catch (error) {
      containerLog.warn(
        { runId: run.runId, reason: describeFailure(error) },
        "could not record the worker's summary and tests of a budget-stopped run; recording its push alone",
      );
      result = this.resultFor(
        {
          ...output,
          summary: budgetStoppedSummary(WORKER_BUDGET_EXHAUSTED_SUMMARY, current.request),
          tests: [],
          tag: undefined,
        },
        pushed.current,
        finalized.outcome,
        finalized,
      );
    }
    return {
      current: pushed.current,
      finalized,
      result,
      record: { ...dependencyCacheRecord(output), ...pushedRecord(finalized), ...description },
    };
  }

  /**
   * A run with several repositories (#537): every writable repository is collected and diffed here,
   * whatever the worker reported, then published one at a time, the default repository first and then
   * each writable extra by position, each with its own branch, description and merge order. One
   * repository's failure is its own: the rest are still tried, and what published stays published.
   * Every repository published (or had nothing to publish): the run succeeds. Some published and some
   * failed: it ends failed as partially_published. None published and one failed: that failure is
   * thrown, as for a run with one repository. Throws coding_run_no_longer_active when the run was
   * stopped meanwhile.
   */
  private async publishAll(
    run: ContainerRunSnapshot,
    handle: JobHandle,
    current: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    held: PreparedWorkspace | RunWorkspaces | null | undefined,
    sessionId: string | null | undefined,
  ): Promise<{ outcome: "succeeded" | "failed"; current: ContainerRunSnapshot; main?: FinalizeResult }> {
    const slots = await this.repositorySlots(current, held);
    await this.collectWritable(handle, current, slots);
    const done: RepositoryPublish[] = [];
    let latest = current;
    for (const slot of slots) {
      if (slot.error !== undefined || !slot.workspace) continue;
      try {
        const publish = await this.publishRepository(current, output, { ...slot, workspace: slot.workspace }, done, {
          summary: (text) => text,
        });
        latest = publish.current;
        done.push(publish);
      } catch (error) {
        if (isNoLongerActive(error)) throw error;
        slot.error = error;
      }
    }
    const failed = slots.filter((slot) => slot.error !== undefined);
    const pushed = done.flatMap((publish) => (publish.finalized.outcome === "no_changes" ? [] : [publish.finalized]));
    if (pushed.length === 0 && failed.length > 0) throw failed[0].error;
    const records = await this.publishRecords(current, output, done, { budgetStopped: false });
    await this.recordRefusal(run.runId, sessionId);
    if (failed.length === 0) {
      // The default repository did not fail, so it has a result.
      await this.options.store.complete(run.runId, "succeeded", records.mainResult!, records.record, records.extras);
      for (const finalized of pushed) this.emit({ stage: finalized.outcome, runId: run.runId, jobId: handle.id });
      this.terminal(latest, "succeeded");
      return { outcome: "succeeded", current: latest, ...(records.main ? { main: records.main } : {}) };
    }
    // Each failure is logged under its own diagnostic id; Run.error names categories only.
    const failures = failed.map((slot) => this.failure(slot.error));
    const statusOf = (slot: RepositorySlot): RepositoryPublishStatus =>
      slot.error !== undefined
        ? `failed(${failureCategory(slot.error)})`
        : done.some((publish) => publish.slot.name === slot.name && publish.finalized.outcome !== "no_changes")
          ? "published"
          : "no_changes";
    const statuses = slots.map((slot) => ({ name: slot.name, status: statusOf(slot) }));
    const error = partiallyPublishedError(statuses);
    const audit = { failureCategory: PARTIALLY_PUBLISHED_CATEGORY, diagnosticId: failures[0].audit.diagnosticId };
    containerLog.warn(
      { runId: run.runId, diagnosticId: audit.diagnosticId, statuses: error },
      "coding run published some of its repositories; the others failed",
    );
    await this.options.store.completePartially(run.runId, {
      mainResult: records.mainResult,
      record: records.record,
      extras: records.extras,
      error,
      audit,
    });
    for (const finalized of pushed) this.emit({ stage: finalized.outcome, runId: run.runId, jobId: handle.id });
    this.terminal(latest, "failed", audit);
    return { outcome: "failed", current: latest };
  }

  /**
   * A run with several repositories stopped at its budget keeps each writable repository's changes so
   * far, the way keepStoppedChanges keeps the default one's: each pushed as its usual draft (or
   * branch) with the unfinished-work summary, nothing pushed onto a continued pull request that is no
   * longer a draft. A repository that fails is left out, alone. Throws only when the run was stopped
   * meanwhile.
   */
  private async keepStoppedChangesAll(
    handle: JobHandle,
    current: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    held: PreparedWorkspace | RunWorkspaces | null | undefined,
  ): Promise<{
    current: ContainerRunSnapshot;
    main?: {
      finalized: Exclude<FinalizeResult, { outcome: "no_changes" }>;
      result: CodingRunResult;
      record: CodingRunRecord;
    };
    extras: ExtraPublishRecord[];
    pushed: Exclude<FinalizeResult, { outcome: "no_changes" }>[];
  }> {
    let slots: RepositorySlot[];
    try {
      slots = await this.repositorySlots(current, held);
      await this.collectWritable(handle, current, slots);
    } catch (error) {
      if (isNoLongerActive(error)) throw error;
      containerLog.warn(
        { runId: current.runId, reason: describeFailure(error) },
        "could not collect the changes of a run stopped at its budget; it ends without them",
      );
      return { current, extras: [], pushed: [] };
    }
    const kept: RepositoryPublish[] = [];
    for (const slot of slots) {
      const reason = (error: unknown) => ({
        runId: current.runId,
        repository: slot.name,
        reason: describeFailure(error),
      });
      if (slot.error !== undefined || !slot.workspace) {
        containerLog.warn(reason(slot.error), "could not keep one repository's changes of a run stopped at its budget");
        continue;
      }
      const view = slot.extra ? extraView(current, slot.extra) : current;
      const continuesPullRequest = Boolean(view.rootCodingRunId) && hasPullRequestDescription(view);
      try {
        if (continuesPullRequest && !(await this.continuationStillDraft(view, slot.workspace, slot.extra?.name))) {
          containerLog.info(
            { runId: current.runId, repository: slot.name },
            "a run stopped at its budget pushes nothing onto a pull request that is no longer a draft",
          );
          continue;
        }
        const publish = await this.publishRepository(current, output, { ...slot, workspace: slot.workspace }, kept, {
          summary: (text) => budgetStoppedSummary(text, current.request),
          keepDescription: continuesPullRequest,
        });
        if (publish.finalized.outcome !== "no_changes") kept.push(publish);
      } catch (error) {
        if (isNoLongerActive(error)) throw error;
        containerLog.warn(reason(error), "could not keep one repository's changes of a run stopped at its budget");
      }
    }
    const records = await this.publishRecords(current, output, kept, { budgetStopped: true });
    const main = kept.find((publish) => !publish.slot.extra);
    return {
      current: main?.current ?? current,
      ...(main && records.mainResult && records.main && records.main.outcome !== "no_changes"
        ? { main: { finalized: records.main, result: records.mainResult, record: records.record } }
        : {}),
      extras: records.extras,
      pushed: kept.flatMap((publish) => (publish.finalized.outcome === "no_changes" ? [] : [publish.finalized])),
    };
  }

  /**
   * The writable repositories of a run with several, in publish order: the default one, then each
   * writable extra by position, each with its workspace (held, else recovered). A read repository is
   * never collected. A repository whose workspace is gone fails alone (coding_workspace_lost).
   */
  private async repositorySlots(
    run: ContainerRunSnapshot,
    held: PreparedWorkspace | RunWorkspaces | null | undefined,
  ): Promise<RepositorySlot[]> {
    const vcs = this.options.vcs;
    const slots: RepositorySlot[] = [];
    const main = isRunWorkspaces(held) ? held.main : held;
    try {
      const workspace = main ?? (await vcs.recoverWorkspace(this.preflight(run, { launched: true })));
      if (!workspace) throw new Error("coding_workspace_lost");
      slots.push({ name: RESERVED_REPOSITORY_NAME, workspace });
    } catch (error) {
      slots.push({ name: RESERVED_REPOSITORY_NAME, error });
    }
    const writable = run.repositories.filter((extra) => extra.access === "write");
    for (const extra of [...writable].sort((a, b) => a.position - b.position)) {
      try {
        let workspace = isRunWorkspaces(held) ? held.writable.get(extra.name) : undefined;
        if (!workspace) {
          const plan = this.extraPreflight(run, extra);
          workspace = (plan.kind === "write" ? await vcs.recoverWorkspace(plan.input) : null) ?? undefined;
        }
        if (!workspace) throw new Error("coding_workspace_lost");
        slots.push({ name: extra.name, extra, workspace });
      } catch (error) {
        slots.push({ name: extra.name, extra, error });
      }
    }
    return slots;
  }

  /**
   * Copies each writable repository's folder out of the finished job into its workspace (a failure
   * is that repository's alone), then caps the entries of every collected folder together: the run's
   * 100,000 entries cover all its repositories, whichever launcher collected them. Over the cap,
   * nothing is published (vcs_workspace_entry_limit).
   */
  private async collectWritable(handle: JobHandle, run: ContainerRunSnapshot, slots: RepositorySlot[]): Promise<void> {
    const collected: string[] = [];
    for (const slot of slots) {
      if (slot.error !== undefined || !slot.workspace) continue;
      try {
        await this.options.jobs.materializeWorkspace(handle, slot.workspace.workspacePath, slot.extra?.name);
        await normalizeCollectedLockfiles(run.provider, slot.workspace.workspacePath);
        collected.push(slot.workspace.workspacePath);
      } catch (error) {
        slot.error = error;
      }
    }
    await (this.options.countEntries ?? countWorkspaceEntries)(collected);
  }

  /**
   * Publishes one repository of a run with several: right before its push, the owner's access to just
   * this repository is checked again and the run must still be active; then finalizeChanges with this
   * repository's own description, title, Related section (the run's pull requests published so far
   * before it) and merge order. Throws whatever stops it.
   */
  private async publishRepository(
    collectedFor: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    slot: RepositorySlot & { workspace: PreparedWorkspace },
    published: readonly RepositoryPublish[],
    options: { summary: (text: string) => string; keepDescription?: boolean },
  ): Promise<RepositoryPublish> {
    const latest = await this.requireCurrent(collectedFor.runId);
    // One row's denial fails only that row.
    if (slot.extra) await this.authorizeExtras(latest, { inFlight: true, only: slot.extra.name });
    else await this.authorizeRepository(latest, { inFlight: true });
    this.requireActive(await this.requireCurrent(collectedFor.runId));
    const view = slot.extra ? extraView(latest, slot.extra) : latest;
    const note = pullRequestNoteFor(output, slot.name);
    // An explicit order wins (the default repository's existing one first); otherwise the run's pull
    // requests are numbered after the order it inherited, in publish order, never past the last step
    // (99). So with an inherited order the default repository keeps it and the extras number from the
    // step after its own (inherited 3: the default 3, the first extra 5), which may leave a gap.
    // publishRecords keeps the number only when two or more repositories pushed; a lone push records
    // soleMergeOrder, as a run with one repository would.
    const pushedSoFar = published.filter((publish) => publish.finalized.outcome !== "no_changes");
    const numbered = Math.min(MAX_MERGE_ORDER, (latest.mergeOrder ?? 0) + pushedSoFar.length + 1);
    const mergeOrder = slot.extra
      ? (note?.mergeOrder ?? numbered)
      : (latest.mergeOrder ?? note?.mergeOrder ?? numbered);
    const soleMergeOrder = slot.extra
      ? (note?.mergeOrder ?? latest.mergeOrder ?? null)
      : (latest.mergeOrder ?? note?.mergeOrder ?? null);
    const agentOutput: CodingWorkerOutput = {
      ...output,
      summary: options.summary(note?.description ?? output.summary),
      tag: note?.title ?? output.tag,
    };
    const descriptionState = options.keepDescription ? null : await this.descriptionStateFor(view, slot.extra?.name);
    const alsoPublished = pushedSoFar.flatMap((publish) =>
      publish.finalized.outcome === "pull_request_opened" || publish.finalized.outcome === "pull_request_updated"
        ? [
            {
              repository: publish.finalized.repository,
              number: publish.finalized.pullRequestNumber,
              mergeOrder: publish.mergeOrder,
            },
          ]
        : [],
    );
    const finalized = await this.options.vcs.finalizeChanges(slot.workspace, {
      summary: agentOutput.summary,
      tests: output.tests,
      tag: agentOutput.tag,
      ...(await this.pullRequestRegistryReport(latest)),
      // The dependency cache restores the default repository's folders only.
      ...(slot.extra ? {} : restoredDependenciesFor(output)),
      ...(await this.issueSourceFor(view)),
      ...(await this.relatedFor(latest, alsoPublished, { repository: view.repository, mergeOrder })),
      ...(descriptionState && "baseline" in descriptionState
        ? { description: { baseline: descriptionState.baseline } }
        : {}),
    });
    return { slot, finalized, current: latest, view, agentOutput, descriptionState, mergeOrder, soleMergeOrder };
  }

  /**
   * What a run with several repositories records: the default repository's result and columns on the
   * run, each other one's on its row. A repository with nothing to publish records its no_changes
   * result; one that failed records nothing. A budget stop records a pushed repository whose summary
   * or tests cannot be recorded with its push alone (as keepStoppedChanges does).
   */
  private async publishRecords(
    run: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    done: readonly RepositoryPublish[],
    options: { budgetStopped: boolean },
  ): Promise<{
    mainResult: CodingRunResult | null;
    main?: FinalizeResult;
    record: CodingRunRecord;
    extras: ExtraPublishRecord[];
  }> {
    let mainResult: CodingRunResult | null = null;
    let main: FinalizeResult | undefined;
    let record: CodingRunRecord = dependencyCacheRecord(output);
    const extras: ExtraPublishRecord[] = [];
    // Numbered only when the run pushed two or more repositories; a lone push keeps a single run's order.
    const several = done.filter((publish) => publish.finalized.outcome !== "no_changes").length >= 2;
    for (const publish of done) {
      const { finalized, view, slot } = publish;
      const mergeOrder = several ? publish.mergeOrder : publish.soleMergeOrder;
      const pushed = finalized.outcome !== "no_changes";
      const name = slot.extra?.name;
      const description = !pushed
        ? await this.refreshDescriptionInTime(view, publish.agentOutput, slot.workspace, name)
        : await this.recordDescription(view, publish.descriptionState, descriptionOutcomeOf(finalized), name).catch(
            (): CodingRunRecord => ({}),
          );
      if (slot.extra && pushed && !view.rootCodingRunId && run.rootCodingRunId) {
        await this.recordFirstExtraDescription(run, slot.extra.name, description);
      }
      const result = this.publishedResult(publish, options.budgetStopped);
      if (!slot.extra) {
        mainResult = result;
        main = finalized;
        record = {
          ...record,
          ...(pushed ? pushedRecord(finalized) : {}),
          ...description,
          ...(pushed && run.mergeOrder == null && mergeOrder != null ? { mergeOrder } : {}),
        };
        continue;
      }
      extras.push({
        id: slot.extra.id,
        name: slot.extra.name,
        result,
        pullRequestNumber:
          finalized.outcome === "pull_request_opened" || finalized.outcome === "pull_request_updated"
            ? finalized.pullRequestNumber
            : null,
        resultBranch: finalized.outcome === "branch_pushed" ? finalized.headRef : null,
        baseSha: pushed ? finalized.baseCommit : null,
        mergeOrder: pushed ? mergeOrder : null,
        ...(description.prDescriptionOutcome ? { prDescriptionOutcome: description.prDescriptionOutcome } : {}),
        ...(description.prDescriptionSha256 && description.prDescriptionRunId
          ? { prDescriptionSha256: description.prDescriptionSha256, prDescriptionRunId: description.prDescriptionRunId }
          : {}),
      });
    }
    return { mainResult, ...(main ? { main } : {}), record, extras };
  }

  /** One repository's result; a budget stop's falls back to its push alone when its summary or tests cannot be recorded. */
  private publishedResult(publish: RepositoryPublish, budgetStopped: boolean): CodingRunResult {
    const { finalized, view, agentOutput } = publish;
    try {
      return this.resultFor(agentOutput, view, finalized.outcome, finalized);
    } catch (error) {
      if (!budgetStopped) throw error;
      containerLog.warn(
        { runId: view.runId, reason: describeFailure(error) },
        "could not record the worker's summary and tests of a budget-stopped run; recording its push alone",
      );
      return this.resultFor(
        {
          ...agentOutput,
          summary: budgetStoppedSummary(WORKER_BUDGET_EXHAUSTED_SUMMARY, view.request),
          tests: [],
          tag: undefined,
        },
        view,
        finalized.outcome,
        finalized,
      );
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
  /**
   * `task` with the original request of the event-started lead that delegated
   * this fresh run (see withOriginalRequest). Unchanged for a continuation, for
   * a run no event-started lead delegated, or on any failure: the run goes
   * ahead without it. Logs counts only, never text.
   */
  private async originalRequestFor(run: ContainerRunSnapshot, task: string): Promise<string> {
    const store = this.options.store;
    if (run.rootCodingRunId || !store.delegatingEventTask) return task;
    let leadTask: string | null;
    try {
      leadTask = await store.delegatingEventTask(run.runId);
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not read the lead's original request; continuing without it");
      return task;
    }
    const added = withOriginalRequest(task, originalRequestOf(leadTask), run.request);
    if (added.outcome === "no_room") {
      containerLog.warn(
        { event: "coding.original_request_omitted", runId: run.runId, taskBytes: Buffer.byteLength(task, "utf8") },
        "the coding task left no room for the lead's original request",
      );
    }
    return added.task;
  }

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
    // The closing keyword names a GitHub issue: no other host's repository has one to read.
    const closed =
      codeProviderOf(run.repository) === "github" ? closingIssueNumber(description, run.repository) : undefined;
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
  /**
   * Whether a continuation's pull request is still a draft: the host's answer
   * when it has one, else the root run's record of wardby marking it ready
   * (`name`: an extra repository's pull request, recorded on the root's row of
   * that name). A failed record lookup counts as not a draft (nothing
   * unfinished is pushed).
   */
  private async continuationStillDraft(
    run: ContainerRunSnapshot,
    workspace: PreparedWorkspace,
    name?: string,
  ): Promise<boolean> {
    const draft = await this.options.vcs.continuationPullRequestDraft?.(workspace).catch(() => undefined);
    if (draft !== undefined) return draft;
    const store = this.options.store;
    if (!run.rootCodingRunId || !store.pullRequestMarkedReady) return true;
    try {
      return !(await store.pullRequestMarkedReady(run.rootCodingRunId, ...(name !== undefined ? [name] : [])));
    } catch (err) {
      containerLog.warn({ err, runId: run.runId }, "could not read whether the pull request was marked ready");
      return false;
    }
  }

  /** `name`: an extra repository's pull request, whose baseline is the root run's row of that name. */
  private async descriptionStateFor(run: ContainerRunSnapshot, name?: string): Promise<DescriptionState> {
    const store = this.options.store;
    if (!run.rootCodingRunId || !hasPullRequestDescription(run) || !store.pullRequestDescriptionBaseline) return null;
    let stored: StoredDescriptionBaseline;
    try {
      stored = await store.pullRequestDescriptionBaseline(run.rootCodingRunId, ...(name !== undefined ? [name] : []));
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
   * kept wardby's text compare-and-sets the root's hash. Never throws. With
   * `name` (an extra repository), the root's row of that name holds the hash.
   */
  private async recordDescription(
    run: ContainerRunSnapshot,
    state: DescriptionState,
    outcome: DescriptionWriteOutcome | undefined,
    name?: string,
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
        ...(name !== undefined ? { name } : {}),
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
   * An extra repository whose first pull request a continuation opened: its description hash is
   * recorded on the root run's row of that name too (only while that row records none), where every
   * later round reads its baseline and mark-ready keeps its state. Never throws.
   */
  private async recordFirstExtraDescription(
    run: ContainerRunSnapshot,
    name: string,
    description: CodingRunRecord,
  ): Promise<void> {
    const store = this.options.store;
    const { prDescriptionSha256: sha256, prDescriptionRunId: agentTextRunId } = description;
    if (!run.rootCodingRunId || !sha256 || !agentTextRunId || !store.recordPullRequestDescription) return;
    try {
      const won = await store.recordPullRequestDescription({
        rootRunId: run.rootCodingRunId,
        expectedSha256: null,
        sha256,
        agentTextRunId,
        name,
      });
      if (!won) {
        containerLog.warn(
          { runId: run.runId, rootRunId: run.rootCodingRunId, repository: name },
          "the root run already records a description for this repository's pull request; not recorded",
        );
      }
    } catch (err) {
      containerLog.warn(
        { err, runId: run.runId, repository: name },
        "could not record the pull request description hash",
      );
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
    name?: string,
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
      return await Promise.race([this.refreshDescriptionWithoutPush(run, output, existingWorkspace, name), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A fix round that changed nothing still re-derives its PR description (no
   * push). Never throws: any failure is recorded as skipped:error. `name`: an
   * extra repository's pull request (`run` as extraView sees it, with its own
   * workspace), checked for access by that row alone.
   */
  private async refreshDescriptionWithoutPush(
    run: ContainerRunSnapshot,
    output: CodingWorkerOutput,
    existingWorkspace: PreparedWorkspace | null | undefined,
    name?: string,
  ): Promise<CodingRunRecord> {
    const vcs = this.options.vcs;
    if (!run.rootCodingRunId || !hasPullRequestDescription(run) || !vcs.refreshPullRequestDescription) return {};
    const state = await this.descriptionStateFor(run, name);
    if (!state || "failed" in state) return this.recordDescription(run, state, undefined, name);
    if (name !== undefined) {
      try {
        if (!existingWorkspace) throw new Error("coding_workspace_lost");
        await this.authorizeExtras(await this.requireCurrent(run.runId), { inFlight: true, only: name });
        const outcome = await vcs.refreshPullRequestDescription(existingWorkspace, {
          summary: output.summary,
          tests: output.tests,
          tag: output.tag,
          ...(await this.pullRequestRegistryReport(run)),
          ...(await this.issueSourceFor(run)),
          description: { baseline: state.baseline },
        });
        return await this.recordDescription(run, state, outcome, name);
      } catch (err) {
        containerLog.warn(
          { err, runId: run.runId, repository: name },
          "could not refresh the pull request description",
        );
        return { prDescriptionOutcome: "skipped:error" };
      }
    }
    try {
      const input = this.preflightForCleanup(run);
      // Only the pull request is needed: a run another process launched has no workspace here.
      const workspace =
        existingWorkspace ??
        (input ? await vcs.recoverWorkspace(input).catch(() => null) : null) ??
        this.continuationTargetOf(run);
      if (!workspace) throw new Error("coding_workspace_lost");
      // The same in-flight access check a push gets: a revoked owner's run edits nothing.
      // Reloaded: the snapshot passed in predates the description reads above, and a link removed since then counts.
      await this.authorizeRepository(await this.requireCurrent(run.runId), { inFlight: true });
      const details: FinalizeChangesDetails = {
        summary: output.summary,
        tests: output.tests,
        tag: output.tag,
        ...(await this.pullRequestRegistryReport(run)),
        ...restoredDependenciesFor(output),
        ...(await this.issueSourceFor(run)),
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
      // A listing-only refusal is for get_run and the agent, not the PR (see LISTING_REFUSAL_FILENAME).
      const packageRefusals = Array.isArray(report?.packageRefusals) ? warningRefusals(report.packageRefusals) : [];
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

  /** The commit a ref names (Executor.resolveCodingRepositoryRef). */
  async resolveCodingRepositoryRef(input: {
    repository: string;
    ref: string;
    access: "read" | "write";
  }): Promise<string | null> {
    return this.options.vcs.resolveRef ? this.options.vcs.resolveRef(input) : null;
  }

  /** One extra repository through the repository-access gate (Executor.authorizeCodingRepository). */
  authorizeCodingRepository(input: AuthorizeUseInput): Promise<RepoAccessDecision> {
    return this.options.repoAccess.authorizeUse(input);
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
   * Recovery's half of a capacity refusal: the launcher recorded it, but the process died before the
   * store put the run back in the queue. The planned handle the attempt persisted is the ownership
   * proof; the run waits in the queue again, never reported ended.
   */
  private async finishCapacityRequeue(run: ContainerRunSnapshot, planned: JobHandle): Promise<ExecutionRecoveryResult> {
    const outcome = await this.options.store.requeueAfterCapacityRefusal!(run.runId, { planned });
    if (outcome === "spend_recorded") {
      await this.abandon(run, "coding_ambiguous_provisioning");
      return { state: "lost", reason: "coding_ambiguous_provisioning" };
    }
    if (outcome === "not_owned") {
      const current = await this.options.store.load(run.runId);
      if (!current || !TERMINAL_STATUSES.has(current.status)) return { state: "active" };
      await this.cleanupTerminal(current);
      return { state: "terminal" };
    }
    // The session went with the requeue; the rest of what the dead attempt left is removed here.
    this.options.capabilities.delete(run.runId);
    const input = this.preflightForCleanup(run);
    const workspace = input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null;
    if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
    await rm(this.artifactPath(run.runId), { recursive: true, force: true }).catch(() => undefined);
    this.emit({ stage: "queued", runId: run.runId });
    containerLog.info({ runId: run.runId }, "coding run waiting for capacity: recovered a refusal its process left");
    return { state: "active" };
  }

  /**
   * After drainCodingQueue failed a queued run (coding_queue_timeout): releases what an earlier
   * attempt the cluster refused left behind, as stop() does for a queued run. A refused
   * continuation already marked its pull request as being worked on; that check is finished
   * here. Best effort; the artifact is removed only where this process wrote it.
   */
  async cleanupQueueTimeout(runId: string): Promise<void> {
    this.capacityRefusedAt.delete(runId);
    this.options.capabilities.delete(runId);
    const run = await this.options.store.load(runId);
    if (run) {
      const input = this.preflightForCleanup(run);
      const workspace = input ? await this.options.vcs.recoverWorkspace(input).catch(() => null) : null;
      if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
      const target = workspace ?? this.continuationTargetOf(run);
      if (target) await this.options.vcs.notifyContinuationFinished?.(target, "failed", { agentName: run.agentName });
    }
    await rm(this.artifactPath(runId), { recursive: true, force: true }).catch(() => undefined);
  }

  private recordCapacityRefusal(runId: string): void {
    const now = this.now().getTime();
    // Drop the ones whose backoff is over, so runs that never come back (timed out in the queue) do not pile up.
    for (const [id, at] of this.capacityRefusedAt) {
      if (now - at >= CAPACITY_RETRY_BACKOFF_MS) this.capacityRefusedAt.delete(id);
    }
    this.capacityRefusedAt.set(runId, now);
  }

  private inCapacityBackoff(runId: string): boolean {
    const at = this.capacityRefusedAt.get(runId);
    if (at === undefined) return false;
    if (this.now().getTime() - at < CAPACITY_RETRY_BACKOFF_MS) return true;
    this.capacityRefusedAt.delete(runId);
    return false;
  }

  /**
   * False when the launcher reports this run's job would not fit the cluster right now; the run
   * is then queued and drainCodingQueue retries it. Launchers and stores without the hooks, and
   * any error, answer true: the launch stays the authority.
   */
  private async fitsCluster(run: ContainerRunSnapshot): Promise<boolean> {
    const { jobs, store } = this.options;
    if (!jobs.hasCapacityFor || !store.markQueued) return true;
    // Asked before any workspace is prepared: the probe counts resources, which repositories don't change.
    const fits = await jobs
      .hasCapacityFor(this.jobSpec(run, CAPACITY_PROBE_INPUT, null, { capacityProbe: true }))
      .catch(() => true);
    if (fits) return true;
    await store.markQueued(run.runId);
    this.emit({ stage: "queued", runId: run.runId });
    return false;
  }

  /**
   * The run's job. `workspaces` holds its prepared extras (null for a run with none): each extra's
   * host path is the VCS's own workspacePath for it, never rebuilt here. Only a capacity probe, asked
   * before anything is prepared, goes without them, and its spec then lists no repositories.
   */
  private jobSpec(
    run: ContainerRunSnapshot,
    inputArtifact: string,
    workspaces: RunWorkspaces | null,
    options: { mcpTools?: boolean; capacityProbe?: boolean } = {},
  ): JobSpec {
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
      // Claude Code only: the launcher gives the SDK's config dir, where the session grows, its own scratch.
      ...(run.sessionResume && provider === "claude-code" ? { sessionResume: true as const } : {}),
      // Only for a run with MCP tools: the launcher then delivers WARDBY_MCP_TOKEN from the vault.
      ...(options.mcpTools ? { mcpTools: true as const } : {}),
      // Claude Code only: the tool runner's per-command limits, capped so no command outlives the run.
      ...(provider === "claude-code"
        ? {
            commandTimeouts: cappedClaudeCommandTimeouts(
              this.options.claudeCommandTimeouts ?? {
                defaultMs: DEFAULT_CLAUDE_COMMAND_TIMEOUT_MS,
                maxMs: DEFAULT_CLAUDE_COMMAND_TIMEOUT_MS,
              },
              run.timeoutSec,
            ),
          }
        : {}),
      timeoutSec: run.timeoutSec,
      limits: { ...this.options.limits, ...(run.workspaceDiskMb ? { diskMb: run.workspaceDiskMb } : {}) },
      labels: {},
      collectExclude: normalizeCollectExclusions(run.collectExclude),
      ...(services.length > 0 ? { services } : {}),
      ...(run.repositories.length > 0 && !options.capacityProbe
        ? { repositories: jobRepositories(run.repositories, workspaces) }
        : {}),
    };
  }

  private credentialRef(provider: string): string {
    if (provider === "codex") return this.options.credentialRef;
    if (provider === "claude-code" && this.options.anthropicCredentialRef) return this.options.anthropicCredentialRef;
    throw new Error("coding_provider_not_configured:claude-code");
  }

  private async writeInput(
    run: ContainerRunSnapshot,
    deadlineAt: Date,
    workspaces: RunWorkspaces,
    history?: GitHistoryForInput,
  ): Promise<string> {
    const workspace = workspaces.main;
    await ensurePrivateDirectory(this.artifactRoot);
    const rootReal = await realpath(this.artifactRoot);
    const directory = resolve(rootReal, run.runId);
    if (!directory.startsWith(`${rootReal}${sep}`)) throw new Error("coding_artifact_path_invalid");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== directory) throw new Error("coding_artifact_path_invalid");
    const destination = join(directory, "input.json");
    const temporary = join(directory, `.input-${randomUUID()}.tmp`);
    const services = parseStoredServices(run.services);
    // Each extra at the commit it was prepared at: the same values go into input.json's repositories
    // and, in full, into the task text (the worker's own note shortens them).
    const extras = run.repositories.map((r) => ({
      name: r.name,
      repository: r.repository,
      access: r.access,
      commit: r.access === "read" ? r.resolvedSha! : workspaces.writable.get(r.name)!.baseCommit,
      ...(history?.input.repositories.some((h) => h.path === `/repos/${r.name}`) ? { history: true } : {}),
    }));
    const withBase = withBaseCommit(run.task, workspace.baseCommit, history?.wording);
    const withCommit = withExtraRepositories(withBase, extras);
    if (extras.length > 0 && withCommit === withBase) {
      containerLog.warn(
        { event: "coding.extra_commits_omitted", runId: run.runId },
        "the coding task left no room for the extra repositories' commits",
      );
    }
    const description = await this.currentDescriptionText(run);
    // The ticket first, then the description: each is cut to what's left of the task's budget.
    // The target-branch merge note (conflicts to resolve) comes before the ticket and the description.
    const withMerge = withTargetMerge(withCommit, workspace.targetMerge, run.headRef);
    // A fresh run a lead delegated: the original request that started the lead (a continuation
    // has the linked issue below instead, so the two never both appear).
    const withOriginal = await this.originalRequestFor(run, withMerge);
    const task = withPullRequestDescription(
      withLinkedIssue(withOriginal, await this.linkedIssueFor(run, description)),
      description,
    );
    if (withBase === run.task && /^[0-9a-f]{40}$/.test(workspace.baseCommit)) {
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
        // The run's limit, not its grant: the proxy enforces the grant, and top-ups raise it while
        // the job runs. Claude Code's own budget stop (its SDK maxBudgetUsd) is set from this, so it
        // never stops a run before a top-up can; Codex has no stop of its own.
        budgetUsd: run.budgetLimitUsd ?? run.budgetUsd,
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
        // Only when on: every other run's input stays exactly what older workers expect.
        ...(run.sessionResume && run.provider === "claude-code" ? { sessionResume: true as const } : {}),
        // Only on a run with git history: every other run's input stays exactly what older workers expect.
        ...(history ? { gitHistory: history.input } : {}),
        // Only on a run with extra repositories: every other run's input stays exactly what older workers expect.
        ...(run.repositories.length > 0
          ? {
              repositories: extras.map((r) => ({
                name: r.name,
                path: `/repos/${r.name}`,
                access: r.access,
                repository: r.repository,
                commit: r.commit,
              })),
            }
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

  /**
   * A continuation's pull request from the run record alone, for the host-side
   * finish signals when the workspace is gone (another control-plane process
   * launched the run). Null for a fresh run: it has no pull request yet.
   */
  private continuationTargetOf(run: ContainerRunSnapshot): ContinuationTarget | null {
    if (!run.rootCodingRunId) return null;
    return {
      runId: run.runId,
      repository: run.repository,
      baseRef: run.baseRef,
      headRef: run.headRef,
      continuation: { rootRunId: run.rootCodingRunId },
    };
  }

  /**
   * Session resume: never throws, never changes the run's outcome. The recorder redacts; only a status
   * code is logged. The run capability is already gone from the vault, so it is not passed (the recorder
   * removes its fixed token shape).
   */
  private async recordTranscript(run: ContainerRunSnapshot, handle: JobHandle): Promise<void> {
    const recorder = this.options.transcripts;
    if (!recorder) return;
    const jobs = this.options.jobs;
    let timer: NodeJS.Timeout | undefined;
    try {
      const recording = Promise.resolve()
        .then(() =>
          recorder.record({
            runId: run.runId,
            agentId: run.agentId,
            provider: run.provider,
            read: (maxBytes) =>
              jobs.readTranscript ? jobs.readTranscript(handle, maxBytes) : Promise.resolve(undefined),
          }),
        )
        .catch(() => "failed" as const);
      const timeout = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), TRANSCRIPT_RECORD_TIMEOUT_MS);
        timer.unref();
      });
      const result = await Promise.race([recording, timeout]);
      if (result !== "stored") containerLog.info({ runId: run.runId, transcript: result }, "run transcript not stored");
    } catch {
      // never changes the run's outcome
    } finally {
      if (timer) clearTimeout(timer);
    }
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
    if (workspace) await this.options.vcs.cleanup(workspace).catch(() => undefined);
    const target = workspace ?? this.continuationTargetOf(run);
    if (target) await this.options.vcs.notifyContinuationFinished?.(target, "failed", { agentName: run.agentName });
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
        ...(outcome === "budget_exhausted" ? storedChangesPushed(run.result) : {}),
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
    const sentence = overrunSentence(run.costUsd, run.budgetBaseUsd, run.budgetLimitUsd ?? run.budgetUsd);
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
      limitUsd: run.budgetLimitUsd,
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
    this.capacityRefusedAt.delete(run.runId);
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

/** The agent's MCP tool pins could not be read at launch (a database error): the run fails, nothing launched. */
export const MCP_PINS_UNAVAILABLE_ERROR = "coding_mcp_pins_unavailable";
/** Its category: the run's error is coding_failure_mcp_pins_unavailable:<diagnostic id>. */
export const MCP_PINS_UNAVAILABLE_CATEGORY = "mcp_pins_unavailable";

/** Low-power mode: the native gateway serving a run's MCP tools did not wake; nothing launched. */
export const MCP_GATEWAY_UNAVAILABLE_CATEGORY = "mcp_gateway_unavailable";

/**
 * Error-code prefixes that name their category outright, checked before the
 * substring heuristics below. Those heuristics filed every `github_*` error
 * (a failed PR lookup or create after the push, a token mint) under
 * "workspace" because "github" contains "git".
 */
export const CATEGORY_BY_PREFIX: ReadonlyArray<readonly [prefix: string, category: string]> = [
  // Claude Code reached the agent's turn limit (codingProfile.maxTurns) before finishing.
  ["job_coding_turn_limit", "turn_limit"],
  // A service sidecar never became ready (src/providers/jobs/kubernetes.ts).
  [SERVICE_UNREADY_ERROR, SERVICE_UNREADY_CATEGORY],
  // Services on a launcher that can't start them: refused at dispatch, failed here as a backstop.
  ["coding_services_unsupported", "preflight"],
  // An extra repository dispatch never resolved to a commit: refused before anything is cloned.
  [CODING_REPOSITORY_UNRESOLVED_ERROR, "preflight"],
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
  // A continuation's target-branch merge (git.ts): conflict markers left in a
  // conflicted file, or a target branch that could not be fetched or merged.
  [CONFLICT_MARKERS_ERROR_PREFIX, MERGE_CONFLICT_CATEGORY],
  [TARGET_MERGE_FAILED_ERROR, TARGET_MERGE_CATEGORY],
  // A continuation whose pull request was merged or closed: nothing pushed (coding/continuation-wording.ts).
  [CONTINUATION_CLOSED_ERROR, CONTINUATION_CLOSED_CATEGORY],
  // A provider whose worker images this deployment doesn't configure (codex or claude-code): configuration.
  ["coding_provider_not_configured", "preflight"],
  // A GitHub repository on a server with no GitHub App: configuration, like an unsupported service.
  ["vcs_github_not_configured", "preflight"],
  // The same for any other host: a repository whose provider this server has not registered.
  ["vcs_host_provider_not_configured", "preflight"],
  ["vcs_", "workspace"],
  // The agent's MCP tool pins could not be read at launch: nothing was launched.
  [MCP_PINS_UNAVAILABLE_ERROR, MCP_PINS_UNAVAILABLE_CATEGORY],
  // Low-power mode: the native gateway serving the run's MCP tools did not wake (jobs/kubernetes.ts).
  [CODING_MCP_GATEWAY_UNAVAILABLE, MCP_GATEWAY_UNAVAILABLE_CATEGORY],
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
export function storedTests(value: unknown): Array<{ command: string; outcome: TestOutcome }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((test) => {
    const command = storedField(test, "command");
    const outcome = storedField(test, "outcome");
    return typeof command === "string" && isTestOutcome(outcome) ? [{ command, outcome }] : [];
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
