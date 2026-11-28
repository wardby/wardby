import { MarkdownManager } from "@tiptap/markdown";
import { describe, expect, it } from "vitest";
import { encodePlainText } from "./markdown-text.js";
import { markdownToDoc, normalMarkdown } from "./live/markdown.js";

const textOf = (md: string) => markdownToDoc(md).textContent;

describe("keepPlainText", () => {
  it("pins the @tiptap/markdown method it replaces", () => {
    expect(typeof (MarkdownManager.prototype as unknown as Record<string, unknown>).encodeTextForMarkdown).toBe(
      "function",
    );
  });

  it("leaves plain &, < and > as they are", () => {
    expect(normalMarkdown("## Design & Wireframes\n\nA & B, a < b, x > y, 5 &amp; 6")).toBe(
      "## Design & Wireframes\n\nA & B, a < b, x > y, 5 & 6",
    );
  });

  it("escapes only what would read as an entity, a tag or a quote", () => {
    expect(encodePlainText("&copy; &#169; &#xA9; & ;")).toBe("&amp;copy; &amp;#169; &amp;#xA9; & ;");
    expect(encodePlainText("<div> </p> <!-- <https://x.y> < 3")).toBe("&lt;div> &lt;/p> &lt;!-- &lt;https://x.y> < 3");
    expect(encodePlainText("> quote\n  > again, not > here")).toBe("&gt; quote\n  &gt; again, not > here");
  });

  it("keeps the text the same through a save", () => {
    for (const text of [
      "Tom & Jerry",
      "&copy; stays literal",
      "a <b>tag</b> as text",
      "1 < 2 > 0",
      "&amp; typed out",
    ]) {
      const md = normalMarkdown(`${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}`);
      expect(textOf(md)).toBe(text);
      expect(normalMarkdown(md)).toBe(md);
    }
  });

  it("leaves code as written", () => {
    expect(normalMarkdown("`a &amp; <b>`\n\n```\nx & <y>\n```")).toBe("`a &amp; <b>`\n\n```\nx & <y>\n```");
  });
});
