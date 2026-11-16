import { describe, expect, it } from "vitest";
import { markdownPrintFile, markdownToSafeHtml } from "./markdown-export.js";

describe("markdown print file", () => {
  it("renders headings and drops scripts, handlers and external references", () => {
    const { html, droppedImages } = markdownToSafeHtml(
      '# Plan\n\nText <script>alert(1)</script> <img src="https://evil.example/x.png" onerror="x()">\n\n[a](javascript:alert(1))',
    );
    const file = markdownPrintFile("A <b> title", html);
    expect(file).toContain("<h1");
    expect(file).toContain("Plan");
    expect(file).not.toContain("<script");
    expect(file).not.toContain("onerror");
    expect(file).not.toMatch(/https?:/);
    expect(file).not.toContain("javascript:");
    expect(file).toContain("<title>A &lt;b&gt; title</title>");
    expect(droppedImages).toBeGreaterThanOrEqual(1);
  });
});
