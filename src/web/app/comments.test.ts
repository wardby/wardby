import { describe, expect, it } from "vitest";
import {
  candidateFrom,
  decodeMentions,
  encodeMentions,
  initials,
  mentionQuery,
  previewText,
  relativeTime,
  snapToWords,
  stackBadges,
  tokenizeBody,
} from "./comments.js";

describe("snapToWords", () => {
  it("snaps a mid-word selection to whole words", () => {
    const t = "by the front window, and a weekend pastry menu that";
    expect(snapToWords(t, t.indexOf("ow,"), t.indexOf("menu") + 4)).toEqual({
      start: t.indexOf("window"),
      end: t.indexOf("menu") + 4,
    });
  });
  it("extends an end that stops inside a word", () => {
    const t = "a weekend pastry menu";
    expect(snapToWords(t, t.indexOf("weekend"), t.indexOf("pastry") + 3)).toEqual({
      start: t.indexOf("weekend"),
      end: t.indexOf("pastry") + 6,
    });
  });
  it("trims whitespace at either edge", () => {
    const t = "one two three";
    expect(snapToWords(t, 3, 8)).toEqual({ start: 4, end: 7 });
  });
  it("treats snake_case and non-ASCII letters as one word", () => {
    const t = "call foo_bar now; café open";
    expect(snapToWords(t, t.indexOf("_bar"), t.indexOf("_bar") + 2)).toEqual({
      start: t.indexOf("foo_bar"),
      end: t.indexOf("foo_bar") + 7,
    });
    expect(snapToWords(t, t.indexOf("afé"), t.indexOf("afé") + 1)).toEqual({
      start: t.indexOf("café"),
      end: t.indexOf("café") + 4,
    });
  });
  it("returns an empty range for a whitespace-only selection", () => {
    const r = snapToWords("a    b", 2, 4);
    expect(r.end - r.start).toBe(0);
  });
});

describe("previewText", () => {
  it("strips formatting markers for the panel preview", () => {
    expect(previewText("Make it **terracotta** and `bold`")).toBe("Make it terracotta and bold");
  });
  it("keeps snake_case, renders mentions by name and joins lines", () => {
    const names = new Map([["p1", "Ana Ruiz"]]);
    expect(previewText("Ask @[p1] about _this_\nand foo_bar", names)).toBe("Ask @Ana Ruiz about this and foo_bar");
  });
  it("shows an unknown mention as @member", () => {
    expect(previewText("cc @[gone]")).toBe("cc @member");
  });
});

describe("stackBadges", () => {
  it("stacks badges that would overlap", () => {
    expect(stackBadges([100, 110, 300], 24)).toEqual([100, 124, 300]);
  });
  it("stacks in position order and returns the input order", () => {
    expect(stackBadges([110, 100, 105], 24)).toEqual([148, 100, 124]);
  });
  it("handles an empty list", () => {
    expect(stackBadges([], 24)).toEqual([]);
  });
});

describe("tokenizeBody", () => {
  it("splits bold, italic, code, mentions and line breaks", () => {
    const names = new Map([["p1", "Ana"]]);
    expect(tokenizeBody("Hi @[p1], **now** *please*\nsee `a*b*c` and foo_bar", names)).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "mention", text: "@Ana" },
      { kind: "text", text: ", " },
      { kind: "bold", text: "now" },
      { kind: "text", text: " " },
      { kind: "italic", text: "please" },
      { kind: "br", text: "" },
      { kind: "text", text: "see " },
      { kind: "code", text: "a*b*c" },
      { kind: "text", text: " and foo_bar" },
    ]);
  });
  it("leaves markup characters as plain text (the renderer never parses HTML)", () => {
    expect(tokenizeBody("<img src=x onerror=alert(1)>")).toEqual([
      { kind: "text", text: "<img src=x onerror=alert(1)>" },
    ]);
  });
  it("supports _italic_ without breaking snake_case", () => {
    expect(tokenizeBody("an _idea_ in my_var")).toEqual([
      { kind: "text", text: "an " },
      { kind: "italic", text: "idea" },
      { kind: "text", text: " in my_var" },
    ]);
  });
});

describe("composer mentions", () => {
  const people = [
    { ref: "p1", name: "Ana Ruiz" },
    { ref: "p2", name: "Ana" },
  ];
  it("finds the @query before the caret", () => {
    expect(mentionQuery("hello @an", 9)).toEqual({ start: 6, query: "an" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail a@b", 8)).toBeNull();
    expect(mentionQuery("hello @an there", 15)).toBeNull();
  });
  it("encodes picked names as @[id], longest name first", () => {
    expect(encodeMentions("cc @Ana Ruiz and @Ana.", people)).toBe("cc @[p1] and @[p2].");
  });
  it("does not encode a picked name inside a longer word", () => {
    expect(encodeMentions("@Anatoly", people)).toBe("@Anatoly");
  });
  it("decodes ids to names for editing and keeps unknown ids", () => {
    const names = new Map([["p1", "Ana Ruiz"]]);
    expect(decodeMentions("cc @[p1] and @[zz]", names)).toEqual({
      text: "cc @Ana Ruiz and @[zz]",
      picked: [{ ref: "p1", name: "Ana Ruiz" }],
    });
  });
});

describe("guest mentions", () => {
  const names = new Map([
    ["p1", "Ana Ruiz"],
    ["guest:g1", "Tess (guest)"],
  ]);
  it("render both stored forms; a guest not on this document shows as @unknown", () => {
    expect(tokenizeBody("@[p1] @[guest:g1] @[guest:other] @[nobody]", names)).toEqual([
      { kind: "mention", text: "@Ana Ruiz" },
      { kind: "text", text: " " },
      { kind: "mention", text: "@Tess (guest)" },
      { kind: "text", text: " " },
      { kind: "mention", text: "@unknown" },
      { kind: "text", text: " " },
      { kind: "mention", text: "@member" },
    ]);
    expect(previewText("hi @[guest:g1]", names)).toBe("hi @Tess (guest)");
  });
  it("keeps a malformed guest ref as text", () => {
    expect(tokenizeBody("@[guest:] @[guest:bad id]", names)).toEqual([
      { kind: "text", text: "@[guest:] @[guest:bad id]" },
    ]);
  });
  it("encode and decode guests by ref", () => {
    const picked = [{ ref: "guest:g1", name: "Tess (guest)" }];
    expect(encodeMentions("thanks @Tess (guest)!", picked)).toBe("thanks @[guest:g1]!");
    expect(decodeMentions("thanks @[guest:g1] @[guest:zz]", names)).toEqual({
      text: "thanks @Tess (guest) @[guest:zz]",
      picked,
    });
  });
  it("maps /mentions entries to candidates", () => {
    expect(candidateFrom({ principalId: "p1", name: "Ana" })).toEqual({ ref: "p1", name: "Ana" });
    expect(candidateFrom({ guestId: "g1", name: "Tess" })).toEqual({ ref: "guest:g1", name: "Tess (guest)" });
    expect(candidateFrom({ name: "x" })).toBeNull();
  });
});

describe("small formatters", () => {
  it("initials", () => {
    expect(initials("Ana Ruiz")).toBe("AR");
    expect(initials("  bob ")).toBe("B");
    expect(initials("")).toBe("?");
  });
  it("relative time", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(relativeTime("2026-11-11T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-11-11T11:55:00Z", now)).toBe("5m");
    expect(relativeTime("2026-11-11T09:00:00Z", now)).toBe("3h");
    expect(relativeTime("2026-11-09T12:00:00Z", now)).toBe("2d");
  });
});
