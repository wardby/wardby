import { describe, expect, it } from "vitest";
import {
  CODING_PROVIDER_LABELS,
  CODING_PROVIDERS,
  assertCodingProviderModel,
  codingProviderForModelProvider,
  codingProviderHasToolRunner,
  codingProviderProtocol,
  codingProviderSupportsModel,
  codingProviderTakesSubAgents,
} from "./provider.js";
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

describe("gemini-cli is the third coding provider", () => {
  it("runs Vertex and AI Studio Gemini models, never Bedrock", () => {
    const catalog = buildCatalog(SHIPPED_CATALOG, [], "2026-10-03");
    expect(CODING_PROVIDERS).toEqual(["codex", "claude-code", "gemini-cli"]);
    expect(codingProviderForModelProvider("vertex-gemini")).toBe("gemini-cli");
    expect(codingProviderForModelProvider("google-ai-studio")).toBe("gemini-cli");
    expect(codingProviderForModelProvider("bedrock-claude")).toBeUndefined();
    expect(codingProviderSupportsModel("gemini-cli", "google-ai-studio.gemini-4-neon", catalog)).toBe(true);
    expect(codingProviderSupportsModel("gemini-cli", "us.gemini-4-hydrogen", catalog)).toBe(true);
    expect(codingProviderSupportsModel("codex", "gemini-4-neon", catalog)).toBe(false);
    expect(codingProviderSupportsModel("gemini-cli", "claude-sonnet-5", catalog)).toBe(false);
  });

  it("has the Codex shape: no tool runner, the Gemini protocol, sub-agents like Claude Code", () => {
    expect(codingProviderHasToolRunner("claude-code")).toBe(true);
    expect(codingProviderHasToolRunner("codex")).toBe(false);
    expect(codingProviderHasToolRunner("gemini-cli")).toBe(false);
    // Fails closed: an unknown or missing provider is treated as running commands next to the agent.
    expect(codingProviderHasToolRunner(undefined)).toBe(false);
    expect(codingProviderProtocol("codex")).toBe("openai-responses");
    expect(codingProviderProtocol("claude-code")).toBe("anthropic-messages");
    expect(codingProviderProtocol("gemini-cli")).toBe("gemini-generate-content");
    expect(() => codingProviderProtocol("cursor")).toThrow("coding_provider_unsupported");
    expect(codingProviderTakesSubAgents("claude-code")).toBe(true);
    expect(codingProviderTakesSubAgents("gemini-cli")).toBe(true);
    expect(codingProviderTakesSubAgents("codex")).toBe(false);
    expect(CODING_PROVIDER_LABELS).toEqual({
      codex: "Codex",
      "claude-code": "Claude Code",
      "gemini-cli": "Gemini CLI",
    });
  });
});
