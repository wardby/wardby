/**
 * Element anchors for design comment pins (spec "Anchors": element id first, then the element
 * path and its first words, plus the point inside the element). dx/dy are fractions (0-1) of
 * the element's box, so a pin stays on its element at every device width. Pure DOM code: the
 * server re-anchors with jsdom on publish, the page places pins in the GrapesJS canvas, and
 * both locate with the same function. Paths are relative to an explicit root element (on the
 * server the document body, in the page the GrapesJS wrapper element). The browser bundle
 * imports this file: keep it free of Node and server-only imports.
 *
 * While a design is edited live, a pin also remembers its element's live id (`liveId`, never written into the
 * board's HTML): it follows that element through everyone's edits and agents' merges, and the server keeps the
 * path and words current from it, so the anchor still works for a page that is not live.
 */
import { z } from "zod";
import { BOARD_ID } from "./boards/ids.js";

export const MAX_ANCHOR_WORDS = 60;
const SEGMENT = "[a-z][a-z0-9-]{0,31}:nth-of-type\\(\\d{1,4}\\)";
const PATH = new RegExp(`^(?:body|${SEGMENT}(?:>${SEGMENT}){0,63})$`);
const ID_OK = /^[A-Za-z][\w-]{0,127}$/;
/** Ids GrapesJS generates for components it has to address (for example `i3kd`, `ix9a-2`). Only a fallback: when the stored file's ids are known they decide instead. */
export const GRAPES_GENERATED_ID = /^i[a-z0-9]{2,}(-\d+)?$/;

const schema = z
  .object({
    type: z.literal("element"),
    board: z.string().regex(BOARD_ID),
    elementId: z.string().regex(ID_OK).optional(),
    liveId: z.string().regex(ID_OK).optional(),
    path: z.string().max(2048).regex(PATH),
    tag: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    words: z.string().max(MAX_ANCHOR_WORDS),
    dx: z.number().min(0).max(1),
    dy: z.number().min(0).max(1),
  })
  .strict();

export type ElementAnchor = z.infer<typeof schema>;

export function parseElementAnchor(value: unknown): ElementAnchor {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error("comment_anchor_invalid");
  return r.data;
}

export interface ElementLike {
  readonly tagName: string;
  readonly id: string;
  readonly textContent: string | null;
  readonly parentElement: ElementLike | null;
  readonly children: ArrayLike<ElementLike>;
  readonly namespaceURI: string | null;
  querySelectorAll(selectors: string): ArrayLike<ElementLike>;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const norm = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
const tagOf = (el: ElementLike) => el.tagName.toLowerCase();

/** Clamp a pin fraction into 0-1 (non-finite becomes 0). The one clamp for server and page. */
export const clamp01 = (n: number): number => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** Where a pin attaches: an element inside an <svg> attaches to the outermost <svg>. */
export function anchorTarget(el: ElementLike): ElementLike {
  let svg: ElementLike | null = null;
  for (let e: ElementLike | null = el; e; e = e.parentElement)
    if (e.namespaceURI === SVG_NS && tagOf(e) === "svg") svg = e;
  return svg ?? el;
}

/**
 * `tag:nth-of-type(n)` segments from below `root` down to `el`; "body" for the root itself.
 * Throws when `el` is not under `root`.
 */
export function elementPath(el: ElementLike, root: ElementLike): string {
  const parts: string[] = [];
  for (let e: ElementLike | null = el; e !== root; e = e.parentElement) {
    const parent: ElementLike | null = e?.parentElement ?? null;
    if (!e || !parent) throw new Error("element_not_under_root");
    let n = 0;
    for (const sib of Array.from<ElementLike>(parent.children)) {
      if (tagOf(sib) === tagOf(e)) n += 1;
      if (sib === e) break;
    }
    parts.unshift(`${tagOf(e)}:nth-of-type(${n})`);
  }
  return parts.length ? parts.join(">") : "body";
}

export const elementWords = (el: ElementLike): string => norm(el.textContent).slice(0, MAX_ANCHOR_WORDS);

/**
 * `storedIds`, when given, are the ids present in the stored file: only those can be the anchor's
 * elementId (an id the editor added at runtime would not survive a reload).
 */
export function anchorForElement(
  board: string,
  picked: ElementLike,
  dx: number,
  dy: number,
  root: ElementLike,
  storedIds?: ReadonlySet<string>,
  /** While editing live: the picked element's live id. */
  liveIdOf?: (el: ElementLike) => string | null,
): ElementAnchor {
  const el = anchorTarget(picked);
  const liveId = liveIdOf?.(el) ?? null;
  // storedIds alone decides when given; the generated-id pattern is only the fallback without it.
  const idOk = ID_OK.test(el.id) && (storedIds ? storedIds.has(el.id) : !GRAPES_GENERATED_ID.test(el.id));
  return {
    type: "element",
    board,
    ...(idOk ? { elementId: el.id } : {}),
    ...(liveId && ID_OK.test(liveId) ? { liveId } : {}),
    path: elementPath(el, root),
    tag: tagOf(el),
    words: elementWords(el),
    dx: clamp01(dx),
    dy: clamp01(dy),
  };
}

const WORDS_PREFIX = 24;

/**
 * The element an anchor points at under `root`: by live id (while editing live, `byLiveId` finds it), then by id,
 * then by path (same tag, same first words), then by unique words.
 */
export function locateElement(
  root: ElementLike,
  a: ElementAnchor,
  byLiveId?: (liveId: string) => ElementLike | null,
): ElementLike | null {
  if (a.liveId && byLiveId) {
    const live = byLiveId(a.liveId);
    if (live) return anchorTarget(live);
  }
  const head = a.words.slice(0, WORDS_PREFIX);
  const sameText = (el: ElementLike) => head === "" || norm(el.textContent).startsWith(head);
  if (a.elementId) {
    const byId = root.querySelectorAll(`[id="${a.elementId}"]`)[0];
    if (byId && tagOf(byId) === a.tag) return byId;
  }
  // The root itself is found only by the path "body".
  const byPath = a.path === "body" ? root : root.querySelectorAll(`:scope>${a.path}`)[0];
  if (byPath && tagOf(byPath) === a.tag && sameText(byPath)) return byPath;
  if (head.length >= 8) {
    const same = Array.from(root.querySelectorAll(a.tag)).filter((el) => norm(el.textContent).startsWith(head));
    if (same.length === 1) return same[0];
  }
  return null;
}
