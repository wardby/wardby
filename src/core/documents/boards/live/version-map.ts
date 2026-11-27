/**
 * The version map (spec "Agent and MCP publishes merge as diffs", step 1): a version written from the live copy
 * says, spot by spot, which live element wrote it (the writer's `spots`). Parsing that version's body and walking
 * it the same way gives every element (and text) its live id, so an agent's change to "paragraph 3 of version 7"
 * lands on that paragraph in the live copy. The map is derived from the stored version state, never stored.
 */
import type { DomElement, DomNode } from "jsdom";
import * as Y from "yjs";
import { boardMaps } from "./model.js";
import { writeBoard, type Spot } from "./writer.js";

/**
 * Maps each element and text node of `body` (a parsed body the writer produced from `spots`) to its live id,
 * walking as the writer wrote: pre-order, not inside text boxes, empty text and comments skipped (and whitespace
 * between elements the live copy did not keep, so a board's original file maps too). Throws
 * `version_map_mismatch` when the body is not what the spots say was written.
 */
export function mapBase(body: DomElement, spots: Spot[]): Map<DomNode, string> {
  const map = new Map<DomNode, string>();
  let i = 0;
  const mismatch = () => new Error("version_map_mismatch");
  const walk = (parent: DomNode) => {
    for (const n of Array.from(parent.childNodes)) {
      if (n.nodeType === 3) {
        if (!n.textContent) continue;
        // Whitespace between elements in a file as written by hand or by an agent: the editor keeps none of it, so
        // the live copy has no spot for it (a version written from the live copy has none to skip).
        if (!n.textContent.trim() && spots[i]?.kind !== "text") continue;
        const spot = spots[i++];
        if (spot?.kind !== "text") throw mismatch();
        map.set(n, spot.id);
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as DomElement;
      const spot = spots[i++];
      if (!spot || spot.kind === "text" || spot.tag?.toLowerCase() !== el.localName.toLowerCase()) throw mismatch();
      map.set(el, spot.id);
      if (spot.kind === "el") walk(el);
    }
  };
  walk(body);
  if (i !== spots.length) throw mismatch();
  return map;
}

/** The spots of a board in a stored version state (the live copy as it was when that version was written). */
export function spotsFromState(update: Uint8Array, boardId: string): Spot[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  return writeBoard(boardMaps(doc, boardId)).spots;
}
