import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readDesignFromRepository } from "./repository.js";

const read = (p: string) => readFileSync(new URL(`./fixtures/coffee/${p}`, import.meta.url), "utf8");
// Like the real executors: null when absent, a thrown code (never a truncation) when too large or not text.
const fakeExecutor = (files: Record<string, string>, failures: Record<string, string> = {}) => ({
  readCodingRepositoryFile: async ({ path, maxBytes }: { path: string; maxBytes: number }) => {
    if (failures[path]) throw new Error(failures[path]);
    const text = files[path];
    if (text === undefined) return null;
    if (Buffer.byteLength(text) > maxBytes) throw new Error("local_file_too_large");
    return text;
  },
});
const aBoard = (file = "boards/a.html") => ({
  "manifest.json": JSON.stringify({ title: "T", boards: [{ id: "a", name: "A", file, width: 1280 }] }),
});
const at = { repository: "local:/r", dir: ".", ref: "main" };

describe("readDesignFromRepository", () => {
  it("reads the manifest, every board and brand.md under the directory", async () => {
    const repo: Record<string, string> = {
      "design/manifest.json": read("manifest.json"),
      "design/brand.md": read("brand.md"),
    };
    for (const id of ["home", "menu", "about", "visit"]) repo[`design/boards/${id}.html`] = read(`boards/${id}.html`);
    const files = await readDesignFromRepository(fakeExecutor(repo), { ...at, dir: "design" });
    expect(Object.keys(files).sort()).toEqual([
      "boards/about.html",
      "boards/home.html",
      "boards/menu.html",
      "boards/visit.html",
      "brand.md",
      "manifest.json",
    ]);
  });

  it("redacts token-shaped values and refuses a missing manifest", async () => {
    const repo: Record<string, string> = { ...aBoard() };
    repo["boards/a.html"] = "<p>ghp_abcdefghijklmnopqrstuvwxyz0123456789</p>";
    const files = await readDesignFromRepository(fakeExecutor(repo), at);
    expect(files["boards/a.html"]).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    await expect(readDesignFromRepository(fakeExecutor({}), at)).rejects.toThrow("board_format_invalid");
  });

  it("maps the executors' read errors without echoing paths", async () => {
    const repo = { ...aBoard(), "boards/a.html": "<p>x</p>" };
    await expect(
      readDesignFromRepository(fakeExecutor(repo, { "boards/a.html": "github_file_too_large" }), at),
    ).rejects.toThrow("board_too_large");
    await expect(
      readDesignFromRepository(fakeExecutor(repo, { "manifest.json": "local_file_too_large" }), at),
    ).rejects.toThrow("document_too_large");
    const bad = await readDesignFromRepository(
      fakeExecutor(repo, { "boards/a.html": "local_file_not_utf8" }),
      at,
    ).catch((e) => e);
    expect(bad.problems).toEqual(["board a: not a UTF-8 text file"]);
    const missing = await readDesignFromRepository(fakeExecutor(aBoard()), at).catch((e) => e);
    expect(missing.problems).toEqual(["board a: file is missing"]);
    await expect(readDesignFromRepository({}, at)).rejects.toThrow("document_repo_link_invalid");
  });
});
