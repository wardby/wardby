import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { putNodes, nodesFromHtml } from "./elements.js";
import { BOARD_ROOT, boardMaps, F } from "./model.js";
import { mapBase, spotsFromState } from "./version-map.js";
import { writeBoard } from "./writer.js";

function liveCopyOf(html: string) {
  let n = 0;
  const doc = new Y.Doc();
  const maps = boardMaps(doc, "home");
  const parsed = nodesFromHtml(html, () => `i${++n}x`);
  doc.transact(() => {
    const root = new Y.Map<unknown>();
    maps.nodes.set(BOARD_ROOT, root);
    const ch = new Y.Array<string>();
    ch.push(parsed.roots);
    root.set(F.children, ch);
    putNodes(maps, parsed);
  });
  return { doc, maps };
}

const HTML =
  '<header class="site"><nav><a href="#a">A</a> <a href="#b">B</a></nav></header>' +
  '<main><section id="menu"><h2>Menu</h2><p>Hi <b>there</b></p></section><svg viewBox="0 0 1 1"><path d="M0"></path></svg></main>';

describe("version map", () => {
  it("maps every written element and text back to the live element that wrote it, not inside text boxes", () => {
    const { maps } = liveCopyOf(HTML);
    const written = writeBoard(maps);
    const body = new JSDOM("").window.document.createElement("body");
    body.innerHTML = written.body;
    const map = mapBase(body, written.spots);
    const section = body.querySelector("#menu")!;
    expect(map.get(section)).toBe("menu");
    // A text box's insides are its HTML, not elements of their own.
    expect(map.has(body.querySelector("p b")!)).toBe(false);
    expect(map.has(body.querySelector("p")!)).toBe(true);
    // Every element outside text boxes has its live id.
    for (const el of Array.from(body.querySelectorAll("header, nav, main, section, h2, p, svg, path"))) {
      expect(maps.nodes.has(map.get(el)!)).toBe(true);
    }
  });

  it("refuses a body that is not what the spots say was written", () => {
    const { maps } = liveCopyOf(HTML);
    const written = writeBoard(maps);
    const b = new JSDOM("").window.document.createElement("body");
    b.innerHTML = written.body.replace("<h2>", "<h3>").replace("</h2>", "</h3>");
    expect(() => mapBase(b, written.spots)).toThrow("version_map_mismatch");
  });

  it("derives the spots from a stored version state (the map is never stored)", () => {
    const { doc, maps } = liveCopyOf(HTML);
    expect(spotsFromState(Y.encodeStateAsUpdate(doc), "home")).toEqual(writeBoard(maps).spots);
  });
});
