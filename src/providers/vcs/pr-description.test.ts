import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { appMarkerRunId } from "../review-host/github-events.js";
import { RELATED_SECTION_END, RELATED_SECTION_START, pullRequestBody, upsertRelatedSection } from "./github.js";
import {
  DESCRIPTION_COMMENT_APPLIED_MARKER,
  DESCRIPTION_COMMENT_MARKER,
  LATEST_RUN_MARKER_PREFIX,
  MIN_PR_BODY_CHARS,
  assessFinalMessage,
  closingIssueNumber,
  descriptionAppliedComment,
  descriptionFallbackComment,
  descriptionSha256,
  extractRelatedBlock,
  findDescriptionComments,
  MAX_DESCRIPTION_COMMENT_PAGES,
  parseDescriptionComment,
  supersededDescriptionComment,
  hasClosingKeyword,
  isUneditedDescription,
  normalizeDescriptionForHash,
} from "./pr-description.js";

const SUMMARY =
  "Adds a shopping cart to the store page, with quantity controls and a running total shown in the header bar.";
const base = { runId: "run-root", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-root" };

function relatedBlock(line: string): string {
  return [RELATED_SECTION_START, "**Related pull requests**", "", line, RELATED_SECTION_END].join("\n");
}

describe("normalizeDescriptionForHash", () => {
  it("strips the Related section so a later replaceRelatedSection keeps the hash", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY });
    const withRelated = upsertRelatedSection(body, relatedBlock("- openai/other#4 (open)"));
    expect(withRelated).not.toBeNull();
    const replaced = upsertRelatedSection(withRelated!, relatedBlock("- openai/other#4 (merged)"));
    expect(normalizeDescriptionForHash(withRelated!)).toBe(normalizeDescriptionForHash(body));
    expect(descriptionSha256(replaced!)).toBe(descriptionSha256(body));
  });

  it("treats CRLF and LF bodies as equal", () => {
    const lf = `<!-- wardby:run-root -->\n\n${SUMMARY}\n\n**Tests:**\n- \`npm test\`: passed`;
    expect(normalizeDescriptionForHash(lf.replace(/\n/g, "\r\n"))).toBe(normalizeDescriptionForHash(lf));
  });

  it("collapses the blank lines left by removing a Related block", () => {
    const body = `<!-- wardby:run-root -->\n\n${relatedBlock("- x")}\n\n${SUMMARY}  \n\n\n\n`;
    expect(normalizeDescriptionForHash(body)).toBe(`<!-- wardby:run-root -->\n\n${SUMMARY}`);
  });

  it("leaves a malformed Related block in place", () => {
    const body = `<!-- wardby:run-root -->\n\n${RELATED_SECTION_START}\n- x\n\n${SUMMARY}`;
    expect(normalizeDescriptionForHash(body)).toContain(RELATED_SECTION_START);
  });
});

describe("descriptionSha256", () => {
  it("is stable for the body GitHub echoes back", () => {
    const written = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    const echoed = `${written.replace(/\n/g, "\r\n")}\r\n`;
    expect(descriptionSha256(echoed)).toBe(descriptionSha256(written));
    expect(descriptionSha256(written)).toMatch(/^[0-9a-f]{64}$/);
    expect(descriptionSha256(written)).toBe(
      createHash("sha256").update(normalizeDescriptionForHash(written), "utf8").digest("hex"),
    );
  });
});

describe("extractRelatedBlock", () => {
  it("returns the marked block inclusive, or undefined when malformed", () => {
    const block = relatedBlock("- x");
    expect(extractRelatedBlock(`a\n\n${block}\n\nb`)).toBe(block);
    expect(extractRelatedBlock("no block")).toBeUndefined();
    expect(extractRelatedBlock(`${RELATED_SECTION_START}\nx`)).toBeUndefined();
    expect(extractRelatedBlock(`${RELATED_SECTION_END}\nx\n${RELATED_SECTION_START}`)).toBeUndefined();
    expect(extractRelatedBlock(`${block}\n${block}`)).toBeUndefined();
  });
});

describe("assessFinalMessage", () => {
  it("rejects empty/whitespace", () => {
    expect(assessFinalMessage(undefined, undefined)).toEqual({ ok: false, reason: "empty" });
    expect(assessFinalMessage("  \n\t ", SUMMARY)).toEqual({ ok: false, reason: "empty" });
  });

  it("rejects under 80 characters", () => {
    expect(MIN_PR_BODY_CHARS).toBe(80);
    expect(assessFinalMessage("Done. Pushed the fixes.", undefined)).toEqual({ ok: false, reason: "too_short" });
    // 79 non-whitespace characters padded with spaces is still too short.
    const padded = `${"a ".repeat(79)}`;
    expect(assessFinalMessage(padded, undefined)).toEqual({ ok: false, reason: "too_short" });
    expect(assessFinalMessage("a".repeat(80), undefined)).toEqual({ ok: true });
  });

  it("rejects a message dropping `Resolves #12` the previous text had", () => {
    expect(assessFinalMessage(SUMMARY, `Resolves #12\n\n${SUMMARY}`)).toEqual({
      ok: false,
      reason: "missing_closing_keyword",
    });
  });

  it("accepts `Fixes owner/repo#3`", () => {
    expect(hasClosingKeyword("Fixes owner/repo#3")).toBe(true);
    expect(assessFinalMessage(`Fixes owner/repo#3\n\n${SUMMARY}`, `closes #3\n\n${SUMMARY}`)).toEqual({ ok: true });
  });

  it("accepts a full body when the previous had no keyword", () => {
    expect(assessFinalMessage(SUMMARY, "An earlier summary with no issue reference at all.")).toEqual({ ok: true });
  });

  it("recognizes the keyword forms case-insensitively and nothing else", () => {
    for (const k of ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "RESOLVED"]) {
      expect(hasClosingKeyword(`${k} #7`)).toBe(true);
    }
    expect(hasClosingKeyword("Resolves Jira issue ABC-1")).toBe(false);
    expect(hasClosingKeyword("prefixes #7")).toBe(false);
    expect(hasClosingKeyword("see #7")).toBe(false);
  });
});

describe("isUneditedDescription", () => {
  const written = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });

  it("matches a recorded hash", () => {
    expect(
      isUneditedDescription({
        currentBody: written.replace(/\n/g, "\r\n"),
        rootRunId: "run-root",
        recordedSha256: descriptionSha256(written),
        previousAgentText: SUMMARY,
      }),
    ).toBe(true);
  });

  it("a differing hash is edited", () => {
    expect(
      isUneditedDescription({
        currentBody: `${written}\n\nA reviewer's note.`,
        rootRunId: "run-root",
        recordedSha256: descriptionSha256(written),
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
  });

  it("a body without the leading root marker is edited", () => {
    const noMarker = written.replace("<!-- wardby:run-root -->", "");
    expect(
      isUneditedDescription({
        currentBody: noMarker,
        rootRunId: "run-root",
        recordedSha256: descriptionSha256(noMarker),
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
    expect(
      isUneditedDescription({
        currentBody: written,
        rootRunId: "run-other",
        recordedSha256: descriptionSha256(written),
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
  });

  it("legacy (no hash) body with no reconstruction is treated as edited", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY });
    expect(
      isUneditedDescription({
        currentBody: legacy,
        rootRunId: "run-root",
        recordedSha256: null,
        previousAgentText: SUMMARY,
      }),
    ).toBe(false);
  });

  it("legacy (no hash): matches the reconstructed root body's hash, Related block and CRLF aside", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY });
    const withRelated = upsertRelatedSection(legacy, relatedBlock("- openai/other#4 (open)"))!;
    expect(
      isUneditedDescription({
        currentBody: withRelated.replace(/\n/g, "\r\n"),
        rootRunId: "run-root",
        recordedSha256: null,
        legacySha256: descriptionSha256(legacy),
        previousAgentText: SUMMARY,
      }),
    ).toBe(true);
  });

  it("legacy (no hash): a person's addition anywhere is edited", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY, tests: [{ command: "npm test", outcome: "passed" }] });
    const legacySha256 = descriptionSha256(legacy);
    const variants = [
      `${legacy}\n\nA reviewer's added note.`,
      legacy.replace(SUMMARY, `${SUMMARY} Also touches the checkout page.`),
      legacy.replace("**Tests:**", "Note from the author.\n\n**Tests:**"),
      legacy.replace("<!-- wardby:run-root -->", "<!-- wardby:run-root -->\n\nPlease review carefully."),
    ];
    for (const currentBody of variants) {
      expect(isUneditedDescription({ currentBody, rootRunId: "run-root", recordedSha256: null, legacySha256 })).toBe(
        false,
      );
    }
  });

  it("a recorded hash wins over a legacy reconstruction", () => {
    const legacy = pullRequestBody({ ...base, summary: SUMMARY });
    expect(
      isUneditedDescription({
        currentBody: legacy,
        rootRunId: "run-root",
        recordedSha256: "0".repeat(64),
        legacySha256: descriptionSha256(legacy),
      }),
    ).toBe(false);
  });
});

describe("pullRequestBody latest marker", () => {
  it("with latestRunId appends the latest marker last and keeps the root marker first", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    const lines = body.split("\n");
    expect(lines[0]).toBe("<!-- wardby:run-root -->");
    expect(lines.at(-1)).toBe(`${LATEST_RUN_MARKER_PREFIX}run-2 -->`);
    expect(pullRequestBody({ ...base, summary: SUMMARY })).not.toContain(LATEST_RUN_MARKER_PREFIX);
  });

  it("omits a latestRunId that is not a safe run id", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "x --> <script>" });
    expect(body).not.toContain(LATEST_RUN_MARKER_PREFIX);
  });

  it("`appMarkerRunId` still returns the root id", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    expect(appMarkerRunId({ user: { type: "Bot", login: "wardby[bot]" }, body }, "wardby")).toBe("run-root");
  });

  it("`upsertRelatedSection` still inserts after the root marker", () => {
    const body = pullRequestBody({ ...base, summary: SUMMARY, latestRunId: "run-2" });
    const block = relatedBlock("- openai/other#4 (open)");
    const next = upsertRelatedSection(body, block);
    expect(next).toBe(`<!-- wardby:run-root -->\n\n${block}\n\n${SUMMARY}\n\n${LATEST_RUN_MARKER_PREFIX}run-2 -->`);
  });
});

const HEAD = "0123456789abcdef0123456789abcdef01234567";

describe("descriptionFallbackComment", () => {
  it("starts with the pull-request-level marker stamped with the head it describes", () => {
    const comment = descriptionFallbackComment("run-2", SUMMARY, HEAD);
    expect(comment.startsWith(`<!-- wardby-description head=${HEAD} -->\n`)).toBe(true);
    expect(comment).toContain("current description proposed by wardby's latest run (`run-2`)");
    expect(comment).toContain("couldn't confirm the description is unchanged since it wrote it");
    expect(comment).toContain("can copy it into the description");
    expect(comment).toContain("<details><summary>Proposed description</summary>");
    expect(comment).toContain(`\`\`\`markdown\n${SUMMARY}\n\`\`\``);
    expect(comment.trimEnd().endsWith("</details>")).toBe(true);
    expect(parseDescriptionComment(comment)).toEqual({
      headSha: HEAD,
      applied: false,
      runId: "run-2",
      proposed: SUMMARY,
    });
  });

  it("without a head, uses the plain marker", () => {
    const comment = descriptionFallbackComment("run-2", SUMMARY);
    expect(comment.startsWith(`${DESCRIPTION_COMMENT_MARKER}\n`)).toBe(true);
    expect(parseDescriptionComment(comment)).toMatchObject({ applied: false, proposed: SUMMARY });
    expect(parseDescriptionComment(comment)).not.toHaveProperty("headSha");
  });

  it("fences a body containing triple backticks safely", () => {
    const proposed = "Example:\n\n```ts\nconst a = 1;\n```\n\nAnd ````four```` too.";
    const comment = descriptionFallbackComment("run-2", proposed, HEAD);
    expect(comment).toContain(`\`\`\`\`\`markdown\n${proposed}\n\`\`\`\`\``);
    expect(parseDescriptionComment(comment)?.proposed).toBe(proposed);
  });

  it("a proposal quoting the applied marker is still a pending proposal", () => {
    const proposed = `${SUMMARY}\n\n${DESCRIPTION_COMMENT_APPLIED_MARKER}`;
    expect(parseDescriptionComment(descriptionFallbackComment("run-2", proposed, HEAD))).toMatchObject({
      applied: false,
      proposed,
    });
  });

  it("is capped under 60,000 characters", () => {
    const comment = descriptionFallbackComment("run-2", "word ".repeat(30_000), HEAD);
    expect(comment.length).toBeLessThan(60_000);
    expect(comment.trimEnd().endsWith("</details>")).toBe(true);
    expect(comment).toContain("truncated");
  });

  it("refuses an unsafe run id or head", () => {
    expect(() => descriptionFallbackComment("bad -->", SUMMARY, HEAD)).toThrow();
    expect(() => descriptionFallbackComment("run-2", SUMMARY, "x --> y")).toThrow();
  });
});

describe("descriptionAppliedComment", () => {
  it("keeps the marker, carries the applied marker on its second line, and holds no proposal", () => {
    const comment = descriptionAppliedComment("run-3");
    expect(comment.startsWith(`${DESCRIPTION_COMMENT_MARKER}\n${DESCRIPTION_COMMENT_APPLIED_MARKER}\n`)).toBe(true);
    expect(comment).toContain("`run-3`");
    expect(parseDescriptionComment(comment)).toEqual({ applied: true });
  });

  it("refuses an unsafe run id", () => {
    expect(() => descriptionAppliedComment("bad -->")).toThrow();
  });
});

describe("parseDescriptionComment", () => {
  it("only recognizes the pull-request-level marker as the first line", () => {
    expect(parseDescriptionComment("<!-- wardby-description:run-2 -->\n\nold per-run comment")).toBeUndefined();
    expect(parseDescriptionComment(`> ${DESCRIPTION_COMMENT_MARKER}\n> quoted`)).toBeUndefined();
    expect(parseDescriptionComment("just a comment")).toBeUndefined();
    expect(parseDescriptionComment(supersededDescriptionComment("https://github.com/o/r/pull/1#c2"))).toBeUndefined();
    expect(parseDescriptionComment(`${DESCRIPTION_COMMENT_MARKER}\n\nno proposal here`)).toEqual({ applied: false });
  });
});

describe("findDescriptionComments", () => {
  const ours = (id: number, body: string) => ({
    id,
    body,
    html_url: `https://github.com/o/r/pull/7#c${id}`,
    mine: true,
  });
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: from + i, body: `chatter ${from + i}`, mine: true }));

  it("pages past the first 100 and picks the newest of ours", async () => {
    const pages = [
      [ours(1, descriptionFallbackComment("run-1", SUMMARY, HEAD)), ...page(2, 99)],
      [
        ...page(200, 50),
        ours(300, descriptionAppliedComment("run-2")),
        { id: 301, body: descriptionFallbackComment("run-x", SUMMARY), mine: false },
      ],
    ];
    const fetched: number[] = [];
    const found = await findDescriptionComments(
      async (n) => {
        fetched.push(n);
        return pages[n - 1] ?? [];
      },
      (c) => c.mine === true,
    );
    expect(fetched).toEqual([1, 2]);
    expect(found.newest).toMatchObject({ id: 300, url: "https://github.com/o/r/pull/7#c300" });
    expect(found.newest?.parsed).toEqual({ applied: true });
    expect(found.older.map((c) => c.id)).toEqual([1]);
  });

  it("stops at MAX_DESCRIPTION_COMMENT_PAGES and ignores per-run legacy comments", async () => {
    let calls = 0;
    const found = await findDescriptionComments(
      async () => {
        calls += 1;
        return [ours(calls, `<!-- wardby-description:run-${calls} -->\n\nlegacy`), ...page(1000 * calls, 99)];
      },
      () => true,
    );
    expect(calls).toBe(MAX_DESCRIPTION_COMMENT_PAGES);
    expect(found).toEqual({ newest: null, older: [] });
  });
});

describe("closingIssueNumber", () => {
  it("returns the first closing reference to an issue in this repository", () => {
    expect(closingIssueNumber("Adds it.\n\nResolves #12", "openai/example")).toBe(12);
    expect(closingIssueNumber("fixes OpenAI/Example#7 and closes #8", "openai/example")).toBe(7);
    expect(closingIssueNumber("Closes other/repo#3, fixes #4", "openai/example")).toBe(4);
  });

  it("is undefined without one, or when it points at another repository only", () => {
    expect(closingIssueNumber("see #12", "openai/example")).toBeUndefined();
    expect(closingIssueNumber("Resolves other/repo#3", "openai/example")).toBeUndefined();
    expect(closingIssueNumber("Resolves Jira issue ABC-1", "openai/example")).toBeUndefined();
    expect(closingIssueNumber(undefined, "openai/example")).toBeUndefined();
  });
});
