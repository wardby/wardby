/** Review wording for the page (spec "Page"): pure, so it is unit-tested without a DOM. */
import type { ReviewPayload, ReviewerPayload, ReviewState } from "./api.js";

export const STATE_LABEL: Record<ReviewState, string> = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  archived: "Archived",
};
export const isLockedState = (s: ReviewState) => s === "approved" || s === "archived";

export const EVENT_LABEL: Record<string, string> = {
  submitted: "submitted for review",
  reviewers_changed: "changed the reviewers",
  approved: "approved",
  changes_requested: "requested changes",
  force_approved: "force approved",
  reopened: "reopened for review",
  archived: "archived",
  unarchived: "unarchived",
};

export function bannerText(r: ReviewPayload): string {
  if (r.state === "approved" && r.forced)
    return `Approved (forced by ${r.forced.byName}) · ${r.forced.notes.join(" · ")}`;
  const head = `${STATE_LABEL[r.state]} · v${r.currentVersion}`;
  if (r.state === "draft" || r.state === "archived" || r.progress.total === 0) return head;
  return `${head} · ${r.progress.approved} of ${r.progress.total} approved`;
}

export function reviewerChip(r: ReviewerPayload, current: number): string {
  if (r.verdict === "none" || r.versionNumber === null) return "Waiting";
  const label = r.verdict === "approved" ? "Approved" : "Changes requested";
  if (r.current) return `${label} v${r.versionNumber}`;
  return r.versionNumber === current
    ? `${label} v${r.versionNumber} · before reopening`
    : `${label} v${r.versionNumber} · older version`;
}

export const newerNote = (read: number, current: number) =>
  `v${current} was published while you were reviewing v${read}`;

export const raceNote = (verdict: "approve" | "request_changes", current: number) =>
  `v${current} was published just before your ${verdict === "approve" ? "approval" : "request for changes"}, so it wasn't recorded. Here's what changed.`;

export const verdictLabels = (read: number, raced: boolean) =>
  raced
    ? { approve: `Approve v${read}`, changes: `Request changes on v${read}` }
    : { approve: "Approve", changes: "Request changes" };

/** Who a force would override, for the confirm step. */
export function pendingLines(r: ReviewPayload): string[] {
  return r.reviewers
    .filter((x) => !(x.verdict === "approved" && x.current))
    .map((x) =>
      x.verdict === "changes_requested" && x.current
        ? `${x.name} has requested changes on v${r.currentVersion}`
        : `${x.name} has not reviewed v${r.currentVersion}`,
    );
}
