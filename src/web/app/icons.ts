/**
 * Small line icons for the review actions (24-unit grid, 1.75 stroke, `currentColor`), drawn here so the page loads
 * nothing extra. Decorative: the button's label names the action, so each icon is aria-hidden.
 */
const SVG = "http://www.w3.org/2000/svg";

type Shape = ["path", string] | ["circle", number, number, number] | ["rect", number, number, number, number, number];

const SHAPES = {
  /** Choose this option: one picked out of several (a selected radio). */
  choose: [
    ["circle", 12, 12, 9],
    ["circle", 12, 12, 3.5],
  ],
  /** Approve. */
  approve: [["path", "M20 6.5 9.5 17 4 11.5"]],
  /** Request changes: edit it. */
  changes: [["path", "M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4"]],
  /** Start review: send it to the reviewers. */
  send: [["path", "M21 3 10 14M21 3l-7 18-4-7-7-4 18-7z"]],
  /** Unarchive: back out of the archive. */
  unarchive: [
    ["rect", 3, 4, 18, 4.5, 1],
    ["path", "M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M12 17v-5.5M9.5 14 12 11.5l2.5 2.5"],
  ],
  /** Reject: out of the plan. */
  reject: [["path", "M17 7 7 17M7 7l10 10"]],
  /** Edit reviewers: people. */
  reviewers: [
    ["circle", 9, 8, 3.5],
    ["path", "M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3a4.5 4.5 0 0 1 4.5 4.5V20"],
    ["path", "M16 4.6a3.5 3.5 0 0 1 0 6.8M21 20v-1.5a4.5 4.5 0 0 0-3-4.2"],
  ],
  /** Force approve: over the missing verdicts. */
  force: [["path", "M13 3 5 13.5h6L10 21l8-10.5h-6L13 3z"]],
  /** Reopen for review: back around. */
  reopen: [
    ["path", "M4 12a8 8 0 1 0 2.6-5.9"],
    ["path", "M4 4v4.5h4.5"],
  ],
  /** Archive: put away. */
  archive: [
    ["rect", 3, 4, 18, 4.5, 1],
    ["path", "M5 8.5V18a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5M10 12.5h4"],
  ],
  /** Comment: a speech bubble. */
  comment: [["path", "M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.3-4.6A7.5 7.5 0 1 1 20 11.5z"]],
  /** A comment link: two links of a chain. */
  link: [
    ["path", "M10 14a4 4 0 0 0 5.7 0l3.1-3.1a4 4 0 0 0-5.7-5.7l-1 1"],
    ["path", "M14 10a4 4 0 0 0-5.7 0l-3.1 3.1a4 4 0 0 0 5.7 5.7l1-1"],
  ],
  /** Overview: every board at once. */
  overview: [
    ["rect", 4, 4, 6.5, 6.5, 1],
    ["rect", 13.5, 4, 6.5, 6.5, 1],
    ["rect", 4, 13.5, 6.5, 6.5, 1],
    ["rect", 13.5, 13.5, 6.5, 6.5, 1],
  ],
  /** Play: the prototype. */
  play: [["path", "M7 4.5v15l12-7.5z"]],
  /** Export: out of the page. */
  export: [["path", "M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"]],
  /** Undo: back one step. */
  undo: [
    ["path", "M9 14 4 9l5-5"],
    ["path", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  ],
  /** Redo: forward one step. */
  redo: [
    ["path", "m15 14 5-5-5-5"],
    ["path", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13"],
  ],
  /** A document (Markdown): a page with a folded corner. */
  page: [
    ["path", "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"],
    ["path", "M14 3v5h5"],
  ],
  /**
   * A design: a set square (drafting triangle) with its inner cut-out, both outlines, the inner one centred on the
   * outer's incentre (8.27, 15.73) at 0.4 scale, so the band between them is even on all three sides.
   */
  design: [
    ["path", "M3 21V3l18 18z"],
    ["path", "M6.2 10.6v7.2h7.2z"],
  ],
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof SHAPES;

/** The icon as markup, for places that take an HTML label (GrapesJS's component toolbar). */
export function iconHtml(name: IconName): string {
  return icon(name).outerHTML;
}

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "15",
    height: "15",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": name === "design" ? "1.5" : "1.75",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
    focusable: "false",
    class: "icon",
  })) {
    svg.setAttribute(k, v);
  }
  for (const shape of SHAPES[name] as Shape[]) {
    const el = document.createElementNS(SVG, shape[0]);
    if (shape[0] === "path") el.setAttribute("d", shape[1]);
    else if (shape[0] === "circle") {
      el.setAttribute("cx", String(shape[1]));
      el.setAttribute("cy", String(shape[2]));
      el.setAttribute("r", String(shape[3]));
    } else {
      const [, x, y, w, hgt, rx] = shape;
      for (const [k, v] of Object.entries({ x, y, width: w, height: hgt, rx })) el.setAttribute(k, String(v));
    }
    svg.append(el);
  }
  return svg;
}
