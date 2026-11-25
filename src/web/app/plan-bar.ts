/**
 * The plan bar under the review banner (spec §5b): "Plan 12 · 2 of 3 approved", then one chip per
 * document of the set the viewer can read, each a link to that document's page. The current page's
 * chip is marked; removed documents come last, struck through. Titles are set as text (dom.ts h()).
 * The chips carry the side-panel tab open on this page (`?tab=`), so moving between a plan's documents
 * keeps the reviewer on Review (or whichever tab they were on); the next page opens it if it has it.
 */
import type { PlanSetPayload } from "../../core/plans/page-payload.js";
import { clear, h } from "./dom.js";
import { choiceResult, chooseCandidates, planAlternatives, STATE_LABEL } from "./review-model.js";
import { errorMessage, type ReviewAction, type ReviewState } from "./api.js";
import { chooseStep, type ChooseStepState } from "./choose-ui.js";
import { icon } from "./icons.js";

const KIND_ICON = { document: "📄", design: "🎨" } as const;

const stateLabel = (s: string) => STATE_LABEL[s as ReviewState] ?? s;

/** The plan each bar last rendered, for the Review tab's "Choose this option" checklist. */
const shown = new WeakMap<HTMLElement, PlanSetPayload | undefined>();

/** Posts a review action to another document of the plan (Api.reviewOf), for "Pick an option". */
export type PlanChooser = (documentId: string, body: ReviewAction) => Promise<unknown>;

interface PickState {
  open: boolean;
  chosenId: string | null;
  step: ChooseStepState;
  busy: boolean;
  error: string;
  /** What the last choice did, shown under the bar until dismissed. */
  result: string | null;
}
const choosers = new WeakMap<HTMLElement, PlanChooser>();
const emptyPick = (): PickState => ({
  open: false,
  chosenId: null,
  step: { ticks: new Set(), note: "" },
  busy: false,
  error: "",
  result: null,
});
const picks = new WeakMap<HTMLElement, PickState>();

/** Turns on "Pick an option" in this bar (members only: a guest's bar never shows it). */
export function setPlanBarChooser(host: HTMLElement, chooser: PlanChooser): void {
  choosers.set(host, chooser);
  renderPlanBar(host, shown.get(host));
}

const OPEN = new Set(["in_review", "changes_requested", "approved"]);

/** The documents a pick can choose between: still in the plan, not plan.md, undecided or approved. */
function pickable(plan: PlanSetPayload): PlanSetPayload["documents"] {
  return plan.documents.filter(
    (d) => !d.removed && d.path !== "plan.md" && OPEN.has(d.reviewState) && d.versionNumber !== undefined,
  );
}

const options = (plan: PlanSetPayload) => planAlternatives(pickable(plan));

/** The plan bar's "Pick an option" step: which option to build, then the shared choose step for it. */
function pickPanel(host: HTMLElement, plan: PlanSetPayload, pick: PickState, chooser: PlanChooser): HTMLElement {
  const rerender = () => renderPlanBar(host, shown.get(host));
  const choices = options(plan);
  const panel = h(
    "div",
    { class: "plan-pick rv-form", role: "group", aria: { label: "Pick an option" } },
    h("h3", {}, "Which option should be built?"),
  );
  const radios = h("fieldset", { class: "rv-choose" }, h("legend", {}, "Build"));
  for (const d of choices) {
    const radio = h("input", {
      type: "radio",
      attrs: { name: "plan-pick" },
      onChange: () => {
        pick.chosenId = d.id;
        const asChosen = plan.documents.map((x) => ({ ...x, current: x.id === d.id }));
        pick.step = {
          ticks: new Set(
            chooseCandidates(asChosen)
              .filter((c) => c.ticked)
              .map((c) => c.id),
          ),
          note: "",
        };
        rerender();
      },
    });
    radio.checked = pick.chosenId === d.id;
    radios.append(
      h(
        "label",
        { class: "rv-pick" },
        radio,
        h("span", {}, d.path),
        h("span", { class: "muted" }, ` · ${stateLabel(d.reviewState)}`),
      ),
    );
  }
  panel.append(radios);
  const chosen = choices.find((d) => d.id === pick.chosenId);
  if (pick.error) panel.append(h("div", { class: "err", role: "alert" }, pick.error));
  const cancel = () => {
    picks.set(host, emptyPick());
    rerender();
  };

  if (!chosen) {
    panel.append(
      h("p", { class: "muted" }, "Pick the option to build; the others can then be rejected in the same step."),
      h("div", { class: "rv-actions" }, h("button", { type: "button", class: "neutral", onClick: cancel }, "Cancel")),
    );
    return panel;
  }
  const asChosen = plan.documents.map((x) => ({ ...x, current: x.id === chosen.id }));
  const chosenApproved = chosen.reviewState === "approved";
  panel.append(
    chooseStep({
      chosenPath: chosen.path,
      chosenApproved,
      candidates: chooseCandidates(asChosen),
      // Whether the chosen option's own approval completes it is not known here (its other reviewers).
      readyAfter: (rejectIds) =>
        chosenApproved
          ? plan.documents.every((d) => d.removed || rejectIds.has(d.id) || d.reviewState === "approved")
          : null,
      state: pick.step,
      busy: pick.busy,
      onConfirm: (reject, note) => {
        pick.busy = true;
        pick.error = "";
        rerender();
        const ids = new Set(reject);
        chooser(chosen.id, {
          action: "choose",
          versionNumber: chosen.versionNumber!,
          reject,
          ...(note ? { note } : {}),
        }).then(
          // Say what happened here, in the bar; the chips update live from the documents' events.
          (out) => {
            const state = (out as { review?: { state?: string } } | undefined)?.review?.state;
            picks.set(host, {
              ...emptyPick(),
              result: choiceResult({
                chosenPath: chosen.path,
                chosenApproved: state === "approved",
                rejectedPaths: plan.documents.filter((d) => ids.has(d.id)).map((d) => d.path),
                waitingPaths: plan.documents
                  .filter((d) => d.id !== chosen.id && !d.removed && !ids.has(d.id) && d.reviewState !== "approved")
                  .map((d) => d.path),
              }),
            });
            rerender();
          },
          (err: unknown) => {
            pick.busy = false;
            pick.error = errorMessage(err);
            rerender();
          },
        );
      },
      onCancel: cancel,
    }),
  );
  return panel;
}

/** The documents of the plan `host` shows now (empty when the page is not in a plan set). */
export function planDocumentsOf(host: HTMLElement): PlanSetPayload["documents"] {
  return shown.get(host)?.documents ?? [];
}

/** Renders the bar into `host`, or hides it when the document is not in a plan set. */
export function renderPlanBar(host: HTMLElement, plan: PlanSetPayload | undefined): void {
  clear(host);
  shown.set(host, plan);
  host.hidden = !plan;
  if (!plan) return;
  const chip = (d: PlanSetPayload["documents"][number]) => {
    const link = h(
      d.pagePath ? "a" : "span",
      {
        class: `plan-chip state-${d.reviewState}${d.current ? " current" : ""}`,
        attrs: {
          ...(d.pagePath ? { href: withTab(d.pagePath, host.dataset.sideTab) } : {}),
          ...(d.current ? { "aria-current": "page" } : {}),
        },
        data: d.pagePath ? { path: d.pagePath } : {},
        title: `${d.path} (${d.kind})`,
      },
      h("span", { class: "plan-kind", aria: { hidden: "true" } }, KIND_ICON[d.kind]),
      h("span", { class: "plan-title" }, d.title),
      h(
        "span",
        { class: "plan-state" },
        d.removed ? (d.reviewState === "rejected" ? "Rejected" : "Removed") : stateLabel(d.reviewState),
      ),
    );
    return h("li", {}, d.removed ? h("s", {}, link) : link);
  };
  host.append(
    h(
      "span",
      { class: "plan-count" },
      plan.partial ? `Plan ${plan.number}` : `Plan ${plan.number} · ${plan.approved} of ${plan.counted} approved`,
    ),
    h("ul", { class: "plan-chips" }, ...plan.documents.map(chip)),
  );
  // "Pick an option": for members (a guest sees part of the set) when there are options to choose between.
  const chooser = choosers.get(host);
  const pick = picks.get(host) ?? emptyPick();
  picks.set(host, pick);
  if (pick.result) {
    host.append(
      h(
        "div",
        { class: "plan-result", role: "status" },
        h("span", {}, pick.result),
        h(
          "button",
          {
            type: "button",
            class: "link",
            onClick: () => {
              pick.result = null;
              renderPlanBar(host, shown.get(host));
            },
          },
          "Dismiss",
        ),
      ),
    );
  }
  if (!chooser || plan.partial || options(plan).length < 2) return;
  host.append(
    h(
      "button",
      {
        type: "button",
        class: "plan-pick-open",
        attrs: { "aria-expanded": String(pick.open) },
        onClick: () => {
          pick.open = !pick.open;
          renderPlanBar(host, shown.get(host));
        },
      },
      icon("choose"),
      "Pick an option",
    ),
  );
  if (pick.open) host.append(pickPanel(host, plan, pick, chooser));
}

/** A `<nav>` for the bar, hidden until rendered with a plan. */
export function planBarHost(): HTMLElement {
  return h("nav", { class: "plan-bar", hidden: true, aria: { label: "Plan" } });
}

/** `path` with `?tab=<tab>` (or as is with no tab). */
function withTab(path: string, tab: string | undefined): string {
  if (!tab) return path;
  const url = new URL(path, "http://x");
  url.searchParams.set("tab", tab);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Records the side-panel tab now open, and points the bar's links at it. */
export function setPlanBarTab(host: HTMLElement, tab: string): void {
  host.dataset.sideTab = tab;
  for (const a of host.querySelectorAll<HTMLAnchorElement>("a.plan-chip[data-path]")) {
    a.setAttribute("href", withTab(a.dataset.path!, tab));
  }
}

/**
 * The tab a plan bar link asked for (`?tab=`), mapped onto this page's tabs through `aliases` and kept
 * only when it is one of `tabs`; the parameter is then dropped from the address bar.
 */
export function requestedTab<T extends string>(tabs: readonly T[], aliases: Record<string, T> = {}): T | undefined {
  const url = new URL(location.href);
  const asked = url.searchParams.get("tab");
  if (asked === null) return undefined;
  url.searchParams.delete("tab");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const tab: string = Object.hasOwn(aliases, asked) ? aliases[asked] : asked;
  return tabs.find((t) => t === tab);
}
