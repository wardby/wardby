/**
 * The anchoring surface for designs: comment pins on board elements in the GrapesJS canvas. Pin mode
 * (C or the 💬 button), the writers' 💬 in GrapesJS's component toolbar, the pins and the blue "+"
 * draft pin, and the boards list's 💬 counts live here; the comment dialog (comments-ui.ts) reaches
 * them only through AnchorSurface, as it reaches the document's highlights through text-surface.ts.
 *
 * Anchors are built and located against the GrapesJS wrapper element (BoardsEditor.root()), the same
 * relative paths the server re-anchors against the stored board's body (element-anchors.ts). Pins are
 * placed on events only (frame load, board and device changes, edits, the canvas's scroll and resizes);
 * there is no animation-frame loop.
 */
import type { Component } from "grapesjs";
import {
  anchorForElement,
  anchorTarget,
  locateElement,
  type ElementAnchor,
} from "../../core/documents/element-anchors.js";
import type { Anchor, ThreadView } from "./api.js";
import type { BoardsEditor } from "./boards-editor.js";
import { previewText } from "./comments.js";
import { h, placeAt } from "./dom.js";
import { offsetFraction, pinPoint, type DOMRectLike } from "./pins.js";
import { quoteClipped, type AnchorSurface, type DraftStart } from "./surface.js";

/** Shown while pin mode is on. */
export const PIN_HINT = "Click anything on the board to comment · Esc to cancel";
/** Shown in the panel when a comment is started with no element picked. */
export const PICK_ELEMENT = "Click an element on the board to comment.";
const COMMENT_COMMAND = "wardby:comment";
/**
 * Keys pressed in the canvas that the page's own key handlers (dialog and surface) get too. Only lower
 * j / k: the dialog's J / K keys are lower-case only, on document pages as here.
 */
const FORWARDED_KEYS = new Set(["c", "C", "j", "k", "Escape"]);

type Handlers = Parameters<AnchorSurface["connect"]>[0];
type Point = { x: number; y: number };

const isElementAnchor = (a: Anchor | null | undefined): a is ElementAnchor => a?.type === "element";
const typingIn = (el: Element | null) =>
  !!el?.closest?.("input, textarea, select, [contenteditable=true], [contenteditable='']");

export class DesignSurface implements AnchorSurface {
  private handlers: Handlers | null = null;
  private threads: readonly ThreadView[] = [];
  /** The draft the dialog shows (its popover is open). */
  private draftAnchor: ElementAnchor | null = null;
  /** The element just picked (pin mode click or toolbar), until draft() hands it to the dialog. */
  private picked: ElementAnchor | null = null;
  private active: string | null = null;
  private canStart = true;
  private suspended = false;
  private pinMode = false;
  /** A pin-mode press in the canvas: its mouseup and click are kept from GrapesJS (no selection). */
  private swallow = false;
  private drawQueued = false;
  /** Tip of each pin drawn now (viewport), by thread id or "draft". */
  private readonly points = new Map<string, Point>();
  /** Open threads on the board in the canvas whose element was not found, as of the last draw (a key). */
  private lostKey = "";
  private readonly marks: HTMLElement;
  /**
   * The pin elements drawn now, by thread id or "draft". A redraw moves and updates them in place
   * rather than building new ones, so a pin stays the same element while it is shown (keyboard focus on
   * it survives a redraw, and nothing holding it finds it detached).
   */
  private readonly pinEls = new Map<string, HTMLElement>();
  private readonly hint: HTMLElement;
  private readonly wiredWindows = new WeakSet<Window>();
  private readonly observed = new WeakSet<Element>();
  private observer: ResizeObserver | null = null;

  /**
   * `names` gives the boards' names by id (labels); `preview` gives a pin's tooltip from the thread's
   * first comment (the dialog's, so mentions show names).
   */
  constructor(
    private readonly boards: BoardsEditor,
    private readonly els: { pins: HTMLElement; commentButton: HTMLButtonElement; boardsList: HTMLElement },
    private readonly names: () => Map<string, string>,
    private readonly preview: (body: string) => string = (body) => previewText(body),
    /** Runs a board switch once no fidelity pass is running (the pass switches boards to measure them). */
    private readonly whenIdle: (run: () => void) => void = (run) => run(),
  ) {
    this.marks = h("div", { class: "pin-marks" });
    this.hint = h("div", { class: "pin-mode-hint", hidden: true, role: "status" }, PIN_HINT);
    els.pins.append(this.marks, this.hint);
  }

  connect(handlers: Handlers): void {
    this.handlers = handlers;
    const { editor } = this.boards;
    const moved = () => {
      this.schedule();
      handlers.layout();
    };
    this.els.commentButton.addEventListener("click", () => {
      if (this.pinMode) this.setPinMode(false);
      else if (this.canStart && !this.suspended) this.setPinMode(true);
    });
    for (const ev of ["page:select", "change:device", "component:update", "update"]) editor.on(ev, moved);
    editor.on("canvas:frame:load", () => {
      this.wireCanvas();
      moved();
    });
    this.boards.onBoard(() => moved());
    addEventListener("resize", moved);
    this.observer = new ResizeObserver(moved);
    this.observer.observe(this.els.pins);
    void this.boards.ready.then(() => {
      this.wireCanvas();
      moved();
    });

    if (this.boards.editable) {
      // Writers: 💬 in the selected component's toolbar comments on it, at its centre.
      editor.Commands.add(COMMENT_COMMAND, () => this.startOnSelected());
      editor.on("component:selected", (c: Component) => {
        const toolbar = c.get("toolbar") ?? [];
        if (toolbar.some((t) => t.command === COMMENT_COMMAND)) return;
        // Silent: the toolbar is not board content (no undo step, no change to save).
        c.set("toolbar", [...toolbar, { label: "💬", command: COMMENT_COMMAND, attributes: { title: "Comment" } }], {
          silent: true,
        });
      });
    }
  }

  /** Listeners on the canvas window: once per window (a reloaded frame has a new one). */
  private wireCanvas(): void {
    const win = this.boards.canvasWindow();
    const frame = this.boards.editor.Canvas.getFrameEl();
    if (frame && this.observer && !this.observed.has(frame)) {
      this.observed.add(frame);
      this.observer.observe(frame);
    }
    if (!win || this.wiredWindows.has(win)) return;
    this.wiredWindows.add(win);
    const moved = () => {
      this.schedule();
      this.handlers?.layout();
    };
    win.addEventListener("scroll", moved, { passive: true });
    win.addEventListener("resize", moved);
    // Captured, so GrapesJS never sees a pin-mode press (it would select, or start a drag).
    win.addEventListener("mousedown", (e) => this.canvasPress(e), true);
    const swallow = (e: Event) => {
      if (!this.swallow) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === "click") this.swallow = false;
    };
    win.addEventListener("mouseup", swallow, true);
    win.addEventListener("click", swallow, true);
    // Keys typed in the canvas do not reach the page: C, J, K and Esc are passed on unless typing.
    win.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || !FORWARDED_KEYS.has(e.key)) return;
      if (typingIn(e.target as Element | null)) return;
      e.preventDefault();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, code: e.code, bubbles: true }));
    });
  }

  private canvasPress(e: MouseEvent): void {
    if (!this.pinMode || e.button !== 0) {
      this.swallow = false; // a pin-mode press whose click never came (dragged off) keeps nothing back
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    this.swallow = true;
    const root = this.boards.root();
    if (!root) return;
    const target = e.target as Element | null;
    // Outside the board's elements (the canvas margin): the board's root.
    const el = target && target.nodeType === 1 && root.contains(target) ? target : root;
    const at = anchorTarget(el) as unknown as Element;
    const { dx, dy } = offsetFraction(at.getBoundingClientRect(), e.clientX, e.clientY);
    this.setPinMode(false);
    this.pick(el, dx, dy);
  }

  /** The toolbar's 💬: the selected component, at its centre. */
  private startOnSelected(): void {
    const el = this.boards.editor.getSelected()?.getEl();
    if (!el || !this.canStart || this.suspended) return;
    this.setPinMode(false);
    this.pick(el, 0.5, 0.5);
  }

  private pick(el: Element, dx: number, dy: number): void {
    const root = this.boards.root();
    if (!root) return;
    try {
      this.picked = anchorForElement(this.boards.currentBoard(), el, dx, dy, root, this.boards.storedIds());
    } catch {
      return; // not under the board's root
    }
    this.handlers?.start();
  }

  private setPinMode(on: boolean): void {
    this.pinMode = on;
    this.hint.hidden = !on;
    this.els.commentButton.setAttribute("aria-pressed", String(on));
    this.els.pins.classList.toggle("pin-mode", on);
    const html = this.boards.canvasDocument()?.documentElement;
    if (html) html.style.cursor = on ? "crosshair" : "";
  }

  // ---- AnchorSurface ----------------------------------------------------------------

  draft(): DraftStart | string | null {
    const a = this.picked;
    this.picked = null;
    if (!a) return PICK_ELEMENT;
    return { anchor: a, quote: a.words };
  }

  mark(state: { threads: readonly ThreadView[]; draft: Anchor | null; active: string | null; canStart?: boolean }) {
    this.threads = state.threads;
    this.draftAnchor = isElementAnchor(state.draft) ? state.draft : null;
    this.active = state.active;
    this.canStart = state.canStart ?? true;
    // A popover opened (or commenting stopped): pin mode ends.
    if (!this.canStart && this.pinMode) this.setPinMode(false);
    // Drawn now: the dialog places its popover at point() right after marking.
    this.draw();
    this.refreshCounts();
  }

  point(id: string): Point | null {
    const p = this.points.get(id);
    // Beside the pin, level with its head.
    return p ? { x: p.x + 18, y: p.y - 30 } : null;
  }

  located(id: string): boolean {
    const t = this.threads.find((x) => x.id === id);
    if (!t || !isElementAnchor(t.anchor)) return false;
    const board = t.anchor.board;
    // Another board is not in the canvas: the server's re-anchoring (the thread's status) decides.
    if (board !== this.boards.currentBoard()) return this.names().has(board);
    // A DOM query, no layout. Before the canvas loads, or while an earlier version is shown, the
    // element cannot be looked for: no claim that it is gone.
    const root = this.boards.root();
    if (this.suspended || !root) return true;
    return locateElement(root, t.anchor) !== null;
  }

  isMark(target: Element): boolean {
    return !!target.closest?.(".pin");
  }

  emptyHint(): string {
    return "Press C or 💬 Comment, then click the board.";
  }

  keysHint(): string {
    return "C: new comment";
  }

  /**
   * Switches to the thread's board, then scrolls its element to the middle of the canvas. A fidelity
   * pass switches boards to measure them: the switch waits until it is done.
   */
  reveal(thread: ThreadView): void {
    const a = thread.anchor;
    if (!isElementAnchor(a)) return;
    this.whenIdle(() => {
      if (a.board !== this.boards.currentBoard()) this.boards.selectBoard(a.board);
      const go = () => {
        const root = this.boards.root();
        const el = root ? (locateElement(root, a) as unknown as HTMLElement | null) : null;
        el?.scrollIntoView({ block: "center" });
      };
      const win = this.boards.canvasWindow();
      if (win) win.requestAnimationFrame(go);
      else go();
    });
  }

  /** Only the element's words are cut to `max`: the board's name always shows. */
  label(thread: ThreadView | DraftStart, max?: number): string {
    const a = thread.anchor;
    if (!isElementAnchor(a)) return "";
    const board = this.names().get(a.board) ?? a.board;
    return a.words ? `${quoteClipped(a.words, max)} · ${board}` : `${a.tag} · ${board}`;
  }

  key(e: KeyboardEvent, typing: boolean): boolean {
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return false;
    if (e.key === "Escape" && this.pinMode) {
      this.setPinMode(false);
      return true;
    }
    if ((e.key === "c" || e.key === "C") && this.canStart && !this.suspended) {
      this.setPinMode(!this.pinMode);
      return true;
    }
    return false;
  }

  suspend(on: boolean): void {
    this.suspended = on;
    if (on) this.setPinMode(false);
    this.draw();
  }

  // ---- the boards list's counts ---------------------------------------------------------

  /** Puts each board's open-thread count (💬 n) in the boards list; the page calls it after redrawing the list. */
  refreshCounts(): void {
    const open = new Map<string, number>();
    for (const t of this.threads) {
      if (t.status === "open" && isElementAnchor(t.anchor))
        open.set(t.anchor.board, (open.get(t.anchor.board) ?? 0) + 1);
    }
    for (const li of Array.from(this.els.boardsList.querySelectorAll<HTMLElement>("li[data-board]"))) {
      const pick = li.querySelector(".pick");
      if (!pick) continue;
      pick.querySelector(".bcount")?.remove();
      const n = open.get(li.dataset.board ?? "") ?? 0;
      if (n) pick.append(h("span", { class: "bcount", title: `${n} open comment${n === 1 ? "" : "s"}` }, `💬 ${n}`));
    }
  }

  // ---- pins ----------------------------------------------------------------------------

  /** Redraws on the next frame (one per burst of events; not a loop). */
  private schedule(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      const before = this.lostKey;
      this.draw();
      this.handlers?.layout();
      // The canvas loaded, the board changed or an edit moved things: the panel's "outdated" chips follow.
      if (this.lostKey !== before) this.handlers?.relist?.();
    });
  }

  /** Removes the pins not drawn this time. */
  private keepPins(drawn: ReadonlySet<string>): void {
    for (const [id, el] of this.pinEls) {
      if (drawn.has(id)) continue;
      el.remove();
      this.pinEls.delete(id);
    }
  }

  /** Thread `t`'s pin, made the first time it is drawn and brought up to date after. */
  private threadPin(t: ThreadView): HTMLElement {
    let pin = this.pinEls.get(t.id);
    if (!pin) {
      const id = t.id;
      pin = h("button", { type: "button", data: { threadId: id }, onClick: () => this.handlers?.activate(id) });
      this.pinEls.set(id, pin);
      this.marks.append(pin);
    }
    pin.className = `pin${t.status !== "open" ? " resolved" : ""}${this.active === t.id ? " on" : ""}`;
    pin.title = this.preview(t.comments[0]?.body ?? "");
    pin.setAttribute(
      "aria-label",
      `Thread ${t.number}, ${t.comments.length} message${t.comments.length === 1 ? "" : "s"}`,
    );
    const num = String(t.number);
    if (pin.textContent !== num) pin.replaceChildren(h("span", {}, num));
    return pin;
  }

  /** The blue + pin of the comment being written. */
  private draftPin(): HTMLElement {
    let pin = this.pinEls.get("draft");
    if (!pin) {
      pin = h("div", { class: "pin draft on", aria: { hidden: "true" }, title: "New comment" }, h("span", {}, "+"));
      this.pinEls.set("draft", pin);
      this.marks.append(pin);
    }
    return pin;
  }

  private draw(): void {
    this.points.clear();
    const root = this.boards.root();
    const frameEl = this.boards.editor.Canvas.getFrameEl();
    if (this.suspended || !root || !frameEl) {
      this.keepPins(new Set());
      this.lostKey = "";
      return;
    }
    const board = this.boards.currentBoard();
    const fr = frameEl.getBoundingClientRect();
    // The frame's content box: element rects inside it are relative to it.
    const frame: DOMRectLike = {
      left: fr.left + frameEl.clientLeft,
      top: fr.top + frameEl.clientTop,
      width: frameEl.clientWidth,
      height: frameEl.clientHeight,
    };
    const layer = this.els.pins.getBoundingClientRect();
    // Pins outside the part of the canvas on screen are not drawn.
    const view = {
      left: Math.max(frame.left, layer.left),
      top: Math.max(frame.top, layer.top),
      right: Math.min(frame.left + frame.width, layer.right),
      bottom: Math.min(frame.top + frame.height, layer.bottom),
    };
    const items: { id: string; anchor: ElementAnchor; t?: ThreadView }[] = [];
    for (const t of this.threads) {
      if (!isElementAnchor(t.anchor) || t.anchor.board !== board) continue;
      // Open threads; a resolved or outdated one only while it is the active one.
      if (t.status !== "open" && t.id !== this.active) continue;
      items.push({ id: t.id, anchor: t.anchor, t });
    }
    if (this.draftAnchor && this.draftAnchor.board === board) items.push({ id: "draft", anchor: this.draftAnchor });
    const lost: string[] = [];
    for (const { id, anchor, t } of items) {
      const el = locateElement(root, anchor) as unknown as Element | null;
      if (!el) {
        if (t?.status === "open") lost.push(id);
        continue;
      }
      const p = pinPoint(frame, el.getBoundingClientRect(), anchor.dx, anchor.dy);
      if (p.x < view.left || p.x > view.right || p.y < view.top || p.y > view.bottom) continue;
      this.points.set(id, p);
      const pin = t ? this.threadPin(t) : this.draftPin();
      placeAt(pin, p.x - layer.left, p.y - layer.top);
    }
    this.keepPins(new Set(this.points.keys()));
    this.lostKey = `${board}:${lost.join(",")}`;
  }
}
