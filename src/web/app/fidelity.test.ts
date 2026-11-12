// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fidelityDiff, measuredElements, selectorKey } from "./fidelity.js";

describe("fidelityDiff", () => {
  it("counts each differing property once per selector key and keeps six samples", () => {
    const before = [
      { key: "a.btn", styles: { "background-color": "rgb(193, 98, 59)", color: "rgb(255, 255, 255)" } },
      { key: "a.btn", styles: { "background-color": "rgb(193, 98, 59)", color: "rgb(255, 255, 255)" } },
      { key: "body", styles: { "background-color": "rgb(251, 243, 231)", color: "rgb(0, 0, 0)" } },
    ];
    const after = [
      { key: "a.btn", styles: { "background-color": "rgba(0, 0, 0, 0)", color: "rgb(255, 255, 255)" } },
      { key: "a.btn", styles: { "background-color": "rgba(0, 0, 0, 0)", color: "rgb(255, 255, 255)" } },
      { key: "body", styles: { "background-color": "rgb(251, 243, 231)", color: "rgb(0, 0, 0)" } },
    ];
    const r = fidelityDiff(before, after);
    expect(r.mismatches).toBe(1);
    expect(r.samples).toEqual(["a.btn background-color: rgb(193, 98, 59) → rgba(0, 0, 0, 0)"]);
  });
});

describe("the measured elements", () => {
  it("walks only the root and its descendants, and skips gjs-* classes in the selector key", () => {
    document.body.innerHTML =
      '<div class="gjs-tools"><span class="gjs-badge">x</span></div>' +
      '<div id="root" class="gjs-selected"><a class="gjs-hovered btn">x</a><style>a{}</style><p>y</p></div>';
    const root = document.getElementById("root")!;
    const els = measuredElements(root);
    expect(els.map(selectorKey)).toEqual(["div", "a.btn", "p"]);
  });
});
