/**
 * Spec "Import fidelity check" (ruling D8): which of a board's styles live only in its base layer,
 * i.e. what GrapesJS did not import and the Style panel cannot edit. The canvas is measured with the
 * base <style> on and then off: the same DOM both times, compared per selector key (tag.firstClass),
 * as in the T7 prototype. Nothing is changed; the base is re-enabled before returning.
 *
 * The samples are display text (selector key, property, two computed values): the server caps and
 * redacts them (core/documents/fidelity.ts), and the page renders them with textContent only.
 */
export const FIDELITY_PROPS = [
  "color",
  "background-color",
  "border-top-width",
  "border-top-style",
  "border-top-color",
  "font-size",
  "font-family",
  "font-weight",
  "padding-top",
  "padding-left",
  "border-top-left-radius",
  "display",
  "text-align",
] as const;

export interface Snapshot {
  key: string;
  styles: Record<string, string>;
}

export interface FidelityResult {
  mismatches: number;
  samples: string[];
}

/** At most this many samples per board, each at most this long (the server's limits). */
const MAX_SAMPLES = 6;
const MAX_SAMPLE_LENGTH = 160;

export function fidelityDiff(before: Snapshot[], after: Snapshot[]): FidelityResult {
  const seen = new Set<string>();
  const samples: string[] = [];
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i];
    const b = after[i];
    for (const p of Object.keys(a.styles)) {
      const id = `${a.key}|${p}`;
      if (seen.has(id) || a.styles[p] === b.styles[p]) continue;
      seen.add(id);
      if (samples.length < MAX_SAMPLES) {
        samples.push(`${a.key} ${p}: ${a.styles[p]} → ${b.styles[p]}`.slice(0, MAX_SAMPLE_LENGTH));
      }
    }
  }
  return { mismatches: seen.size, samples };
}

const keyOf = (el: Element) => `${el.tagName.toLowerCase()}${el.classList[0] ? `.${el.classList[0]}` : ""}`;

export function measureFidelity(doc: Document, win: Window, base: HTMLStyleElement): FidelityResult {
  const els = [
    doc.body,
    ...Array.from(doc.body.querySelectorAll("*")).filter((e) => !["STYLE", "SCRIPT"].includes(e.tagName)),
  ];
  const snap = (): Snapshot[] =>
    els.map((el) => {
      const cs = win.getComputedStyle(el);
      return { key: keyOf(el), styles: Object.fromEntries(FIDELITY_PROPS.map((p) => [p, cs.getPropertyValue(p)])) };
    });
  const before = snap();
  base.disabled = true;
  try {
    return fidelityDiff(before, snap());
  } finally {
    base.disabled = false;
  }
}
