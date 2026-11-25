// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { PlanSetPayload } from "../../core/plans/page-payload.js";
import { renderPlanBar, requestedTab, setPlanBarTab } from "./plan-bar.js";

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

  it("carries the open side-panel tab in its links, set before or after rendering", () => {
    const host = document.createElement("nav");
    const plan = {
      number: 7,
      approved: 0,
      counted: 2,
      documents: [doc("plan.md", "in_review"), doc("option-a/", "in_review")],
    };
    renderPlanBar(host, plan);
    const hrefs = () => [...host.querySelectorAll("a.plan-chip")].map((a) => a.getAttribute("href"));
    expect(hrefs()).toEqual(["/d/plan.md", "/d/option-a/"]);
    setPlanBarTab(host, "review");
    expect(hrefs()).toEqual(["/d/plan.md?tab=review", "/d/option-a/?tab=review"]);
    renderPlanBar(host, plan);
    expect(hrefs()).toEqual(["/d/plan.md?tab=review", "/d/option-a/?tab=review"]);
  });
});

describe("requestedTab", () => {
  it("returns the asked tab, mapped and only if this page has it, and drops it from the address", () => {
    history.replaceState(null, "", "/d/x?tab=review#c1");
    expect(requestedTab(["comments", "review", "history"] as const)).toBe("review");
    expect(location.pathname + location.search + location.hash).toBe("/d/x#c1");
    history.replaceState(null, "", "/d/x?tab=history");
    expect(requestedTab(["comments", "review", "history"] as const)).toBe("history");
    history.replaceState(null, "", "/d/x?tab=style");
    expect(requestedTab(["comments", "review", "history"] as const, { style: "comments" })).toBe("comments");
    history.replaceState(null, "", "/d/x?tab=settings");
    expect(requestedTab(["comments", "review", "history"] as const)).toBeUndefined();
    history.replaceState(null, "", "/d/x");
    expect(requestedTab(["comments"] as const)).toBeUndefined();
  });
});
