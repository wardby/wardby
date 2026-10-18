import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { THOROUGH_REVIEWER_PROMPT, withReviewerPrompt } from "./reviewer-prompt.js";

const ARTICLE = new URL("../../help/architecture-agent.md", import.meta.url);
/** create_agent's systemPrompt limit (src/mcp/tools/agents.ts). */
const MAX_SYSTEM_PROMPT_CHARS = 64 * 1024;

describe("THOROUGH_REVIEWER_PROMPT", () => {
  it("fits create_agent's systemPrompt limit", () => {
    expect(THOROUGH_REVIEWER_PROMPT.length).toBeLessThan(MAX_SYSTEM_PROMPT_CHARS);
  });

  it("names every OWASP Top 10:2025 category", () => {
    for (const category of [
      "A01 Broken Access Control",
      "A02 Security Misconfiguration",
      "A03 Software Supply Chain Failures",
      "A04 Cryptographic Failures",
      "A05 Injection",
      "A06 Insecure Design",
      "A07 Authentication Failures",
      "A08 Software or Data Integrity Failures",
      "A09 Security Logging and Alerting Failures",
      "A10 Mishandling of Exceptional Conditions",
    ]) {
      expect(THOROUGH_REVIEWER_PROMPT, category).toContain(category);
    }
  });

  it("covers every review dimension and the body format", () => {
    for (const text of [
      "**Correctness / bugs**",
      "**Security**",
      "**Performance**",
      "**DRY & maintainability**",
      "**Modularity**",
      "**AI slop**",
      "**Code quality & consistency**",
      "**Test coverage**",
      "**Architecture & process**",
      "### Bugs\n### Security\n### Performance\n### DRY & Maintainability\n### Modularity\n### AI Slop\n### Code Quality\n### Test Coverage\n### Architecture & Process",
      'or the single line "No concerns." when that dimension is clean. Never omit a heading.',
      "## Summary\n## Strengths\n## Findings",
      "MUST_FIX, SUGGESTED, or FUTURE",
      "Never guess APPROVE",
      ".wardby/services.yaml",
      "docs/knowledge/index.md",
    ]) {
      expect(THOROUGH_REVIEWER_PROMPT, text).toContain(text);
    }
  });

  it("sends a change it could not read in full to COMMENT, never CHANGES_REQUESTED (the tool refuses that)", () => {
    const verdict = THOROUGH_REVIEWER_PROMPT.slice(THOROUGH_REVIEWER_PROMPT.indexOf("VERDICT\n"));
    expect(verdict).not.toMatch(/could not read enough of the change to judge it, is CHANGES_REQUESTED/);
    expect(verdict).toMatch(/could not read[^.]*COMMENT[^.]*name the files you did not review/);
  });

  it("is repository-agnostic and never blocks APPROVE on a local repository's missing CI", () => {
    expect(THOROUGH_REVIEWER_PROMPT).not.toMatch(/knock|chfields|pytest|Flask|React|@wardby/i);
    expect(THOROUGH_REVIEWER_PROMPT).toMatch(/"none"[^.]*local repository[^.]*never blocks APPROVE/);
  });
});

describe("the architecture-agent help article", () => {
  it("quotes the reviewer prompt verbatim (npm run sync:reviewer-prompt rewrites it)", () => {
    const article = readFileSync(ARTICLE, "utf8");
    expect(article).toContain(`\`\`\`text\n${THOROUGH_REVIEWER_PROMPT}\n\`\`\``);
    expect(withReviewerPrompt(article)).toBe(article);
  });
});

describe("withReviewerPrompt", () => {
  const doc = (prompt: string) => `# A\n\n### Reviewer system prompt\n\n\`\`\`text\n${prompt}\n\`\`\`\n\n## Next\n`;

  it("replaces a stale quoted prompt and leaves the rest alone", () => {
    expect(withReviewerPrompt(doc("old\nlines"), "new")).toBe(doc("new"));
  });

  it("refuses a prompt that would close the article's code block", () => {
    expect(() => withReviewerPrompt(doc("x"), "a ```suggestion block")).toThrow(/```/);
  });

  it("refuses a document without the quoted prompt", () => {
    expect(() => withReviewerPrompt("# A\n", "new")).toThrow(/Reviewer system prompt/);
  });
});
