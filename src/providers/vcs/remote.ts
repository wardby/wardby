import type { DescriptionWriteOutcome, FinalizeChangesDetails, PreparedWorkspace, VcsProvider } from "./types.js";

/** What a remote needs to publish a pushed commit (GitHub: open or find the draft PR). */
export interface PublishInput {
  /** The validated workspace whose headRef was just pushed. */
  workspace: PreparedWorkspace;
  details?: FinalizeChangesDetails;
  /** Every path the commit changes relative to baseCommit (already validated). */
  changedPaths: readonly string[];
  /** The commit just pushed (the pull request's new head). */
  commitSha?: string;
}

export type PublishResult =
  | { kind: "pull_request"; number: number; url: string; description?: DescriptionWriteOutcome }
  | { kind: "branch"; branch: string };

/**
 * The remote-specific half of GitVcsProvider: where a repository is cloned
 * from and pushed to, how git authenticates, and what happens after a push.
 * Everything else (workspace layout, hardened git config, finalize checks,
 * fetch-compare-push) stays in GitVcsProvider and applies to every remote.
 */
export interface GitRemote {
  /** Extra `-c` pairs appended after HARDENED_GIT_CONFIG for clone/push/ls-remote (GitHub: none). */
  readonly gitConfig: readonly string[];
  /** Syntactic normalization of a repository id for this remote (GitHub: owner/name; local: local:/abs/path). */
  normalizeRepository(repository: string): string;
  cloneUrl(repository: string): string;
  /** Runs fn with an auth token for git (GitHub: installation token; local: undefined). */
  withAccess<T>(repository: string, fn: (token: string | undefined) => Promise<T>): Promise<T>;
  /** Continuation precondition (GitHub: the PR is still open). */
  assertContinuationOpen(input: {
    repository: string;
    baseRef: string;
    headRef: string;
    continuation?: { rootRunId: string };
  }): Promise<void>;
  /** After a successful push: GitHub opens or finds the draft PR; local returns the branch. */
  publish(input: PublishInput): Promise<PublishResult>;
  /** The error pushOnce throws when the remote branch moved since the clone. */
  conflictError(): Error;
  /**
   * When set, prepareWorkspace runs `ls-remote --heads` for the branch it is
   * about to clone and throws this error if the branch is absent, instead of
   * leaving a missing ref to surface as an opaque clone failure (GitHub: unset).
   */
  refNotFoundError?(ref: string): Error;
  /** When set, called with headRef before any push; throws to refuse writing that ref (GitHub: unset). */
  assertPushRef?(headRef: string): void;
  /** When set, called inside withAccess right before the push; throws to refuse it (GitHub: unset). */
  beforePush?(repository: string, headRef: string): Promise<void>;
  /**
   * Optional: the branch a continuation's pull request currently targets, which
   * prepareWorkspace merges into the workspace before the agent starts (GitHub:
   * the open PR's base; local: unset, so no merge). Null when there is nothing to
   * merge from: not a continuation, the PR is a fork's, or the lookup failed.
   * Never throws.
   */
  pullRequestBase?(input: {
    runId: string;
    repository: string;
    baseRef: string;
    headRef: string;
    continuation?: { rootRunId: string };
  }): Promise<{ ref: string } | null>;
  notifyContinuationStarted?: VcsProvider["notifyContinuationStarted"];
  continuationPullRequestDraft?: VcsProvider["continuationPullRequestDraft"];
  notifyContinuationFinished?: VcsProvider["notifyContinuationFinished"];
  readRepositoryFile?: VcsProvider["readRepositoryFile"];
  /**
   * Optional: called after the commit and before the push, with the commit
   * about to become the head. GitHub writes a continuation's description
   * comment here, so it exists before the push starts a review. Never throws.
   */
  proposeDescriptionBeforePush?(input: PublishInput & { commitSha: string }): Promise<void>;
  /** Optional: re-derive a continuation's PR description without a push (GitHub only). Never throws. */
  refreshDescription?: VcsProvider["refreshPullRequestDescription"];
}
