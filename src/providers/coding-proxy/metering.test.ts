import { describe, expect, it } from "vitest";
import {
  actualCostUsd,
  estimateReservationUsd,
  parseAuthoritativeUsage,
  terminalUsageFromSseFrame,
} from "./metering.js";

const pricing = {
  encoding: "o200k_base" as const,
  inputPerMTok: 0.2,
  cachedInputPerMTok: 0.02,
  cacheWritePerMTok: 0.25,
  outputPerMTok: 1.2,
};

describe("coding proxy metering", () => {
  it("reserves every UTF-8 byte as fresh input plus a possible cache write", () => {
    expect(estimateReservationUsd(100, 128, pricing)).toBe((100 * (0.2 + 0.25) + 128 * 1.2) / 1_000_000);
  });

  it("prices cached, cache-write, output, and reasoning-bearing usage", () => {
    const usage = parseAuthoritativeUsage({
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 500 },
      output_tokens: 100,
      output_tokens_details: { reasoning_tokens: 75 },
    });
    expect(usage.reasoningTokens).toBe(75);
    expect(actualCostUsd(usage, pricing)).toBeCloseTo(0.000373, 12);
  });

  it("rejects malformed, negative, and internally inconsistent authoritative usage", () => {
    expect(() => parseAuthoritativeUsage(undefined)).toThrow("invalid_authoritative_usage");
    expect(() => parseAuthoritativeUsage({ input_tokens: -1, output_tokens: 0 })).toThrow("input_tokens");
    expect(() =>
      parseAuthoritativeUsage({ input_tokens: 2, input_tokens_details: { cached_tokens: 3 }, output_tokens: 0 }),
    ).toThrow("details_exceed_total");
    expect(() =>
      parseAuthoritativeUsage({ input_tokens: 2, output_tokens: 1, output_tokens_details: { reasoning_tokens: 2 } }),
    ).toThrow("details_exceed_total");
  });

  it("extracts usage only from a terminal Responses SSE event", () => {
    const frame = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: { usage: { input_tokens: 7, output_tokens: 3 } },
    })}`;
    expect(terminalUsageFromSseFrame(frame)).toEqual({
      terminal: true,
      usage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    });
    expect(terminalUsageFromSseFrame("event: response.output_text.delta\ndata: {}")).toEqual({ terminal: false });
  });

  it("treats a failed terminal event without usage as unresolved", () => {
    expect(
      terminalUsageFromSseFrame('event: response.failed\ndata: {"type":"response.failed","response":{"usage":null}}'),
    ).toEqual({ terminal: true, usage: undefined });
  });
});
