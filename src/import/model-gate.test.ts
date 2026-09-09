import { describe, it, expect } from "vitest";
import { classifyModel } from "./model-gate.js";

describe("classifyModel", () => {
  const routable = new Set(["gpt-4o", "claude-opus-5"]);
  it("routable when the model is registered", () => {
    expect(classifyModel("gpt-4o", routable)).toBe("routable");
  });
  it("unroutable when the model id is not in the routable set (e.g. an un-rostered Bedrock inference-profile id)", () => {
    // The Bedrock-Claude adapter is registered, but its pricing roster is
    // seeded — a profile id not yet in bedrockClaudeSupportedModels() is not
    // routable. A rostered id (e.g. "anthropic.claude-sonnet-5-v1:0") would be.
    expect(classifyModel("us.anthropic.claude-opus-4-6-v1", routable)).toBe("unroutable");
  });
});
