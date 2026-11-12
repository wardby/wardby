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
  it("returns empty for empty input", () => {
    expect(markdownToPlainText("")).toBe("");
  });
});
