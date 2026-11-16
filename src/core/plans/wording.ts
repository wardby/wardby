import { PLAN_FOLDER_PATH } from "../../coding/protocol.js";

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
