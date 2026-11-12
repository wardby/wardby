import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOARD_FORMAT_RULES, boardFormatRulesText } from "./rules.js";
import { BoardFormatError, normalizeDesign, parseManifest } from "./format.js";

const read = (p: string) => readFileSync(new URL(`./fixtures/coffee/${p}`, import.meta.url), "utf8");
const coffee = (): Record<string, string> => ({
  "manifest.json": read("manifest.json"),
  "brand.md": read("brand.md"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, read(`boards/${id}.html`)]),
  ),
});

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BoardFormatError);
    expect((err as Error).message).toBe("board_format_invalid");
    return (err as BoardFormatError).problems;
  }
  throw new Error("expected BoardFormatError");
}

describe("board format v1", () => {
  it("accepts the coffee design and warns about nothing", () => {
    const out = normalizeDesign(coffee());
    expect(out.manifest.boards.map((b) => b.id)).toEqual(["home", "menu", "about", "visit"]);
    expect(Object.keys(out.files).sort()).toEqual([
      "boards/about.html",
      "boards/home.html",
      "boards/menu.html",
      "boards/visit.html",
      "brand.md",
      "manifest.json",
    ]);
    expect(out.warnings).toEqual([]);
  });

  it("is idempotent: normalising a normalised design changes nothing", () => {
    const once = normalizeDesign(coffee()).files;
    const twice = normalizeDesign(once).files;
    expect(twice).toEqual(once);
  });

  it("rejects bad manifests with named problems", () => {
    const bad = (m: unknown) => () => parseManifest(JSON.stringify(m));
    expect(bad({ title: "x", boards: [] })).toThrow(BoardFormatError);
    expect(bad({ title: "x", boards: [{ id: "Home", name: "H", file: "boards/Home.html", width: 1280 }] })).toThrow(
      BoardFormatError,
    );
    expect(bad({ title: "x", boards: [{ id: "a", name: "A", file: "boards/b.html", width: 1280 }] })).toThrow(
      BoardFormatError,
    );
    expect(
      bad({
        title: "x",
        boards: [
          { id: "a", name: "A", file: "boards/a.html" },
          { id: "a", name: "B", file: "boards/a.html" },
        ],
      }),
    ).toThrow(BoardFormatError);
    expect(() => parseManifest("{not json")).toThrow(BoardFormatError);
  });

  it("rejects missing or unlisted files and a board over the hard limit", () => {
    const files = coffee();
    delete files["boards/menu.html"];
    expect(() => normalizeDesign(files)).toThrow(BoardFormatError);
    expect(() => normalizeDesign({ ...coffee(), "boards/extra.html": "<p>x</p>" })).toThrow(BoardFormatError);
    const big = {
      ...coffee(),
      "boards/home.html": `<!doctype html><html><body>${"x".repeat(520 * 1024)}</body></html>`,
    };
    expect(() => normalizeDesign(big)).toThrow("board_too_large");
  });

  it("rejects a design over the version limit", () => {
    const files: Record<string, string> = coffee();
    for (let i = 0; i < 5; i++) files[`boards/pad${i}.html`] = "x".repeat(500 * 1024);
    expect(() => normalizeDesign(files)).toThrow("document_too_large");
  });

  // Ruling PF-L6: problems count caller text, never quote it.
  it("names problems without echoing paths, ids that failed validation or URLs", () => {
    const unlisted = problemsOf(() =>
      normalizeDesign({ ...coffee(), "boards/FAKE-SECRET-1.html": "<p>x</p>", "FAKE-SECRET-2.txt": "y" }),
    );
    expect(unlisted).toEqual(["2 files are not listed in manifest.json"]);
    const badId = problemsOf(() =>
      parseManifest(JSON.stringify({ title: "x", boards: [{ id: "FAKE-SECRET", name: "A", file: "x", width: 1280 }] })),
    );
    expect(badId.join(" ")).not.toContain("FAKE-SECRET");
    const files = coffee();
    files["boards/home.html"] = files["boards/home.html"].replace(
      "</body>",
      '<img src="https://x.test/FAKE-SECRET.png"></body>',
    );
    const ext = problemsOf(() => normalizeDesign(files));
    expect(ext).toEqual(["board home: external reference in img src"]);
  });

  it("rejects files that are not text", () => {
    expect(() => normalizeDesign({ ...coffee(), "boards/home.html": 5 as unknown as string })).toThrow(
      BoardFormatError,
    );
  });

  it("warns over 40 KB and on removals", () => {
    const files = coffee();
    files["boards/home.html"] = files["boards/home.html"].replace(
      "</body>",
      `<p onclick="x()">${"y".repeat(41 * 1024)}</p></body>`,
    );
    const out = normalizeDesign(files);
    expect(out.warnings.map((w) => w.kind).sort()).toEqual(["sanitized", "size"]);
  });

  it("has the spec's seven rules", () => {
    expect(BOARD_FORMAT_RULES).toHaveLength(7);
    expect(BOARD_FORMAT_RULES[5]).toContain("on `body`, not `:root`");
    expect(boardFormatRulesText().split("\n")).toHaveLength(7);
  });
});
