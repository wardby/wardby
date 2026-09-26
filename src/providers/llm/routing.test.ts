import { describe, it, expect } from "vitest";
import { RoutingLlmProvider, modelAcceptsEffort, modelSupportedEfforts } from "./routing.js";
import type { LlmProvider } from "./types.js";

function fake(name: string): LlmProvider {
  return {
    async *stream() {
      yield { type: "done", stopReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
    async countTokens() {
      return name.length;
    },
    priceUsd() {
      return 0;
    },
  };
}

describe("RoutingLlmProvider", () => {
  it("routes countTokens to the provider that owns the model", async () => {
    const a = fake("aaaa");
    const b = fake("bb");
    const r = new RoutingLlmProvider([
      { provider: a, models: ["gpt-4o"] },
      { provider: b, models: ["claude-opus-5"] },
    ]);
    expect(await r.countTokens("gpt-4o", [])).toBe(4);
    expect(await r.countTokens("claude-opus-5", [])).toBe(2);
  });

  it("throws a clear error on an unknown model", async () => {
    const r = new RoutingLlmProvider([{ provider: fake("x"), models: ["gpt-4o"] }]);
    await expect(async () => {
      for await (const _ of r.stream({ model: "nope", messages: [] })) {
        /* */
      }
    }).rejects.toThrow(/nope/);
  });

  it("throws on a model claimed by two providers", () => {
    expect(
      () =>
        new RoutingLlmProvider([
          { provider: fake("a"), models: ["gpt-4o"] },
          { provider: fake("b"), models: ["gpt-4o"] },
        ]),
    ).toThrow(/gpt-4o/);
  });

  it("answers effort support by model without the caller naming a provider", () => {
    expect(modelAcceptsEffort("claude-sonnet-5", "xhigh")).toBe(true);
    expect(modelSupportedEfforts("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelAcceptsEffort("claude-haiku-4-5", "low")).toBe(false);
    // Effort is not sent through Bedrock or OpenAI, and an unknown model accepts nothing.
    expect(modelSupportedEfforts("us.anthropic.claude-sonnet-4-6")).toEqual([]);
    expect(modelSupportedEfforts("gpt-5.6-sol")).toEqual([]);
    expect(modelSupportedEfforts("nope")).toEqual([]);
  });

  it("listModels returns every registered model across all providers", () => {
    const r = new RoutingLlmProvider([
      { provider: fake("a"), models: ["gpt-4o", "gpt-4o-mini"] },
      { provider: fake("b"), models: ["claude-opus-5"] },
    ]);
    expect(r.listModels().sort()).toEqual(["claude-opus-5", "gpt-4o", "gpt-4o-mini"]);
  });
});
