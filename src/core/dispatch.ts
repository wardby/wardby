import type { Prisma, PrismaClient, Run, RunTrigger, Task } from "#prisma";
import type { Executor } from "../providers/executor/types.js";
import {
  CODING_PROTOCOL_VERSION,
  CodingTaskInputSchema,
  normalizeGitHubRepository,
  normalizeGitRef,
  publicCodingRunResult,
  composeCodingTask,
} from "../coding/protocol.js";
import { assertCodingProvider, assertCodingProviderModel, type CodingProvider } from "../coding/provider.js";
import { ModelUnavailableError, entryOf, type ResolvedCatalogEntry } from "../providers/llm/catalog-types.js";
import { parseAllowedServiceNames, workerServices, type ResolvedCodingService } from "../coding/services/catalog.js";
import {
  MAX_SERVICE_DECLARATION_BYTES,
  ServiceDeclarationError,
  parseServiceDeclaration,
  type DeclaredService,
} from "../coding/services/declaration.js";
import { servicesInstructionNote } from "../coding/services/note.js";
import { resolveRunServices, type ServiceResolution } from "../coding/services/resolve.js";
import {
  DECLARATION_UNAVAILABLE_SENTENCE,
  LAUNCHER_UNSUPPORTED_SENTENCE,
  invalidDeclarationSentence,
  serviceRefusal,
} from "../coding/services/wording.js";
import { attributeRun, type AttributionIntent } from "./attribution.js";
import { effectiveBudgetForRun, MIN_RESERVATION_USD, type BudgetConstraint } from "./budget-groups.js";
import { DEFAULT_KNOWLEDGE_BUNDLE_PATH } from "../knowledge/concept.js";
import { KNOWLEDGE_INDEX_READ_MAX_BYTES, knowledgeSection, type KnowledgeNoteInput } from "../knowledge/note.js";
import { logger } from "./logger.js";
import { CodingModelProviderMismatchError, resolveCodingEntry } from "./run-pricing.js";
import { CONTENDED_TX_MAX_WAIT_MS } from "./timing.js";
import { fileSelfDefectForRun, type SelfDefectSink } from "./self-defects.js";

const dispatchLog = logger.child({ module: "dispatch" });

export type DispatchDb = Pick<
  PrismaClient,
  "agent" | "run" | "runHostCheck" | "codingRun" | "task" | "webhook" | "budgetGroup" | "$transaction" | "$queryRaw"
>;

export type DispatchTx = Pick<
  Prisma.TransactionClient,
  | "agent"
  | "run"
  | "runHostCheck"
  | "runHostStatus"
  | "runIssueStatus"
  | "codingRun"
  | "codingService"
  | "task"
  | "webhook"
  | "budgetGroup"
  | "resourceGrant"
  | "workItem"
  | "localPullRequest"
  | "runAttribution"
  | "$queryRaw"
  | "$executeRawUnsafe"
>;

type DispatchAgent = Prisma.AgentGetPayload<{ include: { codingProfile: true } }>;

export interface DispatchRunOptions {
  db: DispatchDb;
  executor: Executor;
  agentId: string;
  trigger?: RunTrigger;
  codingTask?: string;
  codingBaseRef?: string;
  /**
   * Revision-in-place: the id of a prior CodingRun whose branch/PR this
   * dispatch should push a new
   * commit onto instead of opening a fresh branch. Resolved and verified
   * here against the database (same repository, and it actually reached a
   * PR-opening outcome) -- never trusted as a raw branch name, and
   * deliberately not restricted to the same agent (cross-role continuation,
   * e.g. plan -> implement on one PR, is allowed by design). Mutually
   * exclusive with `codingBaseRef`. Coding agents only.
   */
  continuesCodingRunId?: string;
  now?: Date;
  lockAgent?: boolean;
  task?: { principalId: string; ttlMs: number };
  beforePersist?: (tx: DispatchTx, agent: DispatchAgent) => Promise<boolean>;
  /**
   * Runs inside the persist transaction right after the run row is created,
   * before the executor is started — for rows that must exist before the run
   * can observe them (e.g. RunHostCheck, see core/host-events.ts).
   */
  afterPersist?: (tx: DispatchTx, run: Run) => Promise<void>;
  /** Files a self-defect when the executor fails to start the run and this marks it failed. Optional. */
  selfDefects?: SelfDefectSink;
  /**
   * Who the run is visible to besides the agent owner (Run.triggeredById,
   * resource-sharing grants spec §3.5): the trigger_agent caller, a
   * webhook's creator, a sub-agent's parent triggerer. Omit/null for
   * scheduled and host-event runs, which only the owner sees.
   */
  triggeredById?: string | null;
  /** Sub-agent dispatch (see AgentSubAgent): links this run into a run tree. */
  parentRunId?: string;
  /**
   * Cost attribution for a run that starts a new attribution (issue event,
   * linked PR, explicit key), resolved before the call (attribution.ts
   * resolveWorkItem). Ignored when the parent run or the continued coding run
   * is attributed: inheritance wins.
   */
  attribution?: AttributionIntent;
  grantedParentMemoryKeys?: string[];
  /**
   * Per-run task text for a NATIVE agent (appended to its systemPrompt at
   * load time — see runner.ts). The native equivalent of `codingTask`;
   * mutually exclusive with it, since a native run has no CodingRun.
   */
  taskOverride?: string;
  /**
   * Replaces `agent.budgetUsd` as the requested ceiling for this run's coding
   * budget reservation. The reservation is still tightened by the agent's
   * budget group and, with `parentRunId`, the run tree (see
   * src/core/budget-groups.ts), computed inside the persist transaction.
   * Ignored for native agents, which compute their own effective budget
   * inside executeRun's load step.
   */
  budgetUsdOverride?: number;
  /**
   * Default (false/undefined): fire-and-forget, matching every existing
   * caller (webhook ingress, trigger_agent, the scheduler) — none of them
   * want to block on a potentially long-running coding container. Set true
   * only when the caller genuinely wants to await the run's terminal state,
   * e.g. a sub-agent dispatch tool blocking the parent's own turn.
   */
  awaitExecution?: boolean;
  /**
   * Called once, right after the persist transaction commits and before the
   * executor starts the run (refused and failed rows included): the moment
   * the run row is visible to other transactions. The runner releases its
   * delegation admission gate here, so a sibling delegation is admitted
   * while this one's coding run is still starting or queued.
   */
  onPersisted?: (run: Run) => void;
}

export interface DispatchRunResult {
  run: Run;
  task?: Task;
}

/** SQLSTATEs worth retrying the persist transaction for: serialization failure, deadlock. */
const RETRYABLE_SQLSTATES = new Set(["40001", "40P01"]);

/**
 * A transient transaction conflict in the Serializable persist transaction:
 * a serialization failure (40001) or a deadlock (40P01). It arrives in one of
 * three shapes:
 * - on a model statement: P2034;
 * - on a raw statement ($queryRaw, e.g. the FOR UPDATE SKIP LOCKED below, or
 *   anything a beforePersist callback runs): P2010, with the SQLSTATE at
 *   meta.driverAdapterError.cause.originalCode under the pg driver adapter
 *   (Prisma 7) -- Prisma 6's engine put 40001 at meta.code, still accepted;
 * - at COMMIT (e.g. SSI write skew): an unwrapped DriverAdapterError, no
 *   code or meta, with the SQLSTATE at cause.originalCode.
 * Also a unique violation (P2002) on WorkItem: concurrent first dispatches
 * attributed to one new issue each insert its WorkItem, and Postgres reports
 * the loser as 23505 rather than 40001. The retry finds the committed row.
 * Unique violations on other models are real errors and are not retried.
 *
 * @internal Exported only for the real-PostgreSQL tests.
 */
export function isSerializationConflict(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as {
    name?: unknown;
    code?: unknown;
    cause?: { originalCode?: unknown };
    meta?: { code?: unknown; modelName?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } };
  };
  if (candidate.code === "P2034") return true;
  if (candidate.code === "P2002") return candidate.meta?.modelName === "WorkItem";
  if (candidate.code === "P2010") {
    const sqlState = candidate.meta?.driverAdapterError?.cause?.originalCode;
    return (typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState)) || candidate.meta?.code === "40001";
  }
  if (candidate.name === "DriverAdapterError") {
    const sqlState = candidate.cause?.originalCode;
    return typeof sqlState === "string" && RETRYABLE_SQLSTATES.has(sqlState);
  }
  return false;
}

/**
 * Prisma's interactive-transaction error (P2028): no pooled connection within
 * `maxWait` ("Unable to start a transaction in the given time"), or the
 * transaction outlived its timeout. Either way nothing was committed, so the
 * caller can retry or queue.
 */
export function isTransactionUnavailable(err: unknown): boolean {
  return Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "P2028");
}

/**
 * Record an executor-level failure on a run that never reached a terminal
 * state itself. Deliberately idempotent: the same failure can arrive twice —
 * DbosExecutor.start() calls this when the workflow handle rejects, and
 * dispatchRun's `.catch` around that same `start()` call calls it again — and
 * the conditional `updateMany` makes the second call match zero rows rather
 * than overwrite whatever landed in between.
 */
export async function markRunFailedFromExecutorError(
  db: Pick<DispatchDb, "run">,
  runId: string,
  err: unknown,
  selfDefects?: SelfDefectSink,
): Promise<void> {
  const updated = await db.run.updateMany({
    where: { id: runId, status: { in: ["pending", "running"] } },
    data: {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      finishedAt: new Date(),
    },
  });
  // Only the call that made the row failed files (the duplicate call matches zero rows); bounded, never throws.
  if (updated.count > 0) await fileSelfDefectForRun(selfDefects, runId);
}

/**
 * The `Run.error` of a coding run refused at dispatch because a budget
 * constraint has nothing left: `budget_group_exhausted:<period>` or
 * `run_tree_exhausted`, then a sentence for people.
 */
export function budgetExhaustedError(constraint: BudgetConstraint): string {
  if (constraint === "run-tree") {
    return "run_tree_exhausted: the run tree's shared budget is spent; the run was not started.";
  }
  return (
    `budget_group_exhausted:${constraint}: the agent's budget group has no ${constraint} budget left ` +
    "(recorded spend plus live in-flight runs' holds have reached its cap); the run was not started."
  );
}

/**
 * Serializes grouped coding dispatches (security review I1). Under
 * Serializable, a row lock taken after the transaction's first read cannot
 * queue anything: the snapshot is already fixed, so each waiter wakes up
 * with a stale view and aborts. LOCK TABLE is the one statement that takes
 * no snapshot, so as the transaction's first statement it makes a waiter's
 * snapshot start only after the previous holder committed. SHARE ROW
 * EXCLUSIVE conflicts with itself and with writes to BudgetGroup rows, but not
 * with the ROW SHARE that foreign-key checks from Agent take, so attaching
 * agents to groups is not blocked. It serializes grouped coding dispatches
 * across all groups; each holds it only for one short transaction.
 */
const GROUP_DISPATCH_LOCK_SQL = 'LOCK TABLE "BudgetGroup" IN SHARE ROW EXCLUSIVE MODE';

/**
 * A coding run's budget reservation: the requested ceiling (override or the
 * agent's budgetUsd) tightened by its budget group and run tree, where every
 * live in-flight run's unspent hold already counts as spent. Rounded down to
 * CodingRun.budgetReservedUsd's 6 decimal places; less than that is refused.
 */
async function reserveCodingBudget(
  tx: DispatchTx,
  agent: DispatchAgent,
  now: Date,
  options: DispatchRunOptions,
): Promise<{ budgetUsd: number; refusal?: string }> {
  const effective = await effectiveBudgetForRun(tx, agent, now, options.parentRunId);
  const requested = options.budgetUsdOverride ?? Number(agent.budgetUsd);
  const budgetUsd =
    Math.floor(Math.min(requested, effective.effectiveBudgetUsd) / MIN_RESERVATION_USD) * MIN_RESERVATION_USD;
  if (budgetUsd < MIN_RESERVATION_USD && effective.exhaustedBy) {
    return { budgetUsd: 0, refusal: budgetExhaustedError(effective.exhaustedBy) };
  }
  return { budgetUsd };
}

/**
 * Attempts for the persist transaction, and the jittered backoff between
 * them, for serialization failures, deadlocks and transactions that could
 * not start in time (P2028).
 *
 * @internal Exported only for the real-PostgreSQL tests.
 */
export const PERSIST_ATTEMPTS = 8;
const RETRY_BASE_MS = 20;
const RETRY_MAX_MS = 250;

function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
  return Math.floor(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** The branch a coding run works on: its base, and for a continuation, the root's head and id. */
interface CodingBranch {
  baseRef: string;
  headRef?: string;
  continuationOf?: { runId: string };
  rootCodingRunId?: string;
}

export type ContinuationRefusal = "unknown_run" | "other_repository" | "no_pull_request" | "other_owner";

const CONTINUATION_REFUSALS: Readonly<Record<ContinuationRefusal, string>> = {
  unknown_run: "Cannot continue an unknown coding run.",
  other_repository: "Cannot continue a coding run from a different repository.",
  no_pull_request: "Cannot continue a coding run that never opened a pull request.",
  other_owner: "Cannot continue a coding run opened by a different owner's agent.",
};

/** A continuation refused because of the run it names. Its message is fixed text, safe to show the model. */
export class ContinuationRefusedError extends Error {
  constructor(readonly reason: ContinuationRefusal) {
    super(CONTINUATION_REFUSALS[reason]);
    this.name = "ContinuationRefusedError";
  }
}

export type ContinuationCheck =
  | { ok: true; root: { runId: string; baseRef: string; headRef: string; pullRequestNumber: number } }
  | { ok: false; reason: ContinuationRefusal };

/** Carries the root's opening agent's owner along with the row, for the same-owner check below. */
const CONTINUATION_ROOT_INCLUDE = { run: { select: { agent: { select: { ownerId: true } } } } } as const;

/**
 * Whether this deployment can continue coding run `runId` in `repository`: the
 * run (or its root) is in this database, in that repository, and opened a pull
 * request. A run id read from a pull request can name a run that another
 * deployment sharing the same App made, so check before relying on one.
 *
 * `dispatchingOwnerId`, when given (even `null`), additionally fails closed
 * unless the root's opening agent has that exact owner: a sibling-hint or a
 * PR's own marker names a run id, but nothing stops it naming a run opened by
 * another owner's agent in the same repository, and continuing that run would
 * let this dispatch push to a PR another owner's agent controls. `undefined`
 * skips the check for callers that only ask "does this deployment know this
 * run at all" (a user-facing refusal message, not a dispatch).
 */
export async function checkContinuation(
  reader: Pick<DispatchTx, "codingRun">,
  runId: string,
  repository: string,
  dispatchingOwnerId?: string | null,
): Promise<ContinuationCheck> {
  const candidate = await reader.codingRun.findUnique({ where: { runId }, include: CONTINUATION_ROOT_INCLUDE });
  if (!candidate) return { ok: false, reason: "unknown_run" };
  const root = candidate.rootCodingRunId
    ? await reader.codingRun.findUnique({
        where: { runId: candidate.rootCodingRunId },
        include: CONTINUATION_ROOT_INCLUDE,
      })
    : candidate;
  if (!root) return { ok: false, reason: "unknown_run" };
  if (normalizeGitHubRepository(root.repository) !== normalizeGitHubRepository(repository)) {
    return { ok: false, reason: "other_repository" };
  }
  const rootResult = publicCodingRunResult(root.result);
  if (
    (rootResult?.outcome !== "pull_request_opened" && rootResult?.outcome !== "pull_request_updated") ||
    rootResult.pullRequestNumber === undefined
  ) {
    return { ok: false, reason: "no_pull_request" };
  }
  if (dispatchingOwnerId !== undefined) {
    const rootOwnerId = root.run?.agent?.ownerId ?? null;
    // A null owner on either side is never treated as a match: an owner-less
    // agent gets no continuation trust, fail closed either direction.
    if (dispatchingOwnerId === null || rootOwnerId === null || dispatchingOwnerId !== rootOwnerId) {
      return { ok: false, reason: "other_owner" };
    }
  }
  return {
    ok: true,
    root: {
      runId: root.runId,
      baseRef: root.baseRef,
      headRef: root.headRef,
      pullRequestNumber: rootResult.pullRequestNumber,
    },
  };
}

/**
 * Resolves a coding run's branch: an override, else a continuation root's
 * (see checkContinuation), else the profile's base.
 */
async function resolveCodingBranch(
  reader: Pick<DispatchTx, "codingRun">,
  options: DispatchRunOptions,
  profile: { repository: string; baseRef: string },
  /** The dispatched (continuing) agent's current owner; checkContinuation fails closed against it. */
  ownerId: string | null,
): Promise<CodingBranch> {
  if (options.continuesCodingRunId === undefined) return { baseRef: options.codingBaseRef ?? profile.baseRef };
  if (options.codingBaseRef !== undefined) {
    throw new Error("continuesCodingRunId cannot be combined with codingBaseRef.");
  }
  const check = await checkContinuation(reader, options.continuesCodingRunId, profile.repository, ownerId);
  if (!check.ok) throw new ContinuationRefusedError(check.reason);
  const { root } = check;
  return {
    baseRef: root.baseRef,
    headRef: root.headRef,
    continuationOf: { runId: root.runId },
    rootCodingRunId: root.runId,
  };
}

/** What dispatch learned about a coding run's .wardby/services.yaml before its transaction. */
type DeclarationOutcome =
  { kind: "none" } | { kind: "declared"; services: DeclaredService[] } | { kind: "refused"; refusal: string };

interface ServiceDeclarationRead {
  /** The profile the branch was resolved from; the transaction refuses a profile that changed since. */
  repository: string;
  profileBaseRef: string;
  branch: CodingBranch;
  outcome: DeclarationOutcome;
}

/** Read failures that are the file's fault rather than the host's: reported as an invalid declaration. */
const UNREADABLE_DECLARATION: Readonly<Record<string, string>> = {
  github_file_too_large: `it is larger than ${MAX_SERVICE_DECLARATION_BYTES} bytes`,
  github_file_not_a_file: "it is not a file",
  github_file_not_utf8: "it is not UTF-8 text",
  local_file_too_large: `it is larger than ${MAX_SERVICE_DECLARATION_BYTES} bytes`,
  local_file_not_a_file: "it is not a file",
  local_file_not_utf8: "it is not UTF-8 text",
};

/**
 * The knowledge note's input (docs/knowledge.md): the repository's bundle
 * index at the run's base, read before the transaction like the services
 * declaration. Any failure means no note, never a failed dispatch.
 */
async function readKnowledgeIndex(
  options: DispatchRunOptions,
  profile: { repository: string; baseRef: string },
  resolvedBranch: { baseRef: string } | undefined,
  ownerId: string | null,
): Promise<KnowledgeNoteInput | undefined> {
  const executor = options.executor;
  if (!executor.readCodingRepositoryFile) return undefined;
  try {
    // Resolved here, inside the try: a branch problem is the transaction's to report, not the note's.
    const branch = resolvedBranch ?? (await resolveCodingBranch(options.db, options, profile, ownerId));
    const indexText = await executor.readCodingRepositoryFile({
      repository: profile.repository,
      baseRef: normalizeGitRef(branch.baseRef),
      path: `${DEFAULT_KNOWLEDGE_BUNDLE_PATH}/index.md`,
      maxBytes: KNOWLEDGE_INDEX_READ_MAX_BYTES,
    });
    return indexText ? { bundlePath: DEFAULT_KNOWLEDGE_BUNDLE_PATH, indexText } : undefined;
  } catch (err) {
    if (err instanceof Error && err.message in UNREADABLE_DECLARATION) {
      dispatchLog.info(
        { repository: profile.repository, reason: err.message },
        "knowledge index unreadable; dispatching without it",
      );
      return undefined;
    }
    dispatchLog.warn({ err, repository: profile.repository }, "knowledge index read failed; dispatching without it");
    return undefined;
  }
}

/**
 * Coding-run services (docs/coding-services.md): resolves the run's branch and
 * reads the repository's declaration from its base, then parses it. A network
 * call, so it runs before the Serializable transaction, which reuses the
 * branch and resolves the services against the catalog and the agent.
 */
async function readServiceDeclaration(
  options: DispatchRunOptions,
  profile: { repository: string; baseRef: string },
  ownerId: string | null,
): Promise<ServiceDeclarationRead> {
  const branch = await resolveCodingBranch(options.db, options, profile, ownerId);
  const read = { repository: profile.repository, profileBaseRef: profile.baseRef, branch };
  const executor = options.executor;
  if (!executor.readCodingServiceDeclaration) return { ...read, outcome: { kind: "none" } };
  let text: string | null;
  try {
    text = await executor.readCodingServiceDeclaration({
      repository: profile.repository,
      baseRef: normalizeGitRef(branch.baseRef),
    });
  } catch (err) {
    const reason = UNREADABLE_DECLARATION[err instanceof Error ? err.message : ""];
    if (reason) {
      return {
        ...read,
        outcome: {
          kind: "refused",
          refusal: serviceRefusal("service_declaration_invalid", invalidDeclarationSentence(reason)),
        },
      };
    }
    dispatchLog.warn({ err, agentId: options.agentId }, "could not read the repository's service declaration");
    return {
      ...read,
      outcome: {
        kind: "refused",
        refusal: serviceRefusal("service_declaration_unavailable", DECLARATION_UNAVAILABLE_SENTENCE),
      },
    };
  }
  if (text === null) return { ...read, outcome: { kind: "none" } };
  try {
    return { ...read, outcome: { kind: "declared", services: parseServiceDeclaration(text) } };
  } catch (err) {
    if (!(err instanceof ServiceDeclarationError)) throw err;
    return {
      ...read,
      outcome: {
        kind: "refused",
        refusal: serviceRefusal("service_declaration_invalid", invalidDeclarationSentence(err.reason)),
      },
    };
  }
}

/** Inside the transaction: the run's services, or the refusal that stops it. */
async function resolveDispatchServices(
  tx: DispatchTx,
  outcome: DeclarationOutcome,
  allowed: unknown,
  executor: Executor,
  provider: CodingProvider,
  request: string,
  instructions: string | null,
): Promise<ServiceResolution> {
  if (outcome.kind === "refused") return { refusal: outcome.refusal };
  if (outcome.kind === "none" || outcome.services.length === 0) return { services: [] };
  if (executor.supportsCodingServices?.(provider) !== true) {
    return { refusal: serviceRefusal("service_launcher_unsupported", LAUNCHER_UNSUPPORTED_SENTENCE) };
  }
  return resolveRunServices(
    { findMany: (args) => tx.codingService.findMany(args) },
    outcome.services,
    parseAllowedServiceNames(allowed),
    request,
    instructions,
  );
}

/**
 * Persists every detached run input in one transaction, then invokes the
 * executor only after commit. A null result means the caller's transactional
 * claim was no longer valid (for example, a schedule was already claimed).
 */
export async function dispatchRun(options: DispatchRunOptions): Promise<DispatchRunResult | null> {
  const now = options.now ?? new Date();
  // Read outside the transaction only to decide whether to take the group
  // dispatch lock before the transaction's first read, and whether to read the
  // repository's service declaration (a network call); everything the run is
  // built from is re-read inside. If the agent changes in between, the
  // Serializable transaction still refuses a conflicting commit.
  const preview = await options.db.agent.findUnique({
    where: { id: options.agentId },
    select: {
      kind: true,
      ownerId: true,
      budgetGroupId: true,
      codingProfile: { select: { repository: true, baseRef: true, services: true } },
    },
  });
  const lockGroups = preview?.kind === "coding" && preview.budgetGroupId != null;
  // Only an agent allowed some service reads the repository's declaration; any
  // other coding agent never calls the host for it and gets no services.
  const declarationRead =
    preview?.kind === "coding" &&
    preview.codingProfile &&
    parseAllowedServiceNames(preview.codingProfile.services).length > 0
      ? await readServiceDeclaration(options, preview.codingProfile, preview.ownerId ?? null)
      : undefined;
  // The knowledge note's input: the repository's bundle index at the run's base (a network call).
  const knowledgeIndex =
    preview?.kind === "coding" && preview.codingProfile && options.executor.readCodingRepositoryFile
      ? await readKnowledgeIndex(options, preview.codingProfile, declarationRead?.branch, preview.ownerId ?? null)
      : undefined;
  const persistOnce = () =>
    options.db.$transaction(
      async (tx) => {
        if (lockGroups) await tx.$executeRawUnsafe(GROUP_DISPATCH_LOCK_SQL);
        if (options.lockAgent) {
          const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Agent" WHERE "id" = ${options.agentId} FOR UPDATE SKIP LOCKED
      `;
          if (locked.length === 0) return null;
        }

        const agent = await tx.agent.findUnique({
          where: { id: options.agentId },
          include: { codingProfile: true },
        });
        if (!agent) throw new Error(`Unknown agent "${options.agentId}".`);
        if (options.beforePersist && !(await options.beforePersist(tx, agent))) return null;

        if (options.taskOverride !== undefined && agent.kind !== "native") {
          throw new Error("taskOverride can only be supplied for a native agent.");
        }

        // A coding run's services are resolved, and its budget reserved, here,
        // at dispatch (E-01): the container only ever checks the run's own
        // reservation. A native run computes its effective budget in
        // executeRun's load step instead.
        let codingBudget: { budgetUsd: number; refusal?: string } | undefined;
        let codingEntry: ResolvedCatalogEntry | undefined;
        let modelFailure: string | undefined;
        let services: ResolvedCodingService[] = [];
        let servicesRefusal: string | undefined;
        if (agent.kind === "coding") {
          if (!agent.codingProfile) throw new Error(`Coding agent "${agent.id}" has no coding profile.`);
          // An unknown coding provider is a broken profile, not a catalog state: still thrown.
          assertCodingProvider(agent.codingProfile.provider);
          // Recorded on the run row below: the run is billed at this entry for its whole life.
          // A model the catalog cannot run (missing, disabled, or another provider's) fails
          // the run here instead of throwing: the run row commits with the reason, so the
          // caller's own writes stand (a scheduler's lastScheduledAt, a mention's status
          // row) and the owner sees why in list_runs, rather than a rolled-back
          // transaction that a scheduler would retry on every tick.
          try {
            codingEntry = resolveCodingEntry(agent.codingProfile.provider, agent.model);
          } catch (err) {
            if (!(err instanceof ModelUnavailableError || err instanceof CodingModelProviderMismatchError)) throw err;
            modelFailure = err.message;
          }
          if (!modelFailure && declarationRead) {
            if (
              declarationRead.repository !== agent.codingProfile.repository ||
              declarationRead.profileBaseRef !== agent.codingProfile.baseRef
            ) {
              // The declaration was read for a profile that changed before this transaction.
              throw new Error("The coding agent's repository or base branch changed during dispatch; try again.");
            }
            // A missing request fails below, with its own error.
            const request = options.codingTask ?? agent.codingProfile.defaultTask ?? "";
            const resolved = await resolveDispatchServices(
              tx,
              declarationRead.outcome,
              agent.codingProfile.services,
              options.executor,
              agent.codingProfile.provider,
              request,
              agent.systemPrompt,
            );
            if ("refusal" in resolved) servicesRefusal = resolved.refusal;
            else services = resolved.services;
          }
          if (!modelFailure && !servicesRefusal) codingBudget = await reserveCodingBudget(tx, agent, now, options);
        }
        const refusal = servicesRefusal ?? codingBudget?.refusal;

        const run = await tx.run.create({
          data: {
            agentId: agent.id,
            trigger: options.trigger ?? "manual",
            executionManaged: true,
            // Fixed for the run's life: the executor routes on this, never on the agent's current setting.
            nativeExecutionMode: agent.kind === "native" ? agent.nativeExecutionMode : null,
            parentRunId: options.parentRunId,
            grantedParentMemoryKeys: options.grantedParentMemoryKeys ?? [],
            taskOverride: options.taskOverride,
            triggeredById: options.triggeredById ?? null,
            // Failed before it starts, like a native run whose model the
            // runner's load step finds unavailable: zero spend, never started.
            ...(modelFailure ? { status: "failed" as const, error: modelFailure, finishedAt: now } : {}),
            // Refused before it starts, the same terminal status (and zero
            // spend) as a native run whose budget is gone at turn 1.
            ...(refusal ? { status: "refused" as const, error: refusal, finishedAt: now } : {}),
            ...(codingEntry
              ? {
                  pricingVersion: codingEntry.priceVersion,
                  // entryOf returns plain JSON data (fresh array, no Dates); the interface's readonly
                  // efforts array is all that keeps it from matching Prisma's Json input type.
                  pricingSnapshot: entryOf(codingEntry) as unknown as Prisma.InputJsonValue,
                }
              : {}),
          },
        });

        if (options.afterPersist) await options.afterPersist(tx, run);
        const attributed = await attributeRun(
          tx,
          run.id,
          {
            parentRunId: options.parentRunId,
            continuesCodingRunId: options.continuesCodingRunId,
            intent: options.attribution,
          },
          now,
        );

        if (agent.kind === "coding" && agent.codingProfile && codingBudget && !refusal) {
          // Checked above too; repeated so the provider type narrows here.
          assertCodingProviderModel(agent.codingProfile.provider, agent.model);
          const request = options.codingTask ?? agent.codingProfile.defaultTask;
          if (!request) throw new Error(`Coding agent "${agent.id}" requires a task.`);
          // The worker sees only the task text, so the agent's own instructions, and the
          // services note, ride in it.
          const task = composeCodingTask(
            agent.systemPrompt,
            request,
            servicesInstructionNote(services),
            knowledgeIndex ? knowledgeSection(knowledgeIndex) : undefined,
          );
          const budgetUsd = codingBudget.budgetUsd;

          // Resolved once: before the transaction when the declaration was read from it.
          const branch =
            declarationRead?.branch ?? (await resolveCodingBranch(tx, options, agent.codingProfile, agent.ownerId));
          const { baseRef, continuationOf, rootCodingRunId } = branch;
          const headRef = branch.headRef ?? `wardby/run-${run.id}`;

          const input = CodingTaskInputSchema.parse({
            schemaVersion: CODING_PROTOCOL_VERSION,
            runId: run.id,
            repository: agent.codingProfile.repository,
            baseRef,
            headRef,
            task,
            model: agent.model,
            budgetUsd,
            deadlineAt: new Date(now.getTime() + agent.codingProfile.timeoutSec * 1000).toISOString(),
            continuationOf,
            ...(services.length > 0 ? { services: workerServices(services) } : {}),
          });
          const imageSelector = {
            provider: agent.codingProfile.provider,
            toolchain: agent.codingProfile.toolchain,
            toolchainVersion: agent.codingProfile.toolchainVersion,
            workerImageRef: agent.codingProfile.workerImageRef,
          };
          const workerImage = options.executor.resolveCodingWorkerImage?.(imageSelector);
          // Claude Code's commands run in its tool runner, so the toolchain picks that image too; fixed
          // here with the worker image so the run keeps both however the deployment changes later.
          const toolImage = options.executor.resolveCodingToolImage?.(imageSelector) ?? null;
          await tx.codingRun.create({
            data: {
              runId: run.id,
              issueProvider: attributed?.provider ?? null,
              issueKey: attributed?.key ?? null,
              task: input.task,
              repository: input.repository,
              baseRef: input.baseRef,
              headRef: input.headRef,
              provider: agent.codingProfile.provider,
              model: input.model,
              timeoutSec: agent.codingProfile.timeoutSec,
              protectedPaths: agent.codingProfile.protectedPaths as Prisma.InputJsonValue,
              collectExclude: agent.codingProfile.collectExclude as Prisma.InputJsonValue,
              packageAllowlist: agent.codingProfile.packageAllowlist as Prisma.InputJsonValue,
              packagePolicy: agent.codingProfile.packagePolicy as Prisma.InputJsonValue,
              workerImage,
              toolImage,
              budgetReservedUsd: budgetUsd,
              rootCodingRunId,
              workspaceDiskMb: agent.codingProfile.workspaceDiskMb,
              maxTurns: agent.codingProfile.maxTurns,
              repoSkills: agent.codingProfile.repoSkills,
              claudeBareMode: agent.codingProfile.claudeBareMode,
              // Fixed here so a run's tracing never changes mid-run.
              debugTrace:
                agent.codingProfile.debugTraceUntil != null &&
                now.getTime() < agent.codingProfile.debugTraceUntil.getTime(),
              services,
            },
          });
        } else if (
          agent.kind !== "coding" &&
          (options.codingTask !== undefined ||
            options.codingBaseRef !== undefined ||
            options.continuesCodingRunId !== undefined)
        ) {
          throw new Error("Coding overrides cannot be supplied for a native agent.");
        }

        const task = options.task
          ? await tx.task.create({
              data: {
                kind: "run",
                runId: run.id,
                principalId: options.task.principalId,
                status: "working",
                ttlAt: new Date(now.getTime() + options.task.ttlMs),
              },
            })
          : undefined;
        return { run, task };
      },
      { isolationLevel: "Serializable", maxWait: CONTENDED_TX_MAX_WAIT_MS },
    );

  let persisted: DispatchRunResult | null = null;
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
    try {
      persisted = await persistOnce();
      break;
    } catch (err) {
      const retryable = isSerializationConflict(err) || isTransactionUnavailable(err);
      if (!retryable || attempt === PERSIST_ATTEMPTS - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt)));
    }
  }

  if (!persisted) return null;
  options.onPersisted?.(persisted.run);
  if (persisted.run.status === "refused" || persisted.run.status === "failed") {
    dispatchLog.warn(
      { runId: persisted.run.id, agentId: options.agentId, reason: persisted.run.error },
      `coding run ${persisted.run.status} at dispatch`,
    );
    return persisted;
  }
  const runStart = async () => {
    try {
      await options.executor.start(persisted.run.id);
    } catch (err) {
      await markRunFailedFromExecutorError(options.db, persisted.run.id, err, options.selfDefects).catch((err2) =>
        dispatchLog.error({ err: err2, runId: persisted.run.id }, "failed to persist executor start failure"),
      );
    }
  };
  if (options.awaitExecution) {
    await runStart();
  } else {
    void runStart();
  }
  return persisted;
}
