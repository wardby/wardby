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
    expect(await store.listAudits("r")).toEqual([
      {
        ecosystem: "npm",
        name: "expo-dev-client",
        version: "5.1.2",
        relation: "top-level",
        via: null,
        sizeBytes: 41210,
        advisories: [],
      },
    ]);
    expect(await store.listAudits("other")).toEqual([]);

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
