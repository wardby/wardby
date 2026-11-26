import { describe, expect, it } from "vitest";
import { codingProviderForModelProvider, codingProviderSupportsModel, assertCodingProviderModel } from "./provider.js";
import { buildCatalog } from "../providers/llm/catalog.js";
import { SHIPPED_CATALOG } from "../providers/llm/catalog-shipped.js";

const base = SHIPPED_CATALOG.find((e) => e.modelId === "claude-sonnet-5")!;
const added = {
  ...base,
  modelId: "claude-added",
  enabled: true,
  sourceUrl: "x",
  updatedBy: "a",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("coding eligibility comes from the catalog", () => {
  it("treats every enabled anthropic entry as a Claude Code model, added ones included", () => {
    const catalog = buildCatalog(SHIPPED_CATALOG, [added], "2026-10-03");
    expect(codingProviderSupportsModel("claude-code", "claude-added", catalog)).toBe(true);
    expect(codingProviderSupportsModel("codex", "claude-added", catalog)).toBe(false);
  });
  it("treats openai entries as Codex models and never Bedrock entries", () => {
    const catalog = buildCatalog(SHIPPED_CATALOG, [], "2026-10-03");
    expect(codingProviderSupportsModel("codex", "gpt-5.6-sol", catalog)).toBe(true);
    expect(codingProviderSupportsModel("claude-code", "us.anthropic.claude-sonnet-4-6", catalog)).toBe(false);
  });
  it("drops a disabled model", () => {
    const catalog = buildCatalog(
      SHIPPED_CATALOG,
      [{ ...added, modelId: "claude-sonnet-5", enabled: false }],
      "2026-10-03",
    );
    expect(codingProviderSupportsModel("claude-code", "claude-sonnet-5", catalog)).toBe(false);
  });
  it("keeps assertCodingProviderModel's errors", () => {
    expect(() => assertCodingProviderModel("cursor", "x")).toThrow(/Unsupported coding provider/);
    expect(() => assertCodingProviderModel("codex", "claude-sonnet-5")).toThrow(/not supported by coding provider/);
  });
});

describe("Gemini providers are never coding providers", () => {
  it("maps vertex-gemini and google-ai-studio to undefined", () => {
    expect(codingProviderForModelProvider("vertex-gemini")).toBeUndefined();
    expect(codingProviderForModelProvider("google-ai-studio")).toBeUndefined();
  });
});
