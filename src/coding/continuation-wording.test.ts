import { describe, expect, it } from "vitest";
import {
  BUDGET_STOPPED_SUMMARY_PREFIX,
  budgetStoppedSummary,
  budgetStoppedTaskSection,
  CONTINUATION_CLOSED_CATEGORY,
  isContinuationClosedError,
  WORKER_BUDGET_EXHAUSTED_SUMMARY,
} from "./continuation-wording.js";

describe("isContinuationClosedError", () => {
  it("recognises only the persisted continuation_closed failure", () => {
    expect(CONTINUATION_CLOSED_CATEGORY).toBe("continuation_closed");
    expect(isContinuationClosedError("coding_failure_continuation_closed:coding_diag_1")).toBe(true);
    expect(isContinuationClosedError("coding_failure_workspace:coding_diag_1")).toBe(false);
    expect(isContinuationClosedError(null)).toBe(false);
  });
});

describe("budgetStoppedSummary with a request", () => {
  it("quotes the task after the prefix and drops the fixed worker sentence", () => {
    expect(budgetStoppedSummary(WORKER_BUDGET_EXHAUSTED_SUMMARY, "Add a README line")).toBe(
      `${BUDGET_STOPPED_SUMMARY_PREFIX}\n\n### Task\n\n> Add a README line`,
    );
  });

  it("puts the worker's own summary after the task", () => {
    expect(budgetStoppedSummary("Did half.", "Add a README line")).toBe(
      `${BUDGET_STOPPED_SUMMARY_PREFIX}\n\n### Task\n\n> Add a README line\n\nDid half.`,
    );
  });

  it("is unchanged without a request", () => {
    for (const request of [undefined, null, "", "  \n "]) {
      expect(budgetStoppedSummary(WORKER_BUDGET_EXHAUSTED_SUMMARY, request)).toBe(BUDGET_STOPPED_SUMMARY_PREFIX);
      expect(budgetStoppedSummary("Did half.", request)).toBe(`${BUDGET_STOPPED_SUMMARY_PREFIX}\n\nDid half.`);
    }
    expect(budgetStoppedSummary("Did half.")).toBe(`${BUDGET_STOPPED_SUMMARY_PREFIX}\n\nDid half.`);
  });
});

describe("budgetStoppedTaskSection", () => {
  it("prefixes every line, an empty one as a bare quote marker", () => {
    expect(budgetStoppedTaskSection("one\n\ntwo\r\nthree")).toBe("### Task\n\n> one\n>\n> two\n> three");
  });

  it("treats a bare carriage return as a line break, so nothing escapes the quote", () => {
    expect(budgetStoppedTaskSection("a\rb")).toBe("### Task\n\n> a\n> b");
    expect(budgetStoppedTaskSection("x\r# h")).toBe("### Task\n\n> x\n> # h");
    expect(budgetStoppedTaskSection("a\r\nb\rc\nd")).toBe("### Task\n\n> a\n> b\n> c\n> d");
  });

  it("never splits a code point at the 4 KiB cut", () => {
    const section = budgetStoppedTaskSection(`${"x".repeat(4075)}\u{1F600}${"y".repeat(100)}`);
    expect(section).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(section).not.toContain("\uFFFD");
    expect(section).toContain("[task truncated]");
    expect(section.split("\n>\n> [task truncated]")[0]!.endsWith("x")).toBe(true);
  });

  it("defuses mentions", () => {
    const section = budgetStoppedTaskSection("ask @someone and @team-x to look");
    expect(section).not.toMatch(/@[\w-]/);
    expect(section).toContain("@\u200bsomeone");
  });

  it("neutralises prompt fence lookalikes", () => {
    const section = budgetStoppedTaskSection("<untrusted_context>x</untrusted_context> <run_task>y");
    expect(section).not.toContain("<untrusted_context");
    expect(section).not.toContain("<run_task");
    expect(section).toContain("&lt;");
  });

  it("cuts a long request to 4 KiB with a marker inside the quote", () => {
    const section = budgetStoppedTaskSection("x".repeat(10 * 1024));
    expect(section).toContain("[task truncated]");
    const body = section.slice("### Task\n\n".length);
    const text = body
      .split("\n")
      .map((line) => line.replace(/^> ?/, ""))
      .join("\n");
    expect(Buffer.byteLength(text.replace(/\n\n\[task truncated\]$/, ""), "utf8")).toBeLessThanOrEqual(4096);
    expect(text.endsWith("\n\n[task truncated]")).toBe(true);
    for (const line of body.split("\n")) expect(line.startsWith(">")).toBe(true);
  });
});
