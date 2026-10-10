import { describe, expect, it } from "vitest";
import {
  broadcasts,
  escapeMrkdwn,
  nextStatus,
  renderEvent,
  renderParent,
  senderName,
} from "./notification-templates.js";
import { shortReason, type WorkflowPayload } from "./workflow-events.js";

const pr = { prLabel: "acme/api#12", prUrl: "https://github.com/acme/api/pull/12" };

describe("escapeMrkdwn", () => {
  it("escapes &, < and >", () => {
    expect(escapeMrkdwn("<!channel> & <https://evil|x>")).toBe("&lt;!channel&gt; &amp; &lt;https://evil|x&gt;");
  });
});

describe("shortReason", () => {
  it("keeps the first line, capped at 200", () => {
    expect(shortReason("boom\nstack")).toBe("boom");
    expect(shortReason("x".repeat(300))).toHaveLength(200);
    expect(shortReason("")).toBeNull();
    expect(shortReason(null)).toBeNull();
  });
});

describe("nextStatus", () => {
  const seq: Array<[WorkflowPayload, string]> = [
    [{ kind: "issue_picked_up", agentName: "lead", trigger: "assigned" }, "picked up"],
    [{ kind: "pr_opened", ...pr, movedTo: "In Review" }, "PR open"],
    [
      {
        kind: "review_posted",
        agentName: "rev",
        verdict: "CHANGES_REQUESTED",
        prLabel: pr.prLabel,
        prUrl: pr.prUrl,
        ciPending: false,
      },
      "changes requested",
    ],
    [{ kind: "review_fix", prLabel: pr.prLabel, round: 1, maxRounds: 2, state: "started" }, "fixing"],
    [
      {
        kind: "review_posted",
        agentName: "rev",
        verdict: "APPROVE",
        prLabel: pr.prLabel,
        prUrl: pr.prUrl,
        ciPending: false,
      },
      "approved",
    ],
    [{ kind: "pr_closed", ...pr, merged: true, movedTo: "Done" }, "merged ✅"],
  ];
  it("walks the happy path", () => {
    let s: ReturnType<typeof nextStatus> | null = null;
    for (const [p, expected] of seq) {
      s = nextStatus(s, p);
      expect(s).toBe(expected);
    }
  });
  it("COMMENT keeps the previous status", () => {
    expect(
      nextStatus("PR open", {
        kind: "review_posted",
        agentName: "r",
        verdict: "COMMENT",
        prLabel: "x",
        prUrl: null,
        ciPending: true,
      }),
    ).toBe("PR open");
  });
  it("capped and failure and closed", () => {
    expect(nextStatus("fixing", { kind: "review_fix", prLabel: "x", round: 2, maxRounds: 2, state: "capped" })).toBe(
      "fix rounds exhausted",
    );
    expect(nextStatus("picked up", { kind: "run_failed", agentName: "a", status: "failed", reason: null })).toBe(
      "failed ❌",
    );
    expect(nextStatus("PR open", { kind: "pr_closed", ...pr, merged: false, movedTo: null })).toBe("closed");
  });
  it("a terminal merged status is not overwritten by a late failure", () => {
    expect(nextStatus("merged ✅", { kind: "run_failed", agentName: "a", status: "failed", reason: null })).toBe(
      "merged ✅",
    );
  });
  it("a new PR or a new pickup reopens a terminal thread", () => {
    expect(nextStatus("closed", { kind: "pr_opened", ...pr, movedTo: null })).toBe("PR open");
    expect(nextStatus("merged ✅", { kind: "issue_picked_up", agentName: "a", trigger: "assigned" })).toBe("picked up");
  });
  it("late reviews, fix rounds and duplicate closes keep a terminal status", () => {
    const late: WorkflowPayload[] = [
      { kind: "review_posted", agentName: "r", verdict: "APPROVE", ...pr, ciPending: false },
      { kind: "review_fix", prLabel: "x", round: 1, maxRounds: 2, state: "started" },
      { kind: "pr_closed", ...pr, merged: false, movedTo: null },
      { kind: "run_failed", agentName: "a", status: "failed", reason: null },
    ];
    for (const p of late) expect(nextStatus("merged ✅", p)).toBe("merged ✅");
  });
});

describe("senderName", () => {
  it("names the agent when the event has one, otherwise wardby", () => {
    expect(senderName({ kind: "issue_picked_up", agentName: "builder", trigger: "assigned" })).toBe("builder");
    expect(senderName({ kind: "run_failed", agentName: "builder", status: "failed", reason: null })).toBe("builder");
    expect(
      senderName({ kind: "review_posted", agentName: "reviewer", verdict: "COMMENT", ...pr, ciPending: false }),
    ).toBe("reviewer");
    expect(senderName({ kind: "pr_opened", ...pr, movedTo: null })).toBe("wardby");
    expect(senderName({ kind: "pr_closed", ...pr, merged: true, movedTo: null })).toBe("wardby");
    expect(senderName({ kind: "review_fix", prLabel: "x", round: 1, maxRounds: 2, state: "started" })).toBe("wardby");
  });
});

describe("renderParent", () => {
  it("links the subject and escapes the title", () => {
    const { text } = renderParent(
      { label: "PAY-241", title: "Fix <script> & stuff", url: "https://x.atlassian.net/browse/PAY-241" },
      "PR open",
    );
    expect(text).toBe("<https://x.atlassian.net/browse/PAY-241|PAY-241> · Fix &lt;script&gt; &amp; stuff — *PR open*");
  });
  it("works without url/title", () => {
    expect(renderParent({ label: "run abc", title: null, url: null }, "failed ❌").text).toBe("run abc — *failed ❌*");
  });
});

describe("renderEvent", () => {
  it.each<[WorkflowPayload, string]>([
    [
      { kind: "issue_picked_up", agentName: "lead", trigger: "assigned to wardby" },
      "🟢 Picked up by *lead* (assigned to wardby)",
    ],
    [
      { kind: "pr_opened", ...pr, movedTo: "In Review" },
      "🔀 PR <https://github.com/acme/api/pull/12|acme/api#12> is ready — moved to In Review",
    ],
    [
      {
        kind: "review_posted",
        agentName: "rev",
        verdict: "CHANGES_REQUESTED",
        prLabel: pr.prLabel,
        prUrl: pr.prUrl,
        ciPending: false,
      },
      "📝 *rev* requested changes on <https://github.com/acme/api/pull/12|acme/api#12>",
    ],
    [
      {
        kind: "review_posted",
        agentName: "rev",
        verdict: "APPROVE",
        prLabel: pr.prLabel,
        prUrl: null,
        ciPending: false,
      },
      "✅ *rev* approved acme/api#12",
    ],
    [
      {
        kind: "review_posted",
        agentName: "rev",
        verdict: "COMMENT",
        prLabel: pr.prLabel,
        prUrl: null,
        ciPending: true,
      },
      "💬 *rev* commented on acme/api#12 (CI still running)",
    ],
    [
      { kind: "review_fix", prLabel: "acme/api#12", round: 1, maxRounds: 2, state: "started" },
      "🔁 Fix round 1 of 2 started on acme/api#12",
    ],
    [
      { kind: "review_fix", prLabel: "acme/api#12", round: 2, maxRounds: 2, state: "capped" },
      "🛑 Still changes requested after 2 fix rounds on acme/api#12 — needs a person",
    ],
    [
      { kind: "pr_closed", ...pr, merged: true, movedTo: "Done" },
      "🎉 <https://github.com/acme/api/pull/12|acme/api#12> merged — moved to Done",
    ],
    [
      { kind: "pr_closed", ...pr, merged: false, movedTo: null },
      "⚪ <https://github.com/acme/api/pull/12|acme/api#12> closed without merging",
    ],
    [
      { kind: "run_failed", agentName: "lead", status: "budget_exhausted", reason: null },
      "❌ *lead* stopped: budget exhausted",
    ],
    [
      { kind: "run_failed", agentName: "lead", status: "refused", reason: "Estimated input cost <x> meets budget" },
      "❌ *lead* was refused: Estimated input cost &lt;x&gt; meets budget",
    ],
    [
      { kind: "run_failed", agentName: "lead", status: "failed", reason: "model <x> down" },
      "❌ *lead* failed: model &lt;x&gt; down",
    ],
  ])("renders %j", (payload, expected) => {
    expect(renderEvent(payload, null).text).toBe(expected);
  });
  it("appends the spend line", () => {
    expect(renderEvent({ kind: "issue_picked_up", agentName: "a", trigger: "t" }, "Spent $0.42").text).toMatch(
      /\n_Spent \$0\.42_$/,
    );
  });
});

describe("broadcasts", () => {
  it("only merges and failures", () => {
    expect(broadcasts({ kind: "pr_closed", ...pr, merged: true, movedTo: null })).toBe(true);
    expect(broadcasts({ kind: "pr_closed", ...pr, merged: false, movedTo: null })).toBe(false);
    expect(broadcasts({ kind: "run_failed", agentName: "a", status: "lost", reason: null })).toBe(true);
    expect(broadcasts({ kind: "pr_opened", ...pr, movedTo: null })).toBe(false);
  });
});
