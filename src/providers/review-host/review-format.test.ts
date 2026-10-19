import { describe, expect, it } from "vitest";
import {
  hasReviewMarker,
  parseCoveredMarker,
  parseReviewMarker,
  renderSummaryComment,
  reviewMarker,
  stripReviewMarkers,
  stripWardbyMarkers,
  verdictConclusion,
} from "./review-format.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";

describe("review markers", () => {
  it("round-trips the reviewed head sha for one agent only", () => {
    const body = `${reviewMarker("agent1", SHA)}\nhello`;
    expect(parseReviewMarker(body, "agent1")).toBe(SHA);
    expect(parseReviewMarker(body, "agent2")).toBeNull();
    expect(hasReviewMarker(body, "agent1")).toBe(true);
  });

  it("counts a marker only at the start of a body", () => {
    const quoted = `Please note:\n${reviewMarker("agent1", SHA, SHA)}`;
    expect(parseReviewMarker(quoted, "agent1")).toBeNull();
    expect(parseCoveredMarker(quoted, "agent1")).toBeNull();
    expect(hasReviewMarker(quoted, "agent1")).toBe(false);
  });

  it("strips review markers, or every wardby marker, from text", () => {
    const text = `${reviewMarker("agent1", SHA)}a<!--wardby:status x-->b<!-- other -->`;
    expect(stripReviewMarkers(text)).toBe("a<!--wardby:status x-->b<!-- other -->");
    expect(stripWardbyMarkers(text)).toBe("ab<!-- other -->");
  });

  it("carries the covered head; a marker without one (an older marker) has none", () => {
    const COVERED = "f".repeat(40);
    const body = `${reviewMarker("agent1", SHA, COVERED)}\nhello`;
    expect(body).toContain(`sha=${SHA} covered=${COVERED} -->`);
    expect(parseReviewMarker(body, "agent1")).toBe(SHA);
    expect(parseCoveredMarker(body, "agent1")).toBe(COVERED);
    expect(parseCoveredMarker(body, "agent2")).toBeNull();
    const old = `<!-- wardby:review:agent1 sha=${SHA} -->\nhello`;
    expect(parseReviewMarker(old, "agent1")).toBe(SHA);
    expect(parseCoveredMarker(old, "agent1")).toBeNull();
    expect(() => reviewMarker("agent1", SHA, "not-a-sha")).toThrow("review_marker_invalid");
  });

  it("rejects an unsafe agent marker", () => {
    expect(() => reviewMarker("bad id -->", SHA)).toThrow("review_marker_invalid");
  });
});

describe("renderSummaryComment", () => {
  it("renders the badge, the reviewed sha, the body, and an outside-the-diff section", () => {
    const text = renderSummaryComment({
      agentMarker: "agent1",
      headSha: SHA,
      verdict: "CHANGES_REQUESTED",
      summary: "Two problems.",
      body: "## Findings\n- one",
      outside: [{ path: "a.py", line: 99, side: "RIGHT", severity: "MINOR", body: "rename this" }],
    });
    expect(text.startsWith(reviewMarker("agent1", SHA))).toBe(true);
    expect(text).toContain("❌ **Changes requested**");
    expect(text).toContain("`0123456`");
    expect(text).toContain("## Outside the diff");
    expect(text).toContain("**[MINOR] a.py:99** rename this");
  });
});

describe("verdictConclusion", () => {
  it("maps verdicts to check conclusions", () => {
    expect(verdictConclusion("APPROVE")).toBe("success");
    expect(verdictConclusion("CHANGES_REQUESTED")).toBe("failure");
    expect(verdictConclusion("COMMENT")).toBe("neutral");
  });
});
