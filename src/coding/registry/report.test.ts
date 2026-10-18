import { describe, expect, it } from "vitest";
import { refusalHint } from "./refusal-hints.js";
import { acceptedAdvisoriesReason, parseAcceptedAdvisories, summarizeRegistryFetches } from "./report.js";

describe("summarizeRegistryFetches", () => {
  it("dedupes served packages by ecosystem+name+version and refusals by ecosystem+name+reason", () => {
    const row = { reason: null, sizeBytes: null, version: null };
    const summary = summarizeRegistryFetches([
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", sizeBytes: 10 },
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", sizeBytes: 10 },
      { ...row, ecosystem: "pypi", name: "react", version: "19.0.0", outcome: "served" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_package_not_allowed" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_package_not_allowed" },
      { ...row, ecosystem: "npm", name: "left-pad", outcome: "refused", reason: "wardby_upstream_error" },
    ]);
    expect(summary.packages).toEqual([
      { ecosystem: "npm", name: "react", version: "19.0.0", size: 10 },
      { ecosystem: "pypi", name: "react", version: "19.0.0", size: null },
    ]);
    expect(summary.packageRefusals).toEqual([
      {
        ecosystem: "npm",
        name: "left-pad",
        reason: "wardby_package_not_allowed",
        hint: refusalHint("wardby_package_not_allowed"),
      },
      { ecosystem: "npm", name: "left-pad", reason: "wardby_upstream_error" },
    ]);
  });

  it("adds the shared hint to each refusal whose code has one, and none for unknown codes", () => {
    const row = { reason: null, sizeBytes: null, version: null };
    const { packageRefusals } = summarizeRegistryFetches([
      { ...row, ecosystem: "npm", name: "a", outcome: "refused", reason: "wardby_package_not_allowed_pending" },
      { ...row, ecosystem: "npm", name: "b", outcome: "refused", reason: "wardby_upstream_error" },
    ]);
    expect(packageRefusals[0]).toEqual({
      ecosystem: "npm",
      name: "a",
      reason: "wardby_package_not_allowed_pending",
      hint: refusalHint("wardby_package_not_allowed_pending"),
    });
    expect(packageRefusals[0]?.hint).toContain("owner must allowlist");
    expect(packageRefusals[1]).toEqual({ ecosystem: "npm", name: "b", reason: "wardby_upstream_error" });
    expect(packageRefusals[1]).not.toHaveProperty("hint");
  });

  it("carries a served row's accepted-advisories reason onto its package, each id once", () => {
    const row = { sizeBytes: 5, filename: null };
    const summary = summarizeRegistryFetches([
      { ...row, ecosystem: "npm", name: "node-forge", version: "1.4.0", outcome: "served", reason: null },
      {
        ...row,
        ecosystem: "npm",
        name: "node-forge",
        version: "1.4.0",
        outcome: "served",
        reason: "accepted advisories: GHSA-86w9-cpqp-85rv",
      },
      {
        ...row,
        ecosystem: "npm",
        name: "node-forge",
        version: "1.4.0",
        outcome: "served",
        reason: "accepted advisories: GHSA-86w9-cpqp-85rv, GHSA-2nd",
      },
      { ...row, ecosystem: "npm", name: "react", version: "19.0.0", outcome: "served", reason: null },
    ]);
    expect(summary.packages).toEqual([
      {
        ecosystem: "npm",
        name: "node-forge",
        version: "1.4.0",
        size: 5,
        acceptedAdvisories: ["GHSA-86w9-cpqp-85rv", "GHSA-2nd"],
      },
      { ecosystem: "npm", name: "react", version: "19.0.0", size: 5 },
    ]);
  });
});

describe("accepted advisories reason", () => {
  it("round-trips the ids, and is absent with none", () => {
    expect(acceptedAdvisoriesReason(["GHSA-aaaa-bbbb", "CVE-2026-1"])).toBe(
      "accepted advisories: GHSA-aaaa-bbbb, CVE-2026-1",
    );
    expect(acceptedAdvisoriesReason([])).toBeUndefined();
    expect(parseAcceptedAdvisories("accepted advisories: GHSA-aaaa-bbbb, CVE-2026-1")).toEqual([
      "GHSA-aaaa-bbbb",
      "CVE-2026-1",
    ]);
    expect(parseAcceptedAdvisories("wardby_version_filtered")).toEqual([]);
    expect(parseAcceptedAdvisories(null)).toEqual([]);
    expect(parseAcceptedAdvisories("accepted advisories: GHSA-aaaa-bbbb, [x](https://e), @someone")).toEqual([
      "GHSA-aaaa-bbbb",
    ]);
  });
});
