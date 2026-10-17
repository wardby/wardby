import { describe, expect, it } from "vitest";
import {
  BUDGET_STOPPED_SUMMARY_PREFIX,
  budgetStoppedChangesSentence,
  budgetStoppedSummary,
  budgetStoppedTaskSection,
  CONTINUATION_CLOSED_CATEGORY,
  isContinuationClosedError,
  WORKER_BUDGET_EXHAUSTED_SUMMARY,
} from "./continuation-wording.js";
import { upsertRelatedSection } from "../providers/vcs/github.js";
import {
  closingIssueNumber,
  extractRelatedBlock,
  RELATED_SECTION_END,
  RELATED_SECTION_START,
} from "../providers/vcs/pr-description.js";

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
    expect(section.split("\n>\n> [task truncated]")[0].endsWith("x")).toBe(true);
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

  it("escapes every bracket, so no marker or hidden comment can form", () => {
    const markers = [
      RELATED_SECTION_START,
      RELATED_SECTION_END,
      "<!-- wardby:run-x -->",
      "<!-- wardby-latest:run-x -->",
      "<!-- hidden -->",
      "<b>bold</b>",
    ];
    const section = budgetStoppedTaskSection(`Do it.\n${markers.join("\n")}`);
    expect(section).not.toContain("<");
    expect(section).toContain("> &lt;!-- wardby-related:start -->");
    expect(section).toContain("> &lt;!-- wardby:run-x -->");
    expect(section).toContain("> &lt;!-- wardby-latest:run-x -->");
  });

  it("leaves a body carrying the task able to take its Related section", () => {
    const block = `${RELATED_SECTION_START}\nReal\n${RELATED_SECTION_END}`;
    for (const request of [
      `Edit ${RELATED_SECTION_START} please`,
      `Edit ${RELATED_SECTION_START}\nfake\n${RELATED_SECTION_END}`,
      `Edit ${RELATED_SECTION_END}`,
    ]) {
      const body = `<!-- wardby:run-1 -->\n\n${budgetStoppedSummary("Did half.", request)}`;
      expect(extractRelatedBlock(body)).toBeUndefined();
      const updated = upsertRelatedSection(body, block);
      expect(updated).not.toBeNull();
      expect(extractRelatedBlock(updated!)).toBe(block);
      // The section goes after the marker, never inside the quote.
      expect(updated!.indexOf(block)).toBeLessThan(updated!.indexOf("### Task"));
    }
  });

  it("breaks closing keywords so the quote closes and links no issue", () => {
    const requests = [
      "Fixes #7",
      "please closes owner/repo#7 now",
      "RESOLVED: #7",
      "fix  #7",
      "closed:owner/repo#7",
      "Resolves\n#7",
    ];
    for (const request of requests) {
      const summary = budgetStoppedSummary("Did half.", request);
      expect(closingIssueNumber(summary, "owner/repo")).toBeUndefined();
      expect(summary).toContain("#&#8288;7");
    }
  });

  it("keeps a plain issue reference readable", () => {
    const section = budgetStoppedTaskSection("see #7 and owner/repo#8, prefix#9, disclose #10");
    expect(section).toBe("### Task\n\n> see #7 and owner/repo#8, prefix#9, disclose #10");
  });
});

describe("budgetStoppedChangesSentence", () => {
  const APP_HANDLE = `@${"wardby"}`;

  it("is one provider-neutral sentence, with the issue alternative only for an issue's run", () => {
    expect(budgetStoppedChangesSentence("#42", true, true)).toBe(
      "The changes so far are in draft PR #42; mention the agent on it or on the issue it came from to continue.",
    );
    expect(budgetStoppedChangesSentence("owner/repo#42", false)).toBe(
      "The changes so far are in owner/repo#42; mention the agent on it to continue.",
    );
    for (const sentence of [
      budgetStoppedChangesSentence("#42", true, true),
      budgetStoppedChangesSentence("#42", false),
    ]) {
      expect(sentence).not.toContain(APP_HANDLE);
      expect(sentence).not.toContain("@");
    }
  });
});
