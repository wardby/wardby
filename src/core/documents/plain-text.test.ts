import { describe, expect, it } from "vitest";
import { markdownToPlainText } from "./plain-text.js";

describe("markdownToPlainText", () => {
  it("removes heading hashes, emphasis, inline code ticks and link syntax", () => {
    expect(markdownToPlainText("## Title\n\nSome **bold** and _it_ and `code` and [a link](https://x.test/y).")).toBe(
      "Title\nSome bold and it and code and a link.",
    );
  });
  it("removes list bullets, numbers and blockquote markers", () => {
    expect(markdownToPlainText("- one\n* two\n1. three\n2) four\n> quoted")).toBe("one\ntwo\nthree\nfour\nquoted");
  });
  it("collapses whitespace within a block and skips blank lines", () => {
    expect(markdownToPlainText("a   b\t c\n\n\n  d  ")).toBe("a b c\nd");
  });
  it("handles star emphasis and strikes", () => {
    expect(markdownToPlainText("*x* __y__ ~~z~~")).toBe("x y z");
  });
  it("drops fence lines (with a language tag) and keeps code text", () => {
    expect(markdownToPlainText("before\n\n```js\nconst a = 1;\n```\n\nafter")).toBe("before\nconst a = 1;\nafter");
    expect(markdownToPlainText("~~~\nx\n~~~")).toBe("x");
  });
  it("keeps code lines verbatim (no heading, bullet or emphasis stripping)", () => {
    expect(markdownToPlainText("```\n# comment\n- x\n*x*\n  a   b\n```")).toBe("# comment\n- x\n*x*\na b");
  });
  it("keeps snake_case and 2*x*3 intact", () => {
    expect(markdownToPlainText("foo_bar_baz and 2*x*3")).toBe("foo_bar_baz and 2*x*3");
  });
  it("still strips normal star and underscore emphasis", () => {
    expect(markdownToPlainText("a *emphasis* and _emphasis_ here")).toBe("a emphasis and emphasis here");
  });
  it("returns empty for empty input", () => {
    expect(markdownToPlainText("")).toBe("");
  });
});

// Ruling R16: the same text the browser editor shows.
describe("markdownToPlainText (editor text, R16)", () => {
  it("unescapes backslash escapes outside code and keeps them inside code", () => {
    expect(markdownToPlainText("Keep snake\\_case, \\*x\\*, \\# \\[a\\] \\(b\\) \\` \\\\ and `c\\_d`")).toBe(
      "Keep snake_case, *x*, # [a] (b) ` \\ and c\\_d",
    );
    expect(markdownToPlainText("\\# not a heading")).toBe("# not a heading");
  });
  it("gives one line per table cell, without the delimiter row or outer pipes", () => {
    expect(markdownToPlainText("| Name | Value |\n|---|:--:|\n| a **b** | c\\|d |\n\nafter")).toBe(
      "Name\nValue\na b\nc|d\nafter",
    );
    expect(markdownToPlainText("k | v\n--- | ---\n1 | 2")).toBe("k\nv\n1\n2");
  });
  it("drops horizontal rules and setext underlines", () => {
    expect(markdownToPlainText("one\n\n---\n\ntwo\n\n***\n\n_ _ _\n\nthree")).toBe("one\ntwo\nthree");
    expect(markdownToPlainText("Title\n=====\n\nSub\n---")).toBe("Title\nSub");
  });
  it("decodes &amp; &lt; &gt; &quot; &#39; and numeric references once, not other named entities", () => {
    expect(markdownToPlainText("a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#65;&#x42; &amp;lt; &copy;")).toBe(
      "a & b <c> \"d\" 'e' AB &lt; &copy;",
    );
    expect(markdownToPlainText("`&amp;`")).toBe("&amp;");
  });
  it("keeps inline HTML as literal text and unwraps autolinks", () => {
    expect(markdownToPlainText("x <span>y</span> z")).toBe("x <span>y</span> z");
    expect(markdownToPlainText("see <https://x.test/a> or <me@x.test>")).toBe("see https://x.test/a or me@x.test");
  });
  it("treats a trailing backslash inside a paragraph as a line break", () => {
    expect(markdownToPlainText("one\\\ntwo\\\n\nthree\\")).toBe("one\ntwo\\\nthree\\");
  });
});
