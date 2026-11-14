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
