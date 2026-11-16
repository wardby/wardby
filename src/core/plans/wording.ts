import { PLAN_FOLDER_PATH } from "../../coding/protocol.js";
import type { PlanSummary, PublishedPlan } from "./publish.js";

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
