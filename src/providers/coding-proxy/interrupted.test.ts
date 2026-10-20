import { describe, expect, it } from "vitest";
import type { ModelPricing } from "../llm/pricing-core.js";
import { estimateInterrupted, relayedOutputTokens } from "./interrupted.js";

// claude-sonnet-5-5 catalog rates.
const PRICE: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 2,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 2.5,
  outputPerMTok: 10,
};
const usd = (n: number) => Number(n.toFixed(6));

describe("estimateInterrupted", () => {
  it("prices the usage Anthropic already reported plus the output so far", () => {
    const { usage, costUsd } = estimateInterrupted(
      {
        readUsage: { inputTokens: 42_000, cachedInputTokens: 40_000, cacheWriteTokens: 1_000 },
        reportedOutputTokens: 300,
        relayedOutputBytes: 5_000,
        reservationUsd: 2.12,
        maxOutputTokens: 32_000,
      },
      PRICE,
    );
    expect(usage).toEqual({
      inputTokens: 42_000,
      cachedInputTokens: 40_000,
      cacheWriteTokens: 1_000,
      outputTokens: 300,
      reasoningTokens: 0,
    });
    // 2k fresh × 2 + 40k × 0.1 + 1k × 2.5 + 300 × 10, per million
    expect(usd(costUsd)).toBe(usd((2_000 * 2 + 40_000 * 0.1 + 1_000 * 2.5 + 300 * 10) / 1e6));
  });

  it("without read usage, uses the previous reply's input and the relayed output", () => {
    const { usage } = estimateInterrupted(
      {
        relayedOutputBytes: 900,
        previous: {
          inputTokens: 50_000,
          cachedInputTokens: 48_000,
          cacheWriteTokens: 0,
          outputTokens: 80,
          reasoningTokens: 0,
        },
        medianOutputTokens: 120,
        reservationUsd: 3.18,
        maxOutputTokens: 32_000,
      },
      PRICE,
    );
    expect(usage).toMatchObject({
      inputTokens: 50_000,
      cachedInputTokens: 48_000,
      outputTokens: relayedOutputTokens(900),
    });
  });

  it("with nothing relayed, falls back to the run's median output", () => {
    const { usage } = estimateInterrupted(
      {
        relayedOutputBytes: 0,
        previous: {
          inputTokens: 50_000,
          cachedInputTokens: 48_000,
          cacheWriteTokens: 0,
          outputTokens: 80,
          reasoningTokens: 0,
        },
        medianOutputTokens: 120,
        reservationUsd: 3.18,
        maxOutputTokens: 32_000,
      },
      PRICE,
    );
    expect(usage.outputTokens).toBe(120);
  });

  it("on a run's first request, keeps the input part of the hold and prices the relayed output", () => {
    const { costUsd } = estimateInterrupted(
      { relayedOutputBytes: 300, reservationUsd: 2.12, maxOutputTokens: 32_000 },
      PRICE,
    );
    expect(usd(costUsd)).toBe(usd(2.12 - (32_000 * 10) / 1e6 + (relayedOutputTokens(300) * 10) / 1e6));
  });

  it("prices usage read from message_start above the hold, up to the worst case", () => {
    const facts = {
      readUsage: { inputTokens: 100_000, cachedInputTokens: 0, cacheWriteTokens: 0 },
      reportedOutputTokens: 0,
      relayedOutputBytes: 0,
      reservationUsd: 0.05,
      maxOutputTokens: 1_000,
    };
    // 100k fresh input × 2 per million = 0.2: more than the 0.05 hold, less than the 1.0 worst case.
    expect(usd(estimateInterrupted({ ...facts, ceilingUsd: 1 }, PRICE).costUsd)).toBe(0.2);
    expect(estimateInterrupted({ ...facts, ceilingUsd: 0.1 }, PRICE).costUsd).toBe(0.1);
  });

  it("without a worst case, never exceeds the request's hold", () => {
    const { costUsd } = estimateInterrupted(
      {
        readUsage: { inputTokens: 10_000_000, cachedInputTokens: 0, cacheWriteTokens: 0 },
        relayedOutputBytes: 0,
        reservationUsd: 0.5,
        maxOutputTokens: 1_000,
      },
      PRICE,
    );
    expect(costUsd).toBe(0.5);
  });

  it("treats message_start's output count as a floor: the relayed output wins when larger", () => {
    const facts = {
      readUsage: { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0 },
      outputFloorTokens: 1,
      relayedOutputBytes: 60_000,
      reservationUsd: 2,
      maxOutputTokens: 32_000,
    };
    expect(estimateInterrupted(facts, PRICE).usage.outputTokens).toBe(20_000);
    expect(estimateInterrupted({ ...facts, relayedOutputBytes: 1 }, PRICE).usage.outputTokens).toBe(1);
    expect(estimateInterrupted({ ...facts, outputFloorTokens: 25_000 }, PRICE).usage.outputTokens).toBe(25_000);
  });

  const PREVIOUS = {
    inputTokens: 50_000,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 80,
    reasoningTokens: 0,
  };

  it("with nothing relayed and no completed reply to take a median from, books no output", () => {
    const readUsage = { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0 };
    const base = { relayedOutputBytes: 0, reservationUsd: 2.12, maxOutputTokens: 32_000 };
    // message_start's placeholder stays a floor.
    expect(estimateInterrupted({ ...base, readUsage, outputFloorTokens: 1 }, PRICE).usage.outputTokens).toBe(1);
    expect(estimateInterrupted({ ...base, readUsage }, PRICE).usage.outputTokens).toBe(0);
    expect(estimateInterrupted({ ...base, previous: PREVIOUS }, PRICE).usage.outputTokens).toBe(0);
    // A run's first request: the input part of the hold, not the hold's reserved output.
    const first = estimateInterrupted(base, PRICE);
    expect(first.usage.outputTokens).toBe(0);
    expect(usd(first.costUsd)).toBe(usd(2.12 - (32_000 * 10) / 1e6));
  });

  it("with nothing relayed, books the run's median output when there is one", () => {
    const readUsage = { inputTokens: 1_000, cachedInputTokens: 0, cacheWriteTokens: 0 };
    const base = { relayedOutputBytes: 0, reservationUsd: 2.12, maxOutputTokens: 32_000, medianOutputTokens: 700 };
    expect(estimateInterrupted({ ...base, readUsage, outputFloorTokens: 1 }, PRICE).usage.outputTokens).toBe(700);
    expect(estimateInterrupted({ ...base, previous: PREVIOUS }, PRICE).usage.outputTokens).toBe(700);
    const first = estimateInterrupted(base, PRICE);
    expect(first.usage.outputTokens).toBe(700);
    expect(usd(first.costUsd)).toBe(usd(2.12 - (32_000 * 10) / 1e6 + (700 * 10) / 1e6));
  });

  it("for a stream that failed before its response started, books no output", () => {
    const base = { relayedOutputBytes: 0, reservationUsd: 2.12, maxOutputTokens: 32_000, beforeResponse: true };
    const previous = {
      inputTokens: 50_000,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 80,
      reasoningTokens: 0,
    };
    expect(estimateInterrupted({ ...base, previous, medianOutputTokens: 700 }, PRICE).usage.outputTokens).toBe(0);
    expect(usd(estimateInterrupted(base, PRICE).costUsd)).toBe(usd(2.12 - (32_000 * 10) / 1e6));
  });

  it("counts relayed text high: ceil(bytes / 3)", () => {
    expect(relayedOutputTokens(0)).toBe(0);
    expect(relayedOutputTokens(10)).toBe(4);
  });
});
