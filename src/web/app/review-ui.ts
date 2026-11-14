/**
 * The review banner (under the title) and the Review tab, shared by the Markdown page and the design
 * page. Names and notes are set as text (dom.ts). Actions are shown only to those allowed (`can`, from
 * the server). The newer-version flow (spec "Page"): the panel remembers the version the viewer read;
 * when a newer one is current the verdict buttons become "Review vN"; when a verdict loses the race
 * the page says so inline, keeps the typed note, shows the changes and relabels the buttons.
 */
import { ApiError, errorMessage, type Api, type ReviewAction, type ReviewPayload, type ReviewState } from "./api.js";
import { relativeTime } from "./comments.js";
import { append, clear, h } from "./dom.js";
import {
  bannerText,
  EVENT_LABEL,
  isLockedState,
  myCurrentVerdict,
  newerNote,
  pendingLines,
  raceNote,
  reviewerChip,
  STATE_LABEL,
  verdictControls,
} from "./review-model.js";

export interface ReviewHost {
  api: Api;
  banner: HTMLElement;
  panel: HTMLElement;
  showReviewTab(): void;
  showChanges(from: number, to: number): void;
  loadLatest(): Promise<void>;
  /**
   * Locked (approved or archived) changed, or is first known (called once from the constructor), or
   * a locked state changed word (approved to archived and back).
   */
  onLock(locked: boolean, state: ReviewState): void;
  onState(state: ReviewState): void;
}

type Form = "none" | "submit" | "force";

export class ReviewPanel {
  private review: ReviewPayload;
  private read: number;
  private note = "";
  /** The force note as typed: kept across re-renders (a failed force keeps it). */
  private forceNote = "";
  private raced: { verdict: "approve" | "request_changes" } | null = null;
  private form: Form = "none";
  private picked = new Set<string>();
  private approver = "";
  private candidates: { ref: string; name: string; member: boolean }[] | null = null;
  private busy = false;
  private error = "";
  private wasLocked: boolean;

  constructor(
    private readonly host: ReviewHost,
    review: ReviewPayload,
    readVersion: number,
  ) {
    this.review = review;
    this.read = readVersion;
    this.wasLocked = isLockedState(review.state);
    host.onState(review.state);
    host.onLock(this.wasLocked, review.state);
    this.render();
  }

  get locked(): boolean {
    return isLockedState(this.review.state);
  }

  apply(review: ReviewPayload): void {
    const before = this.review.state;
    this.review = review;
    this.host.onState(review.state);
    if (this.locked !== this.wasLocked || (this.locked && review.state !== before)) {
      this.wasLocked = this.locked;
      this.host.onLock(this.locked, review.state);
    }
    this.render();
  }

  /** The viewer published this version themselves: they have read it. */
  markRead(n: number): void {
    this.read = n;
    this.render();
  }

  private render(): void {
    this.renderBanner();
    this.renderPanel();
  }

  private renderBanner(): void {
    const r = this.review;
    const { banner } = this.host;
    clear(banner);
    banner.className = `review-banner state-${r.state}`;
    append(
      banner,
      h("span", { class: `chip review-chip state-${r.state}` }, STATE_LABEL[r.state]),
      h("span", { class: "rb-text" }, bannerText(r)),
      r.can.review && r.currentVersion !== this.read && !this.raced
        ? h("span", { class: "rb-newer", role: "status" }, newerNote(this.read, r.currentVersion))
        : null,
      h("button", { type: "button", class: "link", onClick: () => this.host.showReviewTab() }, "Review details"),
    );
    // A lost race is answered here, beside the changes the Edits tray / History tab now shows:
    // the message, the note as typed and the relabelled buttons (the Review tab shows the same).
    if (this.raced && r.can.review) {
      banner.append(
        h("div", { class: "rb-race", role: "alert" }, raceNote(this.raced.verdict, this.read)),
        this.verdictBox(),
      );
    }
  }

  private renderPanel(): void {
    const r = this.review;
    const { panel } = this.host;
    clear(panel);
    panel.classList.add("rv-panel");
    panel.append(
      h(
        "div",
        { class: "rv-state" },
        h("span", { class: `chip review-chip state-${r.state}` }, STATE_LABEL[r.state]),
        " ",
        bannerText(r),
      ),
    );
    if (this.error) panel.append(h("div", { class: "err tp-err", role: "alert" }, this.error));
    if (this.raced)
      panel.append(h("div", { class: "rv-race", role: "alert" }, raceNote(this.raced.verdict, this.read)));
    if (r.can.review) panel.append(this.verdictBox());
    panel.append(this.actions());
    if (this.form === "submit") panel.append(this.submitForm());
    if (this.form === "force") panel.append(this.forceForm());
    const list = h("ul", { class: "rv-reviewers", aria: { label: "Reviewers" } });
    for (const x of r.reviewers) {
      list.append(
        h(
          "li",
          {},
          h("span", { class: "rv-name" }, x.name),
          h(
            "span",
            { class: `chip verdict-${x.verdict}${x.current ? "" : " older"}` },
            reviewerChip(x, r.currentVersion),
          ),
          x.note ? h("div", { class: "rv-note" }, x.note) : null,
        ),
      );
    }
    if (r.reviewers.length) panel.append(h("h3", {}, "Reviewers"), list);
    if (r.finalApprover) panel.append(h("div", { class: "rv-final" }, `Final approver: ${r.finalApprover.name}`));
    if (r.events.length) {
      panel.append(
        h("h3", {}, "History"),
        h(
          "ul",
          { class: "rv-events" },
          ...r.events.map((e) =>
            h(
              "li",
              {},
              h("span", { class: "rv-when", title: e.createdAt }, relativeTime(e.createdAt)),
              ` ${e.actorName} ${EVENT_LABEL[e.kind] ?? e.kind} v${e.versionNumber}`,
              e.note ? h("div", { class: "rv-note" }, e.note) : null,
            ),
          ),
        ),
      );
    }
  }

  private verdictBox(): HTMLElement {
    const r = this.review;
    const box = h("div", { class: "rv-verdict" });
    const c = verdictControls({
      state: r.state,
      mine: myCurrentVerdict(r),
      read: this.read,
      current: r.currentVersion,
      raced: this.raced !== null,
    });
    if (c.status) box.append(h("div", { class: "rv-mine", role: "status" }, c.status));
    if (!c.review && !c.approve && !c.changes) return box;
    const note = h("textarea", {
      attrs: { placeholder: "Note (optional)", rows: "3" },
      aria: { label: "Review note" },
      onInput: (e) => (this.note = (e.target as HTMLTextAreaElement).value),
    });
    note.value = this.note;
    box.append(note);
    const btn = (label: string, run: () => void, primary: boolean) =>
      h("button", { type: "button", class: primary ? "primary" : "", disabled: this.busy, onClick: run }, label);
    if (c.review) {
      box.append(btn(c.review, () => void this.reviewNewer(), true));
      return box;
    }
    if (c.approve) box.append(btn(c.approve, () => void this.verdict("approve"), true));
    if (c.changes) box.append(btn(c.changes, () => void this.verdict("request_changes"), false));
    return box;
  }

  private actions(): HTMLElement {
    const { can, state } = this.review;
    const bar = h("div", { class: "rv-actions" });
    const btn = (label: string, run: () => void, primary = false) =>
      h("button", { type: "button", class: primary ? "primary" : "", disabled: this.busy, onClick: run }, label);
    if (can.submit)
      bar.append(
        btn(
          state === "draft" ? "Submit for review" : "Edit reviewers",
          () => void this.openSubmit(),
          state === "draft",
        ),
      );
    if (can.force)
      bar.append(
        btn("Force approve", () => {
          this.form = "force";
          this.render();
        }),
      );
    if (can.reopen) bar.append(btn("Reopen for review", () => void this.act({ action: "reopen" }), true));
    if (can.archive) bar.append(btn("Archive", () => void this.act({ action: "archive", archived: true })));
    if (can.unarchive) bar.append(btn("Unarchive", () => void this.act({ action: "archive", archived: false }), true));
    return bar;
  }

  private async openSubmit(): Promise<void> {
    this.form = "submit";
    this.picked = new Set(this.review.reviewers.flatMap((x) => (x.ref ? [x.ref] : [])));
    this.approver = this.review.finalApprover?.ref ?? "";
    try {
      const c = await this.host.api.reviewCandidates();
      this.candidates = [
        ...c.members.map((m) => ({ ref: m.principalId, name: m.name, member: true })),
        ...c.guests.map((g) => ({ ref: `guest:${g.guestId}`, name: `${g.name} (guest)`, member: false })),
      ];
      this.error = "";
    } catch (err) {
      this.error = errorMessage(err);
    }
    this.render();
  }

  private submitForm(): HTMLElement {
    const form = h("div", { class: "rv-form", role: "group", aria: { label: "Reviewers" } }, h("h3", {}, "Reviewers"));
    for (const c of this.candidates ?? []) {
      const box = h("input", {
        type: "checkbox",
        aria: { label: c.name },
        onChange: (e) => {
          if ((e.target as HTMLInputElement).checked) this.picked.add(c.ref);
          else this.picked.delete(c.ref);
          this.render();
        },
      });
      box.checked = this.picked.has(c.ref);
      form.append(h("label", { class: "rv-pick" }, box, c.name));
    }
    const select = h(
      "select",
      { aria: { label: "Final approver" }, onChange: (e) => (this.approver = (e.target as HTMLSelectElement).value) },
      h("option", { attrs: { value: "" } }, "No final approver"),
      ...(this.candidates ?? []).filter((c) => c.member).map((c) => h("option", { attrs: { value: c.ref } }, c.name)),
    );
    select.value = this.approver;
    form.append(h("label", { class: "rv-pick" }, "Final approver (optional) ", select));
    form.append(
      h(
        "div",
        { class: "rv-actions" },
        h(
          "button",
          {
            type: "button",
            class: "primary",
            disabled: this.busy || this.picked.size === 0,
            onClick: () =>
              void this.act({ action: "submit", reviewers: [...this.picked], finalApproverId: this.approver || null }),
          },
          this.review.state === "draft" ? "Submit for review" : "Save reviewers",
        ),
        h(
          "button",
          {
            type: "button",
            onClick: () => {
              this.form = "none";
              this.render();
            },
          },
          "Cancel",
        ),
      ),
    );
    return form;
  }

  private forceForm(): HTMLElement {
    const form = h("div", { class: "rv-form", role: "group", aria: { label: "Force approve" } });
    const lines = pendingLines(this.review);
    form.append(
      h("p", {}, "This approves the current version over:"),
      h("ul", { class: "rv-pending" }, ...lines.map((l) => h("li", {}, l))),
    );
    const note = h("textarea", {
      attrs: { placeholder: "Why (required)", rows: "3" },
      aria: { label: "Force approve note" },
      onInput: () => {
        this.forceNote = note.value;
        confirm.disabled = this.busy || note.value.trim() === "";
      },
    });
    note.value = this.forceNote;
    const confirm = h(
      "button",
      {
        type: "button",
        class: "primary",
        disabled: this.busy || this.forceNote.trim() === "",
        onClick: () => void this.act({ action: "force", note: this.forceNote }),
      },
      "Force approve",
    );
    form.append(
      note,
      h(
        "div",
        { class: "rv-actions" },
        confirm,
        h(
          "button",
          {
            type: "button",
            onClick: () => {
              this.form = "none";
              this.render();
            },
          },
          "Cancel",
        ),
      ),
    );
    return form;
  }

  /** Runs one action; never throws. Returns the error code on failure (shown in the panel unless the caller handles it). */
  private async act(body: ReviewAction): Promise<string | null> {
    if (this.busy) return "busy";
    this.busy = true;
    this.error = "";
    this.render();
    try {
      const out = await this.host.api.review(body);
      this.form = "none";
      this.forceNote = "";
      this.busy = false;
      this.apply(out.review);
      return null;
    } catch (err) {
      this.busy = false;
      this.error = errorMessage(err);
      this.render();
      return err instanceof ApiError ? err.code : "internal_error";
    }
  }

  private async verdict(verdict: "approve" | "request_changes"): Promise<void> {
    const note = this.note.trim() ? this.note : undefined;
    const code = await this.act({ action: "verdict", verdict, versionNumber: this.read, ...(note ? { note } : {}) });
    if (code === null) {
      this.note = "";
      this.raced = null;
      this.render();
      return;
    }
    if (code !== "document_version_conflict") return;
    // Lost the race: inline (not a toast), the note stays typed, the page loads the latest version,
    // the changes since the version they read open, and the buttons name the new version.
    const conflictError = this.error;
    this.error = "";
    const before = this.read;
    await this.host.loadLatest();
    if (this.review.currentVersion === before) {
      // The refetch failed or was put off (the page is saving): the newer version is not known yet,
      // so there is nothing to show. The usual message stands; the note stays typed.
      this.error = conflictError;
      this.render();
      return;
    }
    this.read = this.review.currentVersion;
    this.raced = { verdict };
    this.host.showChanges(before, this.read);
    this.render();
  }

  private async reviewNewer(): Promise<void> {
    const before = this.read;
    await this.host.loadLatest();
    this.read = this.review.currentVersion;
    this.host.showChanges(before, this.read);
    this.render();
  }
}
