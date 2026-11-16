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
  const bar = (el: HTMLElement) => el.querySelector(".rv-actions");

  it("on an approved document, someone who can't reopen it is told to ask an editor", () => {
    const { host, panel } = setup(null);
    new ReviewPanel(host, { ...payload(2), state: "approved" }, 2);
    expect(bar(panel)?.textContent).toContain("ask someone who can edit it to reopen it");
    expect([...panel.querySelectorAll(".rv-actions button")].map((b) => b.textContent)).not.toContain(
      "Reopen for review",
    );
  });

  it("a writer gets the Reopen button and no hint; nothing shows before approval", () => {
    const { host, panel } = setup(null);
    const p = new ReviewPanel(host, { ...payload(2), state: "approved", can: { ...can, reopen: true } }, 2);
    expect([...panel.querySelectorAll(".rv-actions button")].map((b) => b.textContent)).toContain("Reopen for review");
    expect(bar(panel)?.textContent).not.toContain("ask someone");
    p.apply(payload(2));
    expect(panel.textContent).not.toContain("ask someone");
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
    expect(button(panel, "Start review")).toBeDefined();
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
