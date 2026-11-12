import { getSchema, resolveExtensions } from "@tiptap/core";
import { TableKit } from "@tiptap/extension-table";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";
import { locateAnchor as serverLocate } from "../../core/documents/anchors.js";
import { markdownToPlainText } from "../../core/documents/plain-text.js";
import {
  anchorForRange,
  docText,
  locateAnchor,
  normalizeWithMap,
  plainTextForAnchoring,
  rangeForAnchor,
} from "./anchors.js";

// The same extensions the page loads (minus the comment highlight, which is a decoration, not schema).
const schema = getSchema([StarterKit, TableKit]);
const markdown = new MarkdownManager({ extensions: resolveExtensions([StarterKit, TableKit]) });
const docFrom = (md: string) => schema.nodeFromJSON(markdown.parse(md));

/** Shared fixtures: the browser's plain text must equal the server's markdownToPlainText (R1, R1a). */
const FIXTURES: Record<string, string> = {
  headings: "# Title here\n\n## Second   level\n\nBody text under it.",
  emphasis: "Some **bold**, _it_, *star*, ~~gone~~ and `code` with [a link](https://x.test/y).",
  lists: "- one\n- two  item\n\n1. first\n2. second\n\n> quoted line",
  "code block with blank lines": "Before\n\n```js\nconst a = 1;\n\n\n  const   b = 2;\n```\n\nAfter",
  snake_case: "Call foo_bar_baz and my_var, then __bold__ words.",
  "hard break": "line one  \nline two",
  "nested list": "- outer\n  - inner one\n  - inner two\n- last",
};

describe("plainTextForAnchoring matches the server's markdownToPlainText", () => {
  for (const [name, md] of Object.entries(FIXTURES)) {
    it(name, () => {
      expect(plainTextForAnchoring(docText(docFrom(md)).raw)).toBe(markdownToPlainText(md));
    });
  }
  it("is Tiptap's textBetween(…, '\\n') with collapsed whitespace and no empty lines", () => {
    const doc = docFrom(FIXTURES["code block with blank lines"]);
    expect(plainTextForAnchoring(doc.textBetween(0, doc.content.size, "\n"))).toBe(
      plainTextForAnchoring(docText(doc).raw),
    );
  });
});

describe("normalizeWithMap", () => {
  it("collapses whitespace, drops empty lines and maps back to raw offsets", () => {
    const raw = "  a  b\n\n\nc ";
    const { text, toRaw } = normalizeWithMap(raw);
    expect(text).toBe("a b\nc");
    expect([...text].map((_, i) => raw[toRaw[i]])).toEqual(["a", " ", "b", "\n", "c"]);
  });
});

describe("anchors from a selection", () => {
  const md =
    "# Brand\n\nFresh pastries sit on the shelf by the front window, and a weekend pastry menu that changes.\n\nMore text.";
  const doc = docFrom(md);
  const dt = docText(doc);
  const plain = markdownToPlainText(md);
  const posOf = (needle: string) => {
    let found = -1;
    doc.descendants((n, p) => {
      if (found < 0 && n.isText && n.text!.includes(needle)) found = p + n.text!.indexOf(needle);
    });
    return found;
  };

  it("snaps to words, keeps 32 chars of context and is found by the server", () => {
    const from = posOf("ow, and");
    const to = posOf("menu") + 4;
    const result = anchorForRange(dt, from, to);
    expect(result).not.toBeNull();
    const { anchor, range } = result!;
    expect(anchor.type).toBe("text");
    expect(anchor.quote).toBe("window, and a weekend pastry menu");
    const at = plain.indexOf(anchor.quote);
    expect(anchor.prefix).toBe(plain.slice(Math.max(0, at - 32), at));
    expect(anchor.prefix).toHaveLength(32);
    expect(anchor.suffix).toBe(plain.slice(plain.indexOf(anchor.quote) + anchor.quote.length).slice(0, 32));
    expect(serverLocate(plain, anchor)).toEqual({
      start: plain.indexOf(anchor.quote),
      end: plain.indexOf(anchor.quote) + anchor.quote.length,
    });
    expect(doc.textBetween(range.from, range.to)).toBe("window, and a weekend pastry menu");
  });

  it("maps an anchor back to document positions", () => {
    const { anchor } = anchorForRange(dt, posOf("weekend"), posOf("weekend") + 7)!;
    const r = rangeForAnchor(dt, anchor);
    expect(r).not.toBeNull();
    expect(doc.textBetween(r!.from, r!.to)).toBe("weekend");
  });

  it("anchors across blocks with a newline in the quote", () => {
    const { anchor, range } = anchorForRange(dt, posOf("changes"), posOf("More") + 4)!;
    expect(anchor.quote).toBe("changes.\nMore");
    expect(rangeForAnchor(dt, anchor)).toEqual(range);
  });

  it("returns null for an empty or whitespace selection", () => {
    expect(anchorForRange(dt, posOf("weekend"), posOf("weekend"))).toBeNull();
  });

  it("locates with the same preference as the server", () => {
    const text = "the cat and the cat sat";
    const a = { type: "text" as const, quote: "the cat", prefix: "the cat and ", suffix: " sat" };
    expect(locateAnchor(text, a)).toEqual(serverLocate(text, a));
    expect(locateAnchor(text, { ...a, quote: "dog" })).toBeNull();
  });
});
