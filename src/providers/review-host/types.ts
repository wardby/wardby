/**
 * Host-neutral code-review surface for native agents. GitHub (./github.ts) and
 * local git repositories (./local.ts) implement it; Bitbucket Cloud is anticipated. Every method
 * takes the repository and mints its own least-permission credential — no
 * method accepts a token or a permission. See
 * docs/private/2026-09-25-code-review-host-design.md §5.
 */

export type ReviewHostProvider = "github" | "local";
export const REVIEW_HOST_PROVIDERS: readonly ReviewHostProvider[] = ["github", "local"];
/** Providers with host user accounts to link (link_host_account); a local repository has none. */
export const HOST_ACCOUNT_PROVIDERS: readonly ReviewHostProvider[] = ["github"];

export type ReviewVerdict = "APPROVE" | "CHANGES_REQUESTED" | "COMMENT";
export type CheckConclusion = "success" | "failure" | "neutral";
export type CommentSide = "LEFT" | "RIGHT";

export interface PullRequestFileView {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  previousFilename?: string;
  patch: string;
  patchTruncated: boolean;
}

/** One of this agent's own review threads that is still unresolved. */
export interface ReviewThreadView {
  /** Opaque host id; pass it back in PublishReviewInput.resolveThreadIds. */
  id: string;
  path: string;
  /** The line in the current head, or null when the thread is outdated (its line no longer exists). */
  line: number | null;
  outdated: boolean;
  /** The finding as posted, without its marker, capped at 1,000 characters. */
  body: string;
}

export type CiState = "passing" | "failing" | "pending" | "inconclusive" | "none" | "unavailable";

/** One CI result on a commit: a check run or a commit status. */
export interface CiCheckView {
  /** Check run name or status context (repository-controlled text), capped at 100 characters. */
  name: string;
  kind: "check_run" | "status";
  status: "queued" | "in_progress" | "completed";
  /** Set when completed: success, failure, neutral, cancelled, skipped, timed_out, action_required, stale, startup_failure, error. */
  conclusion: string | null;
  /** The app that reported a check run (e.g. "github-actions"); null for statuses. */
  app: string | null;
}

/** CI on the PR's head commit, excluding everything wardby's own App reported. */
export interface CiView {
  headSha: string;
  state: CiState;
  checks: CiCheckView[];
  /** More results exist than are listed. */
  truncated: boolean;
  /** Commit statuses could not be read (permission not granted); only check runs are listed. */
  statusesUnavailable: boolean;
  /** Set when state is "unavailable": a host error code. */
  unavailableReason?: string;
}

export interface PullRequestView {
  number: number;
  title: string;
  body: string;
  author: string | null;
  state: string;
  merged: boolean;
  draft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string;
  isFork: boolean;
  htmlUrl: string;
  /** Head sha recorded in this agent's summary comment, if it reviewed before. */
  lastReviewedSha: string | null;
  /** Set when `files` is the compare of `comparedFrom...headSha` rather than the whole PR. */
  comparedFrom: string | null;
  /**
   * The base branch was merged into the PR since `comparedFrom`: `files` is
   * then the PR's own diff (against its base), limited to files that changed
   * since `comparedFrom`, so base-branch changes are left out.
   */
  baseMergedSince: boolean;
  files: PullRequestFileView[];
  /** This agent's own unresolved review threads on the PR (the first 100 threads are searched). */
  openThreads: ReviewThreadView[];
  /** CI on headSha (check runs and commit statuses, minus wardby's own); absent on hosts that can't read CI. */
  ci?: CiView;
}

export interface PullRequestHead {
  headSha: string;
  isFork: boolean;
  state: string;
}

export interface PullRequestOrigin extends PullRequestHead {
  /** The run id in the description's marker; only on a PR the App itself authored. */
  markerRunId?: string;
  /** The PR's label names; empty on a host without labels. */
  labels: string[];
  /** True once merged; absent on hosts that can't say. */
  merged?: boolean;
  /** True while a draft; absent on hosts that can't say. */
  draft?: boolean;
}

export type FileReadResult =
  | {
      kind: "file";
      path: string;
      ref: string;
      totalLines: number;
      startLine: number;
      endLine: number;
      truncated: boolean;
      /** The window with `N: ` line-number prefixes: the display form shown to agents. */
      content: string;
      /** The same window without line-number prefixes, lines joined by "\n": for machine parsing. */
      text: string;
    }
  | { kind: "directory"; path: string; entries: string[] }
  | { kind: "not_found"; path: string };

export interface FileListView {
  ref: string;
  count: number;
  truncated: boolean;
  /** Display strings (path plus size) shown to agents. */
  files: string[];
  /** Bare repository paths, same order and length as `files`. */
  paths: string[];
}

export interface InlineComment {
  path: string;
  line: number;
  side: CommentSide;
  severity: string;
  body: string;
}

export interface PublishReviewInput {
  prNumber: number;
  headSha: string;
  verdict: ReviewVerdict;
  summary: string;
  body: string;
  comments: InlineComment[];
  /** Identifies this agent's summary comment; the agent id. */
  agentMarker: string;
  /**
   * Names a completed check to create when no checkId is supplied (a run not
   * started by a host event). With neither, no check is created.
   */
  checkName?: string;
  /** The run's own in-progress check, when the control plane started one. */
  checkId?: string;
  /**
   * Threads to resolve because this head fixes them. Only this agent's own
   * unresolved threads on this PR are resolved; any other id is skipped.
   */
  resolveThreadIds?: string[];
}

export type PublishReviewResult =
  | {
      published: true;
      reviewUrl: string | null;
      summaryCommentUrl: string;
      /** Null when no check was completed or created (neither checkId nor checkName). */
      checkId: string | null;
      /** The verdict's check mapping — informational when checkId is null. */
      checkConclusion: CheckConclusion;
      inlineCount: number;
      outsideDiffCount: number;
      resolvedThreadIds: string[];
      /** Requested ids that were not resolved: not this agent's open thread on this PR, or the host refused. */
      skippedThreadIds: string[];
    }
  | { published: false; reason: "stale_head"; currentHeadSha: string };

export interface CommentInput {
  number: number;
  body: string;
  replyToReviewCommentId?: string;
}

/** A comment the App wrote, to edit later: a conversation comment or a reply in a review thread. */
export interface EditCommentInput {
  kind: "conversation" | "inline";
  id: string;
  body: string;
}

export interface CommentRef {
  /**
   * "conversation" = a top-level comment on an issue/PR conversation; "inline" = a comment on a diff line (review
   * thread); "subject" = the issue or PR itself (its title/description), with `id` its number.
   */
  kind: "conversation" | "inline" | "subject";
  id: string;
}

export interface StartCheckInput {
  headSha: string;
  name: string;
}

export interface CompleteCheckInput {
  checkId: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  text?: string;
  detailsUrl?: string;
}

export type UpsertNamedCheckInput = {
  headSha: string;
  /** The check's fixed name, e.g. MERGE_ORDER_CHECK_NAME ("wardby merge order"); identifies which run to update. */
  name: string;
  title: string;
  summary: string;
} & ({ status: "in_progress" } | { status: "completed"; conclusion: "success" | "failure" });

/**
 * A user's effective permission on one repository, host-neutral and ranked
 * none < read < triage < write < maintain < admin. GitHub maps its
 * collaborator permission onto these directly; GitLab would map reporter ->
 * read, developer -> write, maintainer -> maintain, owner -> admin.
 */
export type HostPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";
export const HOST_PERMISSION_RANK: Readonly<Record<HostPermission, number>> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

/** A host user, by its immutable numeric id (as text) and its current login. */
export interface HostUser {
  id: string;
  login: string;
}

export interface CodeReviewHost {
  readonly provider: ReviewHostProvider;
  /**
   * The user's effective permission on `repository`, asked with the App's own
   * installation credential (never a user token). Answers only for the user
   * with this id: a login that now names someone else is re-resolved by id,
   * and `login` in the result is the user's current login.
   */
  repositoryPermission(repository: string, user: HostUser): Promise<{ level: HostPermission; login: string }>;
  readPullRequest(
    repository: string,
    prNumber: number,
    opts: { sinceSha?: string; maxPatchChars: number; agentMarker: string },
  ): Promise<PullRequestView>;
  pullRequestHead(repository: string, prNumber: number): Promise<PullRequestHead>;
  /** CI on one commit, excluding wardby's own checks. Never throws. Hosts that can't say leave it out. */
  readCi?(repository: string, headSha: string): Promise<CiView>;
  /** Head, labels, and (on an App-authored PR) the run marker. Hosts that can't say leave it out. */
  pullRequestOrigin?(repository: string, prNumber: number): Promise<PullRequestOrigin>;
  /** Adds a label to a pull request (created if missing). Absent on hosts without labels. */
  addLabel?(repository: string, prNumber: number, label: string): Promise<void>;
  /**
   * Replaces (or inserts) wardby's marked Related pull requests section in an
   * open pull request's description — only on a PR the App itself authored
   * whose run marker is `expectedMarkerRunId`. "skipped" covers every refusal
   * (not the App's, another run's, closed, malformed markers, too long).
   * Absent on hosts that can't edit descriptions.
   */
  replaceRelatedSection?(
    repository: string,
    prNumber: number,
    input: { expectedMarkerRunId: string; block: string },
  ): Promise<"updated" | "unchanged" | "skipped">;
  readFile(
    repository: string,
    path: string,
    ref: string | undefined,
    window: { startLine: number; maxLines: number },
  ): Promise<FileReadResult>;
  listFiles(repository: string, ref: string | undefined, pathPrefix?: string): Promise<FileListView>;
  publishReview(repository: string, input: PublishReviewInput): Promise<PublishReviewResult>;
  /** `id` identifies the new comment for editComment; a reply is an "inline" comment, anything else "conversation". */
  comment(repository: string, input: CommentInput): Promise<{ url: string; id: string }>;
  /** Replaces the body of a comment the App wrote. */
  editComment(repository: string, input: EditCommentInput): Promise<void>;
  /** Marks a comment as picked up (GitHub: a 👀 reaction); a host without reactions may do nothing. */
  acknowledge(repository: string, target: CommentRef): Promise<void>;
  startCheck(repository: string, input: StartCheckInput): Promise<{ checkId: string }>;
  completeCheck(repository: string, input: CompleteCheckInput): Promise<void>;
  /**
   * Creates or updates, by fixed name, a check run on one commit that isn't
   * tied to a run's own startCheck/completeCheck lifecycle (e.g. the
   * `wardby merge order` check, recomputed fresh and reposted on demand).
   * Finds the one this App owns among the commit's check runs with that
   * name and patches it; creates one when none exists. Hosts that can't
   * post checks (e.g. a local repository) leave this out.
   */
  upsertNamedCheck?(repository: string, input: UpsertNamedCheckInput): Promise<void>;
}

export type ReviewHostErrorCode =
  "host_not_installed" | "host_permission_missing" | "host_api_error" | "host_invalid_response";

export class ReviewHostError extends Error {
  constructor(
    readonly code: ReviewHostErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ReviewHostError";
  }
}

export type ReviewHostRegistry = Partial<Record<ReviewHostProvider, CodeReviewHost>>;

/**
 * A host's user-authorization (OAuth web) flow, used only to learn who a
 * wardby principal is on the host. Implementations never store or return the
 * user token: `complete` reads the user and revokes the token at once.
 */
export interface HostUserAuthorizer {
  readonly provider: ReviewHostProvider;
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  complete(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{
    hostUserId: string;
    login: string;
  }>;
}

export type HostUserAuthorizerRegistry = Partial<Record<ReviewHostProvider, HostUserAuthorizer>>;

/**
 * Host-neutral shape a webhook adapter (github-events.ts) normalises its
 * provider payload into, for src/core/host-events.ts to route.
 */
export type HostEvent =
  | {
      kind: "push";
      provider: ReviewHostProvider;
      repository: string;
      /** The branch pushed (without refs/heads/), always the repository's default branch. */
      branch: string;
      before: string;
      after: string;
      /** Union of added/modified/removed paths over the payload's commits, deduplicated, at most 1000. */
      changedPaths: string[];
      /** False when GitHub truncated the commit list (> 20 commits) or paths were capped: treat every concept as in scope. */
      changedPathsComplete: boolean;
    }
  | {
      kind: "pr_updated";
      provider: ReviewHostProvider;
      repository: string;
      prNumber: number;
      headSha: string;
      isFork: boolean;
    }
  | {
      /** The PR was merged or closed; only drives bookkeeping on issue/PR pairs wardby recorded. */
      kind: "pr_closed";
      provider: ReviewHostProvider;
      repository: string;
      prNumber: number;
      merged: boolean;
    }
  | {
      /** A CI check suite (not wardby's own) finished on a commit some open pull requests point at. */
      kind: "ci_completed";
      provider: ReviewHostProvider;
      repository: string;
      headSha: string;
      prNumbers: number[];
    }
  | {
      kind: "check_rerun";
      provider: ReviewHostProvider;
      repository: string;
      prNumber: number;
      headSha: string;
      checkName: string;
    }
  | {
      kind: "mention";
      provider: ReviewHostProvider;
      repository: string;
      number: number;
      isPullRequest: boolean;
      comment: CommentRef;
      /** Set when the mention is inside an inline review thread. */
      replyToReviewCommentId?: string;
      /** The comment text; for a "subject" mention, the issue/PR description. */
      body: string;
      author: string;
      /** The author's immutable numeric host user id, as text; their permission is checked by it. */
      authorId: string;
      /** The issue or PR the mention is on, when the payload carries it. */
      subject?: { title: string; body: string };
      /** The run that opened this PR, when its description carries a valid run marker. */
      priorRunId?: string;
    };
