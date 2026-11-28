/**
 * The review banner (under the title) and the Review tab, shared by the Markdown page and the design
 * page. Names and notes are set as text (dom.ts). Actions are shown only to those allowed (`can`, from
 * the server). The newer-version flow (spec "Page"): the panel remembers the version the viewer read,
 * which follows the version the page shows (live updates show a newer one in place); when a newer one
 * is current but not shown (unsaved edits, a conflict) the verdict buttons become "Review vN"; when a
 * verdict loses the race the page says so inline, keeps the typed note, shows the changes and relabels
 * the buttons.
 */
import { ApiError, errorMessage, type Api, type ReviewAction, type ReviewPayload, type ReviewState } from "./api.js";
import { relativeTime } from "./comments.js";
import { append, clear, h } from "./dom.js";
import type { PlanSetPayload } from "../../core/plans/page-payload.js";
import { chooseStep, type ChooseStepState } from "./choose-ui.js";
import { icon, type IconName } from "./icons.js";
import {
  bannerText,
  EVENT_LABEL,
  ASK_TO_REOPEN,
  REJECT_EXPLAIN,
  REJECTED_NOTE,
  OPTION_REJECT_EXPLAIN,
  OPTION_REJECTED_NOTE,
  alternativeSets,
  chooseCandidates,
  choiceResult,
  type ChooseCandidate,
  type SetKind,
  isLockedState,
  isReopenCopy,
  lockBannerText,
  matchesQuery,
  myCurrentVerdict,
  myVerdictVersion,
  newerNote,
  PICKER,
  pendingLines,
  raceNote,
  reviewerChip,
  STATE_LABEL,
  verdictControls,
} from "./review-model.js";

/** A job's refusal code in plain words. */
const ROUTING_REFUSAL: Record<string, string> = {
  review_route_limit: "Stopped: this decision started the most agents its router allows.",
  review_router_invalid: "Not routed: the router is no longer a router.",
  run_refused: "Not routed: the router's run was refused (budget).",
  run_failed: "Not routed: the router's run failed to start.",
  route_failed: "Not routed: something went wrong starting the router.",
};

/** The review panel's button styles (styles.css, under .rv-panel / .review-banner). */
type ButtonVariant = "primary" | "tonal" | "neutral" | "danger";

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
  /** The plan's documents (the plan bar's), for "Choose this option"; none outside a plan. */
  planDocuments?(): PlanSetPayload["documents"];
  /** The kind of set the plan bar shows (a native option set's "options"); "plan" when absent. */
  planKind?(): SetKind;
  /** The banner at the top of the page, shown while the document is locked (lockBannerText); hidden otherwise. */
  lockBanner?: HTMLElement;
  /** The linked agent's name the page may show (DocumentPayload.document.agentName), or null. */
  agentName?(): string | null;
}

type Form = "none" | "submit" | "force" | "reject" | "choose" | "reopen" | "archive";

export class ReviewPanel {
  private review: ReviewPayload;
  private read: number;
  private note = "";
  /** The force note as typed: kept across re-renders (a failed force keeps it). */
  private forceNote = "";
  /** The reject note as typed: kept across re-renders (a failed reject keeps it). */
  private rejectNote = "";
  /** The documents ticked in the "Choose this option" checklist (ids), and its optional note. */
  private chooseState: ChooseStepState = { ticks: new Set(), note: "" };
  /** What the last choice made here did, shown in the next-step card until the next action. */
  private lastChoice: string | null = null;
  private raced: { verdict: "approve" | "request_changes" } | null = null;
  private form: Form = "none";
  private picked = new Set<string>();
  private approver = "";
  private candidates: { ref: string; name: string; member: boolean }[] | null = null;
  /** The picker's search, kept across re-renders. */
  private query = "";
  /** A comment link made from the picker: its URL is answered once, so it is kept until the picker closes. */
  private newLink: string | null = null;
  private copied = false;
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
    // A reopen's copy of the version read holds the same content: it counts as read.
    if (isReopenCopy(review, this.read, review.currentVersion)) this.read = review.currentVersion;
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

  /** The page now shows this version (a live update loaded it in place): it counts as read. */
  showing(n: number): void {
    if (n === this.read) return;
    this.read = n;
    this.render();
  }

  private render(): void {
    this.renderBanner();
    this.renderLockBanner();
    this.renderPanel();
  }

  /**
   * Why a locked page can't be edited, at the top of the page, and the way out when the viewer has one: Reopen
   * for review opens the Review tab's confirm step (never a reopen in one click); Unarchive is the same action as
   * the Archived card's.
   */
  private renderLockBanner(): void {
    const el = this.host.lockBanner;
    if (!el) return;
    const r = this.review;
    const b = lockBannerText({
      state: r.state,
      version: r.currentVersion,
      canAct: r.state === "archived" ? r.can.unarchive : r.can.reopen,
      agentName: this.host.agentName?.() ?? null,
    });
    clear(el);
    el.hidden = b === null;
    if (!b) return;
    el.append(b.text);
    if (!b.action) return;
    const action = b.action;
    el.append(
      " ",
      h(
        "button",
        {
          type: "button",
          disabled: this.busy,
          onClick: () =>
            action.kind === "reopen" ? this.startReopen() : void this.act({ action: "archive", archived: false }),
        },
        action.label,
      ),
      action.after,
    );
  }

  /** Opens the Review tab on the Reopen for review confirm step (the lock banner's button). */
  startReopen(): void {
    this.host.showReviewTab();
    this.open("reopen");
  }

  private renderBanner(): void {
    const r = this.review;
    const { banner } = this.host;
    clear(banner);
    banner.className = `review-banner state-${r.state}`;
    // The review status sits in the top bar beside the title: the state and its progress, opening the Review tab.
    append(
      banner,
      h(
        "button",
        { type: "button", class: "rb-status", title: "Open the Review tab", onClick: () => this.host.showReviewTab() },
        // A dot in the state's colour (CSS), then the state and progress as one line, cut short with the full text on hover.
        h("span", { class: "rb-text", title: bannerText(r) }, bannerText(r)),
        h("span", { class: "rb-more", aria: { hidden: "true" } }, "›"),
      ),
      r.can.review && r.currentVersion !== this.read && !this.raced
        ? h("span", { class: "rb-newer", role: "status" }, newerNote(this.read, r.currentVersion))
        : null,
    );
    // A lost race is answered here, beside the changes the History tab now shows: the message, the note as typed
    // and the relabelled buttons (the Review tab shows the same), dropping down under the status.
    if (this.raced && r.can.review) {
      banner.append(
        h(
          "div",
          { class: "rb-drop" },
          h("div", { class: "rb-race", role: "alert" }, raceNote(this.raced.verdict, this.read)),
          this.verdictBox(),
        ),
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
    // A step (editing reviewers, force approve, reject, choose) has the panel to itself until it is confirmed or
    // cancelled: no verdict buttons, other actions, reviewers or history beside it.
    if (this.form !== "none") {
      panel.classList.add("rv-focused");
      if (this.form === "submit") panel.append(this.submitForm());
      if (this.form === "force") panel.append(this.forceForm());
      if (this.form === "reject") panel.append(this.rejectForm());
      if (this.form === "choose") panel.append(this.chooseForm());
      if (this.form === "reopen") panel.append(this.reopenForm());
      if (this.form === "archive") panel.append(this.archiveForm());
      return;
    }
    panel.classList.remove("rv-focused");
    panel.append(this.nextStep(), ...this.sections());
    const list = h("ul", { class: "rv-reviewers", aria: { label: "Reviewers" } });
    for (const x of r.reviewers) {
      list.append(
        h(
          "li",
          {},
          h("span", { class: "rv-name" }, x.name),
          h("span", { class: `chip verdict-${x.verdict}${x.current ? "" : " older"}` }, reviewerChip(x)),
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
    this.routingSection(panel);
  }

  /** Where review actions go: the router now, and for each recent action what it started or why it did not. */
  private routingSection(panel: HTMLElement): void {
    const { router, jobs } = this.review.routing;
    panel.append(
      h("h3", {}, "Routing"),
      h("div", { class: "rv-final" }, router ? `Routed to ${router.name}` : "No router: review actions start nothing."),
    );
    if (!jobs.length) return;
    panel.append(
      h(
        "ul",
        { class: "rv-events" },
        ...jobs.map((j) =>
          h(
            "li",
            {},
            h("span", { class: "rv-when", title: j.at }, relativeTime(j.at)),
            j.outcome === null
              ? " Routing…"
              : j.outcome === "started"
                ? j.started.length
                  ? j.started
                      .map((c) => ` ${j.routerName} started: ${c.agentName}${c.task ? ` — ${c.task}` : ""}`)
                      .join(";")
                  : " Routed; no agent started."
                : ` ${ROUTING_REFUSAL[j.outcome] ?? "Not routed."}`,
          ),
        ),
      ),
    );
  }

  /** The note and verdict buttons; with `choose`, "Choose this option" is the primary action and the verdicts plain. */
  private verdictBox(choose = false): HTMLElement {
    const r = this.review;
    const box = h("div", { class: "rv-verdict" });
    const c = verdictControls({
      state: r.state,
      mine: myCurrentVerdict(r),
      read: this.read,
      current: r.currentVersion,
      raced: this.raced !== null,
      forced: r.forced !== null,
      earlier: myVerdictVersion(r),
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
    const btn = (label: string, run: () => void, variant: ButtonVariant) =>
      h("button", { type: "button", class: variant, disabled: this.busy, onClick: run }, label);
    if (c.review) {
      box.append(btn(c.review, () => void this.reviewNewer(), "primary"));
      return box;
    }
    const row = h("div", { class: "rv-actions" });
    if (choose) row.append(this.button("Choose this option", () => this.open("choose"), "primary", "choose"));
    if (c.approve)
      row.append(this.button(c.approve, () => void this.verdict("approve"), choose ? "neutral" : "primary", "approve"));
    if (c.changes) row.append(this.button(c.changes, () => void this.verdict("request_changes"), "neutral", "changes"));
    // Secondary: what changed since the viewer's last verdict, in History.
    const earlier = myVerdictVersion(r);
    if (c.since && earlier !== null)
      row.append(
        h(
          "button",
          { type: "button", class: "link", onClick: () => this.host.showChanges(earlier, r.currentVersion) },
          c.since,
        ),
      );
    box.append(row);
    return box;
  }

  private open(form: Form): void {
    if (form === "choose") {
      const ticked = this.chooseOptions().filter((c) => c.ticked);
      this.chooseState = { ticks: new Set(ticked.map((c) => c.id)), note: "" };
    }
    this.form = form;
    this.render();
  }

  /** A panel button; `glyph` puts that action's icon before the label (the actions that open a step have one). */
  private button(
    label: string,
    run: () => void,
    variant: ButtonVariant = "neutral",
    glyph?: IconName,
  ): HTMLButtonElement {
    const b = h("button", { type: "button", class: variant, disabled: this.busy, onClick: run }, label);
    if (glyph) b.prepend(icon(glyph));
    return b;
  }

  /**
   * The next-step card: the one boxed thing in the panel, its edge coloured by state, saying what (if anything) the
   * viewer should do now, with that action as the panel's only primary button.
   */
  private nextStep(): HTMLElement {
    const r = this.review;
    const can = r.can;
    const card = (tone: string, title: string, ...body: Array<Node | string | null>) =>
      h("section", { class: `rv-card tone-${tone}`, aria: { label: title } }, h("h3", {}, title), ...body);
    const text = (t: string) => h("p", {}, t);
    if (this.lastChoice) return card("done", "Choice made", text(this.lastChoice));
    const choosable = can.choose === true && this.chooseOptions().length > 0;
    switch (r.state) {
      case "draft":
        return can.submit
          ? card(
              "draft",
              "Not in review yet",
              text("Choose who reviews it to start the review."),
              this.button(PICKER.start, () => void this.openSubmit(), "primary", "send"),
            )
          : card("draft", "Not in review yet", text("The owner hasn't asked for reviews yet."));
      case "approved": {
        const by = r.events.find((e) => e.kind === "approved" || e.kind === "force_approved");
        const when = by ? relativeTime(by.createdAt) : "";
        // "12m" reads as "12m ago"; "just now" as is; an older date as "on 2026-11-20".
        const ago = /^\d+[mhd]$/.test(when) ? `${when} ago` : when === "just now" ? when : `on ${when}`;
        const who = by ? ` by ${by.actorName}, ${ago}` : "";
        const lines = [text(r.forced ? bannerText(r) : `Approved v${r.currentVersion}${who}.`)];
        lines.push(text(can.reopen ? "Nothing to do here." : ASK_TO_REOPEN));
        return card("done", "Approved", ...lines);
      }
      case "rejected": {
        const ev = r.events.find((e) => e.kind === "rejected");
        return card(
          "out",
          this.options() ? "Out of the set" : "Out of the plan",
          text(ev?.note ? `Rejected: “${ev.note}”` : "Rejected."),
          can.reopen ? null : text(this.options() ? OPTION_REJECTED_NOTE : REJECTED_NOTE),
        );
      }
      case "archived":
        return card(
          "out",
          "Archived",
          text("Read-only, and out of the document lists."),
          can.unarchive
            ? this.button(
                "Unarchive",
                () => void this.act({ action: "archive", archived: false }),
                "primary",
                "unarchive",
              )
            : null,
        );
      default: {
        if (can.review) {
          const prompt = !choosable
            ? "Give your review."
            : this.options()
              ? "Pick this option, or give your review."
              : "Pick this option for the plan, or give your review.";
          return card("todo", "Your next step", text(prompt), this.verdictBox(choosable));
        }
        const waiting = r.reviewers.filter((x) => !(x.verdict === "approved" && x.current)).map((x) => x.name);
        const lead =
          r.state === "changes_requested"
            ? "Changes requested. A new version goes back to the reviewers."
            : `${r.progress.approved} of ${r.progress.total} approved.`;
        return card("wait", "Waiting", text(waiting.length ? `${lead} Waiting for ${waiting.join(", ")}.` : lead));
      }
    }
  }

  /** "Plan" and "Manage": every other action the viewer may take, as plain buttons; a heading only when it has some. */
  private sections(): HTMLElement[] {
    const r = this.review;
    const can = r.can;
    const out: HTMLElement[] = [];
    const section = (title: string, buttons: HTMLElement[]) => {
      if (buttons.length)
        out.push(h("div", { class: "rv-section" }, h("h4", {}, title), h("div", { class: "rv-actions" }, ...buttons)));
    };
    // On an approved document a reviewer may still request changes: their review, below the card.
    if (r.state === "approved" && can.review) section("Your review", [this.verdictBox(false)]);
    const plan: HTMLElement[] = [];
    // In review, Choose is the card's primary action; once approved it is one of the plan actions.
    if (can.choose && r.state === "approved" && this.chooseOptions().length > 0)
      plan.push(this.button("Choose this option", () => this.open("choose"), "neutral", "choose"));
    if (can.reject) plan.push(this.button("Reject", () => this.open("reject"), "neutral", "reject"));
    section(this.options() ? "Options" : "Plan", plan);
    const manage: HTMLElement[] = [];
    if (can.submit && r.state !== "draft")
      manage.push(this.button(PICKER.edit, () => void this.openSubmit(), "neutral", "reviewers"));
    if (can.force) manage.push(this.button("Force approve", () => this.open("force"), "neutral", "force"));
    if (can.reopen) manage.push(this.button("Reopen for review", () => this.open("reopen"), "neutral", "reopen"));
    if (can.archive) manage.push(this.button("Archive", () => this.open("archive"), "neutral", "archive"));
    section("Manage", manage);
    return out;
  }

  /** A confirm step: a heading, what confirming does, and Confirm / Cancel. */
  private confirmStep(
    label: string,
    heading: string,
    explain: string,
    confirm: string,
    run: () => void,
    glyph: IconName,
  ): HTMLElement {
    return h(
      "div",
      { class: "rv-form", role: "group", aria: { label } },
      h("h3", {}, heading),
      h("p", {}, explain),
      h(
        "div",
        { class: "rv-actions" },
        this.button(confirm, run, "primary", glyph),
        this.button("Cancel", () => {
          this.form = "none";
          this.render();
        }),
      ),
    );
  }

  private reopenForm(): HTMLElement {
    const n = this.review.currentVersion;
    return this.confirmStep(
      "Reopen for review",
      "Reopen for review",
      `This starts v${n + 1}, a copy of v${n}, and puts it in review: every reviewer approves again.${
        this.review.state === "rejected" ? " It goes back into the plan." : ""
      } v${n} stays in History as the record.`,
      "Reopen",
      () => void this.act({ action: "reopen" }),
      "reopen",
    );
  }

  private archiveForm(): HTMLElement {
    return this.confirmStep(
      "Archive",
      "Archive this document",
      "It becomes read-only and leaves the document lists. You can unarchive it later.",
      "Archive",
      () => void this.act({ action: "archive", archived: true }),
      "archive",
    );
  }

  private async openSubmit(): Promise<void> {
    this.form = "submit";
    this.picked = new Set(this.review.reviewers.flatMap((x) => (x.ref ? [x.ref] : [])));
    this.approver = this.review.finalApprover?.ref ?? "";
    this.query = "";
    this.newLink = null;
    this.copied = false;
    await this.loadCandidates();
  }

  private closeForm(): void {
    this.form = "none";
    this.newLink = null;
    this.render();
  }

  private async loadCandidates(): Promise<void> {
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

  private async createLink(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    this.render();
    try {
      const link = await this.host.api.createCommentLink();
      this.newLink = `${location.origin}${link.path}`;
      this.copied = false;
    } catch (err) {
      this.error = errorMessage(err);
    }
    this.busy = false;
    this.render();
  }

  private submitForm(): HTMLElement {
    const form = h("div", { class: "rv-form", role: "group", aria: { label: "Reviewers" } }, h("h3", {}, "Reviewers"));
    const all = this.candidates ?? [];
    const rows: { el: HTMLElement; name: string }[] = [];
    const noMatch = h("p", { class: "rv-mine", role: "status" }, PICKER.noMatch);
    // Filters in place (no re-render), so the search box keeps focus while typing.
    const filter = () => {
      let shown = 0;
      for (const r of rows) {
        const on = matchesQuery(r.name, this.query);
        r.el.hidden = !on;
        if (on) shown++;
      }
      noMatch.hidden = shown > 0 || rows.length === 0;
    };
    if (all.length > 1) {
      const search = h("input", {
        type: "search",
        class: "rv-search",
        attrs: { placeholder: PICKER.find },
        aria: { label: PICKER.find },
        onInput: (e) => {
          this.query = (e.target as HTMLInputElement).value;
          filter();
        },
      });
      search.value = this.query;
      form.append(search);
    }
    const list = h("div", { class: "rv-pick-list" });
    for (const c of all) {
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
      const el = h("label", { class: "rv-pick" }, box, c.name);
      rows.push({ el, name: c.name });
      list.append(el);
    }
    form.append(list, noMatch);
    filter();
    if (all.length <= 1) form.append(h("p", { class: "rv-mine" }, PICKER.onlyYou));
    if (this.newLink) {
      const field = h("input", {
        type: "text",
        class: "rv-link",
        attrs: { readonly: "" },
        aria: { label: "Comment link" },
      });
      field.value = this.newLink;
      const url = this.newLink;
      form.append(
        h("p", { class: "rv-mine", role: "status" }, PICKER.linkShown),
        h(
          "div",
          { class: "rv-actions" },
          field,
          h(
            "button",
            {
              type: "button",
              class: "tonal",
              onClick: () => {
                void navigator.clipboard?.writeText(url).then(() => {
                  this.copied = true;
                  this.render();
                });
                field.select();
              },
            },
            this.copied ? PICKER.copied : PICKER.copy,
          ),
          h("button", { type: "button", class: "neutral", onClick: () => void this.loadCandidates() }, PICKER.refresh),
        ),
      );
    } else {
      form.append(
        h(
          "div",
          { class: "rv-actions" },
          h(
            "button",
            { type: "button", class: "neutral", disabled: this.busy, onClick: () => void this.createLink() },
            icon("link"),
            PICKER.createLink,
          ),
        ),
      );
    }
    const select = h(
      "select",
      { aria: { label: "Final approver" }, onChange: (e) => (this.approver = (e.target as HTMLSelectElement).value) },
      h("option", { attrs: { value: "" } }, "No final approver"),
      ...all.filter((c) => c.member).map((c) => h("option", { attrs: { value: c.ref } }, c.name)),
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
          icon(this.review.state === "draft" ? "send" : "reviewers"),
          this.review.state === "draft" ? PICKER.submit : PICKER.save,
        ),
        h("button", { type: "button", class: "neutral", onClick: () => this.closeForm() }, "Cancel"),
      ),
    );
    return form;
  }

  /** Whether the bar shows a native option set (every open member an alternative, nothing built). */
  private options(): boolean {
    return this.host.planKind?.() === "options";
  }

  /** The documents a choice may reject now (see chooseCandidates). */
  private chooseOptions(): ChooseCandidate[] {
    const documents = this.host.planDocuments?.() ?? [];
    const kind = this.host.planKind?.() ?? "plan";
    // Only an alternative is chosen (option-b/ among option-a/, option-c/), never a shared part such as screens/;
    // in an option set every open member is one.
    const open = documents.filter(
      (d) =>
        !d.removed &&
        (kind === "options" || d.path !== "plan.md") &&
        ["in_review", "changes_requested", "approved"].includes(d.reviewState),
    );
    if (!alternativeSets(open, kind).some((s) => s.docs.some((d) => d.current))) return [];
    return chooseCandidates(documents, kind);
  }

  private chooseForm(): HTMLElement {
    const documents = this.host.planDocuments?.() ?? [];
    const path = documents.find((d) => d.current)?.path ?? "this option";
    const r = this.review;
    const approved = r.state === "approved";
    // This option ends approved when it is, or when the viewer's approval is the last one it needs.
    const chosenEndsApproved = approved || r.progress.total - r.progress.approved <= 1;
    const form = h("div", { class: "rv-form", role: "group", aria: { label: "Choose this option" } });
    form.append(
      h("h3", {}, `Choose ${path}`),
      chooseStep({
        chosenPath: path,
        chosenApproved: approved,
        candidates: this.chooseOptions(),
        // An option set is never built: no "ready to build" sentence.
        readyAfter: (rejectIds) =>
          this.options()
            ? null
            : chosenEndsApproved &&
              documents.every((d) => d.current || d.removed || rejectIds.has(d.id) || d.reviewState === "approved"),
        ...(this.options() ? { keepText: "stays in the set" } : {}),
        state: this.chooseState,
        busy: this.busy,
        onConfirm: (reject, note) => void this.choose(reject, note),
        onCancel: () => {
          this.form = "none";
          this.render();
        },
      }),
    );
    return form;
  }

  /** Makes the choice; on success the card says what it did and what the plan still waits for. */
  private async choose(reject: string[], note: string | undefined): Promise<void> {
    const documents = this.host.planDocuments?.() ?? [];
    const chosen = documents.find((d) => d.current)?.path ?? "this option";
    const ids = new Set(reject);
    const code = await this.act({ action: "choose", versionNumber: this.read, reject, ...(note ? { note } : {}) });
    if (code !== null) return;
    const waiting = documents
      .filter((d) => !d.current && !d.removed && !ids.has(d.id) && d.reviewState !== "approved")
      .map((d) => d.path);
    this.lastChoice = choiceResult({
      chosenPath: chosen,
      chosenApproved: this.review.state === "approved",
      rejectedPaths: documents.filter((d) => ids.has(d.id)).map((d) => d.path),
      waitingPaths: waiting,
      kind: this.host.planKind?.() ?? "plan",
    });
    this.render();
  }

  private rejectForm(): HTMLElement {
    const form = h("div", { class: "rv-form", role: "group", aria: { label: "Reject" } });
    form.append(
      h("h3", {}, "Reject this document"),
      h("p", {}, this.options() ? OPTION_REJECT_EXPLAIN : REJECT_EXPLAIN),
    );
    const note = h("textarea", {
      attrs: { placeholder: "Why (required), for example: Option B was chosen", rows: "3" },
      aria: { label: "Reject note" },
      onInput: () => {
        this.rejectNote = note.value;
        confirm.disabled = this.busy || note.value.trim() === "";
      },
    });
    note.value = this.rejectNote;
    const confirm = h(
      "button",
      {
        type: "button",
        class: "danger",
        disabled: this.busy || this.rejectNote.trim() === "",
        onClick: () => void this.act({ action: "reject", note: this.rejectNote }),
      },
      icon("reject"),
      "Reject",
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
            class: "neutral",
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
    form.append(h("h3", {}, "Force approve"));
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
      icon("force"),
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
            class: "neutral",
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
    this.lastChoice = null;
    this.busy = true;
    this.error = "";
    this.render();
    try {
      const out = await this.host.api.review(body);
      this.form = "none";
      this.newLink = null;
      this.forceNote = "";
      this.rejectNote = "";
      this.chooseState = { ticks: new Set(), note: "" };
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
