import { describe, expect, it } from "vitest";
import { defuseMentions, splitReply } from "./reply-parts.js";

const ZWSP = "\u200b";

/** Every part fits, and the parts put back together are the defused input. */
function expectLossless(text: string, parts: string[], maxChars: number): void {
  for (const part of parts) expect(part.length).toBeLessThanOrEqual(maxChars);
  expect(parts.join("")).toBe(defuseMentions(text));
}

describe("defuseMentions", () => {
  it("puts a zero-width space after @ before a word character, as quoteReply does", () => {
    expect(defuseMentions("ping @wardby and @someone-else")).toBe(`ping @${ZWSP}wardby and @${ZWSP}someone-else`);
    expect(defuseMentions("mail a@b.com")).toBe(`mail a@${ZWSP}b.com`);
    expect(defuseMentions("a lone @ stays")).toBe("a lone @ stays");
  });
});

describe("splitReply", () => {
  it("returns text under the limit as one part, with mentions defused", () => {
    const text = "Done. @wardby please look.";
    expect(splitReply(text, { maxChars: 100, maxParts: 3 })).toEqual({
      parts: [`Done. @${ZWSP}wardby please look.`],
      truncated: false,
    });
  });

  it("splits at ## heading boundaries when possible", () => {
    const one = `## One\n${"a".repeat(20)}\n\n${"b".repeat(20)}\n`;
    const two = `## Two\n${"c".repeat(20)}\n`;
    const text = one + two;
    const { parts, truncated } = splitReply(text, { maxChars: 60, maxParts: 5 });
    expect(truncated).toBe(false);
    expect(parts).toEqual([one, two]);
    expectLossless(text, parts, 60);
  });

  it("falls back to blank-line paragraphs", () => {
    const first = `${"a".repeat(20)}\n${"b".repeat(20)}\n\n`;
    const second = `${"c".repeat(20)}\n${"d".repeat(20)}\n`;
    const text = first + second;
    const { parts } = splitReply(text, { maxChars: 50, maxParts: 5 });
    expect(parts).toEqual([first, second]);
    expectLossless(text, parts, 50);
  });

  it("falls back to single newlines when there are no paragraphs", () => {
    const lines = ["a", "b", "c", "d"].map((c) => `${c.repeat(20)}\n`);
    const text = lines.join("");
    const { parts } = splitReply(text, { maxChars: 50, maxParts: 5 });
    expect(parts).toEqual([lines[0] + lines[1], lines[2] + lines[3]]);
    expectLossless(text, parts, 50);
  });

  it("hard-cuts one huge line at maxChars", () => {
    const text = "x".repeat(250);
    const { parts, truncated } = splitReply(text, { maxChars: 100, maxParts: 5 });
    expect(truncated).toBe(false);
    expect(parts.map((p) => p.length)).toEqual([100, 100, 50]);
    expectLossless(text, parts, 100);
  });

  it("never cuts inside a ``` fence when the fence fits in a part", () => {
    const intro = `${"i".repeat(30)}\n`;
    const fence = "```ts\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```\n";
    const outro = `${"o".repeat(10)}\n`;
    const text = intro + fence + outro;
    // A newline inside the fence would fit more into the first part; the cut must come before it.
    const { parts } = splitReply(text, { maxChars: 60, maxParts: 5 });
    expect(parts[0]).toBe(intro);
    expect(parts[1]).toBe(fence + outro);
    expectLossless(text, parts, 60);
  });

  it("hard-cuts a fence that alone exceeds maxChars", () => {
    const text = "```\n" + "y".repeat(120) + "\n```\n";
    const { parts, truncated } = splitReply(text, { maxChars: 50, maxParts: 10 });
    expect(truncated).toBe(false);
    expectLossless(text, parts, 50);
  });

  it("stops at maxParts and reports the cut", () => {
    const text = Array.from({ length: 10 }, (_, i) => `## Part ${i}\n${"z".repeat(30)}\n`).join("");
    const { parts, truncated } = splitReply(text, { maxChars: 50, maxParts: 3 });
    expect(truncated).toBe(true);
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(50);
    expect(defuseMentions(text).startsWith(parts.join(""))).toBe(true);
  });

  it("defuses @-mentions and emails across parts", () => {
    const text = `## A\n@wardby ${"a".repeat(30)}\n## B\nwrite to a@b.com or @someone\n`;
    const { parts } = splitReply(text, { maxChars: 45, maxParts: 5 });
    const joined = parts.join("");
    expect(joined).toContain(`@${ZWSP}wardby`);
    expect(joined).toContain(`@${ZWSP}someone`);
    expect(joined).toContain(`a@${ZWSP}b.com`);
    expectLossless(text, parts, 45);
  });

  it("keeps every part within maxChars and loses nothing on mixed content", () => {
    const text = [
      "# Plan",
      "",
      "Intro paragraph for @wardby with some words in it.",
      "",
      "## Step 1",
      "Do the first thing.",
      "```sh",
      "npm test",
      "npm run build",
      "```",
      "",
      "## Step 2",
      "w".repeat(140),
      "",
      "## Step 3",
      "Done.",
    ].join("\n");
    for (const maxChars of [40, 64, 100, 500]) {
      const { parts, truncated } = splitReply(text, { maxChars, maxParts: 100 });
      expect(truncated).toBe(false);
      expectLossless(text, parts, maxChars);
    }
  });
});
