import { describe, expect, it } from "vitest";
import { WARM_COLD_REASONS, type WarmColdReason } from "../providers/jobs/types.js";
import { WARM_ADOPTED_LINE, WARM_COLD_REASON_TEXT, warmStartLine } from "./warm-start-wording.js";

describe("warmStartLine", () => {
  it("says a round resumed", () => {
    expect(warmStartLine({ adopted: true })).toBe("Resumed the previous round's workspace and session");
    expect(WARM_ADOPTED_LINE).toBe("Resumed the previous round's workspace and session");
  });

  it.each([
    ["not_parked", "Started a fresh workspace: the previous round was not kept"],
    ["expired", "Started a fresh workspace: the previous round's sandbox expired"],
    ["branch_moved", "Started a fresh workspace: the branch changed since the previous round"],
    ["fingerprint_changed", "Started a fresh workspace: the agent's settings changed since the previous round"],
    ["actor_missing", "Started a fresh workspace: the previous round's sandbox was no longer available"],
    ["actor_not_suspended", "Started a fresh workspace: the previous round's sandbox was no longer available"],
    ["capacity", "Started a fresh workspace: there was no room to resume the previous round"],
  ] as const)("says why a round started fresh: %s", (reason, line) => {
    expect(warmStartLine({ adopted: false, reason })).toBe(line);
  });

  it("covers every cold reason, and nothing else", () => {
    expect(Object.keys(WARM_COLD_REASON_TEXT).sort()).toEqual([...WARM_COLD_REASONS].sort());
    expect(warmStartLine({ adopted: false, reason: "toString" as WarmColdReason })).toBeUndefined();
    expect(warmStartLine({ adopted: false, reason: "sk-ant-FAKE" as WarmColdReason })).toBeUndefined();
  });
});
