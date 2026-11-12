/**
 * Boards as shown in Play, Overview and the prototype export (spec "Play"; ruling D5): sandboxed
 * srcdoc frames with no script and no same-origin access. A link to another board becomes
 * `href="#board-<id>" target="_top"`, which (with allow-top-navigation-by-user-activation) only
 * changes the parent page's fragment; every other href is removed so a board can never navigate
 * the app away. Overview keeps no links at all. The input is a stored board, already sanitised
 * and redacted when it was written; this only rewrites links.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { BOARD_ID } from "./ids.js";

/** `#board:<id>`, the id by the board-id pattern (ids.ts). */
const BOARD_LINK = new RegExp(`^#board:(${BOARD_ID.source.replace(/^\^|\$$/g, "")})$`);

export type FrameMode = "play" | "overview";

export function frameHtml(boardHtml: string, mode: FrameMode, boardIds: ReadonlySet<string>): string {
  const dom = new JSDOM(boardHtml, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    for (const a of Array.from(doc.querySelectorAll("a, area"))) {
      const m = BOARD_LINK.exec(a.getAttribute("href") ?? "");
      a.removeAttribute("target");
      if (mode === "play" && m && boardIds.has(m[1])) {
        a.setAttribute("href", `#board-${m[1]}`);
        a.setAttribute("target", "_top");
      } else {
        a.removeAttribute("href");
      }
    }
    return dom.serialize();
  } finally {
    dom.window.close();
  }
}
