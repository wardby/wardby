import { getSchema, resolveExtensions } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { describe, expect, it } from "vitest";
import { documentExtensions } from "./extensions.js";
import { isLosslessRoundTrip } from "./roundtrip.js";

// What the page does: parse the source into the editor's schema, then getMarkdown().
const schema = getSchema(documentExtensions());
const markdown = new MarkdownManager({ extensions: resolveExtensions(documentExtensions()) });
const saved = (md: string) => markdown.serialize(schema.nodeFromJSON(markdown.parse(md)).toJSON());
const lossless = (md: string) => isLosslessRoundTrip(md, saved(md));

describe("isLosslessRoundTrip", () => {
  it("keeps a document of headings, lists, quotes, tables, code, links and escapes", () => {
    const md = [
      "# Plan",
      "",
      "Some **bold**, _it_, ~~gone~~, `code`, [a link](https://x.test) and snake\\_case.",
      "",
      "- one\n  - nested\n- two",
      "",
      "1. first\n2. second",
      "",
      "> quoted",
      "",
      "| a | b |\n|---|---|\n| c | d |",
      "",
      "---",
      "",
      "```html\n<div>![img](x.png)</div>\n- [ ] not a task\n```",
      "",
      "Tom &amp; Jerry, 3 &lt; 4, x < y, see <https://x.test>, line\\\nbreak.",
    ].join("\n");
    expect(lossless(md)).toBe(true);
  });

  it("refuses images", () => {
    expect(lossless("An ![alt text](x.png) image")).toBe(false);
    expect(lossless("A reference ![alt][logo]\n\n[logo]: x.png")).toBe(false);
  });

  it("refuses task lists", () => {
    expect(lossless("- [ ] todo\n- [x] done")).toBe(false);
    expect(lossless("> 1. [X] done in a quote")).toBe(false);
  });

  it("refuses raw HTML tags and comments", () => {
    expect(lossless("Text with <span>inline</span> html")).toBe(false);
    expect(lossless("Before\n\n<div>block</div>\n\nAfter")).toBe(false);
    expect(lossless("<u>underlined</u>")).toBe(false);
    expect(lossless("a<br/>b")).toBe(false);
    expect(lossless("<!-- hidden -->\nText")).toBe(false);
  });

  it("refuses named entities the editor would rewrite", () => {
    expect(lossless("&copy; 2026 and&nbsp;more")).toBe(false);
  });

  it("refuses documents whose text changes when written back", () => {
    // Tiptap writes these escapes back unescaped, turning text into a heading and a list.
    expect(lossless("\\# not a heading")).toBe(false);
    expect(lossless("\\- not a list")).toBe(false);
    // The same check, given the editor's output directly.
    expect(isLosslessRoundTrip("Hello world", "Hello")).toBe(false);
  });

  it("ignores image, task and HTML syntax inside code", () => {
    expect(lossless("Use `![x](y)` and `<b>` and ``- [ ]``")).toBe(true);
    expect(lossless("~~~\n<img src=x>\n- [x] y\n~~~")).toBe(true);
  });
});
