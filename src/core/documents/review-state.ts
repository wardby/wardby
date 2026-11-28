/**
 * The document review state rule, as a pure function (spec "States"). `draft` and `archived` change only
 * by explicit action (review.ts); every other state is computed from the reviewers' verdicts on the
 * current version only, after every review action and every publish:
 *   1. a forced approval on the current version → approved;
 *   2. any reviewer's current changes_requested → changes_requested;
 *   3. every reviewer's current verdict is approved → approved;
 *   4. else in_review.
 * Reopening an approved or rejected document starts a new version (a copy of the current one), so nothing given
 * before a reopen is on the current version and none of it counts. `rejected` is set only by an explicit action
 * on a document of a plan set (review.ts rejectDocument): it is locked like `approved` and leaves the plan.
 */
export const REVIEW_STATES = ["draft", "in_review", "changes_requested", "approved", "rejected", "archived"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];
export type ComputedState = "in_review" | "changes_requested" | "approved";
export type LockedState = "approved" | "rejected" | "archived";
export type Verdict = "none" | "approved" | "changes_requested";

export const REVIEW_EVENT_KINDS = [
  "submitted",
  "reviewers_changed",
  "revised",
  "approved",
  "changes_requested",
  "force_approved",
  "rejected",
  "reopened",
  "archived",
  "unarchived",
] as const;
export type ReviewEventKind = (typeof REVIEW_EVENT_KINDS)[number];

export const STATE_LABELS: Record<ReviewState, string> = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  archived: "Archived",
};

export const isReviewState = (v: string): v is ReviewState => (REVIEW_STATES as readonly string[]).includes(v);

/** Approved, rejected and archived documents take no new version by any route. */
export const isLocked = (state: string): state is LockedState =>
  state === "approved" || state === "rejected" || state === "archived";

export interface Mark {
  versionNumber: number;
  at: Date;
}
export interface RuleReviewer {
  id: string;
  verdict: Verdict;
  versionNumber: number | null;
  verdictAt: Date | null;
}
export interface RuleInput {
  currentVersion: number;
  reviewers: RuleReviewer[];
  /** The latest force_approved event, or null. */
  force: Mark | null;
}

/** A verdict or force counts when it is on the current version. */
export function countsNow(mark: Mark | null, input: Pick<RuleInput, "currentVersion">): boolean {
  return mark !== null && mark.versionNumber === input.currentVersion;
}

export function reviewerCounts(r: RuleReviewer, input: RuleInput): boolean {
  if (r.verdict === "none" || r.versionNumber === null || r.verdictAt === null) return false;
  return countsNow({ versionNumber: r.versionNumber, at: r.verdictAt }, input);
}

/** A force approval counts now: it decides the state, and no reviewer verdict can change it. */
export const forceCounts = (input: RuleInput): boolean => countsNow(input.force, input);

export function computeReviewState(input: RuleInput): ComputedState {
  if (forceCounts(input)) return "approved";
  const current = input.reviewers.filter((r) => reviewerCounts(r, input));
  if (current.some((r) => r.verdict === "changes_requested")) return "changes_requested";
  if (
    input.reviewers.length > 0 &&
    current.length === input.reviewers.length &&
    current.every((r) => r.verdict === "approved")
  ) {
    return "approved";
  }
  return "in_review";
}

export function approvedCount(input: RuleInput): number {
  return input.reviewers.filter((r) => r.verdict === "approved" && reviewerCounts(r, input)).length;
}

/** Reviewers a force on the current version overrides: every one without a counting approval. */
export function overriddenReviewerIds(input: RuleInput): string[] {
  return input.reviewers.filter((r) => !(r.verdict === "approved" && reviewerCounts(r, input))).map((r) => r.id);
}

/** One overridden reviewer for the forced banner. `row` null: the reviewer was removed since. */
export function overrideSentence(
  name: string | null,
  row: { verdict: Verdict; versionNumber: number | null } | null,
  forcedVersion: number,
): string {
  if (name === null || row === null) return `A removed reviewer had not reviewed v${forcedVersion}`;
  if (row.verdict === "changes_requested" && row.versionNumber === forcedVersion) {
    return `${name} had requested changes on v${forcedVersion}`;
  }
  return `${name} had not reviewed v${forcedVersion}`;
}
