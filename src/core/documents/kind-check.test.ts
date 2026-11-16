import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { kindWarnings, measureHtml } from "./kind-check.js";

const board = (id: string) =>
  readFileSync(new URL(`./boards/fixtures/coffee/boards/${id}.html`, import.meta.url), "utf8");

describe("kind check", () => {
  it("measures the coffee boards as designs", () => {
    const m = measureHtml(board("home"));
    expect(m.styledShare).toBeGreaterThan(0.5);
    expect(m.layout).toBe(true);
    expect(kindWarnings("design", { boards: ["home", "menu"].map(board) })).toEqual([]);
  });
  it("warns when every board reads like prose", () => {
    const prose = `<!doctype html><html><body>${"<p>Plain paragraph of text that goes on.</p>".repeat(20)}</body></html>`;
    expect(kindWarnings("design", { boards: [prose] })[0]?.kind).toBe("kind");
  });
  it("still warns for prose with only bare type-selector typography CSS", () => {
    const prose = `<!doctype html><html><head><style>body,p,h1,li,*{font:16px serif}</style></head><body>${"<p>Plain paragraph of text that goes on.</p>".repeat(20)}</body></html>`;
    expect(measureHtml(prose).styledShare).toBeLessThan(0.1);
    expect(kindWarnings("design", { boards: [prose] })[0]?.kind).toBe("kind");
  });
  it("warns when Markdown carries page layout", () => {
    const w = kindWarnings("document", { markdown: '# A\n\n<div style="display:flex"><div>a</div><div>b</div></div>' });
    expect(w[0]).toMatchObject({ kind: "kind", message: expect.stringMatching(/save it as a design/) });
    expect(kindWarnings("document", { markdown: "# Plain\n\nText." })).toEqual([]);
  });
});
