/**
 * Host-neutral code-review surface for native agents. GitHub is the first
 * implementation (./github.ts); Bitbucket Cloud is anticipated. Every method
 * takes the repository and mints its own least-permission credential — no
 * method accepts a token or a permission. See
 * docs/private/2026-09-25-code-review-host-design.md §5.
 */

export type ReviewHostProvider = "github";
export const REVIEW_HOST_PROVIDERS: readonly ReviewHostProvider[] = ["github"];

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
}

export interface PullRequestHead {
  headSha: string;
  isFork: boolean;
  state: string;
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
      content: string;
    }
  | { kind: "directory"; path: string; entries: string[] }
  | { kind: "not_found"; path: string };

export interface FileListView {
  ref: string;
  count: number;
  truncated: boolean;
  files: string[];
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
    }
  | { published: false; reason: "stale_head"; currentHeadSha: string };

export interface CommentInput {
  number: number;
  body: string;
  replyToReviewCommentId?: string;
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

export interface CodeReviewHost {
  readonly provider: ReviewHostProvider;
  readPullRequest(
    repository: string,
    prNumber: number,
    opts: { sinceSha?: string; maxPatchChars: number; agentMarker: string },
  ): Promise<PullRequestView>;
  pullRequestHead(repository: string, prNumber: number): Promise<PullRequestHead>;
  readFile(
    repository: string,
    path: string,
    ref: string | undefined,
    window: { startLine: number; maxLines: number },
  ): Promise<FileReadResult>;
  listFiles(repository: string, ref: string | undefined, pathPrefix?: string): Promise<FileListView>;
  publishReview(repository: string, input: PublishReviewInput): Promise<PublishReviewResult>;
  comment(repository: string, input: CommentInput): Promise<{ url: string }>;
  /** Marks a comment as picked up (GitHub: a 👀 reaction); a host without reactions may do nothing. */
  acknowledge(repository: string, target: CommentRef): Promise<void>;
  startCheck(repository: string, input: StartCheckInput): Promise<{ checkId: string }>;
  completeCheck(repository: string, input: CompleteCheckInput): Promise<void>;
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
 * Host-neutral shape a webhook adapter (github-events.ts) normalises its
 * provider payload into, for src/core/host-events.ts to route.
 */
export type HostEvent =
  | {
      kind: "pr_updated";
      provider: ReviewHostProvider;
      repository: string;
      prNumber: number;
      headSha: string;
      isFork: boolean;
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
      /** The issue or PR the mention is on, when the payload carries it. */
      subject?: { title: string; body: string };
      /** The run that opened this PR, when its description carries a valid run marker. */
      priorRunId?: string;
    };
