import { describe, it, expect } from "vitest";
import { RoutingLlmProvider, modelAcceptsEffort, modelSupportedEfforts } from "./routing.js";
import type { CatalogLlmAdapter } from "./routing.js";
import { buildCatalog } from "./catalog.js";
import { SHIPPED_CATALOG } from "./catalog-shipped.js";
import type { CatalogEntry } from "./catalog-types.js";

function fake(name: string): CatalogLlmAdapter {
  const self: CatalogLlmAdapter = {
    async *stream() {
      yield { type: "done", stopReason: "stop", usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };
    },
    async countTokens() {
      return name.length;
    },
    priceUsd() {
      return 0;
    },
    withEntry: () => self,
  };
  return self;
}

describe("RoutingLlmProvider", () => {
  const catalog = () => buildCatalog(SHIPPED_CATALOG, [], "2026-10-03");

  it("routes countTokens to the provider that owns the model", async () => {
    const a = fake("aaaa");
    const b = fake("bb");
    const r = new RoutingLlmProvider(
      [
        { provider: "openai", adapter: a },
        { provider: "anthropic", adapter: b },
      ],
      catalog,
    );
    expect(await r.countTokens("gpt-4o", [])).toBe(4);
    expect(await r.countTokens("claude-opus-5", [])).toBe(2);
  });

  it("throws a clear error on an unknown model", async () => {
    const r = new RoutingLlmProvider([{ provider: "openai", adapter: fake("x") }], catalog);
    await expect(async () => {
      for await (const _ of r.stream({ model: "nope", messages: [] })) {
        /* */
      }
    }).rejects.toThrow(/nope/);
  });

  it("answers effort support by model without the caller naming a provider", () => {
    expect(modelAcceptsEffort("claude-sonnet-5", "xhigh")).toBe(true);
    expect(modelSupportedEfforts("claude-opus-5")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelAcceptsEffort("claude-haiku-4-5", "low")).toBe(false);
    // Effort is not sent through Bedrock, OpenAI 4o/4.1 models take none, and an unknown model accepts nothing.
    expect(modelSupportedEfforts("us.anthropic.claude-sonnet-4-6")).toEqual([]);
    expect(modelSupportedEfforts("gpt-4o")).toEqual([]);
    expect(modelSupportedEfforts("gpt-5.6-sol")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(modelAcceptsEffort("gpt-6-astra", "max")).toBe(true);
    expect(modelSupportedEfforts("nope")).toEqual([]);
  });

  it("listModels returns every catalog model across all configured providers", () => {
    const r = new RoutingLlmProvider(
      [
        { provider: "openai", adapter: fake("a") },
        { provider: "anthropic", adapter: fake("b") },
      ],
      catalog,
    );
    const expected = SHIPPED_CATALOG.filter((e) => e.provider === "openai" || e.provider === "anthropic").map(
      (e) => e.modelId,
    );
    expect(r.listModels().sort()).toEqual(expected.sort());
  });
});

function fakeAdapter(name: string, seen: string[]): CatalogLlmAdapter {
  const self: CatalogLlmAdapter = {
    async *stream() {},
    countTokens: async () => 1,
    priceUsd: (model) => {
      seen.push(`${name}:${model}`);
      return 1;
    },
    withEntry: (entry: CatalogEntry) => ({
      ...self,
      priceUsd: (model) => {
        seen.push(`${name}-pinned:${model}@${entry.outputPerMTok}`);
        return 2;
      },
    }),
  };
  return self;
}

describe("RoutingLlmProvider over the catalog", () => {
  const catalog = () => buildCatalog(SHIPPED_CATALOG, [], "2026-10-03");
  const usage = { inputTokens: 1, outputTokens: 1 };

  it("routes by the catalog entry's provider", () => {
    const seen: string[] = [];
    const router = new RoutingLlmProvider([{ provider: "anthropic", adapter: fakeAdapter("a", seen) }], catalog);
    router.priceUsd("claude-sonnet-5", usage);
    expect(seen).toEqual(["a:claude-sonnet-5"]);
  });

  it("lists only models whose provider is configured", () => {
    const router = new RoutingLlmProvider([{ provider: "anthropic", adapter: fakeAdapter("a", []) }], catalog);
    expect(router.listModels()).toContain("claude-haiku-4-5");
    expect(router.listModels()).not.toContain("gpt-4o");
  });

  it("refuses a catalog model whose provider has no credentials with provider_not_configured", () => {
    const router = new RoutingLlmProvider([{ provider: "anthropic", adapter: fakeAdapter("a", []) }], catalog);
    expect(() => router.entryFor("gpt-4o")).toThrow(/reason: provider_not_configured/);
  });

  it("refuses an unknown model with not_in_catalog", () => {
    const router = new RoutingLlmProvider([{ provider: "anthropic", adapter: fakeAdapter("a", []) }], catalog);
    expect(() => router.priceUsd("nope", usage)).toThrow(/reason: not_in_catalog/);
  });

  it("forRun pins the adapter to the stored entry", () => {
    const seen: string[] = [];
    const router = new RoutingLlmProvider([{ provider: "anthropic", adapter: fakeAdapter("a", seen) }], catalog);
    const entry = { ...catalog().require("claude-sonnet-5"), outputPerMTok: 99 };
    router.forRun(entry).priceUsd("claude-sonnet-5", usage);
    expect(seen).toEqual(["a-pinned:claude-sonnet-5@99"]);
  });

  it("refuses two registrations for one provider", () => {
    expect(
      () =>
        new RoutingLlmProvider(
          [
            { provider: "anthropic", adapter: fakeAdapter("a", []) },
            { provider: "anthropic", adapter: fakeAdapter("b", []) },
          ],
          catalog,
        ),
    ).toThrow(/more than once/);
  });

  it("reads effort levels from the current catalog", () => {
    expect(modelSupportedEfforts("claude-haiku-4-5")).toEqual([]);
    expect(modelSupportedEfforts("claude-sonnet-5")).toContain("high");
    expect(modelSupportedEfforts("unknown")).toEqual([]);
  });
});
