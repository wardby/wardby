/**
 * The comment dialog for documents: the floating 💬 Comment button, the
 * composer and thread popover (with the ⋯ menu and @mention list), margin
 * badges and the threads panel. Shared look with designs via styles.css.
 */
import type { Editor } from "@tiptap/core";
import { anchorForRange, docText, rangeForAnchor, type TextAnchor } from "./anchors.js";
import { ApiError, errorMessage, type Api, type DocumentPayload, type ThreadView, type Viewer } from "./api.js";
import {
  decodeMentions,
  encodeMentions,
  initials,
  mentionQuery,
  previewText,
  relativeTime,
  stackBadges,
  type MentionCandidate,
} from "./comments.js";
import { append, clear, h, placeAt, renderBody, trapFocus } from "./dom.js";
import { getHighlights, setHighlights, type Highlight } from "./editor.js";

const RANK: Record<string, number> = { none: 0, read: 1, comment: 2, write: 3, owner: 4 };
export const atLeast = (access: string, need: string) => (RANK[access] ?? 0) >= RANK[need];

type Filter = "open" | "resolved" | "sent" | "mine";
const FILTERS: [Filter, string][] = [
  ["open", "Open"],
  ["resolved", "Resolved"],
  ["sent", "Sent to agent"],
  ["mine", "Mine"],
];
const BADGE_GAP = 24;
const POLL_MS = 15_000;
/** Codes postThread returns after the thread was created, when only the send to the agent failed. */
const SEND_AFTER_CREATE = new Set([
  "comment_thread_already_sent",
  "document_too_large_for_agent",
  "document_agent_unavailable",
  "document_not_agent_linked",
  "comment_send_rate_limited",
  "document_send_failed",
]);

export interface CommentsHost {
  api: Api;
  editor: Editor;
  shareToken?: string;
  /** Elements the dialog draws into. */
  stage: HTMLElement;
  page: HTMLElement;
  margin: HTMLElement;
  panel: HTMLElement;
  count: HTMLElement;
  bubble: HTMLButtonElement;
  /** Called when the viewer changes (guest registration). */
  onViewer(viewer: Viewer): void;
}

interface Pop {
  el: HTMLElement;
  kind: "draft" | "thread";
  threadId?: string;
  anchor?: TextAnchor;
  quote: string;
  editing?: string;
  confirmDelete?: string;
  changingName?: boolean;
  menuOpen?: boolean;
  error?: string;
  picked: MentionCandidate[];
  suggest?: { list: MentionCandidate[]; idx: number; start: number };
  returnFocus: Element | null;
}

export class CommentsUI {
  viewer: Viewer;
  canSend = false;
  threads: ThreadView[] = [];
  private names = new Map<string, string>();
  private candidates: MentionCandidate[] = [];
  private filter: Filter = "open";
  private selected: string | null = null;
  private checked = new Set<string>();
  private pop: Pop | null = null;
  private layoutQueued = false;
  private panelError = "";

  constructor(
    private readonly host: CommentsHost,
    viewer: Viewer,
  ) {
    this.viewer = viewer;
    this.wire();
  }

  // ---- permissions ----------------------------------------------------------

  /** Comment access: a member or guest with comment, or a visitor on a comment link (who registers first). */
  get canComment(): boolean {
    return atLeast(this.viewer.access, "comment");
  }
  private get canWrite(): boolean {
    return atLeast(this.viewer.access, "write");
  }
  private get needsName(): boolean {
    return this.viewer.kind === "anonymous" || !!this.pop?.changingName;
  }
  private canResolve(t: ThreadView): boolean {
    return this.canWrite || (this.viewer.kind !== "anonymous" && t.comments[0]?.mine === true);
  }
  private working(t: ThreadView): boolean {
    if (!t.sentAt || t.status === "resolved") return false;
    const sent = Date.parse(t.sentAt);
    return !t.comments.some((c) => c.author.kind === "agent" && Date.parse(c.createdAt) >= sent);
  }

  // ---- data -----------------------------------------------------------------

  /** Applies a fresh document payload (threads and permissions). */
  apply(payload: DocumentPayload): void {
    this.viewer = payload.me;
    this.canSend = payload.document.canSend;
    this.threads = payload.threads;
    for (const id of [...this.checked]) if (!this.threads.some((t) => t.id === id)) this.checked.delete(id);
    this.refreshHighlights();
    this.render();
  }

  async loadMentions(): Promise<void> {
    if (this.viewer.kind === "anonymous" || !this.canComment) return;
    try {
      const r = await this.host.api.mentions();
      this.candidates = r.candidates;
      this.names = new Map(r.candidates.map((c) => [c.principalId, c.name]));
      this.render();
    } catch {
      // Mentions are optional: names fall back to "@member".
    }
  }

  async reload(): Promise<void> {
    const payload = await this.host.api.load();
    this.apply(payload);
  }

  startPolling(): void {
    setInterval(() => {
      if (document.hidden || !this.threads.some((t) => this.working(t))) return;
      this.reload().catch(() => undefined);
    }, POLL_MS);
  }

  // ---- highlights -------------------------------------------------------------

  /** Highlights for open threads: kept where edits mapped them, otherwise located from the anchor. */
  refreshHighlights(): void {
    const editor = this.host.editor;
    const current = new Map(getHighlights(editor).map((r) => [r.id, r]));
    let dt: ReturnType<typeof docText> | null = null;
    const ranges: Highlight[] = [];
    for (const t of this.threads) {
      if (t.status !== "open") continue;
      const kept = current.get(t.id);
      if (kept) {
        ranges.push(kept);
        continue;
      }
      dt ??= docText(editor.state.doc);
      const r = rangeForAnchor(dt, t.anchor);
      if (r) ranges.push({ id: t.id, ...r });
    }
    const draft = current.get("draft");
    if (draft && this.pop?.kind === "draft") ranges.push(draft);
    setHighlights(editor, { ranges, active: this.pop?.kind === "draft" ? "draft" : this.selected });
    this.scheduleLayout();
  }

  private rangeOf(id: string): { from: number; to: number } | null {
    return getHighlights(this.host.editor).find((r) => r.id === id) ?? null;
  }

  // ---- wiring -----------------------------------------------------------------

  private wire(): void {
    const { editor, bubble, stage } = this.host;
    bubble.addEventListener("mousedown", (e) => e.preventDefault());
    bubble.addEventListener("click", () => this.startComment());
    editor.on("selectionUpdate", () => this.updateBubble());
    editor.on("update", () => this.scheduleLayout());
    editor.on("blur", () => setTimeout(() => this.updateBubble(), 120));
    document.addEventListener("selectionchange", () => this.updateBubble());
    stage.addEventListener("scroll", () => this.scheduleLayout(), { passive: true });
    addEventListener("resize", () => this.scheduleLayout());
    new ResizeObserver(() => this.scheduleLayout()).observe(this.host.page);

    editor.view.dom.addEventListener("click", (e) => {
      const mark = (e.target as Element).closest?.<HTMLElement>("[data-comment-id]");
      const id = mark?.dataset.commentId;
      if (!id || id === "draft" || !this.selectionRange().empty) return;
      const t = this.threads.find((x) => x.id === id);
      if (t) this.openThread(t);
    });

    document.addEventListener("mousedown", (e) => {
      const target = e.target as Element;
      if (!this.pop) return;
      if (this.pop.el.contains(target)) {
        if (this.pop.menuOpen && !target.closest(".menu, [data-act=menu]")) this.setMenu(false);
        return;
      }
      if (target.closest(".mbadge, .tp-row, [data-comment-id], #bubble")) return;
      this.closePop();
    });

    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
    // ⌘⌥M (Ctrl+Alt+M elsewhere); e.code, because Option changes e.key on macOS.
    if (e.code === "KeyM" && e.altKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      this.startComment();
      return;
    }
    const target = e.target as HTMLElement;
    const typing = !!target.closest?.("textarea, input, [contenteditable=true]");
    if (e.key === "Escape" && this.pop) {
      if (this.pop.suggest) return; // the textarea handler closes the list first
      e.preventDefault();
      if (this.pop.menuOpen) this.setMenu(false);
      else this.closePop();
      return;
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j" || e.key === "k") {
      const list = this.visible();
      if (list.length === 0) return;
      e.preventDefault();
      const i = list.findIndex((t) => t.id === this.selected);
      const n = i < 0 ? 0 : e.key === "j" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      this.reveal(list[n]);
    }
  }

  // ---- selection and the floating button ----------------------------------------

  /** The selection in the editor; read from the DOM too, so read-only pages work the same. */
  private selectionRange(): { from: number; to: number; empty: boolean } {
    const { view, state } = this.host.editor;
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
    const { bubble, editor } = this.host;
    const r = this.selectionRange();
    if (r.empty || this.pop || !this.canComment) {
      bubble.hidden = true;
      return;
    }
    const a = editor.view.coordsAtPos(r.from);
    const b = editor.view.coordsAtPos(r.to);
    bubble.hidden = false;
    placeAt(
      bubble,
      Math.max(12, (a.left + b.right) / 2 - bubble.offsetWidth / 2),
      Math.max(8, Math.min(a.top, b.top) - bubble.offsetHeight - 8),
    );
  }

  startComment(): void {
    if (!this.canComment) return;
    const r = this.selectionRange();
    if (r.empty) return;
    const made = anchorForRange(docText(this.host.editor.state.doc), r.from, r.to);
    if (!made) {
      this.flashPanel("Select some words to comment on (up to 500 characters).");
      return;
    }
    this.host.bubble.hidden = true;
    const ranges = getHighlights(this.host.editor).filter((x) => x.id !== "draft");
    setHighlights(this.host.editor, { ranges: [...ranges, { id: "draft", ...made.range }], active: "draft" });
    this.openPop({ kind: "draft", anchor: made.anchor, quote: made.anchor.quote });
  }

  // ---- popover ------------------------------------------------------------------

  private openThread(t: ThreadView): void {
    this.openPop({ kind: "thread", threadId: t.id, quote: t.anchor.quote });
  }

  private openPop(init: Pick<Pop, "kind" | "threadId" | "anchor" | "quote">): void {
    const returnFocus = this.pop?.returnFocus ?? document.activeElement;
    if (this.pop) {
      const wasDraft = this.pop.kind === "draft";
      this.pop.el.remove();
      this.pop = null;
      if (wasDraft && init.kind !== "draft") this.dropDraft();
    }
    const el = h("div", { class: "cpop", role: "dialog", aria: { modal: "false", label: "Comment" } });
    el.addEventListener("keydown", (e) => trapFocus(el, e));
    this.pop = { el, ...init, picked: [], returnFocus };
    this.selected = init.kind === "thread" ? (init.threadId ?? null) : null;
    document.body.appendChild(el);
    this.renderPop();
    this.positionPop();
    const focus =
      el.querySelector<HTMLElement>("input[data-name], textarea") ?? el.querySelector<HTMLElement>("button");
    focus?.focus();
    if (init.kind === "thread") setHighlights(this.host.editor, { active: this.selected });
    this.renderPanel();
    this.scheduleLayout();
  }

  private dropDraft(): void {
    setHighlights(this.host.editor, {
      ranges: getHighlights(this.host.editor).filter((x) => x.id !== "draft"),
      active: this.selected,
    });
  }

  closePop(): void {
    if (!this.pop) return;
    const { el, kind, returnFocus } = this.pop;
    el.remove();
    this.pop = null;
    this.selected = null;
    if (kind === "draft") this.dropDraft();
    else setHighlights(this.host.editor, { active: null });
    if (returnFocus instanceof HTMLElement && returnFocus.isConnected) returnFocus.focus();
    this.renderPanel();
    this.scheduleLayout();
  }

  private popThread(): ThreadView | undefined {
    return this.pop?.threadId ? this.threads.find((t) => t.id === this.pop!.threadId) : undefined;
  }

  private positionPop(): void {
    if (!this.pop) return;
    const id = this.pop.kind === "draft" ? "draft" : this.pop.threadId!;
    const r = this.rangeOf(id);
    const el = this.pop.el;
    let x: number;
    let y: number;
    if (r) {
      const start = this.host.editor.view.coordsAtPos(r.from);
      const end = this.host.editor.view.coordsAtPos(r.to);
      x = start.left;
      y = end.bottom + 8;
    } else {
      // Outdated or resolved: beside the panel.
      const p = this.host.panel.getBoundingClientRect();
      x = p.left - el.offsetWidth - 12;
      y = p.top + 12;
    }
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    x = Math.min(x, innerWidth - w - 12);
    if (y + hgt > innerHeight - 12) y = Math.max(12, y - hgt - 40);
    placeAt(el, Math.max(12, x), y);
  }

  /** Re-renders the popover, keeping what is being typed. */
  private renderPop(): void {
    const pop = this.pop;
    if (!pop) return;
    const prev = pop.el.querySelector("textarea");
    const kept = prev
      ? {
          value: prev.value,
          start: prev.selectionStart,
          end: prev.selectionEnd,
          focused: document.activeElement === prev,
        }
      : null;
    const nameInput = pop.el.querySelector<HTMLInputElement>("input[data-name]");
    const emailInput = pop.el.querySelector<HTMLInputElement>("input[data-email]");
    const keptName = nameInput?.value;
    const keptEmail = emailInput?.value;
    const keptSend = pop.el.querySelector<HTMLInputElement>("input[data-send]")?.checked ?? false;
    clear(pop.el);

    const t = this.popThread();
    if (pop.kind === "thread" && !t) {
      append(
        pop.el,
        h(
          "div",
          { class: "head" },
          h("div", { class: "quote" }, "This thread no longer exists."),
          this.iconButton("close", "Close", "✕"),
        ),
      );
      return;
    }
    const isDraft = pop.kind === "draft";
    const status =
      t?.status === "resolved"
        ? ["res", "Resolved"]
        : t?.status === "outdated"
          ? ["out", "Outdated"]
          : t?.sentAt
            ? ["sent", "Sent to agent"]
            : null;
    const menuItems = t ? this.menuItems(t) : [];
    append(
      pop.el,
      h(
        "div",
        { class: "head" },
        h(
          "div",
          { class: "quote" },
          isDraft ? "New comment on " : `#${t!.number} on `,
          h("b", {}, `“${pop.quote.slice(0, 60)}${pop.quote.length > 60 ? "…" : ""}”`),
        ),
        status ? h("span", { class: `status ${status[0]}` }, status[1]) : null,
        menuItems.length
          ? this.iconButton("menu", "More actions", "⋯", { haspopup: "menu", expanded: String(!!pop.menuOpen) })
          : null,
        this.iconButton("close", "Close", "✕"),
      ),
    );
    if (pop.menuOpen && menuItems.length) {
      const menu = h("div", { class: "menu", role: "menu" });
      for (const [act, label, danger] of menuItems) {
        menu.append(
          h(
            "button",
            {
              type: "button",
              role: "menuitem",
              class: danger ? "danger" : "",
              onClick: () => void this.menuAction(act),
            },
            label,
          ),
        );
      }
      pop.el.append(menu);
    }

    if (t?.comments.length) {
      const msgs = h("div", { class: "msgs" });
      for (const c of t.comments) {
        const agent = c.author.kind === "agent";
        const who = agent ? `Agent · via ${c.author.viaName ?? "Former member"}` : c.author.name;
        msgs.append(
          h(
            "div",
            { class: `msg${agent ? " agent" : ""}` },
            h(
              "div",
              { class: `av ${agent ? "av-agent" : avatarClass(c.author.name)}`, aria: { hidden: "true" } },
              agent ? "✦" : initials(c.author.name),
            ),
            h(
              "div",
              {},
              h(
                "div",
                { class: "who" },
                who,
                h("span", { class: "t", title: c.createdAt }, relativeTime(c.createdAt)),
                c.editedAt ? h("span", { class: "t" }, "(edited)") : null,
              ),
              h("div", { class: "body" }, renderBody(c.body, this.names)),
            ),
          ),
        );
      }
      pop.el.append(msgs);
    }
    if (t && this.working(t)) pop.el.append(h("div", { class: "typing" }, "Agent is working on it…"));
    if (pop.confirmDelete) {
      pop.el.append(
        h(
          "div",
          { class: "confirm" },
          h("span", {}, "Delete your comment?"),
          h(
            "button",
            { type: "button", class: "danger", onClick: () => void this.deleteOwn(pop.confirmDelete!) },
            "Delete",
          ),
          h("button", { type: "button", onClick: () => ((pop.confirmDelete = undefined), this.renderPop()) }, "Cancel"),
        ),
      );
    }

    const resolved = t?.status === "resolved";
    if (resolved) {
      pop.el.append(
        h(
          "div",
          { class: "compose" },
          h(
            "div",
            { class: "actions" },
            h("span", { class: "kbd grow" }, "This thread is resolved."),
            this.canResolve(t)
              ? h("button", { type: "button", onClick: () => void this.menuAction("reopen") }, "Reopen")
              : null,
          ),
        ),
      );
    } else if (this.canComment) {
      pop.el.append(this.composer(isDraft, keptSend));
    }
    if (pop.error) pop.el.append(h("div", { class: "err", role: "alert" }, pop.error));

    const ta = pop.el.querySelector("textarea");
    if (ta && kept && !pop.editing) {
      ta.value = kept.value;
      if (kept.focused) {
        ta.focus();
        ta.setSelectionRange(kept.start, kept.end);
      }
    }
    const ni = pop.el.querySelector<HTMLInputElement>("input[data-name]");
    if (ni && keptName !== undefined) ni.value = keptName;
    const ei = pop.el.querySelector<HTMLInputElement>("input[data-email]");
    if (ei && keptEmail !== undefined) ei.value = keptEmail;
    const msgs = pop.el.querySelector(".msgs");
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  private iconButton(act: string, label: string, text: string, aria: Record<string, string> = {}): HTMLButtonElement {
    return h(
      "button",
      {
        type: "button",
        class: "iconbtn",
        data: { act },
        aria: { label, ...aria },
        onClick: (e) => {
          e.stopPropagation();
          if (act === "close") this.closePop();
          else this.setMenu(!this.pop?.menuOpen);
        },
      },
      text,
    );
  }

  private setMenu(open: boolean): void {
    if (!this.pop) return;
    this.pop.menuOpen = open;
    this.renderPop();
    if (open) this.pop.el.querySelector<HTMLElement>(".menu button")?.focus();
    else this.pop.el.querySelector<HTMLElement>("[data-act=menu]")?.focus();
  }

  private menuItems(t: ThreadView): [string, string, boolean?][] {
    const items: [string, string, boolean?][] = [];
    if (this.canResolve(t)) items.push(t.status === "resolved" ? ["reopen", "↺ Reopen"] : ["resolve", "✓ Resolve"]);
    if (this.canSend && t.status !== "resolved" && !this.working(t)) items.push(["send", "✦ Send to agent"]);
    items.push(["link", "🔗 Copy link"]);
    if (this.lastOwn(t)) {
      items.push(["edit", "Edit my comment"]);
      items.push(["delete", "Delete my comment", true]);
    }
    return items;
  }

  private lastOwn(t: ThreadView) {
    return [...t.comments].reverse().find((c) => c.mine);
  }

  private composer(isDraft: boolean, keptSend: boolean): HTMLElement {
    const pop = this.pop!;
    const t = this.popThread();
    const editing = pop.editing ? t?.comments.find((c) => c.id === pop.editing) : undefined;
    const ta = h("textarea", {
      aria: { label: isDraft ? "Comment" : editing ? "Edit comment" : "Reply" },
      attrs: { placeholder: isDraft ? "Add a comment… (@ to mention)" : "Reply… (@ to mention)", maxlength: "10000" },
      onKeyDown: (e) => this.composerKey(e, ta),
      onInput: () => this.mentionCheck(ta),
    });
    if (editing) {
      const d = decodeMentions(editing.body, this.names);
      ta.value = d.text;
      pop.picked = d.picked;
    }
    const identity: HTMLElement[] = [];
    if (this.needsName) {
      identity.push(
        h(
          "div",
          { class: "guest" },
          h("input", {
            type: "text",
            data: { name: "1" },
            aria: { label: "Your name" },
            attrs: { placeholder: "Your name", maxlength: "40", autocomplete: "name" },
          }),
          h("input", {
            type: "email",
            data: { email: "1" },
            aria: { label: "Email (optional)" },
            attrs: { placeholder: "Email (optional)", maxlength: "254", autocomplete: "email" },
          }),
        ),
      );
    } else if (this.viewer.kind === "guest") {
      identity.push(
        h(
          "div",
          { class: "as" },
          `Commenting as ${this.viewer.name ?? "Guest"} (guest) · `,
          h(
            "button",
            { type: "button", class: "link", onClick: () => ((pop.changingName = true), this.renderPop()) },
            "change",
          ),
        ),
      );
    }
    const send = h(
      "label",
      { hidden: !(isDraft && this.canSend) },
      h("input", { type: "checkbox", data: { send: "1" } }),
      "Send to agent",
    );
    (send.querySelector("input") as HTMLInputElement).checked = keptSend;
    return h(
      "div",
      { class: "compose" },
      ...identity,
      ta,
      h(
        "div",
        { class: "actions" },
        send,
        h("span", { class: `kbd${isDraft && this.canSend ? "" : " grow-left"}` }, "⌘↵"),
        h(
          "button",
          {
            type: "button",
            onClick: () => (editing ? ((pop.editing = undefined), this.renderPop()) : this.closePop()),
          },
          isDraft || editing ? "Cancel" : "Close",
        ),
        h(
          "button",
          { type: "button", class: "primary", onClick: () => void this.submit() },
          isDraft ? "Comment" : editing ? "Save" : "Reply",
        ),
      ),
    );
  }

  private composerKey(e: KeyboardEvent, ta: HTMLTextAreaElement): void {
    const s = this.pop?.suggest;
    if (s && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(e.key)) {
      e.preventDefault();
      if (e.key === "ArrowDown") s.idx = (s.idx + 1) % s.list.length;
      else if (e.key === "ArrowUp") s.idx = (s.idx + s.list.length - 1) % s.list.length;
      else return this.pickSuggest(ta, s.idx);
      this.drawSuggest(ta);
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void this.submit();
    }
    if (e.key === "Escape" && s) {
      e.preventDefault();
      e.stopPropagation();
      this.hideSuggest();
    }
  }

  // ---- @mentions ------------------------------------------------------------------

  private mentionCheck(ta: HTMLTextAreaElement): void {
    const pop = this.pop;
    if (!pop) return;
    const q = mentionQuery(ta.value, ta.selectionStart);
    const list = q
      ? this.candidates.filter((c) => c.name.toLowerCase().includes(q.query.toLowerCase())).slice(0, 8)
      : [];
    if (!q || list.length === 0) return this.hideSuggest();
    pop.suggest = { list, idx: 0, start: q.start };
    this.drawSuggest(ta);
  }

  private drawSuggest(ta: HTMLTextAreaElement): void {
    const pop = this.pop;
    if (!pop?.suggest) return;
    pop.el.querySelector(".suggest")?.remove();
    const box = h("div", { class: "suggest", role: "listbox", aria: { label: "People" } });
    pop.suggest.list.forEach((p, i) => {
      box.append(
        h(
          "div",
          {
            role: "option",
            class: i === pop.suggest!.idx ? "on" : "",
            aria: { selected: String(i === pop.suggest!.idx) },
            onMouseDown: (e) => {
              e.preventDefault();
              this.pickSuggest(ta, i);
            },
          },
          h("span", { class: `av sm ${avatarClass(p.name)}`, aria: { hidden: "true" } }, initials(p.name)),
          p.name,
        ),
      );
    });
    pop.el.querySelector(".compose")?.append(box);
  }

  private pickSuggest(ta: HTMLTextAreaElement, i: number): void {
    const pop = this.pop;
    const s = pop?.suggest;
    if (!pop || !s) return;
    const p = s.list[i];
    const end = ta.selectionStart;
    ta.value = `${ta.value.slice(0, s.start)}@${p.name} ${ta.value.slice(end)}`;
    const caret = s.start + p.name.length + 2;
    ta.setSelectionRange(caret, caret);
    if (!pop.picked.some((x) => x.principalId === p.principalId)) pop.picked.push(p);
    this.hideSuggest();
    ta.focus();
  }

  private hideSuggest(): void {
    if (!this.pop) return;
    this.pop.el.querySelector(".suggest")?.remove();
    this.pop.suggest = undefined;
  }

  // ---- actions -----------------------------------------------------------------------

  private setError(message: string): void {
    if (!this.pop) return;
    this.pop.error = message;
    this.renderPop();
  }

  private async submit(): Promise<void> {
    const pop = this.pop;
    if (!pop) return;
    const ta = pop.el.querySelector("textarea");
    const text = ta?.value.trim() ?? "";
    if (!ta || !text) {
      ta?.focus();
      return;
    }
    const body = encodeMentions(text, pop.picked);
    pop.error = undefined;
    try {
      if (this.needsName) {
        const name = pop.el.querySelector<HTMLInputElement>("input[data-name]")?.value.trim() ?? "";
        const email = pop.el.querySelector<HTMLInputElement>("input[data-email]")?.value.trim() ?? "";
        if (!name) {
          this.setError("Enter your name to comment as a guest.");
          pop.el.querySelector<HTMLInputElement>("input[data-name]")?.focus();
          return;
        }
        this.viewer = await this.host.api.registerGuest(name, email || undefined);
        pop.changingName = false;
        this.host.onViewer(this.viewer);
        void this.loadMentions();
      }
      if (pop.kind === "draft") {
        await this.createThread(pop, body);
        return;
      }
      const t = this.popThread();
      if (!t) return;
      if (pop.editing) {
        await this.host.api.editComment(pop.editing, body);
        pop.editing = undefined;
      } else {
        await this.host.api.reply(t.id, body);
      }
      ta.value = "";
      pop.picked = [];
      await this.reload();
    } catch (err) {
      this.setError(errorMessage(err));
    }
  }

  private async createThread(pop: Pop, body: string): Promise<void> {
    const send = pop.el.querySelector<HTMLInputElement>("input[data-send]")?.checked === true && this.canSend;
    const before = new Set(this.threads.map((t) => t.id));
    try {
      const r = await this.host.api.createThread(pop.anchor!, body, send);
      await this.afterCreate(r.threadId, undefined);
    } catch (err) {
      if (send && err instanceof ApiError && SEND_AFTER_CREATE.has(err.code)) {
        // The thread was stored; only the send failed. Show it with the reason.
        await this.reload().catch(() => undefined);
        const created = this.threads.find(
          (t) => !before.has(t.id) && t.anchor.quote === pop.anchor!.quote && t.comments[0]?.mine,
        );
        if (created) return this.afterCreate(created.id, errorMessage(err));
      }
      throw err;
    }
  }

  private async afterCreate(threadId: string, error: string | undefined): Promise<void> {
    const draft = this.rangeOf("draft");
    // The new thread takes the draft's range (no flicker while the anchor is located again).
    const ranges = getHighlights(this.host.editor).filter((x) => x.id !== "draft");
    if (draft) ranges.push({ ...draft, id: threadId });
    setHighlights(this.host.editor, { ranges });
    if (this.pop) {
      this.pop.el.remove();
      this.pop = null;
    }
    await this.reload();
    const t = this.threads.find((x) => x.id === threadId);
    if (t) {
      this.openThread(t);
      if (error) this.setError(error);
    }
  }

  private async menuAction(act: string): Promise<void> {
    const pop = this.pop;
    const t = this.popThread();
    if (!pop || !t) return;
    pop.menuOpen = false;
    pop.error = undefined;
    try {
      if (act === "resolve" || act === "reopen") {
        await this.host.api.setStatus(t.id, act === "resolve" ? "resolved" : "open");
        if (act === "resolve") {
          setHighlights(this.host.editor, { ranges: getHighlights(this.host.editor).filter((x) => x.id !== t.id) });
        }
        await this.reload();
        if (act === "resolve") return this.closePop();
      } else if (act === "send") {
        await this.host.api.send([t.id]);
        await this.reload();
      } else if (act === "link") {
        const url = `${location.origin}${location.pathname}#thread-${t.number}`;
        await navigator.clipboard?.writeText(url).catch(() => undefined);
        this.renderPop();
      } else if (act === "edit") {
        pop.editing = this.lastOwn(t)?.id;
        this.renderPop();
        pop.el.querySelector("textarea")?.focus();
      } else if (act === "delete") {
        pop.confirmDelete = this.lastOwn(t)?.id;
        this.renderPop();
      }
    } catch (err) {
      this.setError(errorMessage(err));
    }
  }

  private async deleteOwn(commentId: string): Promise<void> {
    if (!this.pop) return;
    this.pop.confirmDelete = undefined;
    try {
      await this.host.api.deleteComment(commentId);
      await this.reload();
    } catch (err) {
      this.setError(errorMessage(err));
    }
  }

  private async sendSelected(): Promise<void> {
    const ids = [...this.checked];
    if (ids.length === 0) return;
    this.panelError = "";
    try {
      await this.host.api.send(ids);
      this.checked.clear();
      await this.reload();
    } catch (err) {
      this.panelError = errorMessage(err);
      this.renderPanel();
    }
  }

  private flashPanel(message: string): void {
    this.panelError = message;
    this.renderPanel();
  }

  // ---- panel, badges -----------------------------------------------------------------

  private counts(): Record<Filter, number> {
    const c = { open: 0, resolved: 0, sent: 0, mine: 0 };
    for (const t of this.threads) {
      if (t.status === "resolved") c.resolved++;
      else c.open++;
      if (t.sentAt) c.sent++;
      if (t.comments.some((x) => x.mine)) c.mine++;
    }
    return c;
  }

  private visible(): ThreadView[] {
    return this.threads.filter((t) =>
      this.filter === "open"
        ? t.status !== "resolved"
        : this.filter === "resolved"
          ? t.status === "resolved"
          : this.filter === "sent"
            ? !!t.sentAt
            : t.comments.some((c) => c.mine),
    );
  }

  /** Scrolls a thread's highlight into view and opens it. */
  reveal(t: ThreadView): void {
    const r = this.rangeOf(t.id);
    if (r) {
      const top = this.host.editor.view.coordsAtPos(r.from).top;
      const stage = this.host.stage;
      stage.scrollTop += top - stage.getBoundingClientRect().top - 120;
    }
    this.openThread(t);
  }

  /** Opens the thread a #thread-<n> link points at. */
  openFromHash(): void {
    const m = /^#thread-(\d+)$/.exec(location.hash);
    const t = m ? this.threads.find((x) => x.number === Number(m[1])) : undefined;
    if (t) this.reveal(t);
  }

  render(): void {
    this.renderPanel();
    if (this.pop) {
      this.renderPop();
      this.positionPop();
    }
    this.scheduleLayout();
  }

  private renderPanel(): void {
    const { panel, count } = this.host;
    const c = this.counts();
    count.textContent = c.open ? `(${c.open})` : "";
    clear(panel);
    const filters = h("div", { class: "tp-filters", role: "tablist", aria: { label: "Filter comments" } });
    for (const [k, label] of FILTERS) {
      filters.append(
        h(
          "button",
          {
            type: "button",
            role: "tab",
            class: this.filter === k ? "on" : "",
            aria: { selected: String(this.filter === k) },
            onClick: () => {
              this.filter = k;
              this.renderPanel();
            },
          },
          `${label} ${c[k]}`,
        ),
      );
    }
    panel.append(filters);

    const list = this.visible();
    const sendable = (t: ThreadView) => this.canSend && t.status !== "resolved" && !this.working(t);
    if (this.canSend && list.some(sendable)) {
      panel.append(
        h(
          "div",
          { class: "tp-bulk" },
          h(
            "button",
            {
              type: "button",
              class: "primary",
              disabled: this.checked.size === 0,
              onClick: () => void this.sendSelected(),
            },
            `✦ Send selected to agent${this.checked.size ? ` (${this.checked.size})` : ""}`,
          ),
        ),
      );
    }
    if (this.panelError) panel.append(h("div", { class: "err tp-err", role: "alert" }, this.panelError));

    const rows = h("div", { class: "tp-list" });
    if (list.length === 0) {
      rows.append(
        h(
          "div",
          { class: "tp-empty" },
          this.filter === "open"
            ? this.canComment
              ? "No open comments. Select some text and click 💬 Comment."
              : "No open comments."
            : "Nothing here.",
        ),
      );
    }
    for (const t of list) {
      const first = t.comments[0];
      const last = t.comments[t.comments.length - 1];
      const located = t.status === "open" && !!this.rangeOf(t.id);
      const row = h(
        "div",
        {
          class: `tp-row${this.selected === t.id ? " on" : ""}`,
          role: "button",
          tabIndex: 0,
          data: { id: t.id },
          onClick: (e) => {
            if ((e.target as Element).closest("input")) return;
            this.reveal(t);
          },
          onKeyDown: (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              this.reveal(t);
            }
          },
        },
        h(
          "div",
          { class: "a" },
          sendable(t)
            ? h("input", {
                type: "checkbox",
                aria: { label: `Select thread ${t.number}` },
                onChange: (e) => {
                  if ((e.target as HTMLInputElement).checked) this.checked.add(t.id);
                  else this.checked.delete(t.id);
                  this.renderPanel();
                },
              })
            : null,
          h("span", { class: "n" }, String(t.number)),
          `“${t.anchor.quote.slice(0, 40)}${t.anchor.quote.length > 40 ? "…" : ""}”`,
        ),
        h("div", { class: "t" }, first ? previewText(first.body, this.names) : ""),
        h(
          "div",
          { class: "m" },
          h("span", {}, `${t.comments.length} message${t.comments.length === 1 ? "" : "s"}`),
          last ? h("span", {}, `· ${relativeTime(last.createdAt)}`) : null,
          t.sentAt ? h("span", { class: "chip sent" }, this.working(t) ? "✦ working" : "✦ sent") : null,
          t.status === "outdated" || (t.status === "open" && !located)
            ? h("span", { class: "chip out" }, "outdated")
            : null,
        ),
      );
      const box = row.querySelector<HTMLInputElement>("input[type=checkbox]");
      if (box) box.checked = this.checked.has(t.id);
      rows.append(row);
    }
    panel.append(rows);
    panel.append(
      h(
        "div",
        { class: "tp-help" },
        this.canComment
          ? "Select text → 💬 Comment (⌘⌥M) · J / K: next / previous · Esc: close"
          : "J / K: next / previous · Esc: close",
      ),
    );
  }

  scheduleLayout(): void {
    if (this.layoutQueued) return;
    this.layoutQueued = true;
    requestAnimationFrame(() => {
      this.layoutQueued = false;
      this.layout();
    });
  }

  private layout(): void {
    const { margin, page, editor } = this.host;
    const top = page.getBoundingClientRect().top;
    clear(margin);
    const items: { t: ThreadView; y: number }[] = [];
    for (const t of this.threads) {
      if (t.status !== "open") continue;
      const r = this.rangeOf(t.id);
      if (!r) continue;
      items.push({ t, y: editor.view.coordsAtPos(r.from).top - top });
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
          class: `mbadge${this.selected === t.id ? " on" : ""}`,
          title: previewText(t.comments[0]?.body ?? "", this.names),
          aria: { label: `Thread ${t.number}, ${t.comments.length} message${t.comments.length === 1 ? "" : "s"}` },
          onClick: () => this.openThread(t),
        },
        h("span", {}, String(t.number)),
        h("small", {}, String(t.comments.length)),
      );
      b.style.top = `${Math.round(ys[i])}px`;
      margin.append(b);
    });
    if (this.pop) this.positionPop();
    this.updateBubble();
  }
}

const AVATARS = 6;
function avatarClass(name: string): string {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `c${n % AVATARS}`;
}
