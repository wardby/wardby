/**
 * The plan bar under the review banner (spec §5b): "Plan 12 · 2 of 3 approved", then one chip per
 * document of the set the viewer can read, each a link to that document's page. The current page's
 * chip is marked; removed documents come last, struck through. Titles are set as text (dom.ts h()).
 * The chips carry the side-panel tab open on this page (`?tab=`), so moving between a plan's documents
 * keeps the reviewer on Review (or whichever tab they were on); the next page opens it if it has it.
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
      d.pagePath ? "a" : "span",
      {
        class: `plan-chip state-${d.reviewState}${d.current ? " current" : ""}`,
        attrs: {
          ...(d.pagePath ? { href: withTab(d.pagePath, host.dataset.tab) } : {}),
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
  host.dataset.tab = tab;
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
