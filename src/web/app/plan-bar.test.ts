// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { PlanSetPayload } from "../../core/plans/page-payload.js";
import { renderPlanBar, requestedTab, setPlanBarChooser, setPlanBarTab } from "./plan-bar.js";

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

describe("Pick an option", () => {
  const opt = (id: string, path: string, reviewState = "in_review") => ({
    ...doc(path, reviewState),
    id,
    versionNumber: 3,
  });
  const PLAN = {
    number: 9,
    approved: 1,
    counted: 5,
    documents: [
      opt("pm", "plan.md", "approved"),
      opt("a", "option-a/"),
      opt("b", "option-b/"),
      opt("c", "option-c/"),
      opt("s", "screens/"),
    ],
  };
  const button = (host: HTMLElement, label: string | RegExp) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""),
    );

  it("is offered to members with a chooser when there are options, never to a guest's partial bar", () => {
    const host = document.createElement("nav");
    renderPlanBar(host, PLAN);
    expect(button(host, "Pick an option")).toBeUndefined();
    setPlanBarChooser(host, vi.fn());
    expect(button(host, "Pick an option")).toBeDefined();
    renderPlanBar(host, { ...PLAN, partial: true });
    expect(button(host, "Pick an option")).toBeUndefined();
    // Decided: one option left beside shared screens; nothing to pick.
    const lone = {
      ...PLAN,
      documents: [opt("pm", "plan.md", "approved"), opt("a", "option-a/"), opt("s", "screens/")],
    };
    renderPlanBar(host, lone);
    expect(button(host, "Pick an option")).toBeUndefined();
  });

  it("picks the option, ticks its siblings to reject, and posts the choice to the chosen option", async () => {
    const host = document.createElement("nav");
    document.body.replaceChildren(host);
    const chooser = vi.fn(() => Promise.reject(new Error("document_review_forbidden")));
    setPlanBarChooser(host, chooser);
    renderPlanBar(host, PLAN);
    button(host, "Pick an option")!.click();
    const radios = [...host.querySelectorAll<HTMLInputElement>('.plan-pick input[type="radio"]')];
    // screens/ is not an alternative (no family): not offered to build, only (unticked) to reject.
    expect(radios.map((r) => r.parentElement!.querySelector("span")!.textContent)).toEqual([
      "option-a/",
      "option-b/",
      "option-c/",
    ]);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change"));
    const ticks = [...host.querySelectorAll<HTMLInputElement>('.plan-pick input[type="checkbox"]')].map((b) => [
      b.parentElement!.querySelector("span")!.textContent,
      b.checked,
    ]);
    expect(ticks).toEqual([
      ["option-a/", true],
      ["option-c/", true],
      ["screens/", false],
    ]);
    expect(host.querySelector(".ch-summary")!.textContent).toBe(
      "This approves option-b/ and rejects option-a/ and option-c/.",
    );
    button(host, /^Approve and reject/)!.click();
    await vi.waitFor(() => expect(chooser).toHaveBeenCalled());
    expect(chooser).toHaveBeenCalledWith("b", { action: "choose", versionNumber: 3, reject: ["a", "c"] });
    // A refusal is shown in the step, which stays open.
    await vi.waitFor(() => expect(host.querySelector(".plan-pick [role=alert]")).not.toBeNull());
  });

  it("says what the choice did under the bar, without leaving the page", async () => {
    const host = document.createElement("nav");
    document.body.replaceChildren(host);
    setPlanBarChooser(
      host,
      vi.fn(() => Promise.resolve({ review: { state: "approved" } })),
    );
    renderPlanBar(host, PLAN);
    button(host, "Pick an option")!.click();
    const radio = host.querySelectorAll<HTMLInputElement>('.plan-pick input[type="radio"]')[0];
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    button(host, /^Approve and reject/)!.click();
    await vi.waitFor(() => expect(host.querySelector(".plan-result")).not.toBeNull());
    expect(host.querySelector(".plan-result span")!.textContent).toBe(
      "You chose option-a/. Rejected: option-b/ and option-c/. Still waiting: screens/.",
    );
    expect(host.querySelector(".plan-pick")).toBeNull();
    button(host, "Dismiss")!.click();
    expect(host.querySelector(".plan-result")).toBeNull();
  });
});
