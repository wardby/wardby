import { describe, expect, it } from "vitest";
import { parseGuestMentions, parseMentionRefs, parseMentions } from "./mentions.js";

describe("parseMentions", () => {
  it("extracts principal ids", () => {
    expect(parseMentions("hi @[p_1] and @[p_2], not @plain")).toEqual(["p_1", "p_2"]);
  });

  it("reads both stored forms in order, deduped, and keeps guests out of the principal list", () => {
    const body = "@[guest:g_1] then @[p_1], @[guest:g_1] again, @[guest:] and @[guest:bad id]";
    expect(parseMentionRefs(body)).toEqual([
      { kind: "guest", id: "g_1" },
      { kind: "principal", id: "p_1" },
    ]);
    expect(parseMentions(body)).toEqual(["p_1"]);
    expect(parseGuestMentions(body)).toEqual(["g_1"]);
  });

  it("applies the id length rule to guests too", () => {
    expect(parseGuestMentions(`@[guest:${"a".repeat(64)}]`)).toHaveLength(1);
    expect(parseGuestMentions(`@[guest:${"a".repeat(65)}]`)).toHaveLength(0);
  });
});
