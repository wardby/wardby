import { describe, expect, it } from "vitest";
import { MAX_PLAN_DOCUMENTS, parsePlanLayout } from "./layout.js";

const manifest = (ids: string[] = ["home"]) =>
  JSON.stringify({
    title: "Screens",
    boards: ids.map((id) => ({ id, name: id, file: `boards/${id}.html`, width: 1280 })),
  });

describe("parsePlanLayout", () => {
  it("plan.md first, other top-level Markdown next, then one design per board folder; the rest ignored", () => {
    const result = parsePlanLayout([
      { path: "api.md", content: "# API\n" },
      { path: "plan.md", content: "# The plan\n\n## Tickets\n" },
      { path: "screens/manifest.json", content: manifest() },
      { path: "screens/boards/home.html", content: "<main>Home</main>" },
      { path: "notes.txt", content: "x" },
      { path: "deep/a.md", content: "# A" },
    ]);
    expect(result.ok && result.documents.map((d) => [d.kind, d.path, d.title])).toEqual([
      ["document", "plan.md", "The plan"],
      ["document", "api.md", "API"],
      ["design", "screens/", "screens"],
    ]);
    expect(result.ok && result.ignored).toEqual(["deep/a.md", "notes.txt"]);
  });

  it("a folder that is not in board format is ignored, file by file", () => {
    const result = parsePlanLayout([
      { path: "plan.md", content: "# P" },
      { path: "bad/manifest.json", content: "{ not json" },
      { path: "bad/boards/home.html", content: "<main>Home</main>" },
    ]);
    expect(result.ok && result.documents.map((d) => d.path)).toEqual(["plan.md"]);
    expect(result.ok && result.ignored).toEqual(["bad/boards/home.html", "bad/manifest.json"]);
  });

  it("more than 20 documents is plan_too_large; no Markdown and no design is plan_empty", () => {
    const many = Array.from({ length: MAX_PLAN_DOCUMENTS + 1 }, (_, i) => ({ path: `d${i}.md`, content: `# ${i}` }));
    expect(parsePlanLayout(many)).toEqual({ ok: false, error: "plan_too_large" });
    expect(parsePlanLayout([{ path: "x.txt", content: "x" }])).toEqual({ ok: false, error: "plan_empty" });
  });

  it("a Markdown document over 60,000 characters is plan_too_large", () => {
    expect(parsePlanLayout([{ path: "plan.md", content: "x".repeat(60_001) }])).toEqual({
      ok: false,
      error: "plan_too_large",
    });
  });

  it("a design whose files exceed the 1 MiB document limit is plan_too_large (R21)", () => {
    const big = "x".repeat(600 * 1024);
    expect(
      parsePlanLayout([
        { path: "plan.md", content: "# P" },
        { path: "screens/manifest.json", content: manifest(["home", "feed"]) },
        { path: "screens/boards/home.html", content: big },
        { path: "screens/boards/feed.html", content: big },
      ]),
    ).toEqual({ ok: false, error: "plan_too_large" });
  });
});
