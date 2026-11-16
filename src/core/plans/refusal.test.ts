import { describe, expect, it } from "vitest";
import { PlanRefusedError, refusalOf } from "./refusal.js";

describe("refusalOf", () => {
  it.each(["plan_number_missing", "plan_too_large"] as const)("maps a %s refusal to its code and message", (code) => {
    expect(refusalOf(new PlanRefusedError(code, "detail"))).toEqual({ error: code, message: `${code}: detail` });
  });

  it("has nothing for any other error", () => {
    expect(refusalOf(new Error("plan_number_missing: x"))).toBeUndefined();
    expect(refusalOf("plan_too_large")).toBeUndefined();
  });
});
