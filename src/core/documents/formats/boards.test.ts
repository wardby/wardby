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

/** A fake value holding every character a serialiser escapes: & < > " \\ and U+00A0. */
const SPECIAL = 'Pa"ss&w<rd>\\99\u00a0zz';
/** SPECIAL as HTML text or an attribute value: the raw text never holds the value. */
const SPECIAL_HTML = "Pa&quot;ss&amp;w&lt;rd&gt;\\99&nbsp;zz";

/** Every string a reader of `text` gets once it is decoded: as HTML (text and attributes) and as JSON. */
function decodedStrings(text: string): string[] {
  const out = [text];
  try {
    const walk = (v: unknown): void => {
      if (typeof v === "string") out.push(v);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(JSON.parse(text));
  } catch {
    // Not JSON.
  }
  const dom = new JSDOM(text, { virtualConsole: new VirtualConsole() });
  const doc = dom.window.document;
  out.push(doc.documentElement.textContent ?? "");
  for (const el of Array.from(doc.querySelectorAll("*"))) for (const a of Array.from(el.attributes)) out.push(a.value);
  dom.window.close();
  return out;
}

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

  it("redacts values that reach the stored files only in escaped form, checked decoded", () => {
    const files = coffee();
    expect(files["boards/home.html"]).not.toContain(SPECIAL);
    files["boards/home.html"] = files["boards/home.html"]
      .replace(/<title>[^<]*<\/title>/, `<title>t ${SPECIAL_HTML}</title>`)
      .replace("</body>", `<p>t ${SPECIAL_HTML}</p><p title="${SPECIAL_HTML}" class="k">a</p></body>`);
    const manifest = JSON.parse(files["manifest.json"]);
    manifest.title = `X ${SPECIAL}`;
    manifest.boards[0].name = `N ${SPECIAL}`;
    // JSON.stringify leaves U+00A0 as it is; write it escaped so no raw form of it is left either.
    files["manifest.json"] = JSON.stringify(manifest).replace(/\u00a0/g, "\\u00a0");
    files["brand.md"] = `# Brand\n\nKey ${SPECIAL_HTML}\n`;
    for (const text of Object.values(files)) expect(text).not.toContain(SPECIAL);

    const stored = prepared(files, [SPECIAL]);
    for (const [path, text] of Object.entries(stored)) {
      for (const s of decodedStrings(text)) expect(s, path).not.toContain(SPECIAL);
    }
    const doc = new JSDOM(stored["boards/home.html"], { virtualConsole: new VirtualConsole() }).window.document;
    expect(doc.title).toBe("t [REDACTED]");
    expect(doc.querySelector("p.k")?.getAttribute("title")).toBe("[REDACTED]");
    expect(doc.body.textContent).toContain("t [REDACTED]");
    expect(JSON.parse(stored["manifest.json"]).title).toBe("X [REDACTED]");
    expect(JSON.parse(stored["manifest.json"]).boards[0].name).toBe("N [REDACTED]");
    expect(stored["brand.md"]).toBe("# Brand\n\nKey [REDACTED]\n");
    // Stable: preparing the stored files again changes nothing.
    expect(prepared(stored, [SPECIAL])).toEqual(stored);
  });

  it("redacts a value written with numeric entities in board text and attributes", () => {
    const secret = "FAKE-NUMERIC-VALUE-41";
    const files = coffee();
    const encoded = "FAKE&#45;NUMERIC&#x2D;VALUE-&#52;1";
    files["boards/menu.html"] = files["boards/menu.html"].replace(
      "</body>",
      `<p>${encoded}</p><a href="#${encoded}" class="q">x</a></body>`,
    );
    const menu = prepared(files, [secret])["boards/menu.html"];
    for (const s of decodedStrings(menu)) expect(s).not.toContain(secret);
    expect(menu).toContain("[REDACTED]");
  });

  it("refuses a board that redaction would push past the size limit", () => {
    // Written as an entity, the 6-character value is 10 characters in the input, 6 once sanitised
    // and 10 again as the marker: only the post-pass grows the board, past 512 KB here.
    const unit = "FAKEV&#76; ";
    const limit = 512 * 1024;
    const n = Math.floor((limit - "<p></p>".length) / unit.length);
    const board = `<p>${unit.repeat(n)}</p>`;
    expect(Buffer.byteLength(board, "utf8")).toBeLessThanOrEqual(limit);
    const manifest = JSON.stringify({ title: "Big", boards: [{ id: "home", name: "Home", file: "boards/home.html" }] });
    const files = { "manifest.json": manifest, "boards/home.html": board };
    expect(() => prepared(files, [])).not.toThrow();
    expect(() => prepared(files, ["FAKEVL"])).toThrow("board_too_large");
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
