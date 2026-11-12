import { describe, expect, it } from "vitest";
import {
  ago,
  describeRow,
  diffMarks,
  GROUP_WINDOW_MS,
  groupVersions,
  parseMarkdown,
  plainOf,
  restoredFrom,
  type VersionItem,
} from "./history.js";

const T0 = Date.parse("2026-11-12T10:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();
const member = (name: string) => ({ kind: "member" as const, name });
function v(number: number, min: number, extra: Partial<VersionItem> = {}): VersionItem {
  return { number, via: "editor", createdAt: at(min), author: member("Chris Fields"), answeredThreads: [], ...extra };
}
const shape = (rows: ReturnType<typeof groupVersions>) => rows.map((r) => [r.first, r.last]);

describe("groupVersions", () => {
  it("groups consecutive editor saves by the same person within the window", () => {
    const list = [v(5, 9), v(4, 6), v(3, 2), v(2, 1)];
    expect(shape(groupVersions(list))).toEqual([[2, 5]]);
  });

  it("splits when the gap to the previous save is over the window", () => {
    expect(shape(groupVersions([v(3, 20), v(2, 14), v(1, 0)]))).toEqual([
      [3, 3],
      [2, 2],
      [1, 1],
    ]);
    expect(shape(groupVersions([v(2, 5), v(1, 0)]))).toEqual([[1, 2]]);
    expect(GROUP_WINDOW_MS).toBe(5 * 60 * 1000);
  });

  it("never groups agent, MCP, import or restore versions, or different people", () => {
    const agent = v(6, 5, { via: "agent", author: { kind: "agent", name: "Agent", viaName: "Chris Fields" } });
    const mcp = v(4, 3, { via: "mcp" });
    const restore = v(3, 2, { summary: "Restored v1" });
    const other = v(2, 1, { author: member("Robin") });
    const rows = groupVersions([v(7, 6), agent, v(5, 4), mcp, restore, other, v(1, 0)]);
    expect(shape(rows)).toEqual([
      [7, 7],
      [6, 6],
      [5, 5],
      [4, 4],
      [3, 3],
      [2, 2],
      [1, 1],
    ]);
  });
});

describe("describeRow", () => {
  const one = (x: VersionItem) => ({ first: x.number, last: x.number, items: [x] });

  it("labels editor, grouped, created, MCP, agent and restore rows", () => {
    expect(describeRow({ first: 4, last: 5, items: [v(5, 1), v(4, 0)] })).toEqual({
      versions: "v4–v5",
      parts: ["Chris Fields", "2 edits"],
    });
    expect(describeRow(one(v(1, 0, { via: "mcp" })))).toEqual({
      versions: "v1",
      parts: ["Created by Chris Fields (MCP)"],
    });
    expect(describeRow(one(v(3, 0)))).toEqual({ versions: "v3", parts: ["Chris Fields"] });
    expect(
      describeRow(one(v(3, 0, { via: "agent", author: { kind: "agent", name: "Agent", viaName: "Chris Fields" } }))),
    ).toEqual({ versions: "v3", parts: ["Agent", "via Chris Fields"] });
    expect(describeRow(one(v(3, 0, { via: "agent", author: { kind: "agent", name: "Agent" } })))).toEqual({
      versions: "v3",
      parts: ["Agent"],
    });
    expect(describeRow(one(v(6, 0, { summary: "Restored v3" })))).toEqual({
      versions: "v6",
      parts: ["Restored v3", "Chris Fields"],
    });
    expect(restoredFrom(v(6, 0, { summary: "Restored v3 and more" }))).toBeNull();
  });

  it("says how long ago", () => {
    expect(ago(at(0), T0 + 10_000)).toBe("just now");
    expect(ago(at(0), T0 + 2 * 60_000)).toBe("2 min ago");
    expect(ago(at(0), T0 + 3 * 3600_000)).toBe("3 h ago");
    expect(ago(at(0), T0 + 30 * 86400_000)).toBe("2026-11-12");
  });
});

describe("diffMarks", () => {
  /** The highlighted text and the deletion widgets, read back from the document. */
  function marks(beforeMd: string, afterMd: string) {
    const doc = parseMarkdown(afterMd);
    const m = diffMarks(doc, plainOf(parseMarkdown(beforeMd)));
    return {
      inserted: m.inserts.map((r) => doc.textBetween(r.from, r.to, "\n")),
      deleted: m.deletes.map((d) => ({ text: d.text, before: doc.textBetween(0, d.pos, "\n").slice(-6) })),
    };
  }

  it("marks nothing when the text is the same", () => {
    expect(marks("Same **text**", "Same text")).toEqual({ inserted: [], deleted: [] });
  });

  it("highlights an insert inside a block", () => {
    expect(marks("The quick fox.", "The quick brown fox.")).toEqual({ inserted: ["brown "], deleted: [] });
  });

  it("shows a delete at the deletion point", () => {
    expect(marks("The quick brown fox.", "The brown fox.")).toEqual({
      inserted: [],
      deleted: [{ text: "quick", before: "The " }],
    });
  });

  it("shows a replace as a delete and an insert", () => {
    const m = marks("Ship on Monday please.", "Ship on Friday please.");
    expect(m.inserted).toEqual(["Friday"]);
    expect(m.deleted).toEqual([{ text: "Monday", before: "ip on " }]);
  });

  it("highlights a new block (heading, list item) as inserted text", () => {
    const m = marks("# Plan\n\n- one\n- two", "# Plan\n\n## Goals\n\n- one\n- one and a half\n- two");
    expect(m.inserted).toEqual(["Goals", "one and a half"]);
    expect(m.deleted).toEqual([]);
  });

  it("highlights an insert that spans blocks once per block", () => {
    const m = marks("Start.\n\nEnd.", "Start. More here.\n\nAnd a new para.\n\nEnd.");
    expect(m.inserted).toEqual([" More here.", "And a new para."]);
  });

  it("shows a deleted block at the start of the block after it", () => {
    const m = marks("First.\n\nGone para.\n\nLast.", "First.\n\nLast.");
    expect(m.inserted).toEqual([]);
    expect(m.deleted).toHaveLength(1);
    expect(m.deleted[0].text).toContain("Gone para.");
    expect(m.deleted[0].before).toBe("irst.\n");
    const doc = parseMarkdown("First.\n\nLast.");
    const pos = diffMarks(doc, "First.\nGone para.\nLast.").deletes[0].pos;
    expect(doc.resolve(pos).parent.textContent).toBe("Last.");
  });

  it("shows a delete at the start of the document", () => {
    const m = marks("Intro words. Body.", "Body.");
    expect(m.deleted).toEqual([{ text: "Intro words.", before: "" }]);
  });

  it("handles an emptied document", () => {
    const doc = parseMarkdown("");
    const m = diffMarks(doc, "Everything gone");
    expect(m.inserts).toEqual([]);
    expect(m.deletes).toEqual([{ pos: Math.min(1, doc.content.size), text: "Everything gone" }]);
  });
});
