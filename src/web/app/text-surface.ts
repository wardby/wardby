/**
 * The anchoring surface for documents: comments on words in the Tiptap editor.
 * Highlights (editor.ts decorations), the floating 💬 Comment button, the
 * margin badges, ⌘⌥M, and reading and snapping the selection live here; the
 * comment dialog (comments-ui.ts) reaches them only through AnchorSurface.
 */
import type { Editor } from "@tiptap/core";
import { anchorForRange, docText, rangeForAnchor, type TextAnchor } from "./anchors.js";
import type { Anchor, ThreadView } from "./api.js";
import { previewText, stackBadges } from "./comments.js";
import { clear, h, placeAt } from "./dom.js";
import { getHighlights, setHighlights, type Highlight } from "./editor.js";
import { quoteClipped, type AnchorSurface, type DraftStart } from "./surface.js";

const BADGE_GAP = 24;
/** Shown in the panel when the selection can't be commented on. */
export const SELECT_WORDS = "Select some words to comment on (up to 500 characters).";

type Handlers = Parameters<AnchorSurface["connect"]>[0];

const sameText = (a: TextAnchor, b: TextAnchor) =>
  a.quote === b.quote && a.prefix === b.prefix && a.suffix === b.suffix;

export class TextSurface implements AnchorSurface {
  private handlers: Handlers | null = null;
  private threads: readonly ThreadView[] = [];
  private active: string | null = null;
  private canStart = false;
  private suspended = false;
  /** The range draft() found, until mark() shows it. */
  private pendingDraft: { from: number; to: number } | null = null;
  /** The anchor of the draft last shown: the thread created from it takes over its highlight. */
  private lastDraft: TextAnchor | null = null;
  private drawQueued = false;

  /**
   * `preview` gives a badge's tooltip from the thread's first comment (the dialog's, so mentions show names).
   */
  constructor(
    private readonly editor: Editor,
    private readonly els: { page: HTMLElement; margin: HTMLElement; bubble: HTMLButtonElement; stage: HTMLElement },
    private readonly preview: (body: string) => string = (body) => previewText(body),
  ) {}

  connect(handlers: Handlers): void {
    this.handlers = handlers;
    const { editor } = this;
    const { bubble, stage, page } = this.els;
    const moved = () => {
      this.schedule();
      handlers.layout();
    };
    bubble.addEventListener("mousedown", (e) => e.preventDefault());
    bubble.addEventListener("click", () => handlers.start());
    editor.on("selectionUpdate", () => this.updateBubble());
    editor.on("update", moved);
    editor.on("blur", () => setTimeout(() => this.updateBubble(), 120));
    document.addEventListener("selectionchange", () => this.updateBubble());
    stage.addEventListener("scroll", moved, { passive: true });
    addEventListener("resize", moved);
    new ResizeObserver(moved).observe(page);

    editor.view.dom.addEventListener("click", (e) => {
      const mark = (e.target as Element).closest?.<HTMLElement>("[data-comment-id]");
      const id = mark?.dataset.commentId;
      if (!id || id === "draft" || !this.selectionRange().empty) return;
      handlers.activate(id);
    });

    document.addEventListener("keydown", (e) => {
      // ⌘⌥M (Ctrl+Alt+M elsewhere); e.code, because Option changes e.key on macOS.
      if (e.code === "KeyM" && e.altKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handlers.start();
      }
    });
  }

  // ---- marks --------------------------------------------------------------------

  /**
   * Highlights for open threads: kept where edits mapped them, otherwise located from the anchor.
   * They are worked out again only when the threads change; otherwise only the draft and the
   * active one change.
   */
  mark(state: { threads: readonly ThreadView[]; draft: Anchor | null; active: string | null; canStart?: boolean }) {
    const editor = this.editor;
    const draftAnchor = state.draft?.type === "text" ? state.draft : null;
    const current = new Map(getHighlights(editor).map((r) => [r.id, r]));
    const draftRange = draftAnchor ? (this.pendingDraft ?? current.get("draft") ?? null) : null;
    this.pendingDraft = null;
    let ranges: Highlight[];
    if (state.threads !== this.threads) {
      let dt: ReturnType<typeof docText> | null = null;
      const shown = current.get("draft");
      ranges = [];
      for (const t of state.threads) {
        if (t.status !== "open" || t.anchor.type !== "text") continue;
        const kept = current.get(t.id);
        if (kept) {
          ranges.push(kept);
          continue;
        }
        // A thread just created from the draft keeps the draft's range (no flicker while it is located again).
        if (shown && this.lastDraft && sameText(this.lastDraft, t.anchor)) {
          ranges.push({ ...shown, id: t.id });
          continue;
        }
        dt ??= docText(editor.state.doc);
        const r = rangeForAnchor(dt, t.anchor);
        if (r) ranges.push({ id: t.id, ...r });
      }
      this.threads = state.threads;
    } else {
      ranges = [...current.values()].filter((r) => r.id !== "draft");
    }
    if (draftRange) ranges.push({ id: "draft", ...draftRange });
    this.lastDraft = draftAnchor;
    this.active = state.active;
    this.canStart = state.canStart ?? true;
    setHighlights(editor, { ranges, active: state.active });
    this.schedule();
  }

  /** Drops every highlight, so the next mark() locates each thread again (a newer version was loaded). */
  reset(): void {
    setHighlights(this.editor, { ranges: [] });
    this.threads = [];
  }

  private rangeOf(id: string): { from: number; to: number } | null {
    return getHighlights(this.editor).find((r) => r.id === id) ?? null;
  }

  point(id: string): { x: number; y: number } | null {
    const r = this.rangeOf(id);
    if (!r) return null;
    const start = this.editor.view.coordsAtPos(r.from);
    const end = this.editor.view.coordsAtPos(r.to);
    return { x: start.left, y: end.bottom + 8 };
  }

  located(id: string): boolean {
    return this.rangeOf(id) !== null;
  }

  isMark(target: Element): boolean {
    return !!target.closest?.(".mbadge, [data-comment-id]");
  }

  emptyHint(): string {
    return "Select some text and click 💬 Comment.";
  }

  keysHint(): string {
    return "Select text → 💬 Comment (⌘⌥M)";
  }

  /** Scrolls a thread's highlight into view. */
  reveal(thread: ThreadView): void {
    const r = this.rangeOf(thread.id);
    if (!r) return;
    const top = this.editor.view.coordsAtPos(r.from).top;
    const stage = this.els.stage;
    stage.scrollTop += top - stage.getBoundingClientRect().top - 120;
  }

  label(thread: ThreadView | DraftStart, max?: number): string {
    const quote = "number" in thread ? (thread.anchor.type === "text" ? thread.anchor.quote : "") : thread.quote;
    return quoteClipped(quote, max);
  }

  suspend(on: boolean): void {
    this.suspended = on;
    if (on) this.els.bubble.hidden = true;
    this.schedule();
  }

  // ---- the selection and the floating button ------------------------------------------

  draft(): DraftStart | string | null {
    const r = this.selectionRange();
    if (r.empty) return null;
    const made = anchorForRange(docText(this.editor.state.doc), r.from, r.to);
    if (!made) return SELECT_WORDS;
    this.els.bubble.hidden = true;
    this.pendingDraft = made.range;
    return { anchor: made.anchor, quote: made.anchor.quote };
  }

  /** The selection in the editor; read from the DOM too, so read-only pages work the same. */
  private selectionRange(): { from: number; to: number; empty: boolean } {
    const { view, state } = this.editor;
    const { from, to, empty } = state.selection;
    if (!empty) return { from, to, empty };
    const sel = document.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return { from, to, empty: true };
    const r = sel.getRangeAt(0);
    if (!view.dom.contains(r.startContainer) || !view.dom.contains(r.endContainer)) return { from, to, empty: true };
    try {
      const a = view.posAtDOM(r.startContainer, r.startOffset);
      const b = view.posAtDOM(r.endContainer, r.endOffset);
      return { from: Math.min(a, b), to: Math.max(a, b), empty: a === b };
    } catch {
      return { from, to, empty: true };
    }
  }

  private updateBubble(): void {
    const { bubble } = this.els;
    const r = this.selectionRange();
    if (r.empty || !this.canStart || this.suspended) {
      bubble.hidden = true;
      return;
    }
    const a = this.editor.view.coordsAtPos(r.from);
    const b = this.editor.view.coordsAtPos(r.to);
    bubble.hidden = false;
    placeAt(
      bubble,
      Math.max(12, (a.left + b.right) / 2 - bubble.offsetWidth / 2),
      Math.max(8, Math.min(a.top, b.top) - bubble.offsetHeight - 8),
    );
  }

  // ---- margin badges -------------------------------------------------------------

  private schedule(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.drawBadges();
      this.updateBubble();
    });
  }

  private drawBadges(): void {
    const { margin, page } = this.els;
    clear(margin);
    if (this.suspended) return;
    const top = page.getBoundingClientRect().top;
    const items: { t: ThreadView; y: number }[] = [];
    for (const t of this.threads) {
      if (t.status !== "open") continue;
      const r = this.rangeOf(t.id);
      if (!r) continue;
      items.push({ t, y: this.editor.view.coordsAtPos(r.from).top - top });
    }
    const ys = stackBadges(
      items.map((i) => i.y),
      BADGE_GAP,
    );
    items.forEach(({ t }, i) => {
      const b = h(
        "button",
        {
          type: "button",
          class: `mbadge${this.active === t.id ? " on" : ""}`,
          title: this.preview(t.comments[0]?.body ?? ""),
          aria: { label: `Thread ${t.number}, ${t.comments.length} message${t.comments.length === 1 ? "" : "s"}` },
          onClick: () => this.handlers?.activate(t.id),
        },
        h("span", {}, String(t.number)),
        h("small", {}, String(t.comments.length)),
      );
      b.style.top = `${Math.round(ys[i])}px`;
      margin.append(b);
    });
  }
}
