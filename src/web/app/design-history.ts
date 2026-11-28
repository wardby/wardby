/**
 * A design's version history: the History tab (versions grouped and worded as the document Edits tray
 * does, from version-rows.ts), the read-only view of an older version, and Restore.
 *
 * An older version is shown in a layer over the canvas, as sandboxed frames from the server (frames.ts,
 * overview mode: no script, no links), one board at a time; the editor under it is not touched and
 * cannot be reached (the page makes it inert while this is open). Restore publishes the old files as a
 * new version through the same route as documents. Names and summaries are text (dom.ts).
 */
import { ApiError, errorMessage, type Api, type FrameBoard } from "./api.js";
import { append, clear, h } from "./dom.js";
import { openOverlay, type Overlay } from "./overlay.js";
import { ago, describeRow, groupVersions, type EditRow, type VersionItem } from "./version-rows.js";

export interface DesignHistoryHost {
  api: Api;
  /** The History tab's panel. */
  panel: HTMLElement;
  /** The element the older version covers (the canvas area). */
  stage: HTMLElement;
  /** Write access as a member (others see the list and versions, but no Restore). */
  canRestore(): boolean;
  /** The latest version the page shows (restore's base) and whether unsaved edits or a check are pending. */
  latest(): { number: number; busy: boolean };
  /** Called when an older version opens or closes (the page suspends comments and locks editing). */
  onViewing(viewing: boolean): void;
  /** After a restore: the page loads the new version. */
  onRestored(): void;
}

interface Viewing {
  number: number;
  frames: FrameBoard[];
  /** Shown as the changes since this version (Review vN): the boards whose HTML differs from it. */
  since: { number: number; changed: Set<string> } | null;
  board: string;
  confirm: boolean;
  error: string;
  busy: boolean;
  overlay: Overlay;
  bar: HTMLElement;
  stageEl: HTMLElement;
}

export class DesignHistory {
  private items: VersionItem[] = [];
  private nextBefore: number | undefined;
  private loaded = false;
  private loading = false;
  private error = "";
  private viewing: Viewing | null = null;
  private seq = 0;

  constructor(private readonly host: DesignHistoryHost) {}

  get isViewing(): boolean {
    return this.viewing !== null;
  }

  /** The older version shown and its board on screen, or null when the page shows the latest. */
  viewed(): { board: string; version: number } | null {
    return this.viewing ? { board: this.viewing.board, version: this.viewing.number } : null;
  }

  /** Loads the first page the first time the tab is opened. */
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
    panel.append(h("div", { class: "tp-help" }, "Click an edit to see that version · Esc: back to latest"));
  }

  private rowEl(row: EditRow, isLatest: boolean): HTMLElement {
    const { versions, parts } = describeRow(row);
    const newest = row.items[0];
    const on = this.viewing !== null && this.viewing.number === row.last;
    const label = `${versions} · ${parts.join(" · ")}`;
    return h(
      "div",
      {
        class: `tp-row ed-row${on ? " on" : ""}`,
        role: "button",
        tabIndex: 0,
        data: { version: String(row.last) },
        aria: { label: `${label}, ${ago(newest.createdAt)}` },
        onClick: () => void this.view(row.last),
        onKeyDown: (e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            void this.view(row.last);
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
      h("div", { class: "m" }, h("span", {}, ago(newest.createdAt))),
    );
  }

  // ---- one version ------------------------------------------------------------------

  /**
   * Shows version `number` read-only. With `since` (an earlier version), the boards that differ from it
   * (changed or added) are marked, and the first of them is shown.
   */
  async view(number: number, since?: number): Promise<void> {
    const seq = ++this.seq;
    let frames: FrameBoard[];
    let changes: Viewing["since"] = null;
    try {
      const [shown, earlier] = await Promise.all([
        this.host.api.frames("overview", number),
        since !== undefined && since < number ? this.host.api.frames("overview", since) : null,
      ]);
      frames = shown;
      if (earlier && since !== undefined) {
        const before = new Map(earlier.map((f) => [f.id, f.html]));
        changes = {
          number: since,
          changed: new Set(frames.filter((f) => before.get(f.id) !== f.html).map((f) => f.id)),
        };
      }
    } catch (err) {
      if (seq !== this.seq) return;
      this.error = errorMessage(err);
      this.render();
      return;
    }
    if (seq !== this.seq) return;
    this.close();
    const root = this.host.stage;
    const overlay = openOverlay(
      root,
      { className: "version-view", label: `Version ${number}`, swallowKeys: false, role: "region" },
      () => this.escape(),
    );
    const bar = h("div", { class: "vbar", role: "region", aria: { label: "Version" } });
    const stageEl = h("div", { class: "vv-stage" });
    overlay.el.append(bar, stageEl);
    this.viewing = {
      number,
      frames,
      since: changes,
      board: (frames.find((f) => changes?.changed.has(f.id)) ?? frames[0])?.id ?? "",
      confirm: false,
      error: "",
      busy: false,
      overlay,
      bar,
      stageEl,
    };
    this.host.onViewing(true);
    this.renderBar();
    this.renderStage();
    this.render();
  }

  private escape(): void {
    const v = this.viewing;
    if (!v) return;
    if (v.confirm) {
      v.confirm = false;
      this.renderBar();
    } else this.back();
  }

  private close(): void {
    if (!this.viewing) return;
    this.viewing.overlay.dispose();
    this.viewing = null;
  }

  /** Back to the latest version (the editor). */
  back(): void {
    if (!this.viewing) return;
    this.seq++;
    this.close();
    this.host.onViewing(false);
    this.render();
  }

  private renderStage(): void {
    const v = this.viewing;
    if (!v) return;
    clear(v.stageEl);
    if (v.frames.length === 0) {
      v.stageEl.append(h("p", { class: "ov-empty" }, "This version has no boards."));
      return;
    }
    const picks = v.frames.map((f) =>
      h(
        "button",
        {
          type: "button",
          class: f.id === v.board ? "on" : "",
          data: { board: f.id, ...(v.since?.changed.has(f.id) ? { changed: "" } : {}) },
          aria: { pressed: String(f.id === v.board) },
          onClick: () => {
            v.board = f.id;
            this.renderStage();
          },
        },
        f.name,
        v.since?.changed.has(f.id) ? " · changed" : "",
      ),
    );
    const board = v.frames.find((f) => f.id === v.board) ?? v.frames[0];
    const frame = h("iframe", { class: "vv-frame", title: `${board.name} (version ${v.number})` });
    // Empty sandbox: no script, no same-origin, no navigation. The HTML only ever goes to srcdoc.
    frame.setAttribute("sandbox", "");
    frame.srcdoc = board.html;
    frame.style.width = `${board.width}px`;
    append(
      v.stageEl,
      h("div", { class: "vv-boards group", role: "group", aria: { label: "Boards" } }, ...picks),
      frame,
    );
  }

  private renderBar(): void {
    const v = this.viewing;
    if (!v) return;
    clear(v.bar);
    const latest = this.host.latest();
    // The latest version itself (the review's changes since a verdict): nothing to go back to, only Done.
    const atLatest = v.number === latest.number;
    const canRestore = this.host.canRestore() && !atLatest;
    if (v.confirm) {
      append(
        v.bar,
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
        v.bar,
        h(
          "span",
          { class: "vb-text" },
          h("b", {}, `Viewing v${v.number}${atLatest ? " (latest)" : ""}`),
          v.since ? ` — changes since v${v.since.number}` : v.number === 1 ? " — the first version" : "",
        ),
        canRestore
          ? h(
              "button",
              {
                type: "button",
                data: { action: "restore" },
                onClick: () => {
                  v.confirm = true;
                  v.error = "";
                  this.renderBar();
                },
              },
              "Restore this version",
            )
          : null,
        h(
          "button",
          { type: "button", class: "primary", onClick: () => this.back() },
          atLatest ? "Done" : "Back to latest",
        ),
      );
    }
    if (v.error) v.bar.append(h("span", { class: "err", role: "alert" }, v.error));
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
