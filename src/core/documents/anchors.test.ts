import { describe, expect, it } from "vitest";
import { locateAnchor, parseTextAnchor } from "./anchors.js";

const text = "Warm, plain-spoken, a little poetic without trying hard. We write like we talk.";

describe("text anchors", () => {
  it("finds the quote using its context", () => {
    const a = parseTextAnchor({ type: "text", quote: "a little poetic", prefix: "plain-spoken, ", suffix: " without" });
    expect(locateAnchor(text, a)).toEqual({ start: 20, end: 35 });
  });

  it("prefers the occurrence whose context matches", () => {
    const t = "the menu. Read the menu now.";
    const a = parseTextAnchor({ type: "text", quote: "the menu", prefix: "Read ", suffix: " now" });
    expect(locateAnchor(t, a)).toEqual({ start: 15, end: 23 });
  });

  it("returns null when the quote is gone", () => {
    expect(
      locateAnchor("nothing here", parseTextAnchor({ type: "text", quote: "poetic", prefix: "", suffix: "" })),
    ).toBeNull();
  });

  it("rejects oversized or empty quotes", () => {
    expect(() => parseTextAnchor({ type: "text", quote: "", prefix: "", suffix: "" })).toThrow(
      "comment_anchor_invalid",
    );
    expect(() => parseTextAnchor({ type: "text", quote: "x".repeat(501), prefix: "", suffix: "" })).toThrow(
      "comment_anchor_invalid",
    );
  });
});
