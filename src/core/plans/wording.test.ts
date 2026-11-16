import { describe, expect, it } from "vitest";
import { composeCodingTask, MAX_CODING_TASK_BYTES, PLAN_FOLDER_PATH } from "../../coding/protocol.js";
import { PLAN_LAYOUT_RULES, planRevisionNote, plannerTaskNote, withPlanSections } from "./wording.js";

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
