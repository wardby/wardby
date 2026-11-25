import { PLAN_FOLDER_PATH } from "../../coding/protocol.js";
import { defuseMentions } from "../reply-parts.js";
import type { PlanSummary, PublishedPlan } from "./publish.js";
import type { PlanRefusedError } from "./refusal.js";

/** The layout a planner (or a revision) writes, shared by both notes. */
export const PLAN_LAYOUT_RULES = [
  "Layout: each top-level `*.md` file is one document; `plan.md` comes first, and a document's title is its first heading.",
  "Each subfolder in the board format (`manifest.json` plus `boards/*.html`) is one design. Anything else is ignored.",
  "`plan.md` ends with a `## Tickets` section with one `### Ticket <t>: <title>` heading per ticket, numbered from 1.",
  "At most 20 documents and 8 MiB in all; each Markdown document at most 60,000 characters.",
].join("\n");

export function plannerTaskNote(input: { store: "wardby" | "repository"; folder: string; number: number }): string {
  const where =
    input.store === "wardby"
      ? `Write plan ${input.number} as files under \`${input.folder}/\` (outside the repository). Change nothing in the repository: no file, no commit.`
      : `Write plan ${input.number} as files under the repository folder \`${input.folder}\`. Change nothing else.`;
  return `${where}\n${PLAN_LAYOUT_RULES}`;
}

/** A revision run (B8): the set's current files are already in the plan folder. */
export function planRevisionNote(): string {
  return `The plan's files are in \`${PLAN_FOLDER_PATH}/\`; edit them there to answer the threads. Change nothing in the repository.\n${PLAN_LAYOUT_RULES}`;
}

/** The request with plan sections after it: stored as the run's request, so every composer keeps them. */
export function withPlanSections(request: string, sections: readonly string[]): string {
  return [request, ...sections].join("\n\n");
}

const STATE_WORDS: Record<string, string> = {
  draft: "draft",
  in_review: "in review",
  changes_requested: "changes requested",
  approved: "approved",
  rejected: "rejected",
  archived: "archived",
};

/** A published plan's reply: file names, states and links only, never a document's text or a reviewer's name. */
export function planReplyLines(plan: PublishedPlan): string[] {
  const lines = [`Plan ${plan.number}:`];
  for (const doc of plan.documents) {
    const state =
      doc.change === "removed" ? "removed from the plan" : (STATE_WORDS[doc.reviewState] ?? doc.reviewState);
    const note =
      doc.change === "approved_unchanged"
        ? "; not changed, reopen it first"
        : doc.change === "rejected_unchanged"
          ? "; not in the plan, reopen it to bring it back"
          : doc.change === "archived_unchanged"
            ? "; not changed, it is archived"
            : "";
    lines.push(`- ${doc.path} (${state}${note}): ${doc.url ?? doc.pagePath}`);
  }
  if (plan.withheld.length > 0) {
    lines.push(`Not published, because it held a token-shaped value: ${plan.withheld.join(", ")}`);
  }
  if (plan.ignored.length > 0) lines.push(`Ignored: ${plan.ignored.join(", ")}`);
  if (plan.skippedReviewers.length > 0) {
    lines.push(
      `Not asked to review (no longer has access to the agent): ${plan.skippedReviewers.length} ${plan.skippedReviewers.length === 1 ? "person" : "people"}`,
    );
  }
  return lines;
}

/** planReplyLines for a published plan; one line for a failure or a publish still running. */
export function planSummaryLines(plan: PlanSummary): string[] {
  if ("error" in plan) return [`Plan ${plan.number}: not published (${plan.error}).`];
  if ("pending" in plan) return [`Plan ${plan.number}: being published.`];
  return planReplyLines(plan);
}

/** A plan path as shown in a reply: one line, no code-span breakout. */
const shownPath = (path: string) => `\`${path.replace(/[`\r\n]/g, "")}\``;

/**
 * The reply on an issue (GitHub or Jira) when a buildFromPlan builder refuses to start (spec §7).
 * Fixed wording per refusal code; plan_not_approved lists the waiting documents by plan path only,
 * never a title or any document text. Never names the App's handle (it is posted by the App).
 */
export function planRefusedReply(err: PlanRefusedError): string {
  switch (err.code) {
    case "plan_not_approved":
      return err.waiting.length > 0
        ? `ℹ️ I didn't start a build: the plan is not approved yet. Still waiting for approval: ${err.waiting.map(shownPath).join(", ")}. Ask again once each is approved.`
        : "ℹ️ I didn't start a build: the plan could not be checked (`plan_not_approved`). An agent owner can look up `plan_not_approved` in the wardby help.";
    case "plan_too_large":
      return "ℹ️ I didn't start a build: the approved plan is too large for one run (`plan_too_large`).";
    case "plan_number_missing":
      return "ℹ️ I didn't start a run: it needs an issue or a plan number (`plan_number_missing`).";
  }
}

/** A bare URL (`https://…`, `www.…`) with its scheme broken by a zero-width space, so nothing autolinks it. */
export const defuseAutolinks = (text: string): string =>
  text.replace(/(https?|ftp)(:\/\/)/gi, "$1\u200b$2").replace(/(www)(\.)/gi, "$1\u200b$2");

/** A plan path in a notice or a PR body: one line, never a code-span delimiter, a design without its trailing slash. */
export const shownPlanPath = (path: string): string =>
  defuseAutolinks(path.replace(/\/$/, "").replace(/[`\r\n]+/g, ""));

/** @-mentions outside `code` spans defused: names and paths ping nobody; a code-span hint stays copyable. */
export function defuseNotice(text: string): string {
  return text
    .split(/(`[^`\n]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : defuseMentions(part)))
    .join("");
}
