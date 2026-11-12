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
