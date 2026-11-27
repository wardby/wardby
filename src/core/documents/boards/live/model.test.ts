import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BOARD_ROOT, boardMaps, manifestOf, orderedPairs } from "./model.js";

describe("live copy model", () => {
  it("keeps each board's maps under boards/<id>, created once", () => {
    const doc = new Y.Doc();
    const a = boardMaps(doc, "home");
    const b = boardMaps(doc, "home");
    expect(a.nodes).toBe(b.nodes);
    expect(boardMaps(doc, "menu").nodes).not.toBe(a.nodes);
    expect([...doc.getMap("boards").keys()].sort()).toEqual(["home", "menu"]);
    expect(BOARD_ROOT).toBe("root");
  });

  it("reads ordered pairs in key order, skips listed keys the map lacks, and keeps unlisted ones at the end", () => {
    const doc = new Y.Doc();
    const m = doc.getMap<string>("m");
    const k = doc.getArray<string>("k");
    doc.transact(() => {
      m.set("b", "2");
      m.set("a", "1");
      m.set("c", "3");
      k.push(["a", "gone", "b", "a"]);
    });
    expect(orderedPairs(m, k)).toEqual([
      ["a", "1"],
      ["b", "2"],
      ["c", "3"],
    ]);
    expect(orderedPairs(undefined, k)).toEqual([]);
  });

  it("has one manifest array", () => {
    const doc = new Y.Doc();
    expect(manifestOf(doc)).toBe(manifestOf(doc));
  });
});
