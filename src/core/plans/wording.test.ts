import { describe, expect, it } from "vitest";
import { composeCodingTask, MAX_CODING_TASK_BYTES, PLAN_FOLDER_PATH } from "../../coding/protocol.js";
import {
  PLAN_LAYOUT_RULES,
  planReplyLines,
  planRevisionNote,
  plannerTaskNote,
  planSummaryLines,
  withPlanSections,
} from "./wording.js";

describe("plannerTaskNote", () => {
  it("store wardby: writes under the plan folder, never the repository", () => {
    const note = plannerTaskNote({ store: "wardby", folder: PLAN_FOLDER_PATH, number: 12 });
    expect(note).toContain(`${PLAN_FOLDER_PATH}/`);
    expect(note).toContain("plan.md");
    expect(note).toContain("manifest.json");
    expect(note).toContain("## Tickets");
    expect(note).toMatch(/Change nothing in the repository/);
  });
  it("store repository: writes the folder and changes nothing else", () => {
    const note = plannerTaskNote({ store: "repository", folder: "docs/plans/issue-12/", number: 12 });
    expect(note).toContain("docs/plans/issue-12/");
    expect(note).toMatch(/Change nothing else/);
  });
  it("a revision edits the placed files, with the same layout rules", () => {
    const note = planRevisionNote();
    expect(note).toContain(`${PLAN_FOLDER_PATH}/`);
    expect(note).toMatch(/answer the threads/);
    expect(note).toContain(PLAN_LAYOUT_RULES);
  });
  it("withPlanSections appends after the request", () => {
    expect(withPlanSections("Do it.", ["A", "B"])).toBe("Do it.\n\nA\n\nB");
    expect(withPlanSections("Do it.", [])).toBe("Do it.");
  });

  it("a large knowledge index never costs the planner note: the note stays whole, the index is fitted or dropped", () => {
    const note = plannerTaskNote({ store: "wardby", folder: PLAN_FOLDER_PATH, number: 4 });
    const request = withPlanSections("Plan the feature.", [note]);
    const big = "k".repeat(MAX_CODING_TASK_BYTES);
    const composed = composeCodingTask("Be careful.", request, undefined, {
      render: (max) => big.slice(0, max),
    });
    expect(composed).toContain(note);
    expect(Buffer.byteLength(composed)).toBeLessThanOrEqual(MAX_CODING_TASK_BYTES);
    const dropped = composeCodingTask("Be careful.", request, undefined, { render: () => undefined });
    expect(dropped).toContain(note);
  });
});

describe("plan reply lines", () => {
  it("carry names, states and links, never text", () => {
    const lines = planReplyLines({
      number: 12,
      planSetId: "ps1",
      documents: [
        {
          id: "d1",
          pagePath: "/d/d1",
          url: "https://x/d/d1",
          kind: "document",
          path: "plan.md",
          reviewState: "in_review",
          versionNumber: 1,
          change: "created",
        },
        {
          id: "d2",
          pagePath: "/d/d2",
          url: "https://x/d/d2",
          kind: "design",
          path: "screens/",
          reviewState: "approved",
          versionNumber: 2,
          change: "approved_unchanged",
        },
      ],
      ignored: ["notes.txt"],
      withheld: ["leak.md"],
      skippedReviewers: ["p9", "p10"],
    });
    expect(lines).toEqual([
      "Plan 12:",
      "- plan.md (in review): https://x/d/d1",
      "- screens/ (approved; not changed, reopen it first): https://x/d/d2",
      "Not published, because it held a token-shaped value: leak.md",
      "Ignored: notes.txt",
      "Not asked to review (no longer has access to the agent): 2 people",
    ]);
    expect(lines.join("\n")).not.toContain("p9");
  });

  it("a document without a url shows its page path; failures and pending have one line", () => {
    const base = { number: 12, planSetId: "ps1", ignored: [], withheld: [], skippedReviewers: [] };
    const doc = {
      id: "d1",
      pagePath: "/d/d1",
      kind: "document" as const,
      path: "plan.md",
      reviewState: "in_review",
      versionNumber: 1,
      change: "created" as const,
    };
    expect(planReplyLines({ ...base, documents: [doc] })).toEqual(["Plan 12:", "- plan.md (in review): /d/d1"]);
    expect(planSummaryLines({ number: 12, error: "plan_too_large" })).toEqual([
      "Plan 12: not published (plan_too_large).",
    ]);
    expect(planSummaryLines({ number: 12, documents: [], pending: true })).toEqual(["Plan 12: being published."]);
    expect(planSummaryLines({ ...base, documents: [doc] })).toEqual(planReplyLines({ ...base, documents: [doc] }));
  });
});
