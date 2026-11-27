/** The design format's repairs on the live server (no database): two people moving one element at once. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { BOARD_ROOT, boardMaps, F } from "../../../core/documents/boards/live/model.js";
import { writeBoard } from "../../../core/documents/boards/live/writer.js";
import { mergeManifest } from "../../../core/documents/boards/live/design-doc.js";
import { keepLaterMoves } from "./boards.js";

/** A board: root > [a, b], a > [x]; a, b and x are divs. */
function board(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const { nodes } = boardMaps(doc, "home");
    const el = (id: string, children: string[]) => {
      const n = new Y.Map<unknown>();
      nodes.set(id, n);
      n.set(F.tag, "div");
      const ch = new Y.Array<string>();
      ch.push(children);
      n.set(F.children, ch);
    };
    el(BOARD_ROOT, ["a", "b"]);
    el("a", ["x"]);
    el("b", []);
    el("x", []);
  });
  return doc;
}
const childrenOf = (doc: Y.Doc, id: string) =>
  (boardMaps(doc, "home").nodes.get(id)!.get(F.children) as Y.Array<string>).toArray();
const move = (doc: Y.Doc, id: string, from: string, to: string) =>
  doc.transact(() => {
    const src = boardMaps(doc, "home").nodes.get(from)!.get(F.children) as Y.Array<string>;
    src.delete(src.toArray().indexOf(id), 1);
    (boardMaps(doc, "home").nodes.get(to)!.get(F.children) as Y.Array<string>).push([id]);
  });

describe("two moves of one element at the same moment", () => {
  it("leave it once, where the later move put it", () => {
    const server = board();
    const fromPage = { source: "connection" };
    server.getMap<unknown>("boards").observeDeep((events, tr) => {
      if ((tr.origin as { source?: unknown } | null)?.source === "connection")
        keepLaterMoves(server, events as Y.YEvent<Y.AbstractType<unknown>>[]);
    });
    const [ann, bo] = [new Y.Doc(), new Y.Doc()];
    for (const d of [ann, bo]) Y.applyUpdate(d, Y.encodeStateAsUpdate(server));
    // Ann moves x into b; Bo, at the same moment, moves x to the root.
    move(ann, "x", "a", "b");
    move(bo, "x", "a", BOARD_ROOT);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(ann, Y.encodeStateVector(server)), fromPage);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(bo, Y.encodeStateVector(server)), fromPage);
    expect(childrenOf(server, "b")).toEqual([]);
    expect(childrenOf(server, BOARD_ROOT)).toEqual(["a", "b", "x"]);
    expect(childrenOf(server, "a")).toEqual([]);
    // Every page gets the repair.
    for (const d of [ann, bo]) {
      Y.applyUpdate(d, Y.encodeStateAsUpdate(server));
      expect(childrenOf(d, "b")).toEqual([]);
      expect(childrenOf(d, BOARD_ROOT)).toEqual(["a", "b", "x"]);
    }
  });

  it("a moved element left in two places, or two elements inside each other, is written once", () => {
    const doc = board();
    doc.transact(() => (boardMaps(doc, "home").nodes.get("b")!.get(F.children) as Y.Array<string>).push(["x"]));
    expect(writeBoard(boardMaps(doc, "home")).body).toBe("<div><div></div></div><div></div>");
    // a inside x inside a (each person moved one into the other): written once, without looping.
    doc.transact(() => (boardMaps(doc, "home").nodes.get("x")!.get(F.children) as Y.Array<string>).push(["a"]));
    expect(writeBoard(boardMaps(doc, "home")).body).toBe("<div><div></div></div><div></div>");
  });
});

describe("the board list after an agent's version", () => {
  const m = (title: string, ...boards: [string, string][]) => ({
    title,
    boards: boards.map(([id, name]) => ({ id, name, file: `boards/${id}.html`, width: 1280 })),
  });
  it("takes the version's renames, additions and removals, and keeps boards added and renamed meanwhile", () => {
    const before = m("Coffee", ["home", "Home"], ["menu", "Menu"], ["about", "About"]);
    const next = m("Coffee", ["home", "Home"], ["menu", "Our menu"], ["visit", "Visit"]);
    const now = m("Coffee shop", ["home", "Start"], ["menu", "Menu"], ["about", "About"], ["events", "Events"]);
    expect(mergeManifest(before, next, now)).toEqual(
      m("Coffee shop", ["home", "Start"], ["menu", "Our menu"], ["visit", "Visit"], ["events", "Events"]),
    );
  });
});
