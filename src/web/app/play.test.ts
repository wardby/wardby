import { describe, expect, it } from "vitest";
import { nextPlayState } from "./play.js";

describe("Play navigation", () => {
  const ids = new Set(["home", "menu"]);
  it("pushes a board from its fragment and ignores unknown ones", () => {
    expect(nextPlayState({ stack: ["home"] }, "#board-menu", ids)).toEqual({ stack: ["home", "menu"] });
    expect(nextPlayState({ stack: ["home"] }, "#board-nope", ids)).toEqual({ stack: ["home"] });
    expect(nextPlayState({ stack: ["home"] }, "#thread-3", ids)).toEqual({ stack: ["home"] });
  });
  it("does not push the board that is already shown, and keeps the same state object when nothing changes", () => {
    const state = { stack: ["home", "menu"] };
    expect(nextPlayState(state, "#board-menu", ids)).toBe(state);
    expect(nextPlayState(state, "", ids)).toBe(state);
    expect(nextPlayState(state, "#board-home", ids)).toEqual({ stack: ["home", "menu", "home"] });
  });
});
