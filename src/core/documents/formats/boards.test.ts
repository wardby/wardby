import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { boardsFormat } from "./boards.js";
import { markdownFormat } from "./markdown.js";
import { formatFor } from "./index.js";

const read = (p: string) => readFileSync(new URL(`../boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const coffee = (): Record<string, string> => ({
  "manifest.json": read("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, read(`boards/${id}.html`)]),
  ),
});
const prepared = (files: Record<string, string>, secrets: string[]) => {
  const out = boardsFormat.prepare({ format: "boards-v1", files }, secrets).content;
  if (out.format !== "boards-v1") throw new Error("expected boards");
  return out.files;
};

describe("format adapters", () => {
  it("picks the adapter by kind", () => {
    expect(formatFor("document")).toBe(markdownFormat);
    expect(formatFor("design")).toBe(boardsFormat);
    expect(() => formatFor("sheet")).toThrow("document_kind_unsupported");
    expect(() => markdownFormat.prepare({ format: "boards-v1", files: {} }, [])).toThrow("document_format_mismatch");
    expect(() => boardsFormat.prepare({ format: "markdown", markdown: "x" }, [])).toThrow("document_format_mismatch");
  });

  it("sanitises again when redacting the normalised board cuts into markup", () => {
    // The raw text never holds the value: the serialiser rewrites the single quotes as double ones.
    const files = coffee();
    files["boards/home.html"] = files["boards/home.html"].replace(
      "</body>",
      `<p title='a onmouseover=alert(1)' class="k">x</p></body>`,
    );
    const secret = 'title="a';
    expect(files["boards/home.html"]).not.toContain(secret);
    const home = prepared(files, [secret])["boards/home.html"];
    expect(home).not.toContain(secret);
    // Whatever the cut left is text now: no element carries an event handler.
    const dom = new JSDOM(home, { virtualConsole: new VirtualConsole() });
    const handlers = Array.from(dom.window.document.querySelectorAll("*")).flatMap((el) =>
      Array.from(el.attributes).filter((a) => /^on/i.test(a.name)),
    );
    dom.window.close();
    expect(handlers).toEqual([]);
    // Stable: preparing the stored files again changes nothing.
    const again = prepared(prepared(files, [secret]), [secret]);
    expect(again["boards/home.html"]).toBe(home);
  });

  it("refuses a design whose board id only becomes a secret value once normalised", () => {
    // The raw manifest escapes one letter, so only the re-serialised manifest holds the value.
    const files = coffee();
    files["manifest.json"] = files["manifest.json"].replace('"id": "about"', '"id": "abo\\u0075t"');
    expect(files["manifest.json"]).not.toContain('"about"');
    expect(() => prepared(files, ['"about"'])).toThrow("board_format_invalid");
  });

  it("labels anchors for agents in plain text", () => {
    expect(markdownFormat.anchorLabel({ type: "text", quote: "hi", prefix: "", suffix: "" })).toBe('the text "hi"');
    expect(
      boardsFormat.anchorLabel({
        type: "element",
        board: "menu",
        path: "h1:nth-of-type(1)",
        tag: "h1",
        words: "A",
        dx: 0,
        dy: 0,
      }),
    ).toBe('board "menu", the <h1> element starting "A" (h1:nth-of-type(1))');
  });
});
