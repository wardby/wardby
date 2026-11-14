import { describe, expect, it } from "vitest";
import { markdownAgentFormat, designAgentFormat } from "./agent-formats.js";
import { editedFiles, MAX_MERGE_LINES, mergeContent, mergeFiles, mergeLines } from "./merge.js";
import { MAX_EDITS } from "./text-diff.js";

describe("mergeFiles (per-file three-way merge)", () => {
  const base = { "manifest.json": "m", "boards/home.html": "h", "boards/about.html": "a" };

  it("takes theirs where ours is the base, and ours where theirs is the base", () => {
    expect(mergeFiles(base, { ...base, "boards/about.html": "a2" }, { ...base, "boards/home.html": "h2" })).toEqual({
      kind: "merged",
      files: { "manifest.json": "m", "boards/home.html": "h2", "boards/about.html": "a2" },
    });
  });

  it("takes a change both sides made the same way", () => {
    const same = { ...base, "boards/home.html": "h2" };
    expect(mergeFiles(base, same, same)).toEqual({ kind: "merged", files: same });
  });

  it("is a conflict when both sides changed the same line of a file differently", () => {
    expect(
      mergeFiles(base, { ...base, "boards/home.html": "theirs" }, { ...base, "boards/home.html": "ours" }),
    ).toEqual({ kind: "conflict", paths: ["boards/home.html"] });
  });

  it("treats a missing file as deleted: a one-sided delete wins over an unchanged file", () => {
    const { "boards/about.html": _gone, ...withoutAbout } = base;
    expect(mergeFiles(base, withoutAbout, base)).toEqual({ kind: "merged", files: withoutAbout });
    expect(mergeFiles(base, base, withoutAbout)).toEqual({ kind: "merged", files: withoutAbout });
    // Both deleted it: gone.
    expect(mergeFiles(base, withoutAbout, withoutAbout)).toEqual({ kind: "merged", files: withoutAbout });
  });

  it("a delete on one side and an edit on the other is a conflict", () => {
    const { "boards/about.html": _gone, ...withoutAbout } = base;
    expect(mergeFiles(base, withoutAbout, { ...base, "boards/about.html": "a2" })).toEqual({
      kind: "conflict",
      paths: ["boards/about.html"],
    });
  });

  it("an added board on one side is kept; the same path added differently on both is a conflict", () => {
    expect(mergeFiles(base, base, { ...base, "boards/new.html": "n" })).toEqual({
      kind: "merged",
      files: { ...base, "boards/new.html": "n" },
    });
    expect(mergeFiles(base, { ...base, "boards/new.html": "n1" }, { ...base, "boards/new.html": "n2" })).toEqual({
      kind: "conflict",
      paths: ["boards/new.html"],
    });
  });

  it("lists every conflicting path, sorted", () => {
    const r = mergeFiles(
      base,
      { "manifest.json": "m1", "boards/home.html": "h1", "boards/about.html": "a" },
      { "manifest.json": "m2", "boards/home.html": "h2", "boards/about.html": "a" },
    );
    expect(r).toEqual({ kind: "conflict", paths: ["boards/home.html", "manifest.json"] });
  });
});

describe("mergeContent (through the format adapter)", () => {
  it("merges a Markdown document as one file", () => {
    const md = (markdown: string) => ({ format: "markdown" as const, markdown });
    expect(mergeContent(markdownAgentFormat, md("a"), md("a"), md("b"))).toEqual({ kind: "merged", content: md("b") });
    expect(mergeContent(markdownAgentFormat, md("a"), md("c"), md("a"))).toEqual({ kind: "merged", content: md("c") });
    expect(mergeContent(markdownAgentFormat, md("a"), md("c"), md("b"))).toMatchObject({ kind: "conflict" });
  });

  it("merges a design file by file", () => {
    const d = (files: Record<string, string>) => ({ format: "boards-v1" as const, files });
    const base = d({ "manifest.json": "m", "boards/home.html": "h", "boards/about.html": "a" });
    const theirs = d({ "manifest.json": "m", "boards/home.html": "h", "boards/about.html": "a2" });
    const ours = d({ "manifest.json": "m", "boards/home.html": "h2", "boards/about.html": "a" });
    expect(mergeContent(designAgentFormat, base, theirs, ours)).toEqual({
      kind: "merged",
      content: d({ "manifest.json": "m", "boards/home.html": "h2", "boards/about.html": "a2" }),
    });
  });

  it("refuses contents of the wrong format for the adapter", () => {
    const md = { format: "markdown" as const, markdown: "a" };
    expect(() => mergeContent(designAgentFormat, md, md, md)).toThrow("document_format_mismatch");
  });
});

describe("editedFiles", () => {
  it("lists the files ours changed or added, and the ones it deleted", () => {
    expect(
      editedFiles(
        { "manifest.json": "m", "boards/home.html": "h", "boards/about.html": "a" },
        { "manifest.json": "m2", "boards/home.html": "h", "boards/new.html": "n" },
      ),
    ).toEqual({
      changed: { "boards/new.html": "n", "manifest.json": "m2" },
      deleted: ["boards/about.html"],
    });
  });
});

describe("mergeLines (line-level three-way merge of one file)", () => {
  it("treats a file over MAX_MERGE_LINES as a conflict, even with edits far apart", () => {
    const base = Array.from({ length: MAX_MERGE_LINES + 1 }, (_, i) => `line ${i}\n`).join("");
    const theirs = base.replace("line 0\n", "first\n");
    const ours = base.replace(`line ${MAX_MERGE_LINES}\n`, "last\n");
    expect(mergeLines(base, theirs, ours)).toBeNull();
    // Just under the cap the same edits merge.
    const small = Array.from({ length: MAX_MERGE_LINES }, (_, i) => `line ${i}\n`).join("");
    const merged = mergeLines(
      small,
      small.replace("line 0\n", "first\n"),
      small.replace(`line ${MAX_MERGE_LINES - 1}\n`, "last\n"),
    );
    expect(merged?.startsWith("first\n")).toBe(true);
    expect(merged?.endsWith("last\n")).toBe(true);
  });

  const base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n";

  it("merges edits to different paragraphs", () => {
    expect(
      mergeLines(
        base,
        base.replace("Third paragraph.", "Third, edited by them."),
        base.replace("First paragraph.", "First, edited by us."),
      ),
    ).toBe("# Title\n\nFirst, edited by us.\n\nSecond paragraph.\n\nThird, edited by them.\n");
  });

  it("is a conflict when both sides changed the same line differently", () => {
    expect(mergeLines(base, base.replace("Second", "Their second"), base.replace("Second", "Our second"))).toBeNull();
  });

  it("is a conflict when the two sides changed adjacent lines", () => {
    const b = "a\nb\nc\nd\n";
    expect(mergeLines(b, "a\nB\nc\nd\n", "a\nb\nC\nd\n")).toBeNull();
    // An insertion right next to the other side's change touches it too.
    expect(mergeLines(b, "a\nB\nc\nd\n", "a\nb\nnew\nc\nd\n")).toBeNull();
  });

  it("applies a change both sides made the same way once, alongside a change only one side made", () => {
    const both = base.replace("First paragraph.", "First, fixed.");
    expect(mergeLines(base, both, both.replace("Third paragraph.", "Third, ours."))).toBe(
      "# Title\n\nFirst, fixed.\n\nSecond paragraph.\n\nThird, ours.\n",
    );
  });

  it("merges an insertion at the start with one at the end", () => {
    expect(mergeLines(base, `${base}Appended.\n`, `Preface.\n${base}`)).toBe(`Preface.\n${base}Appended.\n`);
    expect(mergeLines(base, `Preface.\n${base}`, `${base}Appended.\n`)).toBe(`Preface.\n${base}Appended.\n`);
  });

  it("merges a deletion on one side with an edit elsewhere on the other", () => {
    expect(mergeLines(base, base.replace("Second paragraph.\n\n", ""), base.replace("# Title", "# New title"))).toBe(
      "# New title\n\nFirst paragraph.\n\nThird paragraph.\n",
    );
  });

  it("ignores blank lines at the end of the file: both sides dropping them is not a conflict", () => {
    // The case seen live: both agent edits ended with one newline where the sent version had a blank line more,
    // and one of them also changed the last paragraph.
    const b = "Checklist.\n\nPara 1, favourite.\n\nPara 2, favourite.\n\n";
    const theirs = "Checklist.\n\nPara 1, favorite.\n\nPara 2, favorite.\n";
    const ours = "Checklist, with export steps.\n\nPara 1, favourite.\n\nPara 2, favourite.\n";
    expect(mergeLines(b, theirs, ours)).toBe(
      "Checklist, with export steps.\n\nPara 1, favorite.\n\nPara 2, favorite.\n",
    );
    // The end of the file is merged on its own: one side's change to it wins over an unchanged other side.
    expect(mergeLines("a\n\nb\n", "a\n\nb\n\n\n", "A\n\nb\n")).toBe("A\n\nb\n\n\n");
    // Both changed it differently: one newline.
    expect(mergeLines("a\n\nb\n\n", "a\n\nb", "A\n\nb\n\n\n")).toBe("A\n\nb\n");
    // Content at the end still conflicts as before.
    expect(mergeLines("a\n\nb\n\n", "a\n\nB\n", "a\n\nb, ours\n")).toBeNull();
  });

  it("keeps a file without a final newline exactly", () => {
    const b = "one\n\ntwo\n\nthree";
    expect(mergeLines(b, "one\n\ntwo\n\nthree, theirs", "one, ours\n\ntwo\n\nthree")).toBe(
      "one, ours\n\ntwo\n\nthree, theirs",
    );
    expect(mergeLines(b, "ONE\n\ntwo\n\nthree", "one\n\ntwo\n\nthree\n")).toBe("ONE\n\ntwo\n\nthree\n");
  });

  it("is a conflict when a side's diff goes past the edit cap", () => {
    const lines = (tag: string) => Array.from({ length: MAX_EDITS }, (_, i) => `${tag} ${i}\n`).join("");
    const b = `head\n\n${lines("base")}`;
    expect(mergeLines(b, b.replace("head", "their head"), `head\n\n${lines("ours")}`)).toBeNull();
  });

  it("merges a board file whose two sides edited separate style rules", () => {
    const board = [
      "<!doctype html>",
      "<html><head><style>",
      "  h1{color:#2C4330;}",
      "  p{margin:0 0 1em;}",
      "  a{color:#C1623B;}",
      "</style></head>",
      "<body><h1>Menu</h1></body></html>",
      "",
    ].join("\n");
    const theirs = board.replace("h1{color:#2C4330;}", "h1{color:#000;}");
    const ours = board.replace("a{color:#C1623B;}", "a{color:#3F5B45;}");
    const want = board
      .replace("h1{color:#2C4330;}", "h1{color:#000;}")
      .replace("a{color:#C1623B;}", "a{color:#3F5B45;}");
    expect(mergeLines(board, theirs, ours)).toBe(want);
    expect(
      mergeFiles(
        { "manifest.json": "m", "boards/menu.html": board },
        { "manifest.json": "m", "boards/menu.html": theirs },
        { "manifest.json": "m", "boards/menu.html": ours },
      ),
    ).toEqual({ kind: "merged", files: { "manifest.json": "m", "boards/menu.html": want } });
  });
});
