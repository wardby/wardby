// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PlanSetPayload } from "../../core/plans/page-payload.js";
import { renderPlanBar } from "./plan-bar.js";

const doc = (path: string, reviewState: string, removed = false): PlanSetPayload["documents"][number] => ({
  id: path,
  title: path,
  kind: path.endsWith("/") ? "design" : "document",
  reviewState,
  path,
  removed,
  current: false,
  pagePath: `/d/${path}`,
});

describe("renderPlanBar", () => {
  it("labels a rejected document Rejected and a removed one Removed, both struck through", () => {
    const host = document.createElement("nav");
    renderPlanBar(host, {
      number: 7,
      approved: 2,
      counted: 2,
      documents: [
        doc("plan.md", "approved"),
        doc("option-b/", "approved"),
        doc("option-a/", "rejected", true),
        doc("old.md", "in_review", true),
      ],
    });
    expect(host.querySelector(".plan-count")?.textContent).toBe("Plan 7 · 2 of 2 approved");
    const states = [...host.querySelectorAll(".plan-state")].map((s) => s.textContent);
    expect(states).toEqual(["Approved", "Approved", "Rejected", "Removed"]);
    expect([...host.querySelectorAll(".plan-chips s .plan-title")].map((t) => t.textContent)).toEqual([
      "option-a/",
      "old.md",
    ]);
  });
});
