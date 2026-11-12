/**
 * The Edits tray: the document's versions (grouped, newest first) beside the
 * Comments tray, and the read-only view of one version with its changes
 * against the version before, with Restore.
 *
 * Version text is only ever shown through a read-only Tiptap editor (text
 * nodes; deleted words are set with textContent), never as HTML. Names and
 * summaries are set as text by dom.ts.
 */
import type { Editor } from "@tiptap/core";
import { errorMessage, ApiError, type Api } from "./api.js";
import { append, clear, h } from "./dom.js";
import { createVersionViewer } from "./editor.js";
import { ago, describeRow, groupVersions, parseMarkdown, plainOf, type EditRow, type VersionItem } from "./history.js";

export interface EditsHost {
  api: Api;
  /** The tray's panel. */
  panel: HTMLElement;
  /** The bar is shown at the top of the stage; the version replaces the editor inside the page. */
  stage: HTMLElement;
  page: HTMLElement;
  /** Elements hidden while a version is shown (the live editor, the comment badges). */
  live: HTMLElement[];
  /** Write access as a member (guests and readers see the tray and changes, but no Restore). */
  canRestore(): boolean;
  /** The latest version the page shows (restore's base) and whether unsaved edits are pending. */
  latest(): { number: number; busy: boolean };
  /** Called when a version view opens or closes. */
  onViewing(viewing: boolean): void;
  /** After a restore: the page loads the new version. */
  onRestored(): void;
  /** Opens a thread by number in the Comments tray. */
  openThread(number: number): void;
}

interface Viewing {
  row: EditRow;
  number: number;
  since: number | null;
  editor: Editor;
  el: HTMLElement;
  confirm: boolean;
  error: string;
  busy: boolean;
}

export class EditsTray {
  private items: VersionItem[] = [];
  private nextBefore: number | undefined;
  private loaded = false;
  private loading = false;
  private error = "";
  private viewing: Viewing | null = null;
  /** Version Markdown by number: versions never change. */
  private texts = new Map<number, string>();
  private seq = 0;
  private readonly bar: HTMLElement;

  constructor(private readonly host: EditsHost) {
    this.bar = h("div", { class: "vbar", hidden: true, role: "region", aria: { label: "Version" } });
    host.stage.prepend(this.bar);
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !this.viewing) return;
      // An open popover or menu closes first (comments-ui handles those).
      if (document.querySelector(".cpop")) return;
      e.preventDefault();
      if (this.viewing.confirm) {
        this.viewing.confirm = false;
        this.renderBar();
      } else this.back();
    });
  }

  get isViewing(): boolean {
    return this.viewing !== null;
  }

  /** Loads the first page the first time the tray is opened. */
  async open(): Promise<void> {
    if (!this.loaded && !this.loading) await this.fetchFirst();
    else this.render();
  }

  /** A new version (live event, save or restore): refetches the newest page, keeping older pages already loaded. */
  async refresh(): Promise<void> {
    if (this.loaded) await this.fetchFirst();
  }

  private async fetchFirst(): Promise<void> {
    this.loading = true;
    this.render();
    try {
      const page = await this.host.api.versions();
      const oldest = page.versions[page.versions.length - 1]?.number ?? 0;
      const kept = this.loaded ? this.items.filter((v) => v.number < oldest) : [];
      this.items = [...page.versions, ...kept];
      if (!this.loaded || kept.length === 0) this.nextBefore = page.nextBefore;
      this.loaded = true;
      this.error = "";
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.loading = false;
    }
    this.render();
  }

  private async loadOlder(): Promise<void> {
    if (this.nextBefore === undefined || this.loading) return;
    this.loading = true;
    this.render();
    try {
      const page = await this.host.api.versions(this.nextBefore);
      this.items = [...this.items, ...page.versions.filter((v) => !this.items.some((x) => x.number === v.number))];
      this.nextBefore = page.nextBefore;
      this.error = "";
    } catch (err) {
      this.error = errorMessage(err);
    } finally {
      this.loading = false;
    }
    this.render();
  }

  // ---- the list ---------------------------------------------------------------------

  render(): void {
    const { panel } = this.host;
    clear(panel);
    if (this.error) panel.append(h("div", { class: "err tp-err", role: "alert" }, this.error));
    const rows = h("div", { class: "tp-list" });
    const grouped = groupVersions(this.items);
    if (grouped.length === 0) {
      rows.append(h("div", { class: "tp-empty" }, this.loading ? "Loading…" : this.loaded ? "No versions." : ""));
    }
    const latest = this.items[0]?.number;
    for (const row of grouped) rows.append(this.rowEl(row, row.last === latest));
    panel.append(rows);
    if (this.nextBefore !== undefined) {
      panel.append(
        h(
          "div",
          { class: "tp-more" },
          h(
            "button",
            { type: "button", disabled: this.loading, onClick: () => void this.loadOlder() },
            this.loading ? "Loading…" : "Show older edits",
          ),
        ),
      );
    }
    panel.append(h("div", { class: "tp-help" }, "Click an edit to see what changed · Esc: back to latest"));
  }

  private rowEl(row: EditRow, isLatest: boolean): HTMLElement {
    const { versions, parts } = describeRow(row);
    const newest = row.items[0];
    const threads = [...new Set(row.items.flatMap((v) => v.answeredThreads))];
    const on = this.viewing && this.viewing.row.first === row.first && this.viewing.row.last === row.last;
    const label = `${versions} · ${parts.join(" · ")}`;
    return h(
      "div",
      {
        class: `tp-row ed-row${on ? " on" : ""}`,
        role: "button",
        tabIndex: 0,
        aria: { label: `${label}, ${ago(newest.createdAt)}` },
        onClick: (e) => {
          if ((e.target as Element).closest("button")) return;
          void this.view(row);
        },
        onKeyDown: (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void this.view(row);
          }
        },
      },
      h(
        "div",
        { class: "a" },
        h("span", { class: "vn" }, versions),
        isLatest ? h("span", { class: "chip" }, "latest") : null,
      ),
      h("div", { class: "t" }, parts.join(" · ")),
      h(
        "div",
        { class: "m" },
        h("span", {}, ago(newest.createdAt)),
        ...threads.map((n) =>
          h(
            "button",
            {
              type: "button",
              class: "link",
              aria: { label: `Open thread ${n}` },
              onClick: () => {
                this.back();
                this.host.openThread(n);
              },
            },
            `for thread #${n}`,
          ),
        ),
      ),
    );
  }

  // ---- one version ------------------------------------------------------------------

  private async text(number: number): Promise<string> {
    const known = this.texts.get(number);
    if (known !== undefined) return known;
    const r = await this.host.api.version(number);
    this.texts.set(number, r.version.markdown);
    return r.version.markdown;
  }

  /** Shows the row's newest version read-only, with its changes since the version before the row. */
  async view(row: EditRow): Promise<void> {
    const seq = ++this.seq;
    const since = row.first > 1 ? row.first - 1 : null;
    let markdown: string;
    let before: string | null;
    try {
      [markdown, before] = await Promise.all([
        this.text(row.last),
        since === null ? Promise.resolve(null) : this.text(since),
      ]);
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = errorMessage(err);
      this.render();
      return;
    }
    if (seq !== this.seq) return;
    this.close();
    const el = h("div", { class: "editor version-view" });
    this.host.page.append(el);
    for (const x of this.host.live) x.hidden = true;
    const editor = createVersionViewer(el, markdown, before === null ? null : plainOf(parseMarkdown(before)));
    this.viewing = { row, number: row.last, since, editor, el, confirm: false, error: "", busy: false };
    this.host.onViewing(true);
    this.host.stage.scrollTop = 0;
    this.renderBar();
    this.render();
  }

  private close(): void {
    if (!this.viewing) return;
    this.viewing.editor.destroy();
    this.viewing.el.remove();
    this.viewing = null;
  }

  /** Back to the latest version (the live editor). */
  back(): void {
    if (!this.viewing) return;
    this.close();
    for (const x of this.host.live) x.hidden = false;
    this.bar.hidden = true;
    clear(this.bar);
    this.host.onViewing(false);
    this.render();
  }

  private renderBar(): void {
    const v = this.viewing;
    if (!v) return;
    clear(this.bar);
    this.bar.hidden = false;
    const latest = this.host.latest();
    const canRestore = this.host.canRestore() && v.number !== latest.number;
    if (v.confirm) {
      append(
        this.bar,
        h("span", { class: "vb-text" }, `Restore v${v.number} as a new version?`),
        h(
          "button",
          { type: "button", class: "primary", disabled: v.busy, onClick: () => void this.restore() },
          v.busy ? "Restoring…" : "Restore",
        ),
        h(
          "button",
          {
            type: "button",
            disabled: v.busy,
            onClick: () => {
              v.confirm = false;
              v.error = "";
              this.renderBar();
            },
          },
          "Cancel",
        ),
      );
    } else {
      append(
        this.bar,
        h(
          "span",
          { class: "vb-text" },
          h("b", {}, `Viewing v${v.number}`),
          v.since === null ? " — the first version" : ` — changes since v${v.since}`,
        ),
        h("span", { class: "vb-key" }, h("span", { class: "diff-ins" }, "added"), " ", h("del", {}, "removed")),
        canRestore
          ? h(
              "button",
              {
                type: "button",
                onClick: () => {
                  v.confirm = true;
                  v.error = "";
                  this.renderBar();
                },
              },
              "Restore this version",
            )
          : null,
        h("button", { type: "button", class: "primary", onClick: () => this.back() }, "Back to latest"),
      );
    }
    if (v.error) this.bar.append(h("span", { class: "err", role: "alert" }, v.error));
  }

  private async restore(): Promise<void> {
    const v = this.viewing;
    if (!v || v.busy) return;
    const latest = this.host.latest();
    if (latest.busy) {
      v.error = "Wait until your edits are saved, then restore.";
      this.renderBar();
      return;
    }
    v.busy = true;
    v.error = "";
    this.renderBar();
    try {
      await this.host.api.restore(v.number, latest.number);
      v.busy = false;
      this.back();
      this.host.onRestored();
      void this.refresh();
    } catch (err) {
      v.busy = false;
      v.confirm = false;
      v.error =
        err instanceof ApiError && err.code === "document_version_conflict"
          ? "Someone published a newer version. Check the list, then try again."
          : errorMessage(err);
      this.renderBar();
      void this.refresh();
    }
  }
}
