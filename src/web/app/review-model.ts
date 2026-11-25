/** Review wording for the page (spec "Page"): pure, so it is unit-tested without a DOM. */
import type { ReviewPayload, ReviewerPayload, ReviewState } from "./api.js";

export const STATE_LABEL: Record<ReviewState, string> = {
  draft: "Draft",
  in_review: "In review",
  changes_requested: "Changes requested",
  approved: "Approved",
  rejected: "Rejected",
  archived: "Archived",
};
export const isLockedState = (s: ReviewState) => s === "approved" || s === "rejected" || s === "archived";

export const EVENT_LABEL: Record<string, string> = {
  submitted: "submitted for review",
  reviewers_changed: "changed the reviewers",
  approved: "approved",
  changes_requested: "requested changes",
  force_approved: "force approved",
  rejected: "rejected",
  reopened: "reopened for review",
  archived: "archived",
  unarchived: "unarchived",
};

export function bannerText(r: ReviewPayload): string {
  if (r.state === "approved" && r.forced)
    return `Approved (forced by ${r.forced.byName}) · ${r.forced.notes.join(" · ")}`;
  const head = `${STATE_LABEL[r.state]} · v${r.currentVersion}`;
  if (r.state === "draft" || r.state === "archived" || r.state === "rejected" || r.progress.total === 0) return head;
  return `${head} · ${r.progress.approved} of ${r.progress.total} approved`;
}

/** Shown on a rejected plan document to anyone who can't reopen it. */
export const REJECTED_NOTE =
  "Rejected: it is not part of the plan and is not given to a builder. Someone who can edit it can reopen it.";

/** The Reject form's explanation (review-ui.ts). */
export const REJECT_EXPLAIN =
  "This takes the document out of the plan: it stops counting toward the plan's approval and is not given to a builder. It stays here, read-only, as the record. Reopen brings it back.";

const listOf = (items: string[]) =>
  items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * The sentence under a choice: what confirming does. `ready` is whether the plan is then fully approved (null when
 * the page cannot tell, as for an option picked from the plan bar whose other reviewers it does not know).
 */
export function chooseSummary(input: {
  chosenPath: string;
  chosenApproved: boolean;
  rejectPaths: string[];
  ready: boolean | null;
}): string {
  if (input.rejectPaths.length === 0) return "Tick at least one document to reject.";
  const first = input.chosenApproved
    ? `This keeps ${input.chosenPath} approved and rejects ${listOf(input.rejectPaths)}.`
    : `This approves ${input.chosenPath} and rejects ${listOf(input.rejectPaths)}.`;
  if (input.ready === null) return first;
  return input.ready
    ? `${first} The plan is then ready to build.`
    : `${first} Other documents still need approval before the plan can be built.`;
}

/**
 * The option family a path names, or null: a prefix, a dash, then a one-letter or one-digit variant ending the name or
 * followed by "-", "." or "/" (option-a/, option-b-cards/, design-2.md share "option-" or "design-"). A word after the
 * dash is not a variant, so api-spec.md and api-client.md are not options of one another.
 */
export function optionFamily(path: string): string | null {
  const m = /^(.+?-)[a-z0-9](?:[-./]|$)/i.exec(path);
  return m ? m[1].toLowerCase() : null;
}

/**
 * The alternatives among a plan's open documents: those named in one option family (optionFamily) with at least one
 * other; shared parts such as screens/, and documents not named as options at all, are not alternatives (the planner
 * names alternatives <set>-<letter>-<slug>, PLAN_LAYOUT_RULES). (A lone option-a/ beside screens/ is a choice already made.)
 */
export function planAlternatives<T extends { path: string }>(docs: T[]): T[] {
  const sizes = new Map<string, number>();
  for (const d of docs) {
    const f = optionFamily(d.path);
    if (f) sizes.set(f, (sizes.get(f) ?? 0) + 1);
  }
  return docs.filter((d) => (sizes.get(optionFamily(d.path) ?? "") ?? 0) >= 2);
}

/** The plan's option sets (planAlternatives grouped by family), in the order their first document comes. */
export function optionSets<T extends { path: string }>(docs: T[]): Array<{ family: string; docs: T[] }> {
  const sets = new Map<string, T[]>();
  for (const d of planAlternatives(docs)) {
    const f = optionFamily(d.path)!;
    sets.set(f, [...(sets.get(f) ?? []), d]);
  }
  return [...sets].map(([family, list]) => ({ family, docs: list }));
}

/** How a set is named on the page: "option-" is just Options; "layout-" is Layout options, picked as "a layout". */
export function optionSetWords(family: string): { title: string; noun: string; pick: string } {
  const noun = family.replace(/-$/, "").toLowerCase();
  if (noun === "option") return { title: "Options", noun, pick: "Pick an option" };
  const article = /^[aeiou]/.test(noun) ? "an" : "a";
  return { title: `${noun[0].toUpperCase()}${noun.slice(1)} options`, noun, pick: `Pick ${article} ${noun}` };
}

/** What a choice did, said after it lands: rejected, and what the plan still waits for (or that it is ready). */
export function choiceResult(input: {
  chosenPath: string;
  chosenApproved: boolean;
  rejectedPaths: string[];
  waitingPaths: string[];
}): string {
  const head = `You chose ${input.chosenPath}. Rejected: ${listOf(input.rejectedPaths)}.`;
  const waiting = [...(input.chosenApproved ? [] : [`${input.chosenPath} (more approvals)`]), ...input.waitingPaths];
  return waiting.length ? `${head} Still waiting: ${listOf(waiting)}.` : `${head} The plan is ready to build.`;
}

/** One document the "Choose this option" checklist offers. */
export interface ChooseCandidate {
  id: string;
  title: string;
  path: string;
  reviewState: string;
  /** Ticked at first: named like the chosen one (option-b/ beside option-a/). */
  ticked: boolean;
}

const OPEN_FOR_CHOICE = new Set(["in_review", "changes_requested", "approved"]);

/**
 * The other documents of the plan a choice can reject: still in the plan, not plan.md, not the chosen one,
 * and in a state Reject takes. Those in the chosen one's option family (optionFamily: option-b-cards/ beside
 * option-a-tree/) start ticked; the rest (shared screens, other parts) start unticked.
 */
export function chooseCandidates(
  documents: Array<{
    id: string;
    title: string;
    path: string;
    reviewState: string;
    removed: boolean;
    current: boolean;
  }>,
): ChooseCandidate[] {
  const chosen = documents.find((d) => d.current);
  if (!chosen) return [];
  const family = optionFamily(chosen.path);
  return documents
    .filter((d) => !d.current && !d.removed && d.path !== "plan.md" && OPEN_FOR_CHOICE.has(d.reviewState))
    .map((d) => ({
      id: d.id,
      title: d.title,
      path: d.path,
      reviewState: d.reviewState,
      ticked: family !== null && optionFamily(d.path) === family,
    }));
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
