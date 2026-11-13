import { describe, expect, it } from "vitest";
import { SAMPLE_PAYLOADS } from "./samples.js";

describe("run hook sample payloads", () => {
  it("run_completed shows a run that opened a pull request in two repositories", () => {
    const sample = SAMPLE_PAYLOADS.run_completed as { pullRequests: Array<{ repository: string; number: number }> };
    expect(sample.pullRequests.map((p) => p.repository)).toEqual(["your-org/app", "your-org/tools"]);
  });
});
