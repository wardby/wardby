/** Test support for live designs: the coffee fixture and a scripted builder (what a page does with GrapesJS). */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import * as Y from "yjs";
import { putNodes, nodesFromHtml } from "../../core/documents/boards/live/elements.js";
import { BOARD_ROOT, boardMaps, F } from "../../core/documents/boards/live/model.js";

export const coffee = (p: string) =>
  readFileSync(new URL(`../../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
export const coffeeFiles = (): Record<string, string> => ({
  "manifest.json": coffee("manifest.json"),
  ...Object.fromEntries(
    ["home", "menu", "about", "visit"].map((id) => [`boards/${id}.html`, coffee(`boards/${id}.html`)]),
  ),
});

/** What a builder page does: the board's live copy from its file (GrapesJS in the page; Part 1's rules here). */
export function buildBoard(ydoc: Y.Doc, board: string, file: string): void {
  const dom = new JSDOM(file).window.document;
  const baseCss = Array.from(dom.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n");
  for (const s of Array.from(dom.querySelectorAll("style"))) s.remove();
  let n = 0;
  const parsed = nodesFromHtml(dom.body.innerHTML.replace(/\s+$/, ""), () => `ib${board}${++n}`);
  ydoc.transact(() => {
    const maps = boardMaps(ydoc, board);
    const root = new Y.Map<unknown>();
    maps.nodes.set(BOARD_ROOT, root);
    root.set(F.gid, "wrapper");
    const ch = new Y.Array<string>();
    ch.push(parsed.roots);
    root.set(F.children, ch);
    putNodes(maps, parsed);
    maps.meta.set("baseCss", baseCss);
    maps.meta.set("parts", JSON.stringify({ lang: dom.documentElement.lang || "en", title: dom.title, bodyAttrs: {} }));
  });
}
