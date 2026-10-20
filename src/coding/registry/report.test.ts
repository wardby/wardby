import { describe, expect, it } from "vitest";
import { refusalHint } from "./refusal-hints.js";
import {
  acceptedAdvisoriesReason,
  LISTING_REFUSAL_FILENAME,
  parseAcceptedAdvisories,
  summarizeRegistryFetches,
} from "./report.js";

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

  it.each(["npm", "pypi"])(
    "drops a %s refusal the same package was served after (a retried temporary error)",
    (eco) => {
      const row = { sizeBytes: null, filename: null };
      const { packages, packageRefusals } = summarizeRegistryFetches([
        // A name-level refusal (no version) is cleared by any later served version of the name.
        { ...row, ecosystem: eco, name: "a", version: null, outcome: "refused", reason: "wardby_upstream_error" },
        { ...row, ecosystem: eco, name: "a", version: "1.0.0", outcome: "served", reason: null },
        // A version's refusal is cleared only by that version being served later.
        { ...row, ecosystem: eco, name: "b", version: "2.0.0", outcome: "refused", reason: "wardby_upstream_error" },
        { ...row, ecosystem: eco, name: "b", version: "2.0.0", outcome: "served", reason: null },
        { ...row, ecosystem: eco, name: "c", version: "2.0.0", outcome: "refused", reason: "wardby_version_filtered" },
        { ...row, ecosystem: eco, name: "c", version: "1.0.0", outcome: "served", reason: null },
        // Served first, refused after: the refusal still stands.
        { ...row, ecosystem: eco, name: "d", version: "1.0.0", outcome: "served", reason: null },
        { ...row, ecosystem: eco, name: "d", version: null, outcome: "refused", reason: "wardby_graph_incomplete" },
      ]);
      expect(packages.map((p) => p.name)).toEqual(["a", "b", "c", "d"]);
      expect(packageRefusals.map((r) => [r.name, r.reason])).toEqual([
        ["c", "wardby_version_filtered"],
        ["d", "wardby_graph_incomplete"],
      ]);
    },
  );

  it("clears a refusal only with a package served in the same run", () => {
    const row = { sizeBytes: null, filename: null };
    const { packageRefusals } = summarizeRegistryFetches([
      {
        ...row,
        runId: "a",
        ecosystem: "npm",
        name: "foo",
        version: null,
        outcome: "refused",
        reason: "wardby_upstream_error",
      },
      {
        ...row,
        runId: "b",
        ecosystem: "npm",
        name: "foo",
        version: null,
        outcome: "refused",
        reason: "wardby_upstream_error",
      },
      { ...row, runId: "b", ecosystem: "npm", name: "foo", version: "1.0.0", outcome: "served", reason: null },
    ]);
    // b got past it; a did not, so the refusal stands (once).
    expect(packageRefusals.map((r) => [r.name, r.reason])).toEqual([["foo", "wardby_upstream_error"]]);
    const cleared = summarizeRegistryFetches([
      {
        ...row,
        runId: "b",
        ecosystem: "npm",
        name: "foo",
        version: null,
        outcome: "refused",
        reason: "wardby_upstream_error",
      },
      { ...row, runId: "b", ecosystem: "npm", name: "foo", version: "1.0.0", outcome: "served", reason: null },
    ]);
    expect(cleared.packageRefusals).toEqual([]);
  });

  it.each(["npm", "pypi"])(
    "marks a %s refusal recorded only from an index listing, until a real one joins it",
    (eco) => {
      const row = { sizeBytes: null, version: null };
      const listing = { ...row, filename: LISTING_REFUSAL_FILENAME, outcome: "refused" };
      const { packageRefusals } = summarizeRegistryFetches([
        { ...listing, ecosystem: eco, name: "looked-at", reason: "wardby_file_not_allowed" },
        { ...listing, ecosystem: eco, name: "looked-at", reason: "wardby_file_not_allowed" },
        // Listed, then a version of it served: cleared like any name-level refusal.
        { ...listing, ecosystem: eco, name: "served-later", reason: "wardby_version_filtered" },
        {
          ...row,
          ecosystem: eco,
          name: "served-later",
          version: "1.0",
          outcome: "served",
          reason: null,
          filename: "x",
        },
        // Listed, then its download refused: a real refusal.
        { ...listing, ecosystem: eco, name: "downloaded", reason: "wardby_file_not_allowed" },
        {
          ...row,
          ecosystem: eco,
          name: "downloaded",
          version: "1.0",
          outcome: "refused",
          reason: "wardby_file_not_allowed",
          filename: "downloaded-1.0.tar.gz",
        },
      ]);
      expect(packageRefusals).toEqual([
        {
          ecosystem: eco,
          name: "looked-at",
          reason: "wardby_file_not_allowed",
          hint: refusalHint("wardby_file_not_allowed"),
          listingOnly: true,
        },
        {
          ecosystem: eco,
          name: "downloaded",
          reason: "wardby_file_not_allowed",
          hint: refusalHint("wardby_file_not_allowed"),
        },
      ]);
    },
  );

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
