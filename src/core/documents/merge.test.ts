import { describe, expect, it } from "vitest";
import { markdownAgentFormat, designAgentFormat } from "./agent-formats.js";
import { editedFiles, mergeContent, mergeFiles } from "./merge.js";

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

  it("is a conflict when both sides changed a file differently", () => {
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
