import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { LIVE_FIELD, liveDocToMarkdown, markdownToDoc, normalMarkdown, seedLiveDoc } from "./markdown.js";

const SOURCE = `# Launch plan

The launch happens in March. We ship the mobile app first.

- The app store review may be slow.
- Support needs training.

| Owner | Task |
| --- | --- |
| Ann | Pricing page |

See [the brief](https://example.com/brief) for details.

\`\`\`ts
const launch = "march";
\`\`\`
`;

describe("live Markdown conversions", () => {
  it("a seeded live document reads back as the editor's form of the source", () => {
    expect(normalMarkdown(liveDocToMarkdown(seedLiveDoc(SOURCE)))).toBe(normalMarkdown(SOURCE));
  });

  it("puts the content in the fragment Tiptap's Collaboration extension reads", () => {
    expect(seedLiveDoc(SOURCE).getXmlFragment(LIVE_FIELD).length).toBeGreaterThan(0);
  });

  it("normalMarkdown ignores formatting-only differences and keeps text differences", () => {
    const padded = SOURCE.replace("| Ann | Pricing page |", "| Ann   | Pricing page  |").replace(
      "| --- | --- |",
      "| ----- | ------------- |",
    );
    expect(normalMarkdown(padded)).toBe(normalMarkdown(SOURCE));
    // Normalising is stable: the editor's form of its own form is itself.
    expect(normalMarkdown(normalMarkdown(SOURCE))).toBe(normalMarkdown(SOURCE));
    expect(normalMarkdown(SOURCE.replace("March", "April"))).not.toBe(normalMarkdown(SOURCE));
  });

  it("markdownToDoc parses into the shared schema", () => {
    const doc = markdownToDoc(SOURCE);
    expect(doc.type.name).toBe("doc");
    expect(doc.textContent).toContain("Pricing page");
  });

  it("an empty document round-trips", () => {
    expect(liveDocToMarkdown(seedLiveDoc("")).trim()).toBe("");
    expect(new Y.Doc().getXmlFragment(LIVE_FIELD).length).toBe(0);
  });
});
