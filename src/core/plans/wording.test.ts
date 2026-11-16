import { describe, expect, it } from "vitest";
import { PLAN_FOLDER_PATH } from "../../coding/protocol.js";
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
});
