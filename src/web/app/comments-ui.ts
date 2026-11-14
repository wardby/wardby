/**
 * The comment dialog, one for documents and designs: the composer and thread
 * popover (with the ⋯ menu and @mention list) and the threads panel. What is
 * commented on (highlights or pins, the gesture that starts a comment, margin
 * badges) is the anchoring surface's (surface.ts): text-surface.ts for documents.
 */
import {
  ApiError,
  errorMessage,
  type Anchor,
  type Api,
  type DocumentPayload,
  type ThreadView,
  type Viewer,
} from "./api.js";
import {
  candidateFrom,
  decodeMentions,
  encodeMentions,
  initials,
  mentionQuery,
  previewText,
  relativeTime,
  type MentionCandidate,
} from "./comments.js";
import { append, clear, h, placeAt, renderBody, trapFocus } from "./dom.js";
import type { AnchorSurface, DraftStart } from "./surface.js";

const RANK: Record<string, number> = { none: 0, read: 1, comment: 2, write: 3, owner: 4 };
export const atLeast = (access: string, need: string) => (RANK[access] ?? 0) >= RANK[need];

type Filter = "open" | "all" | "resolved" | "sent" | "mine";
const FILTERS: [Filter, string][] = [
  ["open", "Open"],
  ["all", "All"],
  ["resolved", "Resolved"],
  ["sent", "Sent to agent"],
  ["mine", "Mine"],
];
const POLL_MS = 15_000;
/** Shown in the composer while a guest changes their name. */
export const GUEST_RENAME_NOTE = "Earlier comments stay under your old name.";
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
  /** What is commented on: marks, the gesture that starts a comment, where a popover opens. */
  surface: AnchorSurface;
  shareToken?: string;
  /** Elements the dialog draws into. */
  stage: HTMLElement;
  page: HTMLElement;
  panel: HTMLElement;
  count: HTMLElement;
  /** Called when the viewer changes (guest registration). */
  onViewer(viewer: Viewer): void;
  /** Leaves an earlier version shown in the Edits tray and returns to the latest, so a thread can be positioned. */
  returnToLatest?(): void;
}

interface Pop {
  el: HTMLElement;
  kind: "draft" | "thread";
  threadId?: string;
  /** The draft's anchor and quote (drafts only). */
  start?: DraftStart;
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
  /** Shown names by mention ref: members from /mentions, this document's guests from the payload. */
  private names = new Map<string, string>();
  private candidates: MentionCandidate[] = [];
  private filter: Filter = "open";
  private selected: string | null = null;
  private checked = new Set<string>();
  private pop: Pop | null = null;
  private layoutQueued = false;
  private panelError = "";
  /** True while the Edits tray shows an earlier version: no comment button, badges or new comments. */
  private suspended = false;

  constructor(
    private readonly host: CommentsHost,
    viewer: Viewer,
  ) {
    this.viewer = viewer;
    this.wire();
  }

  private get surface(): AnchorSurface {
    return this.host.surface;
  }

  /** A comment body as one line of plain text, with mentions named (badge and pin tooltips). */
  preview(body: string): string {
    return previewText(body, this.names);
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
    for (const g of payload.mentionedGuests ?? []) this.names.set(`guest:${g.guestId}`, `${g.name} (guest)`);
    for (const id of [...this.checked]) if (!this.threads.some((t) => t.id === id)) this.checked.delete(id);
    this.render();
  }

  async loadMentions(): Promise<void> {
    // Only members get an @-list (members and guests who commented here); guests get none (the server sends none).
    if (this.viewer.kind !== "member" || !this.canComment) return;
    try {
      const r = await this.host.api.mentions();
      // Members, then the guests who commented on this document (shown as "<name> (guest)").
      this.candidates = r.candidates.flatMap((c) => {
        const cand = candidateFrom(c);
        return cand ? [cand] : [];
      });
      for (const c of this.candidates) this.names.set(c.ref, c.name);
      this.render();
    } catch {
      // Mentions are optional: names fall back to "@member".
    }
  }

  async reload(): Promise<void> {
    const payload = await this.host.api.load();
    this.apply(payload);
  }

  /** Polls while an agent is working on a thread, unless `isLive()` says live updates already cover it. */
  startPolling(isLive: () => boolean = () => false): void {
    setInterval(() => {
      if (document.hidden || isLive() || !this.threads.some((t) => this.working(t))) return;
      this.reload().catch(() => undefined);
    }, POLL_MS);
  }

  // ---- marks -------------------------------------------------------------------

  /** Tells the surface what to mark: the threads, the draft, the active one, and whether a comment can start. */
  private mark(): void {
    const draft = this.pop?.kind === "draft" ? (this.pop.start?.anchor ?? null) : null;
    this.surface.mark({
      threads: this.threads,
      draft,
      active: this.pop?.kind === "draft" ? "draft" : this.selected,
      canStart: !this.pop && this.canComment && !this.suspended,
    });
    this.scheduleLayout();
  }

  // ---- wiring -----------------------------------------------------------------

  private wire(): void {
    this.surface.connect({
      activate: (id) => {
        const t = this.threads.find((x) => x.id === id);
        if (t) this.openThread(t);
      },
      start: () => this.startComment(),
      layout: () => this.scheduleLayout(),
      relist: () => this.renderPanel(),
    });

    document.addEventListener("mousedown", (e) => {
      const target = e.target as Element;
      if (!this.pop) return;
      if (this.pop.el.contains(target)) {
        if (this.pop.menuOpen && !target.closest(".menu, [data-act=menu]")) this.setMenu(false);
        return;
      }
      // The panel's rows and the surface's marks open a thread themselves: no close, then reopen.
      if (target.closest?.(".tp-row") || this.surface.isMark(target)) return;
      this.closePop();
    });

    document.addEventListener("keydown", (e) => this.onKey(e));
  }

  private onKey(e: KeyboardEvent): void {
    const target = e.target as HTMLElement;
    const typing = !!target.closest?.("textarea, input, [contenteditable=true]");
    if (e.key === "Escape" && this.pop) {
      if (this.pop.suggest) return; // the textarea handler closes the list first
      e.preventDefault();
      if (this.pop.menuOpen) this.setMenu(false);
      else this.closePop();
      return;
    }
    if (this.suspended) return;
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "j" || e.key === "k")) {
      const list = this.visible();
      if (list.length === 0) return;
      e.preventDefault();
      const i = list.findIndex((t) => t.id === this.selected);
      const n = i < 0 ? 0 : e.key === "j" ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
      this.reveal(list[n]);
      return;
    }
    // Keys the surface owns, after the dialog's own.
    if (this.surface.key?.(e, typing)) e.preventDefault();
  }

  // ---- starting a comment ----------------------------------------------------------

  startComment(): void {
    if (!this.canComment || this.suspended) return;
    const made = this.surface.draft();
    if (made === null) return;
    if (typeof made === "string") {
      this.flashPanel(made);
      return;
    }
    this.openPop({ kind: "draft", start: made });
  }

  // ---- popover ------------------------------------------------------------------

  private openThread(t: ThreadView): void {
    // The editor shows an earlier version while suspended: the thread's highlight is not there.
    if (this.suspended) this.host.returnToLatest?.();
    this.openPop({ kind: "thread", threadId: t.id });
  }

  private openPop(init: Pick<Pop, "kind" | "threadId" | "start">): void {
    const returnFocus = this.pop?.returnFocus ?? document.activeElement;
    if (this.pop) {
      this.pop.el.remove();
      this.pop = null;
    }
    const el = h("div", { class: "cpop", role: "dialog", aria: { modal: "false", label: "Comment" } });
    el.addEventListener("keydown", (e) => trapFocus(el, e));
    this.pop = { el, ...init, picked: [], returnFocus };
    this.selected = init.kind === "thread" ? (init.threadId ?? null) : null;
    // The draft (or the thread, made active) is marked before the popover is placed at it.
    this.mark();
    document.body.appendChild(el);
    this.renderPop();
    this.positionPop();
    const focus =
      el.querySelector<HTMLElement>("input[data-name], textarea") ?? el.querySelector<HTMLElement>("button");
    focus?.focus();
    this.renderPanel();
  }

  closePop(): void {
    if (!this.pop) return;
    const { el, returnFocus } = this.pop;
    el.remove();
    this.pop = null;
    this.selected = null;
    this.mark();
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
    const at = this.surface.point(id);
    const el = this.pop.el;
    let x: number;
    let y: number;
    if (at) {
      x = at.x;
      y = at.y;
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
          h("b", {}, this.surface.label(isDraft ? pop.start! : t!, 60)),
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
      attrs: {
        placeholder: (isDraft ? "Add a comment…" : "Reply…") + (this.viewer.kind === "member" ? " (@ to mention)" : ""),
        maxlength: "10000",
      },
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
      // "change" registers a new guest; the old name stays on what was already posted.
      if (pop.changingName && this.viewer.kind === "guest") {
        identity.push(h("div", { class: "as" }, GUEST_RENAME_NOTE));
      }
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
    if (!pop || this.viewer.kind !== "member") return;
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
    if (!pop.picked.some((x) => x.ref === p.ref)) pop.picked.push(p);
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
      const r = await this.host.api.createThread(pop.start!.anchor, body, send);
      await this.afterCreate(r.threadId, undefined);
    } catch (err) {
      if (send && err instanceof ApiError && SEND_AFTER_CREATE.has(err.code)) {
        // The thread was stored; only the send failed. Show it with the reason.
        await this.reload().catch(() => undefined);
        // Matched on the anchor itself: labels can repeat (two pins on elements with the same words).
        // The server redacts secret values out of an anchor, so failing that, the one new thread of mine.
        const anchor = anchorKey(pop.start!.anchor);
        const mine = this.threads.filter((t) => !before.has(t.id) && t.comments[0]?.mine);
        const created = mine.find((t) => anchorKey(t.anchor) === anchor) ?? (mine.length === 1 ? mine[0] : undefined);
        if (created) return this.afterCreate(created.id, errorMessage(err));
      }
      throw err;
    }
  }

  private async afterCreate(threadId: string, error: string | undefined): Promise<void> {
    // The draft's mark stays until the reload: the surface hands it to the new thread (no flicker).
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
          // Unmarked at once, before the reload.
          this.threads = this.threads.map((x) => (x.id === t.id ? { ...x, status: "resolved" } : x));
          this.mark();
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
    const c = { open: 0, all: this.threads.length, resolved: 0, sent: 0, mine: 0 };
    for (const t of this.threads) {
      if (t.status === "resolved") c.resolved++;
      else c.open++;
      if (t.sentAt) c.sent++;
      if (t.comments.some((x) => x.mine)) c.mine++;
    }
    return c;
  }

  private visible(): ThreadView[] {
    if (this.filter === "all") return [...this.threads];
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

  /** Brings a thread's anchor into view and opens it. */
  reveal(t: ThreadView): void {
    this.surface.reveal(t);
    this.openThread(t);
  }

  /** Hides the surface's marks and start affordance and the popover while an earlier version is shown; layout resumes after. */
  suspend(on: boolean): void {
    this.suspended = on;
    if (on) this.closePop();
    this.surface.suspend?.(on);
    this.mark();
  }

  /** Opens a thread by its number (the Edits tray's "for thread #N"). */
  revealNumber(number: number): void {
    const t = this.threads.find((x) => x.number === number);
    if (t) this.reveal(t);
  }

  /** Opens the thread a #thread-<n> link points at. */
  openFromHash(): void {
    const m = /^#thread-(\d+)$/.exec(location.hash);
    const t = m ? this.threads.find((x) => x.number === Number(m[1])) : undefined;
    if (t) this.reveal(t);
  }

  render(): void {
    this.mark();
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
              ? `No open comments. ${this.surface.emptyHint()}`
              : "No open comments."
            : "Nothing here.",
        ),
      );
    }
    for (const t of list) {
      const first = t.comments[0];
      const last = t.comments[t.comments.length - 1];
      const located = t.status === "open" && this.surface.located(t.id);
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
          this.surface.label(t, 40),
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
          ? `${this.surface.keysHint()} · J / K: next / previous · Esc: close`
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
    if (this.pop) this.positionPop();
  }
}

/** An anchor as text with its keys sorted: equal anchors give equal keys, whatever the key order. */
function anchorKey(anchor: Anchor): string {
  const a = anchor as unknown as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(a)
      .sort()
      .map((k) => [k, a[k]]),
  );
}

const AVATARS = 6;
function avatarClass(name: string): string {
  let n = 0;
  for (const ch of name) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return `c${n % AVATARS}`;
}
