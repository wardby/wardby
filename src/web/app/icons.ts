/**
 * Small line icons for the review actions (24-unit grid, 1.75 stroke, `currentColor`), drawn here so the page loads
 * nothing extra. Decorative: the button's label names the action, so each icon is aria-hidden.
 */
const SVG = "http://www.w3.org/2000/svg";

type Shape = ["path", string] | ["circle", number, number, number] | ["rect", number, number, number, number, number];

const SHAPES = {
  /** Choose this option: pick this one. */
  choose: [
    ["circle", 12, 12, 9],
    ["path", "m8 12.5 2.8 2.8L16.5 9.5"],
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
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof SHAPES;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "15",
    height: "15",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "1.75",
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
