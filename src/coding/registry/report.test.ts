import { describe, expect, it } from "vitest";
import { summarizeRegistryFetches } from "./report.js";

describe("summarizeRegistryFetches", () => {
  it("dedupes served packages by ecosystem+name+version and refusals by ecosystem+name+reason", () => {
    const row = { reason: null, sizeBytes: null, version: null };
    const summary = summarizeRegistryFetches([
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", sizeBytes: 10 },
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", sizeBytes: 10 },
      { ...row, ecosystem: "pypi", name: "react", version: "19.0.0", outcome: "served" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_package_not_allowed" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_package_not_allowed" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_version_filtered" },
    ]);
    expect(summary.packages).toEqual([
      { ecosystem: "npm", name: "react", version: "19.0.0", size: 10 },
      { ecosystem: "pypi", name: "react", version: "19.0.0", size: null },
    ]);
    expect(summary.packageRefusals).toEqual([
      { ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" },
      { ecosystem: "npm", name: "left-pad", reason: "wardby_version_filtered" },
    ]);
  });
});
