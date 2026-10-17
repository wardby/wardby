import type { PackageAuditReport } from "../../coding/registry/audit-mode.js";
import type {
  DescriptionBaseline,
  DescriptionUpdateResult,
  RelatedPullRequestsInput,
  RepositoryFileInput,
} from "./github.js";

/** What happened to a pull request description: wardby just wrote it (a new PR) or updated a fix round's. */
export type DescriptionWriteOutcome = { kind: "written"; sha256: string } | DescriptionUpdateResult;

export interface VcsPrepareInput {
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  protectedPaths: string[];
  /** Repository-relative paths never collected, in addition to the built-in names. */
  collectExclude?: string[];
  /**
   * Revision-in-place: set when headRef is an EXISTING branch to continue
   * rather than a fresh one
   * to create off baseRef. `rootRunId` is the id of the run that originally
   * opened the PR headRef belongs to (used for PR lookup identity, since
   * GitHub's find-by-marker keys on that run's id, not this one's) -- the
   * caller (dispatch.ts) must already have verified, against the database,
   * that this run is legitimately allowed to continue that branch before
   * ever setting this; this layer trusts it exactly as much as it already
   * trusts baseRef, no more, and cannot independently re-verify a database
   * fact.
   */
  continuation?: { rootRunId: string };
}

/** Trusted paths are returned by the provider, never accepted from worker output. */
export interface PreparedWorkspace {
  id: string;
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  /** For a fresh workspace, the commit baseRef pointed at when cloned. For
   * a continuation, the tip of the branch being continued at clone time --
   * each round is independently validated against its own agent's rules at
   * commit time (see design doc §8.3), so there's no need to re-derive or
   * re-validate the PR's true original root here; "where this round
   * started" is the only anchor the single-new-commit and protected-path
   * checks need. */
  baseCommit: string;
  workspacePath: string;
  gitMetadataPath: string;
  protectedPaths: string[];
  collectExclude: string[];
  continuation?: { rootRunId: string };
}

/**
 * The pull request a continuation run works on, without its local workspace:
 * what the host-side finish signals and the no-push description refresh need.
 * A run finished by another control-plane process (a deploy moved it) has no
 * workspace to recover, so the executor builds this from the run record, and
 * `baseCommit` is then unknown.
 */
export type ContinuationTarget = Pick<
  PreparedWorkspace,
  "runId" | "repository" | "baseRef" | "headRef" | "continuation"
> & {
  baseCommit?: string;
};

/** Already-validated/redacted agent-authored fields (coding/protocol.ts) surfaced in the opened PR, if any. */
export interface FinalizeChangesDetails {
  summary?: string;
  tests?: readonly { command: string; outcome: "passed" | "failed" | "skipped" }[];
  tag?: string;
  /** Packages the registry proxy served/refused during this run (RegistryFetch), for the PR body. */
  packages?: readonly {
    ecosystem: string;
    name: string;
    version: string;
    /** Blocking advisories the run's accepted set waived to serve it. */
    acceptedAdvisories?: readonly string[];
  }[];
  packageRefusals?: readonly { ecosystem: string; name: string; reason: string }[];
  /** Package audit mode (control-plane records): the mode the run(s) had and what the registry served only
   *  because of it, for the PR body's caution banner. Absent when the mode was off. */
  packageAudit?: PackageAuditReport;
  /** Folders whose node_modules the run's dependency cache restored from a snapshot ("." for the root), for the PR body. */
  restoredDependencies?: readonly string[];
  /** Originating issue (control-plane data): named in the PR title and body. Provider-neutral. */
  issue?: { key: string; url?: string; trackerName?: string };
  /** The same-repository issue the run came from (a mention on a GitHub issue): the body's `Resolves #N` line. */
  issueNumber?: number;
  /** The request's other pull requests (control-plane rows): the PR body's Related pull requests section. */
  related?: RelatedPullRequestsInput;
  /** Fix rounds: the control plane's record of the description wardby last wrote; enables the description update. */
  description?: { baseline: DescriptionBaseline };
}

export type FinalizeChangesResult =
  | {
      outcome: "no_changes";
      repository: string;
      baseRef: string;
      baseCommit: string;
    }
  | {
      outcome: "pull_request_opened";
      repository: string;
      baseRef: string;
      baseCommit: string;
      headRef: string;
      commitSha: string;
      pullRequestNumber: number;
      pullRequestUrl: string;
      description?: DescriptionWriteOutcome;
    }
  | {
      /** Revision-in-place: pushed a new commit onto an existing open PR's
       * branch instead of opening a new one. */
      outcome: "pull_request_updated";
      repository: string;
      baseRef: string;
      baseCommit: string;
      headRef: string;
      commitSha: string;
      pullRequestNumber: number;
      pullRequestUrl: string;
      description?: DescriptionWriteOutcome;
    }
  | {
      /** Pushed the run's branch to a remote with no pull requests (a local
       * repository): headRef now points at commitSha there. */
      outcome: "branch_pushed";
      repository: string;
      baseRef: string;
      baseCommit: string;
      headRef: string;
      commitSha: string;
    };

export interface VcsProvider {
  prepareWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace>;
  recoverWorkspace(input: VcsPrepareInput): Promise<PreparedWorkspace | null>;
  finalizeChanges(workspace: PreparedWorkspace, details?: FinalizeChangesDetails): Promise<FinalizeChangesResult>;
  cleanup(workspace: PreparedWorkspace): Promise<void>;
  /**
   * Best-effort "wardby is working on this" signal for a continuation
   * a no-op when `workspace.continuation` is unset, since a fresh run has
   * no PR to attach anything to until its one commit lands. Optional
   * because this is a GitHub-specific concept, not a universal VCS one --
   * a future non-GitHub provider (or a test double) can simply omit it,
   * mirroring `Executor.resolveCodingWorkerImage?` (dispatch.ts calls it
   * with `?.()`). Implementations MUST NOT throw: this is strictly
   * observability, never allowed to affect the real coding run.
   * `details.agentName`, when present, is the human-readable agent name
   * (e.g. "knock-knock-implement") surfaced alongside the opaque run id --
   * particularly useful for the cross-agent case, where the agent
   * continuing the PR isn't the one that originally opened it.
   */
  notifyContinuationStarted?(workspace: PreparedWorkspace, details?: { agentName?: string }): Promise<void>;
  /**
   * Companion to `notifyContinuationStarted` -- must find and update
   * whatever that call created, never create fresh state itself (a
   * "finished" status with no preceding "in progress" one would be
   * confusing, and could happen if the process crashed between the two
   * calls). Safe to call more than once for the same run. Same
   * never-throw contract as `notifyContinuationStarted`. `details.summary`,
   * when present, is the agent's own already-validated/redacted summary
   * (the same text that goes in the PR body -- see
   * `FinalizeChangesDetails.summary`) so the "done" status reflects what
   * actually happened instead of a caller having to go find out.
   * `budget_exhausted` is a failure that ran out of budget;
   * `details.budgetSentence` then says how (see core/budget-wording.ts), and
   * `details.changesPushed` says its changes so far were pushed anyway.
   * A `failed` run the model provider refused carries `details.providerSentence`.
   * A `failed` run whose changes touched a protected path carries
   * `details.protectedPathSentence` (see coding/protected-path-wording.ts).
   */
  notifyContinuationFinished?(
    workspace: ContinuationTarget,
    outcome: ContinuationOutcome,
    details?: ContinuationFinishedDetails,
  ): Promise<void>;
  /**
   * The raw text of one repository file at a ref, read through the host's API
   * without a clone, or null when it does not exist. Dispatch reads a coding
   * run's .wardby/services.yaml from its base branch with it
   * (docs/coding-services.md). Optional, mirroring notifyContinuationStarted: a
   * provider (or test double) without it gives runs no services.
   */
  readRepositoryFile?(input: RepositoryFileInput): Promise<string | null>;
  /**
   * Re-derive a continuation's pull request description without pushing (a fix
   * round that made no changes). Undefined when there is nothing to refresh
   * (no description details, or a remote without pull requests). Never throws.
   */
  refreshPullRequestDescription?(
    workspace: ContinuationTarget,
    details: FinalizeChangesDetails,
  ): Promise<DescriptionWriteOutcome | undefined>;
  /**
   * Whether the pull request a continuation pushes to is still a draft, per
   * the host: true or false, or undefined when unknown (a fresh run, a remote
   * without pull requests, a pull request no longer open, or a failed
   * lookup). Optional; never throws.
   */
  continuationPullRequestDraft?(workspace: PreparedWorkspace): Promise<boolean | undefined>;
}

export type ContinuationOutcome = "succeeded" | "failed" | "budget_exhausted";

export interface ContinuationFinishedDetails {
  summary?: string;
  agentName?: string;
  /** Host-safe sentence naming the run's budget; used with `budget_exhausted`. */
  budgetSentence?: string;
  /** Host-safe sentence for a run that finished over its base budget (core/budget-wording.ts); used with `succeeded`. */
  overrunSentence?: string;
  /** Host-safe sentence naming a model-provider refusal (see core/provider-wording.ts); used with `failed`. */
  providerSentence?: string;
  /** Host-safe sentence naming a coding-run service that never became ready (coding/services/wording.ts); used with `failed`. */
  serviceSentence?: string;
  /** Host-safe sentence naming a protected path the run's changes touched (coding/protected-path-wording.ts); used with `failed`. */
  protectedPathSentence?: string;
  /**
   * Set with `budget_exhausted` when the run's changes so far were pushed anyway
   * (the pull request it opened or continued, or a branch with no number).
   */
  changesPushed?: { pullRequestNumber?: number };
}
