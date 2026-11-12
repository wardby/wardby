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

const XLINK_NS = "http://www.w3.org/1999/xlink";

export type FrameMode = "play" | "overview";

export function frameHtml(boardHtml: string, mode: FrameMode, boardIds: ReadonlySet<string>): string {
  const dom = new JSDOM(boardHtml, { virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    for (const a of Array.from(doc.querySelectorAll("a, area"))) {
      // An SVG link may carry its target as xlink:href; it counts as the link's href (same rule).
      const href = a.getAttribute("href") ?? a.getAttributeNS(XLINK_NS, "href") ?? "";
      const m = BOARD_LINK.exec(href);
      a.removeAttribute("target");
      a.removeAttributeNS(XLINK_NS, "href");
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

/** One board of a version as frame HTML (see frameHtml). */
export interface FramedBoard {
  id: string;
  name: string;
  width: number;
  html: string;
}

/** Most versions and the most frame HTML (UTF-16 code units, about bytes for ASCII boards) kept. */
export const FRAME_CACHE_MAX_ENTRIES = 32;
export const FRAME_CACHE_MAX_CHARS = 16 * 1024 * 1024;

/**
 * A small in-process LRU of a version's frame HTML per mode. Versions are immutable, so an entry
 * never goes stale; it only saves re-parsing every board with jsdom on each Play, Overview or
 * prototype request (share-readable, so anyone with a view link can repeat them). Callers check
 * access before they ask; the entries are the stored, already redacted boards with links rewritten.
 */
const frameCache = new Map<string, { boards: readonly FramedBoard[]; chars: number }>();
let frameCacheChars = 0;

/** For tests: empties the cache. */
export function clearFrameCache(): void {
  frameCache.clear();
  frameCacheChars = 0;
}

/** For tests: the number of versions and modes cached. */
export const frameCacheSize = (): number => frameCache.size;

/**
 * Every board of version `versionId` (manifest order, boards whose file is missing left out) as
 * frame HTML in `mode`, from the cache when this version and mode were framed before.
 */
export function versionFrames(
  versionId: string,
  mode: FrameMode,
  boards: readonly { id: string; name: string; width: number; file: string }[],
  files: Readonly<Record<string, string>>,
): readonly FramedBoard[] {
  const key = `${mode}\u0000${versionId}`;
  const hit = frameCache.get(key);
  if (hit) {
    // Most recently used goes last.
    frameCache.delete(key);
    frameCache.set(key, hit);
    return hit.boards;
  }
  const ids = new Set(boards.map((b) => b.id));
  const framed: readonly FramedBoard[] = Object.freeze(
    boards
      .filter((b) => typeof files[b.file] === "string")
      .map((b) => Object.freeze({ id: b.id, name: b.name, width: b.width, html: frameHtml(files[b.file], mode, ids) })),
  );
  const chars = framed.reduce((n, b) => n + b.html.length, 0);
  if (chars > FRAME_CACHE_MAX_CHARS) return framed;
  frameCache.set(key, { boards: framed, chars });
  frameCacheChars += chars;
  for (const [k, v] of frameCache) {
    if (frameCache.size <= FRAME_CACHE_MAX_ENTRIES && frameCacheChars <= FRAME_CACHE_MAX_CHARS) break;
    frameCache.delete(k);
    frameCacheChars -= v.chars;
  }
  return framed;
}
