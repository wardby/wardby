import { describe, expect, it } from "vitest";
import { MemoryRegistryStore } from "./store.js";

describe("MemoryRegistryStore package audit mode", () => {
  it("keeps the first writer of an allowance, records each version once, and round-trips an approval's audit", async () => {
    const store = new MemoryRegistryStore();
    expect(await store.findAllowance("r", "npm", "expo-dev-client")).toBeNull();
    await store.addAuditedAllowances("r", "npm", ["expo-dev-client"], "expo-dev-client");
    await store.addAuditedAllowances("r", "npm", ["expo-dev-launcher"], "expo-dev-client");
    expect(await store.findAllowance("r", "npm", "expo-dev-launcher")).toEqual({ auditedVia: "expo-dev-client" });
    expect(await store.isAllowedDependency("r", "npm", "expo-dev-launcher")).toBe(true);
    await store.addAllowances("r", "npm", ["expo-dev-launcher", "react"]);
    await store.addAuditedAllowances("r", "npm", ["expo-dev-launcher", "react"], "other");
    expect(await store.findAllowance("r", "npm", "expo-dev-launcher")).toEqual({ auditedVia: "expo-dev-client" });
    expect(await store.findAllowance("r", "npm", "react")).toEqual({ auditedVia: null });
    await store.addExtraAllowances("r", "pypi", [{ name: "uvicorn", extras: ["standard"] }]);
    expect(await store.findAllowance("r", "pypi", "uvicorn[standard]")).toBeNull();

    const record = {
      runId: "r",
      ecosystem: "npm",
      name: "expo-dev-client",
      version: "5.1.2",
      relation: "top-level" as const,
      sizeBytes: 41210,
      advisories: [],
    };
    await store.recordAudit(record);
    await store.recordAudit({ ...record, sizeBytes: 1 });
    expect(store.audits.map(({ runId: _r, createdAt: _c, ...row }) => row)).toEqual([
      {
        ecosystem: "npm",
        name: "expo-dev-client",
        version: "5.1.2",
        relation: "top-level",
        sizeBytes: 41210,
        advisories: [],
      },
    ]);

    await store.putVersionFacts("npm", [
      {
        name: "c",
        version: "1.0.0",
        publishedAt: new Date(0),
        integrity: "sha512-c",
        downloadUrl: "https://registry.npmjs.org/c/-/c-1.0.0.tgz",
        dependencies: [],
      },
    ]);
    await store.approveVersions("r", "npm", [
      { name: "c", version: "1.0.0", integrity: "sha512-c", audit: { relation: "transitive", via: "b" } },
    ]);
    expect(await store.findApprovedVersion("r", "npm", "c", "1.0.0")).toEqual({
      integrity: "sha512-c",
      downloadUrl: "https://registry.npmjs.org/c/-/c-1.0.0.tgz",
      acceptedAdvisories: [],
      audit: { relation: "transitive", via: "b" },
    });
  });
});

describe("MemoryRegistryStore shared run state", () => {
  const now = new Date("2026-11-16T00:00:00Z");
  const later = new Date(now.getTime() + 60_000);

  it("takes a plan lease that lapses on its own, and refuses past the plan limit", async () => {
    const store = new MemoryRegistryStore();
    expect(await store.startPlan("r", { max: 3, leaseUntil: later, now })).toBe("started");
    expect(await store.startPlan("r", { max: 3, leaseUntil: later, now })).toBe("busy");
    // The replica that held the lease died: once it lapses, the next plan may start.
    expect(await store.startPlan("r", { max: 3, leaseUntil: later, now: later })).toBe("started");
    await store.endPlan("r");
    expect(await store.startPlan("r", { max: 3, leaseUntil: later, now: later })).toBe("started");
    await store.endPlan("r");
    expect(await store.startPlan("r", { max: 3, leaseUntil: later, now: later })).toBe("limit");
  });

  it("keeps a run's plan fallback per ecosystem, without duplicates", async () => {
    const store = new MemoryRegistryStore();
    expect(await store.planFallback("r")).toEqual([]);
    await store.addPlanFallback("r", "npm");
    await store.addPlanFallback("r", "npm");
    expect(await store.planFallback("r")).toEqual(["npm"]);
    expect(await store.planFallback("other")).toEqual([]);
  });

  it("reserves files against served rows and live reservations, and sums bytes for a sync", async () => {
    const store = new MemoryRegistryStore();
    await store.recordFetch({ runId: "r", ecosystem: "npm", name: "a", outcome: "served", sizeBytes: 10 });
    const first = await store.reserveDownload("r", { sizeBytes: 5, maxFiles: 3, leaseUntil: later, now });
    const second = await store.reserveDownload("r", { sizeBytes: null, maxFiles: 3, leaseUntil: later, now });
    expect(first).not.toBeNull();
    expect(await store.reserveDownload("r", { sizeBytes: 1, maxFiles: 3, leaseUntil: later, now })).toBeNull();
    expect(await store.syncDownload("r", second!, { streamedBytes: 7, leaseUntil: later, now })).toBe(22);
    await store.releaseDownload(first!);
    expect(await store.syncDownload("r", second!, { streamedBytes: 7, leaseUntil: later, now })).toBe(17);
  });
});
