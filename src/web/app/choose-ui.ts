/**
 * The "Choose this option" step, shared by the Review tab (the option on screen) and the plan bar's "Pick an
 * option…" (any option of the plan): what gets approved, the documents to reject (ticked as chooseCandidates
 * says; unticked ones say they stay in the plan), an optional note, a sentence saying exactly what confirming
 * does, and Confirm / Cancel. The ticks and the note live in `state`, owned by the caller, so they survive
 * re-renders. Text is set as text (dom.ts).
 */
import { h } from "./dom.js";
import { chooseSummary, STATE_LABEL, type ChooseCandidate } from "./review-model.js";
import type { ReviewState } from "./api.js";

export interface ChooseStepState {
  ticks: Set<string>;
  note: string;
}

export interface ChooseStepInput {
  chosenPath: string;
  chosenApproved: boolean;
  candidates: ChooseCandidate[];
  /** Whether the plan is fully approved once the choice lands, given the ticks; null when unknown. */
  readyAfter: (rejectIds: Set<string>) => boolean | null;
  state: ChooseStepState;
  busy: boolean;
  onConfirm(rejectIds: string[], note: string | undefined): void;
  onCancel(): void;
}

export function chooseStep(input: ChooseStepInput): HTMLElement {
  const { state, candidates } = input;
  // Ticks for documents no longer offered (decided meanwhile) are dropped.
  for (const id of [...state.ticks]) if (!candidates.some((c) => c.id === id)) state.ticks.delete(id);
  const summary = h("p", { class: "ch-summary", aria: { live: "polite" } });
  const confirm = h("button", { type: "button", class: "primary" });
  const keepNotes = new Map<string, HTMLElement>();
  const update = () => {
    const ticked = candidates.filter((c) => state.ticks.has(c.id));
    const n = ticked.length;
    summary.textContent = chooseSummary({
      chosenPath: input.chosenPath,
      chosenApproved: input.chosenApproved,
      rejectPaths: ticked.map((c) => c.path),
      ready: input.readyAfter(state.ticks),
    });
    confirm.textContent = input.chosenApproved ? `Reject ${n}` : `Approve and reject ${n}`;
    confirm.disabled = input.busy || n === 0;
    for (const [id, el] of keepNotes) el.hidden = state.ticks.has(id);
  };
  confirm.addEventListener("click", () => {
    const ids = candidates.filter((c) => state.ticks.has(c.id)).map((c) => c.id);
    input.onConfirm(ids, state.note.trim() ? state.note : undefined);
  });

  const approve = h(
    "div",
    { class: "ch-approve" },
    h("span", { class: "ch-mark ok", aria: { hidden: "true" } }, "✓"),
    h("span", { class: "ch-label" }, input.chosenApproved ? "Stays approved" : "Approve"),
    h("strong", {}, input.chosenPath),
  );
  const list = h("fieldset", { class: "rv-choose" }, h("legend", {}, "✕ Reject the others"));
  for (const c of candidates) {
    const box = h("input", {
      type: "checkbox",
      onChange: () => {
        if (box.checked) state.ticks.add(c.id);
        else state.ticks.delete(c.id);
        update();
      },
    });
    box.checked = state.ticks.has(c.id);
    const keep = h("span", { class: "ch-keep muted" }, "stays in the plan");
    keepNotes.set(c.id, keep);
    list.append(
      h(
        "label",
        { class: "rv-pick" },
        box,
        h("span", {}, c.path),
        h("span", { class: "muted" }, ` · ${STATE_LABEL[c.reviewState as ReviewState] ?? c.reviewState}`),
        keep,
      ),
    );
  }
  const note = h("input", {
    type: "text",
    attrs: { placeholder: "Note (optional), added to each reject" },
    aria: { label: "Choice note" },
    onInput: () => {
      state.note = note.value;
    },
  });
  note.value = state.note;
  const cancel = h("button", { type: "button", class: "neutral", onClick: () => input.onCancel() }, "Cancel");
  update();
  return h(
    "div",
    { class: "ch-step" },
    approve,
    list,
    note,
    summary,
    h("div", { class: "rv-actions" }, confirm, cancel),
  );
}
