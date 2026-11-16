import { describe, expect, it } from "vitest";
import { offsetFraction, pinPoint } from "./pins.js";

describe("pin geometry", () => {
  const frame = { left: 100, top: 50, width: 800, height: 600 };
  const el = { left: 20, top: 30, width: 200, height: 40 };
  it("places a pin at the fraction of the element inside the frame", () => {
    expect(pinPoint(frame, el, 0.5, 0.25)).toEqual({ x: 100 + 20 + 100, y: 50 + 30 + 10 });
  });
  it("turns a click into clamped fractions", () => {
    expect(offsetFraction(el, 120, 40)).toEqual({ dx: 0.5, dy: 0.25 });
    expect(offsetFraction(el, -500, 999)).toEqual({ dx: 0, dy: 1 });
  });
});
