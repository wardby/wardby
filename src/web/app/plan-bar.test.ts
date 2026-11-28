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

describe("the plan rail's outline", () => {
  const d = (
    id: string,
    path: string,
    reviewState = "in_review",
    over: { removed?: boolean; current?: boolean } = {},
  ) => ({
    ...doc(path, reviewState, over.removed ?? false),
    id,
    current: over.current ?? false,
    versionNumber: 1,
  });
  const groups = (host: HTMLElement) =>
    [...host.querySelectorAll(".plan-group")].map((g) => [
      g.querySelector("h3, summary")?.textContent ?? "",
      [...g.querySelectorAll(".plan-title")].map((t) => t.textContent),
    ]);

  it("groups plan.md, the alternatives, the other documents, and what left the plan (folded)", () => {
    const host = document.createElement("nav");
    renderPlanBar(host, {
      number: 3,
      approved: 1,
      counted: 5,
      documents: [
        d("pm", "plan.md", "approved"),
        d("a", "option-a/"),
        d("b", "option-b/", "in_review", { current: true }),
        d("s", "screens/"),
        d("c", "option-c/", "rejected", { removed: true }),
      ],
    });
    expect(groups(host)).toEqual([
      ["", ["plan.md"]],
      ["Options", ["option-a/", "option-b/"]],
      ["Other documents", ["screens/"]],
      ["Out of the plan (1)", ["option-c/"]],
    ]);
    expect(host.querySelector<HTMLDetailsElement>("details.plan-out")!.open).toBe(false);
    expect(host.querySelector(".plan-row.current .plan-title")?.textContent).toBe("option-b/");
  });

  it("calls them Documents when the plan offers no alternatives, and opens the fold on a page that left the plan", () => {
    const host = document.createElement("nav");
    renderPlanBar(host, {
      number: 4,
      approved: 0,
      counted: 2,
      documents: [
        d("pm", "plan.md"),
        d("n", "notes.md"),
        d("x", "old.md", "rejected", { removed: true, current: true }),
      ],
    });
    expect(groups(host).map(([title]) => title)).toEqual(["", "Documents", "Out of the plan (1)"]);
    expect(host.querySelector<HTMLDetailsElement>("details.plan-out")!.open).toBe(true);
  });

  it("links a row's name to the document (on the open tab) and its state to the document's Review tab", () => {
    const host = document.createElement("nav");
    setPlanBarTab(host, "history");
    renderPlanBar(host, { number: 5, approved: 0, counted: 1, documents: [d("pm", "plan.md")] });
    expect(host.querySelector("a.plan-chip")!.getAttribute("href")).toBe("/d/plan.md?tab=history");
    const review = host.querySelector("a.plan-review")!;
    expect(review.getAttribute("href")).toBe("/d/plan.md?tab=review");
    expect(review.querySelector(".plan-state")!.textContent).toBe("In review");
  });
});

describe("several option sets", () => {
  const d = (id: string, path: string, reviewState = "in_review") => ({
    ...doc(path, reviewState),
    id,
    versionNumber: 2,
  });
  const PLAN = {
    number: 8,
    approved: 0,
    counted: 6,
    documents: [
      d("pm", "plan.md"),
      d("la", "layout-a-tree/"),
      d("lb", "layout-b-cards/"),
      d("ca", "color-a-light/"),
      d("cb", "color-b-dark/"),
      d("s", "screens/"),
    ],
  };
  const buttons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("button.plan-pick-open")];

  it("groups each set on its own, with its own Pick button", () => {
    const host = document.createElement("nav");
    setPlanBarChooser(host, vi.fn());
    renderPlanBar(host, PLAN);
    const groups = [...host.querySelectorAll(".plan-group")].map((g) => [
      g.querySelector("h3")?.textContent ?? "",
      [...g.querySelectorAll(".plan-title")].map((t) => t.textContent),
    ]);
    expect(groups).toEqual([
      ["", ["plan.md"]],
      ["Layout options", ["layout-a-tree/", "layout-b-cards/"]],
      ["Color options", ["color-a-light/", "color-b-dark/"]],
      ["Other documents", ["screens/"]],
    ]);
    expect(buttons(host).map((b) => b.textContent)).toEqual(["Pick a layout", "Pick a color"]);
  });

  it("a set's pick asks about that set only, and rejects only within it", async () => {
    const host = document.createElement("nav");
    document.body.replaceChildren(host);
    const chooser = vi.fn(() => Promise.resolve({ review: { state: "approved" } }));
    setPlanBarChooser(host, chooser);
    renderPlanBar(host, PLAN);
    buttons(host)[1].click();
    const panel = host.querySelector(".plan-pick")!;
    expect(panel.querySelector("h3")!.textContent).toBe("Which color should be built?");
    const radios = [...panel.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.parentElement!.querySelector("span")!.textContent)).toEqual([
      "color-a-light/",
      "color-b-dark/",
    ]);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change"));
    const ticked = [...host.querySelectorAll<HTMLInputElement>('.plan-pick input[type="checkbox"]')]
      .filter((b) => b.checked)
      .map((b) => b.parentElement!.querySelector("span")!.textContent);
    expect(ticked).toEqual(["color-a-light/"]);
    [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((b) => /^Approve and reject/.test(b.textContent ?? ""))!
      .click();
    await vi.waitFor(() => expect(chooser).toHaveBeenCalled());
    expect(chooser).toHaveBeenCalledWith("cb", { action: "choose", versionNumber: 2, reject: ["ca"] });
  });
});

describe("a native option set's bar", () => {
  const opt = (id: string, option: string, reviewState = "in_review", removed = false) => ({
    id,
    title: `Title of ${option}`,
    kind: "document" as const,
    reviewState,
    path: option,
    removed,
    current: id === "a",
    versionNumber: 2,
    pagePath: `/d/${id}`,
  });
  const SET: PlanSetPayload = {
    kind: "options",
    name: "landing",
    number: 0,
    approved: 0,
    counted: 2,
    documents: [opt("a", "concept-a"), opt("b", "concept-b")],
  };
  const button = (host: HTMLElement, label: string | RegExp) =>
    [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""),
    );

  it("is titled by the set's name and lists each option by its label", () => {
    const host = document.createElement("nav");
    renderPlanBar(host, { ...SET, documents: [...SET.documents, opt("c", "concept-c", "rejected", true)] });
    expect(host.querySelector(".plan-count")?.textContent).toBe("landing · 0 of 2 approved");
    expect([...host.querySelectorAll(".plan-group-head h3")].map((x) => x.textContent)).toEqual(["Options"]);
    expect([...host.querySelectorAll(".plan-title")].map((t) => t.textContent)).toEqual([
      "concept-a",
      "concept-b",
      "concept-c",
    ]);
    expect(host.querySelector(".plan-out summary")?.textContent).toBe("Out of the set (1)");
    expect(host.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe("/d/a");
    // A guest's partial bar: the name only.
    renderPlanBar(host, { ...SET, partial: true });
    expect(host.querySelector(".plan-count")?.textContent).toBe("landing");
  });

  it("picks between all open options, ticks the others, and says what the choice did", async () => {
    const host = document.createElement("nav");
    document.body.replaceChildren(host);
    const chooser = vi.fn(() => Promise.resolve({ review: { state: "approved" } }));
    setPlanBarChooser(host, chooser);
    renderPlanBar(host, SET);
    button(host, "Pick an option")!.click();
    expect(host.querySelector(".plan-pick h3")?.textContent).toBe("Which option should be kept?");
    const radios = [...host.querySelectorAll<HTMLInputElement>('.plan-pick input[type="radio"]')];
    expect(radios.map((r) => r.parentElement!.querySelector("span")!.textContent)).toEqual(["concept-a", "concept-b"]);
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change"));
    const ticks = [...host.querySelectorAll<HTMLInputElement>('.plan-pick input[type="checkbox"]')].map((b) => [
      b.parentElement!.querySelector("span")!.textContent,
      b.checked,
    ]);
    expect(ticks).toEqual([["concept-a", true]]);
    // An option set is never built: no "ready to build" sentence.
    expect(host.querySelector(".ch-summary")!.textContent).toBe("This approves concept-b and rejects concept-a.");
    button(host, /^Approve and reject/)!.click();
    await vi.waitFor(() => expect(host.querySelector(".plan-result")).not.toBeNull());
    expect(chooser).toHaveBeenCalledWith("b", { action: "choose", versionNumber: 2, reject: ["a"] });
    expect(host.querySelector(".plan-result span")!.textContent).toBe("You chose concept-b. Rejected: concept-a.");
  });
});
