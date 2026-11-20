import { describe, expect, it } from "vitest";
import { formatSpendLine } from "./run-spend.js";

describe("formatSpendLine", () => {
  it("shows the tree total, the issue total and the models by cost", () => {
    expect(
      formatSpendLine({
        treeUsd: 1.84,
        issueUsd: 4.12,
        models: [
          { model: "claude-sonnet-4-6", costUsd: 1.52 },
          { model: "claude-haiku-4-5", costUsd: 0.32 },
        ],
      }),
    ).toBe(
      "Agent spend: $1.84 this run · $4.12 on this issue so far · claude-sonnet-4-6 $1.52, claude-haiku-4-5 $0.32",
    );
  });

  it("omits the issue total when unattributed and the models when unknown", () => {
    expect(formatSpendLine({ treeUsd: 0.01, issueUsd: null, models: [] })).toBe("Agent spend: $0.01 this run");
  });

  it("shows cents for $1 and up, and 2 significant digits below $1, never in exponent form", () => {
    const line = (usd: number) => formatSpendLine({ treeUsd: usd, issueUsd: null, models: [] });
    expect(line(0.0034567)).toBe("Agent spend: $0.0035 this run");
    expect(line(0.1234)).toBe("Agent spend: $0.12 this run");
    expect(line(12.343)).toBe("Agent spend: $12.34 this run");
    expect(line(1234.5)).toBe("Agent spend: $1234.50 this run");
    expect(line(1.84)).toBe("Agent spend: $1.84 this run");
    expect(line(0.5)).toBe("Agent spend: $0.50 this run");
    expect(line(0.00000012)).toBe("Agent spend: $0.00000012 this run");
    expect(line(0)).toBe("Agent spend: $0.00 this run");
    expect(line(0.0999)).toBe("Agent spend: $0.10 this run");
    expect(line(0.0012)).toBe("Agent spend: $0.0012 this run");
  });
});
