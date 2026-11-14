import { describe, expect, it } from "vitest";
import { designAgentFormat, markdownAgentFormat } from "./agent-formats.js";

const d = (files: Record<string, string>) => ({ format: "boards-v1" as const, files });
const board = (h1: string) => `<main>\n<h1>${h1}</h1>\n${"<p>same</p>\n".repeat(50)}</main>\n`;

describe("the agent's earlier edit for a reconcile run", () => {
  const base = d({ "manifest.json": "{}\n", "boards/home.html": board("Big Fern"), "boards/menu.html": board("Menu") });
  const ours = d({
    "manifest.json": "{}\n",
    "boards/home.html": board("Little Fern"),
    "boards/new.html": "<p>new</p>\n",
  });

  it("a design's diff form holds a diff per changed or added file, and lists deletions", () => {
    const whole = designAgentFormat.earlierEdit({ path: "site" }, base, ours, 4);
    const diff = designAgentFormat.earlierEdit({ path: "site" }, base, ours, 4, "diff");
    expect(whole.form).toBe("files");
    expect(diff).toMatchObject({
      form: "diff",
      heading: "YOUR EARLIER EDIT AS A DIFF (made against version 4):",
      files: { changed: ["site/boards/home.html", "site/boards/new.html"], deleted: ["site/boards/menu.html"] },
    });
    expect(diff.body).toContain("-<h1>Big Fern</h1>\n+<h1>Little Fern</h1>\n");
    expect(diff.body).toContain("@@ -0,0 +1,1 @@\n+<p>new</p>\n");
    expect(diff.body.length).toBeLessThan(whole.body.length / 2);
    // The trusted instructions say the sections are diffs and how to read them.
    const context = { heading: "H", body: "", files: { marker: "M", write: [], delete: [] } };
    const text = designAgentFormat.reconcileInstructions({ path: "site", baseRef: "main" }, 5, [1], context, diff);
    expect(text).toContain("each as a unified diff against the file in the version you started from");
    expect(text).toMatch(/unified format/);
    expect(
      designAgentFormat.reconcileInstructions({ path: "site", baseRef: "main" }, 5, [1], context as never, whole),
    ).not.toMatch(/unified/);
  });

  it("a Markdown diff form is a diff of the document; whole is the edited document", () => {
    const md = (markdown: string) => ({ format: "markdown" as const, markdown });
    const diff = markdownAgentFormat.earlierEdit({ path: "a.md" }, md("a\nb\nc\n"), md("a\nB\nc\n"), 2, "diff");
    expect(diff.body).toBe("@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n");
    expect(markdownAgentFormat.earlierEdit({ path: "a.md" }, md("a\n"), md("A\n"), 2).body).toBe("A\n");
  });
});
