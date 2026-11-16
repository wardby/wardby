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

/** Shown on an approved document to anyone who can't reopen it (a guest, or a member without write access). */
export const ASK_TO_REOPEN = "Approved and locked. To change it, ask someone who can edit it to reopen it.";

/** The reviewer picker's wording (review-ui.ts). */
export const PICKER = {
  start: "Start review",
  submit: "Submit for review",
  edit: "Edit reviewers",
  save: "Save reviewers",
  find: "Find people",
  onlyYou:
    "Only people with access to this document can be named. For anyone else, create a comment link: once they open it and give a name, they appear here.",
  noMatch: "No one matches.",
  createLink: "Create comment link",
  linkShown:
    "Comment link (shown once; expires in 14 days). Send it to the reviewer; after they open it and give a name, choose Refresh list.",
  copy: "Copy",
  copied: "Copied",
  refresh: "Refresh list",
} as const;

/** Whether a candidate's name matches the picker's search (case-insensitive, anywhere in the name). */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || name.toLowerCase().includes(q);
}

export function reviewerChip(r: ReviewerPayload): string {
  if (r.verdict === "none" || r.versionNumber === null) return "Waiting";
  const label = r.verdict === "approved" ? "Approved" : "Changes requested";
  if (r.current) return `${label} v${r.versionNumber}`;
  return `${label} v${r.versionNumber} · older version`;
}

/**
 * Whether version `latest` is a reopen's copy of version `shown`: a reopen for review writes the next version as a
 * copy of the approved one, and its event names that new version.
 */
export const isReopenCopy = (r: Pick<ReviewPayload, "events">, shown: number, latest: number): boolean =>
  latest === shown + 1 && r.events.some((e) => e.kind === "reopened" && e.versionNumber === latest);

export const newerNote = (read: number, current: number) =>
  `v${current} was published while you were reviewing v${read}`;

export const raceNote = (verdict: "approve" | "request_changes", current: number) =>
  `v${current} was published just before your ${verdict === "approve" ? "approval" : "request for changes"}, so it wasn't recorded. Here's what changed.`;

export const verdictLabels = (read: number, raced: boolean) =>
  raced
    ? { approve: `Approve v${read}`, changes: `Request changes on v${read}` }
    : { approve: "Approve", changes: "Request changes" };

type MyVerdict = ReviewerPayload["verdict"];

/** The viewer's own verdict while it counts (on the current version), else "none". */
export const myCurrentVerdict = (r: ReviewPayload): MyVerdict =>
  r.reviewers.find((x) => x.me && x.current)?.verdict ?? "none";

/**
 * What a reviewer is offered, as labels (null: not shown). `review` ("Review vN") replaces everything
 * while a newer version than the one read is current. Approved: only Request changes, unless a force
 * approval made it (final: no buttons). In review or
 * changes requested: the verdict the viewer has not already given on the current version, with a
 * status line for the one they have. A repeat verdict would change nothing, so it is never offered.
 */
export interface VerdictControls {
  review: string | null;
  status: string | null;
  approve: string | null;
  changes: string | null;
}

export function verdictControls(i: {
  state: ReviewState;
  mine: MyVerdict;
  read: number;
  current: number;
  raced: boolean;
  /** The approval is a force approval, which is final: no verdict is offered. */
  forced?: boolean;
}): VerdictControls {
  const out: VerdictControls = { review: null, status: null, approve: null, changes: null };
  if (i.state !== "in_review" && i.state !== "changes_requested" && i.state !== "approved") return out;
  if (i.current !== i.read && !i.raced) return { ...out, review: `Review v${i.current}` };
  if (i.mine === "approved") out.status = `You approved v${i.current}`;
  if (i.mine === "changes_requested") out.status = `You requested changes on v${i.current}`;
  if (i.forced && i.state === "approved") return out;
  const labels = verdictLabels(i.read, i.raced || i.state === "approved");
  if (i.state !== "approved" && i.mine !== "approved") out.approve = labels.approve;
  if (i.mine !== "changes_requested") out.changes = labels.changes;
  return out;
}

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
