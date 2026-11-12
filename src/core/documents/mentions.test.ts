import { describe, expect, it } from "vitest";
import { parseMentions } from "./mentions.js";

describe("parseMentions", () => {
  it("extracts principal ids", () => {
    expect(parseMentions("hi @[p_1] and @[p_2], not @plain")).toEqual(["p_1", "p_2"]);
  });
});
