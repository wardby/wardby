import { describe, expect, it } from "vitest";
import { authorLabel } from "./comments.js";

describe("authorLabel", () => {
  it("names the kind once: a guest's name already says (guest)", () => {
    expect(authorLabel({ kind: "guest", name: "Sam (guest)" })).toBe("Sam (guest)");
    expect(authorLabel({ kind: "guest", name: "Sam (guest)" }, "comment c1")).toBe("Sam (guest) (comment c1)");
  });

  it("adds the kind for members and agents, with the via name", () => {
    expect(authorLabel({ kind: "member", name: "Chris" })).toBe("Chris (member)");
    expect(authorLabel({ kind: "member", name: "Chris" }, "comment c2")).toBe("Chris (member, comment c2)");
    expect(authorLabel({ kind: "agent", name: "Agent", viaName: "Chris" }, "comment c3")).toBe(
      "Agent via Chris (agent, comment c3)",
    );
  });
});
