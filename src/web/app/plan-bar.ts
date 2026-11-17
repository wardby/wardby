/**
 * The plan bar under the review banner (spec §5b): "Plan 12 · 2 of 3 approved", then one chip per
 * document of the set the viewer can read, each a link to that document's page. The current page's
 * chip is marked; removed documents come last, struck through. Titles are set as text (dom.ts h()).
 */
import type { PlanSetPayload } from "../../core/plans/page-payload.js";
import { clear, h } from "./dom.js";
import { STATE_LABEL } from "./review-model.js";
import type { ReviewState } from "./api.js";

const KIND_ICON = { document: "📄", design: "🎨" } as const;

const stateLabel = (s: string) => STATE_LABEL[s as ReviewState] ?? s;

/** Renders the bar into `host`, or hides it when the document is not in a plan set. */
export function renderPlanBar(host: HTMLElement, plan: PlanSetPayload | undefined): void {
  clear(host);
  host.hidden = !plan;
  if (!plan) return;
  const chip = (d: PlanSetPayload["documents"][number]) => {
    const link = h(
      "a",
      {
        class: `plan-chip state-${d.reviewState}${d.current ? " current" : ""}`,
        attrs: { href: d.pagePath, ...(d.current ? { "aria-current": "page" } : {}) },
        title: `${d.path} (${d.kind})`,
      },
      h("span", { class: "plan-kind", aria: { hidden: "true" } }, KIND_ICON[d.kind]),
      h("span", { class: "plan-title" }, d.title),
      h("span", { class: "plan-state" }, d.removed ? "Removed" : stateLabel(d.reviewState)),
    );
    return h("li", {}, d.removed ? h("s", {}, link) : link);
  };
  host.append(
    h("span", { class: "plan-count" }, `Plan ${plan.number} · ${plan.approved} of ${plan.counted} approved`),
    h("ul", { class: "plan-chips" }, ...plan.documents.map(chip)),
  );
}

/** A `<nav>` for the bar, hidden until rendered with a plan. */
export function planBarHost(): HTMLElement {
  return h("nav", { class: "plan-bar", hidden: true, aria: { label: "Plan" } });
}
