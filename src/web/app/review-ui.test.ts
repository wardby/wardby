// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ApiError, errorMessage, type Api, type ReviewPayload } from "./api.js";
import { ReviewPanel, type ReviewHost } from "./review-ui.js";

const payload = (currentVersion: number): ReviewPayload => ({
  state: "in_review",
  currentVersion,
  progress: { approved: 0, total: 1 },
  reviewers: [
    {
      id: "r1",
      kind: "member",
      name: "Ada",
      verdict: "none",
      versionNumber: null,
      note: null,
      current: true,
      me: true,
    },
  ],
  finalApprover: null,
  forced: null,
  routing: { router: null, jobs: [] },
  events: [],
  can: { submit: false, review: true, force: false, reopen: false, archive: false, unarchive: false },
});

/** A panel whose verdict is refused as stale; `latest` is what the page's refetch learns (or not). */
function setup(latest: number | null) {
  document.body.replaceChildren();
  const banner = document.createElement("div");
  const panel = document.createElement("div");
  document.body.append(banner, panel);
  const api = {
    review: vi.fn(() => Promise.reject(new ApiError("document_version_conflict", 409))),
  } as unknown as Api;
  const ref: { panel?: ReviewPanel } = {};
  const host: ReviewHost = {
    api,
    banner,
    panel,
    showReviewTab: vi.fn(),
    showChanges: vi.fn(),
    // The page's refresh: applies the new payload, or does nothing (failed or put off while saving).
    loadLatest: vi.fn(() => {
      if (latest !== null) ref.panel?.apply(payload(latest));
      return Promise.resolve();
    }),
    onLock: vi.fn(),
    onState: vi.fn(),
  };
  ref.panel = new ReviewPanel(host, payload(2), 2);
  return { banner, panel, host };
}

const approve = (panel: HTMLElement) => [...panel.querySelectorAll("button")].find((b) => b.textContent === "Approve")!;

describe("ReviewPanel: a verdict that lost the race", () => {
  it("shows the changes and names the newer version once the refetch finds it", async () => {
    const { panel, banner, host } = setup(3);
    approve(panel).click();
    await vi.waitFor(() => expect(host.showChanges).toHaveBeenCalledWith(2, 3));
    expect(banner.textContent).toContain("v3 was published just before your approval");
    expect([...panel.querySelectorAll("button")].map((b) => b.textContent)).toContain("Approve v3");
  });

  it("when the refetch learned nothing, keeps the usual error instead of a race against the same version", async () => {
    const { panel, banner, host } = setup(null);
    const note = panel.querySelector("textarea")!;
    note.value = "Keep me";
    note.dispatchEvent(new Event("input"));
    approve(panel).click();
    await vi.waitFor(() => expect(host.loadLatest).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(panel.querySelector("[role=alert]")?.textContent).toBe(
        errorMessage(new ApiError("document_version_conflict", 409)),
      ),
    );
    expect(host.showChanges).not.toHaveBeenCalled();
    expect(banner.textContent).not.toContain("just before your approval");
    expect(approve(panel)).toBeDefined();
    expect(panel.querySelector("textarea")!.value).toBe("Keep me");
  });
});

describe("ReviewPanel: the lock", () => {
  it("calls onLock on a lock flip and when a locked state changes word (approved to archived), not otherwise", () => {
    const { host } = setup(null);
    const panel = new ReviewPanel(host, payload(2), 2);
    vi.mocked(host.onLock).mockClear();
    panel.apply({ ...payload(2), state: "approved" });
    panel.apply({ ...payload(2), state: "approved" });
    panel.apply({ ...payload(2), state: "archived" });
    panel.apply({ ...payload(2), state: "in_review" });
    panel.apply({ ...payload(2), state: "draft" });
    expect(vi.mocked(host.onLock).mock.calls).toEqual([
      [true, "approved"],
      [true, "archived"],
      [false, "in_review"],
    ]);
  });
});

describe("ReviewPanel: the verdicts offered", () => {
  const buttons = (el: HTMLElement) => [...el.querySelectorAll(".rv-verdict button")].map((b) => b.textContent);
  const mine = (verdict: "approved" | "changes_requested"): ReviewPayload["reviewers"] => [
    { ...payload(2).reviewers[0], verdict, versionNumber: 2, current: true },
  ];

  it("once approved: only Request changes on vN, with what the viewer gave", () => {
    const { host, panel } = setup(null);
    new ReviewPanel(host, { ...payload(2), state: "approved", reviewers: mine("approved") }, 2);
    expect(buttons(panel)).toEqual(["Request changes on v2"]);
    expect(panel.querySelector(".rv-verdict")?.textContent).toContain("You approved v2");
  });

  it("in review: hides the verdict the viewer already gave on this version", () => {
    const { host, panel } = setup(null);
    const p = new ReviewPanel(host, { ...payload(2), reviewers: mine("approved") }, 2);
    expect(buttons(panel)).toEqual(["Request changes"]);
    p.apply({ ...payload(2), state: "changes_requested", reviewers: mine("changes_requested") });
    expect(buttons(panel)).toEqual(["Approve"]);
    expect(panel.querySelector(".rv-verdict")?.textContent).toContain("You requested changes on v2");
  });
});

describe("ReviewPanel: reopening", () => {
  const can = payload(2).can;

  const card = (el: HTMLElement) => el.querySelector(".rv-card");
  const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")].map((b) => b.textContent);

  it("on an approved document, someone who can't reopen it is told to ask an editor", () => {
    const { host, panel } = setup(null);
    new ReviewPanel(host, { ...payload(2), state: "approved" }, 2);
    expect(card(panel)?.textContent).toContain("ask someone who can edit it to reopen it");
    expect(buttons(panel)).not.toContain("Reopen for review");
  });

  it("a writer gets Reopen under Manage (never as the card's action) and no hint; nothing shows before approval", () => {
    const { host, panel } = setup(null);
    const p = new ReviewPanel(host, { ...payload(2), state: "approved", can: { ...can, reopen: true } }, 2);
    expect(card(panel)?.textContent).toContain("Nothing to do here.");
    expect(card(panel)?.querySelector("button")).toBeNull();
    expect(buttons(panel)).toContain("Reopen for review");
    expect(card(panel)?.textContent).not.toContain("ask someone");
    p.apply(payload(2));
    expect(panel.textContent).not.toContain("ask someone");
  });

  it("Reopen is a confirm step: one click reopens nothing", async () => {
    const { host, panel } = setup(null);
    new ReviewPanel(host, { ...payload(2), state: "approved", can: { ...can, reopen: true } }, 2);
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Reopen for review")!.click();
    expect(host.api.review).not.toHaveBeenCalled();
    expect(panel.querySelector("h3")?.textContent).toBe("Reopen for review");
    expect(panel.textContent).toContain("This starts v3, a copy of v2");
    expect(buttons(panel)).toEqual(["Reopen", "Cancel"]);
    [...panel.querySelectorAll("button")].find((b) => b.textContent === "Reopen")!.click();
    await vi.waitFor(() => expect(host.api.review).toHaveBeenCalledWith({ action: "reopen" }));
  });
});

describe("ReviewPanel: the reviewer picker", () => {
  type Candidates = Awaited<ReturnType<Api["reviewCandidates"]>>;
  const draft = (): ReviewPayload => ({
    ...payload(1),
    state: "draft",
    progress: { approved: 0, total: 0 },
    reviewers: [],
    can: { submit: true, review: false, force: false, reopen: false, archive: true, unarchive: false },
  });
  const you = { principalId: "p-owner", name: "Owner" };
  function picker(lists: Candidates[]) {
    document.body.replaceChildren();
    const banner = document.createElement("div");
    const panel = document.createElement("div");
    document.body.append(banner, panel);
    let call = 0;
    const api = {
      reviewCandidates: vi.fn(() => Promise.resolve(lists[Math.min(call++, lists.length - 1)])),
      createCommentLink: vi.fn(() =>
        Promise.resolve({ id: "l1", path: "/s/tok", expiresAt: "2026-12-01T00:00:00.000Z" }),
      ),
      review: vi.fn((body: unknown) => Promise.resolve({ review: { ...draft(), state: "in_review", body } })),
    } as unknown as Api;
    const host: ReviewHost = {
      api,
      banner,
      panel,
      showReviewTab: vi.fn(),
      showChanges: vi.fn(),
      loadLatest: vi.fn(() => Promise.resolve()),
      onLock: vi.fn(),
      onState: vi.fn(),
    };
    new ReviewPanel(host, draft(), 1);
    return { panel, api };
  }
  const button = (panel: HTMLElement, label: string) =>
    [...panel.querySelectorAll("button")].find((b) => b.textContent === label);
  const names = (panel: HTMLElement) =>
    [...panel.querySelectorAll<HTMLLabelElement>(".rv-pick-list .rv-pick")]
      .filter((l) => !l.hidden)
      .map((l) => l.textContent);

  it("a draft offers Start review; the picker lists members with access and guests, and submits the picked", async () => {
    const { panel, api } = picker([
      {
        members: [you, { principalId: "p-bo", name: "Bo" }],
        guests: [{ guestId: "g1", name: "Gail" }],
      },
    ]);
    expect(button(panel, "Submit for review")).toBeUndefined();
    button(panel, "Start review")!.click();
    await vi.waitFor(() => expect(names(panel)).toEqual(["Owner", "Bo", "Gail (guest)"]));
    expect(panel.textContent).not.toContain("Only people with access");
    // The picker is a focused step: the other actions are hidden while it is open.
    expect(button(panel, "Start review")).toBeUndefined();
    panel.querySelector<HTMLInputElement>('input[aria-label="Bo"]')!.click();
    button(panel, "Submit for review")!.click();
    await vi.waitFor(() =>
      expect(api.review).toHaveBeenCalledWith({ action: "submit", reviewers: ["p-bo"], finalApproverId: null }),
    );
  });

  it("the search filters in place, keeping the same box (and its focus) while typing", async () => {
    const { panel } = picker([
      {
        members: [you, { principalId: "p-ada", name: "Ada Lovelace" }, { principalId: "p-bo", name: "Bo" }],
        guests: [],
      },
    ]);
    button(panel, "Start review")!.click();
    await vi.waitFor(() => expect(names(panel)).toHaveLength(3));
    const search = panel.querySelector<HTMLInputElement>('input[aria-label="Find people"]')!;
    search.focus();
    search.value = "love";
    search.dispatchEvent(new Event("input"));
    expect(names(panel)).toEqual(["Ada Lovelace"]);
    expect(document.activeElement).toBe(search);
    search.value = "zed";
    search.dispatchEvent(new Event("input"));
    expect(names(panel)).toEqual([]);
    expect(panel.textContent).toContain("No one matches.");
  });

  it("with only the owner to name, says so; a comment link is made, shown with this origin, and Refresh lists its guest", async () => {
    const { panel, api } = picker([
      { members: [you], guests: [] },
      { members: [you], guests: [{ guestId: "g1", name: "Gail" }] },
    ]);
    button(panel, "Start review")!.click();
    await vi.waitFor(() =>
      expect(panel.textContent).toContain("Only people with access to this document can be named."),
    );
    expect(panel.querySelector('input[aria-label="Find people"]')).toBeNull();
    button(panel, "Create comment link")!.click();
    await vi.waitFor(() =>
      expect(panel.querySelector<HTMLInputElement>('input[aria-label="Comment link"]')?.value).toBe(
        `${location.origin}/s/tok`,
      ),
    );
    expect(api.createCommentLink).toHaveBeenCalledTimes(1);
    button(panel, "Refresh list")!.click();
    await vi.waitFor(() => expect(names(panel)).toEqual(["Owner", "Gail (guest)"]));
    // The link stays shown until the picker closes; closing forgets it.
    expect(panel.querySelector('input[aria-label="Comment link"]')).not.toBeNull();
    button(panel, "Cancel")!.click();
    button(panel, "Start review")!.click();
    await vi.waitFor(() => expect(names(panel)).toHaveLength(2));
    expect(panel.querySelector('input[aria-label="Comment link"]')).toBeNull();
  });

  it("in review the bar says Edit reviewers and the picker saves", async () => {
    document.body.replaceChildren();
    const banner = document.createElement("div");
    const panel = document.createElement("div");
    document.body.append(banner, panel);
    const api = {
      reviewCandidates: vi.fn(() => Promise.resolve({ members: [you], guests: [] })),
    } as unknown as Api;
    new ReviewPanel(
      {
        api,
        banner,
        panel,
        showReviewTab: vi.fn(),
        showChanges: vi.fn(),
        loadLatest: vi.fn(() => Promise.resolve()),
        onLock: vi.fn(),
        onState: vi.fn(),
      },
      { ...payload(1), can: { ...payload(1).can, submit: true } },
      1,
    );
    button(panel, "Edit reviewers")!.click();
    await vi.waitFor(() => expect(button(panel, "Save reviewers")).toBeDefined());
    expect(button(panel, "Create comment link")).toBeDefined();
  });
});

describe("ReviewPanel: Reject", () => {
  const can = (over: Partial<ReviewPayload["can"]>): ReviewPayload["can"] => ({
    submit: false,
    review: false,
    force: false,
    reopen: false,
    archive: false,
    unarchive: false,
    ...over,
  });
  function mount(review: ReviewPayload, answer?: ReviewPayload) {
    document.body.replaceChildren();
    const banner = document.createElement("div");
    const panel = document.createElement("div");
    document.body.append(banner, panel);
    const reviewCall = vi.fn((_body: unknown) => Promise.resolve({ review: answer ?? review }));
    const host: ReviewHost = {
      api: { review: reviewCall } as unknown as Api,
      banner,
      panel,
      showReviewTab: vi.fn(),
      showChanges: vi.fn(),
      loadLatest: vi.fn(() => Promise.resolve()),
      onLock: vi.fn(),
      onState: vi.fn(),
    };
    new ReviewPanel(host, review, review.currentVersion);
    return { panel, reviewCall };
  }
  const actionButton = (panel: HTMLElement, label: string) =>
    [...panel.querySelectorAll<HTMLButtonElement>(".rv-actions button")].find((b) => b.textContent === label);

  it("offers Reject only when the server says so", () => {
    expect(actionButton(mount({ ...payload(1), can: can({}) }).panel, "Reject")).toBeUndefined();
    expect(actionButton(mount({ ...payload(1), can: can({ reject: true }) }).panel, "Reject")).toBeDefined();
  });

  it("asks for a note before rejecting, then posts the reject action with it", async () => {
    const rejected: ReviewPayload = { ...payload(1), state: "rejected", can: can({ reopen: true }) };
    const { panel, reviewCall } = mount({ ...payload(1), can: can({ reject: true }) }, rejected);
    actionButton(panel, "Reject")!.click();
    const form = panel.querySelector<HTMLElement>('[role="group"][aria-label="Reject"]')!;
    expect(form.textContent).toContain("takes the document out of the plan");
    const confirm = () =>
      [...panel.querySelectorAll<HTMLButtonElement>('[aria-label="Reject"] button')].find(
        (b) => b.textContent === "Reject",
      )!;
    expect(confirm().disabled).toBe(true);
    const note = form.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reject note"]')!;
    note.value = "Option B was chosen";
    note.dispatchEvent(new Event("input"));
    expect(confirm().disabled).toBe(false);
    confirm().click();
    await vi.waitFor(() => expect(reviewCall).toHaveBeenCalledWith({ action: "reject", note: "Option B was chosen" }));
    await vi.waitFor(() => expect(actionButton(panel, "Reopen for review")).toBeDefined());
  });

  it("tells someone who can't reopen a rejected document what it means", () => {
    const { panel } = mount({ ...payload(1), state: "rejected", can: can({}) });
    expect(panel.textContent).toContain("Rejected: it is not part of the plan");
  });
});

describe("ReviewPanel: Choose this option", () => {
  const can = (over: Partial<ReviewPayload["can"]>): ReviewPayload["can"] => ({
    submit: false,
    review: false,
    force: false,
    reopen: false,
    archive: false,
    unarchive: false,
    ...over,
  });
  const doc = (
    id: string,
    path: string,
    reviewState = "in_review",
    over: { removed?: boolean; current?: boolean } = {},
  ) => ({
    id,
    title: path,
    kind: "design" as const,
    reviewState,
    path,
    removed: over.removed ?? false,
    current: over.current ?? false,
    pagePath: `/d/${id}`,
  });
  const PLAN = [
    doc("pm", "plan.md", "approved"),
    doc("a", "option-a-tree/", "in_review", { current: true }),
    doc("b", "option-b-cards/"),
    doc("c", "option-c-lanes/", "approved"),
    doc("s", "screens/"),
    doc("x", "option-x/", "rejected", { removed: true }),
  ];
  function mount(review: ReviewPayload, documents = PLAN) {
    document.body.replaceChildren();
    const banner = document.createElement("div");
    const panel = document.createElement("div");
    document.body.append(banner, panel);
    const reviewCall = vi.fn((_body: unknown) =>
      Promise.resolve({ review: { ...review, state: "approved" as const } }),
    );
    const host: ReviewHost = {
      api: { review: reviewCall } as unknown as Api,
      banner,
      panel,
      showReviewTab: vi.fn(),
      showChanges: vi.fn(),
      loadLatest: vi.fn(() => Promise.resolve()),
      onLock: vi.fn(),
      onState: vi.fn(),
      planDocuments: () => documents,
    };
    new ReviewPanel(host, review, review.currentVersion);
    return { panel, reviewCall };
  }
  const button = (panel: HTMLElement, label: string | RegExp) =>
    [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""),
    );

  it("is offered only when the server allows it and the plan has something to reject", () => {
    expect(button(mount({ ...payload(1), can: can({}) }).panel, "Choose this option")).toBeUndefined();
    expect(
      button(mount({ ...payload(1), can: can({ choose: true, review: true }) }).panel, "Choose this option"),
    ).toBeDefined();
    const alone = [doc("pm", "plan.md", "approved"), doc("a", "option-a/", "in_review", { current: true })];
    expect(
      button(mount({ ...payload(1), can: can({ choose: true, review: true }) }, alone).panel, "Choose this option"),
    ).toBeUndefined();
  });

  it("is never offered on a shared part (screens/), only on an alternative", () => {
    const onScreens = PLAN.map((d) => ({ ...d, current: d.path === "screens/" }));
    expect(
      button(mount({ ...payload(1), can: can({ choose: true, review: true }) }, onScreens).panel, "Choose this option"),
    ).toBeUndefined();
  });

  it("lists the other open documents, ticks the same-named options, and posts the ticked ids", async () => {
    const { panel, reviewCall } = mount({ ...payload(1), can: can({ choose: true, review: true }) });
    button(panel, "Choose this option")!.click();
    // A focused step: none of the other actions beside it.
    expect(button(panel, "Choose this option")).toBeUndefined();
    expect(button(panel, "Approve")).toBeUndefined();
    expect(panel.querySelector("h3")?.textContent).toBe("Choose option-a-tree/");
    const rows = [...panel.querySelectorAll<HTMLLabelElement>(".rv-choose label")].map((l) => [
      l.querySelector("input")!.checked,
      [...l.querySelectorAll("span")]
        .filter((x) => !x.hidden)
        .map((x) => x.textContent)
        .join(""),
    ]);
    // plan.md, the chosen one and the already rejected option are not offered; screens/ starts unticked and
    // says it stays in the plan.
    expect(rows).toEqual([
      [true, "option-b-cards/ · In review"],
      [true, "option-c-lanes/ · Approved"],
      [false, "screens/ · In reviewstays in the plan"],
    ]);
    const summary = () => panel.querySelector(".ch-summary")!.textContent;
    expect(summary()).toBe(
      "This approves option-a-tree/ and rejects option-b-cards/ and option-c-lanes/. Other documents still need approval before the plan can be built.",
    );
    const confirm = button(panel, /^Approve and reject/)!;
    expect(confirm.textContent).toBe("Approve and reject 2");
    // Unticking all disables it; ticking one back enables it.
    const boxes = [...panel.querySelectorAll<HTMLInputElement>(".rv-choose input")];
    for (const box of boxes.slice(0, 2)) {
      box.checked = false;
      box.dispatchEvent(new Event("change"));
    }
    expect([confirm.disabled, confirm.textContent]).toEqual([true, "Approve and reject 0"]);
    expect(summary()).toBe("Tick at least one document to reject.");
    boxes[1].checked = true;
    boxes[1].dispatchEvent(new Event("change"));
    expect([confirm.disabled, confirm.textContent]).toEqual([false, "Approve and reject 1"]);
    const note = panel.querySelector<HTMLInputElement>('input[aria-label="Choice note"]')!;
    note.value = "cleanest";
    note.dispatchEvent(new Event("input"));
    confirm.click();
    await vi.waitFor(() => expect(reviewCall).toHaveBeenCalled());
    expect(reviewCall.mock.calls[0][0]).toEqual({
      action: "choose",
      versionNumber: 1,
      reject: ["c"],
      note: "cleanest",
    });
  });

  it("says Reject, not Approve, when the option is already approved", () => {
    const { panel } = mount({ ...payload(1), state: "approved", can: can({ choose: true, review: true }) });
    button(panel, "Choose this option")!.click();
    expect(button(panel, /^Reject \d/)?.textContent).toBe("Reject 2");
    expect(panel.querySelector(".ch-summary")!.textContent).toMatch(/^This keeps option-a-tree\/ approved and rejects/);
  });

  it("says the plan is ready to build when everything left is approved after the choice", () => {
    const plan = [
      doc("pm", "plan.md", "approved"),
      doc("a", "option-a/", "in_review", { current: true }),
      doc("b", "option-b/"),
      doc("s", "screens/", "approved"),
    ];
    const { panel } = mount({ ...payload(1), can: can({ choose: true, review: true }) }, plan);
    button(panel, "Choose this option")!.click();
    expect(panel.querySelector(".ch-summary")!.textContent).toBe(
      "This approves option-a/ and rejects option-b/. The plan is then ready to build.",
    );
  });
});

describe("ReviewPanel: Choose this option in a native option set", () => {
  const can = (over: Partial<ReviewPayload["can"]>): ReviewPayload["can"] => ({
    submit: false,
    review: false,
    force: false,
    reopen: false,
    archive: false,
    unarchive: false,
    ...over,
  });
  const opt = (id: string, option: string, reviewState = "in_review", current = false) => ({
    id,
    title: `Title of ${option}`,
    kind: "document" as const,
    reviewState,
    path: option,
    removed: false,
    current,
    pagePath: `/d/${id}`,
  });
  function mount(review: ReviewPayload, documents: ReturnType<typeof opt>[]) {
    document.body.replaceChildren();
    const banner = document.createElement("div");
    const panel = document.createElement("div");
    document.body.append(banner, panel);
    const reviewCall = vi.fn((_body: unknown) =>
      Promise.resolve({ review: { ...review, state: "approved" as const } }),
    );
    const host: ReviewHost = {
      api: { review: reviewCall } as unknown as Api,
      banner,
      panel,
      showReviewTab: vi.fn(),
      showChanges: vi.fn(),
      loadLatest: vi.fn(() => Promise.resolve()),
      onLock: vi.fn(),
      onState: vi.fn(),
      planDocuments: () => documents,
      planKind: () => "options",
    };
    new ReviewPanel(host, review, review.currentVersion);
    return { panel, reviewCall };
  }
  const button = (panel: HTMLElement, label: string | RegExp) =>
    [...panel.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""),
    );

  it("treats every open member as an alternative, ticks them all, and words the result without a plan", async () => {
    // Labels in no option family: still alternatives of one another.
    const docs = [opt("a", "go", "in_review", true), opt("b", "no-go"), opt("c", "maybe")];
    const { panel, reviewCall } = mount({ ...payload(1), can: can({ choose: true, review: true }) }, docs);
    expect(panel.textContent).toContain("Pick this option, or give your review.");
    expect(panel.textContent).not.toContain("for the plan");
    button(panel, "Choose this option")!.click();
    expect(panel.querySelector("h3")?.textContent).toBe("Choose go");
    const rows = [...panel.querySelectorAll<HTMLInputElement>(".rv-choose input")].map((b) => b.checked);
    expect(rows).toEqual([true, true]);
    expect(panel.querySelector(".ch-summary")!.textContent).toBe("This approves go and rejects no-go and maybe.");
    const box = panel.querySelectorAll<HTMLInputElement>(".rv-choose input")[1];
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(panel.querySelector(".ch-keep:not([hidden])")?.textContent).toBe("stays in the set");
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    button(panel, /^Approve and reject/)!.click();
    await vi.waitFor(() => expect(reviewCall).toHaveBeenCalled());
    expect(reviewCall.mock.calls[0][0]).toEqual({ action: "choose", versionNumber: 1, reject: ["b", "c"] });
    await vi.waitFor(() => expect(panel.textContent).toContain("You chose go. Rejected: no-go and maybe."));
    expect(panel.textContent).not.toContain("ready to build");
  });

  it("says a rejected option is out of the set, with no builder", () => {
    const { panel } = mount({ ...payload(1), state: "rejected", can: can({}) }, [opt("a", "go", "rejected", true)]);
    expect(panel.textContent).toContain("Out of the set");
    expect(panel.textContent).toContain("no longer one of the set's options");
    expect(panel.textContent).not.toContain("builder");
  });
});

describe("ReviewPanel: steps have the panel to themselves", () => {
  const can = (over: Partial<ReviewPayload["can"]>): ReviewPayload["can"] => ({
    submit: false,
    review: false,
    force: false,
    reopen: false,
    archive: false,
    unarchive: false,
    ...over,
  });
  function mount(review: ReviewPayload) {
    document.body.replaceChildren();
    const banner = document.createElement("div");
    const panel = document.createElement("div");
    document.body.append(banner, panel);
    const host: ReviewHost = {
      api: { review: vi.fn() } as unknown as Api,
      banner,
      panel,
      showReviewTab: vi.fn(),
      showChanges: vi.fn(),
      loadLatest: vi.fn(() => Promise.resolve()),
      onLock: vi.fn(),
      onState: vi.fn(),
    };
    new ReviewPanel(host, review, review.currentVersion);
    return panel;
  }
  const labels = (panel: HTMLElement) => [...panel.querySelectorAll("button")].map((b) => b.textContent);

  for (const [open, heading, confirm] of [
    ["Reject", "Reject this document", "Reject"],
    ["Force approve", "Force approve", "Force approve"],
  ] as const) {
    it(`${open}: only its form, then everything back on Cancel`, () => {
      const panel = mount({ ...payload(1), can: can({ review: true, reject: true, force: true, archive: true }) });
      const before = labels(panel);
      [...panel.querySelectorAll("button")].find((b) => b.textContent === open)!.click();
      expect(panel.querySelector("h3")?.textContent).toBe(heading);
      expect(labels(panel)).toEqual([confirm, "Cancel"]);
      expect(panel.querySelector(".rv-events, .rv-reviewers")).toBeNull();
      [...panel.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!.click();
      expect(labels(panel)).toEqual(before);
    });
  }
});
