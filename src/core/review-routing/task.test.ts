import { describe, expect, it } from "vitest";
import { routerTask } from "./task.js";

describe("routerTask", () => {
  it("states the action, the choice, the person and their note", () => {
    const text = routerTask({
      action: "option_chosen",
      subject: { kind: "set", title: "Concepts" },
      versions: [3],
      documents: [
        { id: "doc-b", label: "concept-b" },
        { id: "doc-a", label: "concept-a" },
      ],
      chosen: { option: "concept-b", rejected: ["concept-a", "concept-c"] },
      byName: "Ann Lead",
      note: "Start with subscriptions.",
      builderStarted: false,
    });
    expect(text).toContain("Review action: option chosen on Concepts (version 3).");
    expect(text.split("\n")[1]).toBe("Documents: doc-b (concept-b), doc-a (concept-a).");
    expect(text).toContain('Option "concept-b" was chosen; concept-a, concept-c were rejected.');
    expect(text).toContain("By: Ann Lead.");
    expect(text).toContain('Note from Ann Lead: "Start with subscriptions."');
    expect(text).toContain("You may start only your attached agents. Do nothing if nothing is needed.");
    expect(text).not.toContain("builder");
  });
  it("says when a plan's builder already started, and leaves out a missing note", () => {
    const text = routerTask({
      action: "approved",
      subject: { kind: "set", title: "Plan 12" },
      versions: [2, 1],
      documents: [{ id: "doc-1", label: null }],
      byName: null,
      note: null,
      builderStarted: true,
    });
    expect(text).toContain("(versions 2, 1)");
    expect(text).toContain("Documents: doc-1.");
    expect(text).toContain("The builder for this plan was already started.");
    expect(text).not.toContain("Note from");
    expect(text).toContain("By: an agent.");
  });
});
