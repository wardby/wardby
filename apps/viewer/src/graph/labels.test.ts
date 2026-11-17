import { describe, expect, it } from "vitest";
import { codingBadge, shortModel, triggerLabel } from "./labels";

describe("shortModel", () => {
  it("drops the claude- prefix and a trailing date stamp", () => {
    expect(shortModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
    expect(shortModel("claude-sonnet-4-6")).toBe("sonnet-4-6");
  });

  it("leaves other models alone", () => {
    expect(shortModel("gpt-5.5-codex")).toBe("gpt-5.5-codex");
  });
});

describe("codingBadge", () => {
  it("names the known workers", () => {
    expect(codingBadge("codex")).toEqual({ text: "CX", name: "Codex", known: true });
    expect(codingBadge("claude-code")).toEqual({ text: "CC", name: "Claude Code", known: true });
  });

  it("falls back to the provider's first two letters", () => {
    expect(codingBadge("aider")).toEqual({ text: "AI", name: "aider", known: false });
  });
});

describe("triggerLabel", () => {
  it("names a plan approval", () => {
    expect(triggerLabel({ kind: "plan_approved" })).toBe("plan approved");
  });
});
