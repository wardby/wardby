/** Shared lists (children, rule order, property and attribute order): a page applies only its own changes. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { mergeList } from "./read.js";

const list = (items: string[]) => {
  const doc = new Y.Doc();
  const a = doc.getArray<string>("l");
  a.push(items);
  return a;
};

describe("mergeList", () => {
  it("adds this page's new item and keeps one someone else added meanwhile", () => {
    const a = list(["a", "b", "X", "c"]);
    expect(mergeList(a, ["a", "b", "c"], ["a", "b", "c", "D"])).toBe(true);
    expect(a.toArray()).toEqual(["a", "b", "X", "c", "D"]);
  });

  it("removes only what this page removed", () => {
    const a = list(["a", "b", "X", "c"]);
    mergeList(a, ["a", "b", "c"], ["a", "c"]);
    expect(a.toArray()).toEqual(["a", "X", "c"]);
  });

  it("moves what this page moved, leaving someone else's addition", () => {
    const a = list(["a", "b", "X", "c"]);
    mergeList(a, ["a", "b", "c"], ["c", "a", "b"]);
    expect(a.toArray()).toEqual(["c", "a", "b", "X"]);
  });

  it("a duplicate placed after its original lands after it, wherever the original is now", () => {
    const a = list(["X", "a", "b", "c"]);
    mergeList(a, ["a", "b", "c"], ["a", "b", "b2", "c"]);
    expect(a.toArray()).toEqual(["X", "a", "b", "b2", "c"]);
  });

  it("without a base, the list becomes this page's", () => {
    const a = list(["a", "b"]);
    mergeList(a, undefined, ["b", "c"]);
    expect(a.toArray()).toEqual(["b", "c"]);
  });

  it("two pages changing one list at once both keep their changes", () => {
    const one = new Y.Doc();
    one.getArray<string>("l").push(["p1", "p2", "p3"]);
    const two = new Y.Doc();
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    // Ann duplicates p1 (her view: p1 p1c p2 p3); Bo duplicates p3 (p1 p2 p3 p3c), at the same moment.
    mergeList(one.getArray<string>("l"), ["p1", "p2", "p3"], ["p1", "p1c", "p2", "p3"]);
    mergeList(two.getArray<string>("l"), ["p1", "p2", "p3"], ["p1", "p2", "p3", "p3c"]);
    Y.applyUpdate(one, Y.encodeStateAsUpdate(two));
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    for (const d of [one, two]) expect(d.getArray<string>("l").toArray()).toEqual(["p1", "p1c", "p2", "p3", "p3c"]);
    // Then Ann, whose page has not shown Bo's copy yet, adds another: Bo's copy stays.
    mergeList(one.getArray<string>("l"), ["p1", "p1c", "p2", "p3"], ["p1", "p1c", "p2", "p2c", "p3"]);
    expect(one.getArray<string>("l").toArray()).toEqual(["p1", "p1c", "p2", "p2c", "p3", "p3c"]);
  });
});
