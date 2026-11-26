import { describe, expect, it } from "vitest";
import { SHIPPED_CATALOG, SHIPPED_CATALOG_VERSION } from "./catalog-shipped.js";
import { parseStoredEntry } from "./catalog-types.js";

const byProvider = (provider: string) => SHIPPED_CATALOG.filter((e) => e.provider === provider);

describe("shipped model catalog", () => {
  it("has a dated version", () => {
    expect(SHIPPED_CATALOG_VERSION).toBe("2026-11-25");
  });

  it.each([
    ["gpt-4o", 2.5, 10, 1.25, 2.5],
    ["gpt-4o-mini", 0.15, 0.6, 0.075, 0.15],
    ["gpt-4.1", 2, 8, 0.5, 2],
    ["gpt-4.1-mini", 0.4, 1.6, 0.1, 0.4],
    ["gpt-4.1-nano", 0.1, 0.4, 0.025, 0.1],
    ["gpt-6-astra", 10, 50, 1, 12.5],
    ["gpt-5.6-sol", 4, 20, 0.4, 5],
    ["gpt-5.6-terra", 2, 12, 0.2, 2.5],
    ["gpt-5.6-luna", 0.2, 1.2, 0.02, 0.25],
    ["claude-opus-5", 5, 25, 0.5, 6.25],
    ["claude-sonnet-5", 2, 10, 0.2, 2.5],
    ["claude-fable-5", 10, 50, 1, 12.5],
    ["claude-haiku-4-5", 1, 5, 0.1, 1.25],
    ["us.anthropic.claude-sonnet-4-6", 3, 15, 0.3, 3.75],
    ["us.anthropic.claude-opus-4-6-v1", 5, 25, 0.5, 6.25],
    ["us.anthropic.claude-opus-4-8", 5, 25, 0.5, 6.25],
    ["us.anthropic.claude-haiku-4-5-20251001-v1:0", 1, 5, 0.1, 1.25],
  ])("%s is priced input %s / output %s / cache read %s / cache write %s", (id, input, output, read, write) => {
    const e = SHIPPED_CATALOG.find((x) => x.modelId === id)!;
    expect([e.inputPerMTok, e.outputPerMTok, e.cachedInputPerMTok, e.cacheWritePerMTok]).toEqual([
      input,
      output,
      read,
      write,
    ]);
  });

  it("lists exactly these 29 models", () => {
    expect(SHIPPED_CATALOG).toHaveLength(29);
  });

  it("keeps the anthropic opus/sonnet/fable effort ladder, and no efforts for haiku or Bedrock", () => {
    for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-fable-5"]) {
      expect([...SHIPPED_CATALOG.find((e) => e.modelId === id)!.efforts]).toEqual([
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    }
    for (const e of byProvider("bedrock-claude")) expect([...e.efforts]).toEqual([]);
    expect([...SHIPPED_CATALOG.find((e) => e.modelId === "claude-haiku-4-5")!.efforts]).toEqual([]);
  });

  it("lists efforts only on the OpenAI reasoning models, and none on the 4o/4.1 family", () => {
    const all = ["low", "medium", "high", "xhigh", "max"];
    const withEfforts = byProvider("openai")
      .filter((e) => e.efforts.length > 0)
      .map((e) => e.modelId);
    expect(withEfforts).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
    for (const id of withEfforts) {
      expect([...SHIPPED_CATALOG.find((e) => e.modelId === id)!.efforts]).toEqual(all);
    }
    for (const id of ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]) {
      expect([...SHIPPED_CATALOG.find((e) => e.modelId === id)!.efforts]).toEqual([]);
    }
  });

  it("marks only Claude Haiku 4.5 (direct API) as manual thinking, matching the proxy's old set", () => {
    const manual = SHIPPED_CATALOG.filter((e) => e.thinkingMode === "manual").map((e) => e.modelId);
    expect(manual).toEqual(["claude-haiku-4-5"]);
    for (const e of byProvider("openai")) expect(e.thinkingMode).toBe("none");
  });

  it("sets every rate as a finite non-negative literal", () => {
    for (const e of SHIPPED_CATALOG) {
      for (const rate of [e.inputPerMTok, e.outputPerMTok, e.cachedInputPerMTok, e.cacheWritePerMTok]) {
        expect(Number.isFinite(rate) && rate >= 0).toBe(true);
      }
    }
  });

  it("has unique model ids across providers (routing is by model id)", () => {
    const ids = SHIPPED_CATALOG.map((e) => e.modelId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

const GEMINI: [string, string, number, number, number, number, string[]][] = [
  // provider, modelId, input, output, cacheRead, cacheWrite, efforts
  ["google-ai-studio", "google-ai-studio.gemini-4-neon", 3.0, 15.0, 0.15, 3.0, ["low", "medium", "high", "xhigh"]],
  ["google-ai-studio", "google-ai-studio.gemini-4-hydrogen", 1.5, 7.5, 0.075, 1.5, ["low", "medium", "high", "xhigh"]],
  ["google-ai-studio", "google-ai-studio.gemini-4-carbon", 4.0, 20.0, 0.2, 4.0, ["low", "medium", "high"]],
  ["vertex-gemini", "gemini-4-neon", 3.0, 15.0, 0.15, 3.0, ["low", "medium", "high", "xhigh"]],
  ["vertex-gemini", "gemini-4-hydrogen", 1.5, 7.5, 0.075, 1.5, ["low", "medium", "high", "xhigh"]],
  ["vertex-gemini", "gemini-4-carbon", 4.0, 20.0, 0.2, 4.0, ["low", "medium", "high"]],
  ["vertex-gemini", "us.gemini-4-neon", 3.3, 16.5, 0.165, 3.3, ["low", "medium", "high", "xhigh"]],
  ["vertex-gemini", "eu.gemini-4-neon", 3.3, 16.5, 0.165, 3.3, ["low", "medium", "high", "xhigh"]],
  ["vertex-gemini", "us.gemini-4-hydrogen", 1.65, 8.25, 0.0825, 1.65, ["low", "medium", "high", "xhigh"]],
  ["vertex-gemini", "eu.gemini-4-hydrogen", 1.65, 8.25, 0.0825, 1.65, ["low", "medium", "high", "xhigh"]],
  ["vertex-gemini", "us.gemini-4-carbon", 4.4, 22.0, 0.22, 4.4, ["low", "medium", "high"]],
  ["vertex-gemini", "eu.gemini-4-carbon", 4.4, 22.0, 0.22, 4.4, ["low", "medium", "high"]],
];

describe("shipped Gemini entries", () => {
  it.each(GEMINI)("%s %s has its exact published rates", (provider, modelId, i, o, r, w, efforts) => {
    const entry = SHIPPED_CATALOG.find((e) => e.modelId === modelId);
    expect(entry).toEqual({
      provider,
      modelId,
      encoding: "o200k_base",
      inputPerMTok: i,
      outputPerMTok: o,
      cachedInputPerMTok: r,
      cacheWritePerMTok: w,
      efforts,
      thinkingMode: "level",
    });
  });

  it("parseStoredEntry accepts a level-mode vertex-gemini entry", () => {
    const entry = SHIPPED_CATALOG.find((e) => e.modelId === "gemini-4-neon");
    expect(parseStoredEntry(entry)).toEqual(entry);
  });
});
