import { describe, expect, it } from "vitest";
import { fidelityDiff } from "./fidelity.js";

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
