import { describe, expect, it } from "vitest";
import { SeenIds } from "./seen.js";

describe("SeenIds", () => {
  it("passes each call id of a session once", () => {
    const seen = new SeenIds();
    expect(seen.fresh("s1", [{ callId: "a" }, { callId: "b" }])).toEqual([{ callId: "a" }, { callId: "b" }]);
    expect(seen.fresh("s1", [{ callId: "a" }, { callId: "c" }])).toEqual([{ callId: "c" }]);
    expect(seen.fresh("s2", [{ callId: "a" }])).toEqual([{ callId: "a" }]);
  });

  it("forgets the oldest sessions and ids past its bounds", () => {
    const seen = new SeenIds(2, 2);
    seen.fresh("s1", [{ callId: "a" }]);
    seen.fresh("s2", [{ callId: "a" }]);
    seen.fresh("s3", [{ callId: "a" }]);
    expect(seen.fresh("s1", [{ callId: "a" }])).toEqual([{ callId: "a" }]);
    seen.fresh("s4", [{ callId: "x" }, { callId: "y" }, { callId: "z" }]);
    expect(seen.fresh("s4", [{ callId: "x" }])).toEqual([{ callId: "x" }]);
  });

  it("forgets a session it is told has ended", () => {
    const seen = new SeenIds();
    seen.fresh("s1", [{ callId: "a" }]);
    seen.fresh("s2", [{ callId: "a" }]);
    seen.forget("s1");
    seen.forget("never-seen");
    expect(seen.fresh("s1", [{ callId: "a" }])).toEqual([{ callId: "a" }]);
    expect(seen.fresh("s2", [{ callId: "a" }])).toEqual([]);
  });
});
