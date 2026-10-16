import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../../core/db.js";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaRegistryStore } from "./prisma-store.js";

const db = createPrismaClient();

async function seedRun(options: {
  registryTokenHash: string;
  allowlist: Record<string, string[]>;
  packageAuditMode?: "audit" | "full";
}) {
  const suffix = randomUUID();
  const agentId = `registry-agent-${suffix}`;
  const runId = `registry-run-${suffix}`;
  const sessionId = `registry-session-${suffix}`;
  await db.agent.create({
    data: { id: agentId, name: agentId, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
  });
  await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
  await db.codingRun.create({
    data: {
      runId,
      task: "test",
      repository: "openai/example",
      baseRef: "main",
      headRef: `wardby/run-${runId}`,
      provider: "codex",
      model: "gpt-5.6-luna",
      timeoutSec: 60,
      protectedPaths: [],
      budgetReservedUsd: 0.0002,
      packageAllowlist: options.allowlist,
      packageAuditMode: options.packageAuditMode ?? null,
    },
  });
  await db.codingProxySession.create({
    data: {
      id: sessionId,
      runId,
      capabilityHash: `capability-hash-${suffix}`,
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["gpt-5.6-luna"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 0.0002,
      status: "active",
      registryTokenHash: options.registryTokenHash,
    },
  });
  return { db, runId, agentId };
}

describe.skipIf(!process.env.DATABASE_URL)("PrismaRegistryStore (database)", () => {
  const agentIds: string[] = [];
  const runIds: string[] = [];

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  it("resolves a live session's run, grows allowances, and totals usage", async () => {
    const { runId, agentId } = await seedRun({ registryTokenHash: "h1", allowlist: { npm: ["react"] } });
    runIds.push(runId);
    agentIds.push(agentId);

    const store = new PrismaRegistryStore(db);
    const context = await store.findRunByRegistryTokenHash("h1", new Date());
    expect(context).toMatchObject({
      runId,
      allowlist: { npm: ["react"] },
      repository: "openai/example",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });

    expect(await store.isAllowedDependency(runId, "npm", "loose-envify")).toBe(false);
    await store.addAllowances(runId, "npm", ["loose-envify", "loose-envify"]);
    expect(await store.isAllowedDependency(runId, "npm", "loose-envify")).toBe(true);

    // Extras a run allows ride in the same table, never as a fetchable name.
    await store.addExtraAllowances(runId, "pypi", [{ name: "uvicorn", extras: ["standard", "reload"] }]);
    await store.addExtraAllowances(runId, "pypi", [{ name: "uvicorn-x", extras: ["other"] }]);
    expect(await store.allowedExtras(runId, "pypi", "uvicorn")).toEqual(["reload", "standard"]);
    expect(await store.allowedExtras(runId, "npm", "uvicorn")).toEqual([]);
    expect(await store.isAllowedDependency(runId, "pypi", "uvicorn")).toBe(false);
    expect(await store.isAllowedDependency(runId, "pypi", "uvicorn[standard]")).toBe(false);

    await store.recordFetch({
      runId,
      ecosystem: "npm",
      name: "react",
      version: "19.0.0",
      sizeBytes: 100,
      outcome: "served",
    });
    await store.recordFetch({
      runId,
      ecosystem: "npm",
      name: "evil",
      outcome: "refused",
      reason: "wardby_package_not_allowed",
    });
    expect(await store.usage(runId)).toEqual({ files: 1, bytes: 100 });
    expect(await store.refusalCount(runId)).toBe(1);

    const fetches = await store.listFetches(runId);
    expect(fetches).toHaveLength(2);
    expect(fetches[0]).toMatchObject({ name: "react", outcome: "served", sizeBytes: 100 });
    expect(fetches[1]).toMatchObject({ name: "evil", outcome: "refused", reason: "wardby_package_not_allowed" });

    expect(await store.findRunByRegistryTokenHash("h1", new Date(Date.now() + 10 * 86_400_000))).toBeNull();
  });

  it("stores facts once, looks up approvals with their download URL, and drops approvals with the run", async () => {
    const { runId, agentId } = await seedRun({ registryTokenHash: `h2-${randomUUID()}`, allowlist: {} });
    agentIds.push(agentId);
    const name = `fact-${randomUUID()}`;
    const store = new PrismaRegistryStore(db);
    const facts = Array.from({ length: 600 }, (_, i) => ({
      name,
      version: `1.0.${i}`,
      publishedAt: new Date("2020-01-01T00:00:00Z"),
      integrity: `sha512-${i}`,
      downloadUrl: `https://registry.npmjs.org/${name}/-/${name}-1.0.${i}.tgz`,
      dependencies: [{ key: "a-cjs", name: "a", range: "^1" }],
    }));
    try {
      await store.putVersionFacts("npm", facts);
      await store.putVersionFacts("npm", [{ ...facts[0], integrity: "sha512-changed" }]);
      // More versions than one query's chunk.
      const read = await store.getVersionFacts(
        "npm",
        facts.map(({ version }) => ({ name, version })),
      );
      expect(read).toHaveLength(600);
      expect(read.find((fact) => fact.version === "1.0.0")).toEqual(facts[0]);
      expect(await store.getVersionFacts("pypi", [{ name, version: "1.0.0" }])).toEqual([]);

      await store.approveVersions(runId, "npm", [{ name, version: "1.0.1", integrity: "sha512-1" }]);
      expect(await store.findApprovedVersion(runId, "npm", name, "1.0.1")).toEqual({
        integrity: "sha512-1",
        downloadUrl: facts[1].downloadUrl,
        acceptedAdvisories: [],
      });
      await store.approveVersions(runId, "npm", [
        { name, version: "1.0.3", integrity: "sha512-3", acceptedAdvisories: ["GHSA-a", "GHSA-b"] },
      ]);
      expect(await store.findApprovedVersion(runId, "npm", name, "1.0.3")).toEqual({
        integrity: "sha512-3",
        downloadUrl: facts[3].downloadUrl,
        acceptedAdvisories: ["GHSA-a", "GHSA-b"],
      });
      expect(await store.findApprovedVersion(runId, "npm", name, "1.0.2")).toBeNull();
      await store.refusePlanVersions(runId, "npm", [
        { name, version: "9.0.0", code: "wardby_package_not_allowed", reason: "unreachable" },
      ]);
      await store.refusePlanVersions(runId, "npm", [
        {
          name,
          version: "9.1.0",
          code: "wardby_version_filtered",
          reason: "too new",
          publishedAt: facts[0].publishedAt,
        },
      ]);
      expect(await store.findPlanRefusal(runId, "npm", name, "9.0.0")).toEqual({
        code: "wardby_package_not_allowed",
        reason: "unreachable",
        publishedAt: null,
      });
      expect(await store.findPlanRefusal(runId, "npm", name, "9.1.0")).toEqual({
        code: "wardby_version_filtered",
        reason: "too new",
        publishedAt: facts[0].publishedAt,
      });
      expect(await store.findPlanRefusal(runId, "npm", name, "1.0.1")).toBeNull();
      await db.codingRun.delete({ where: { runId } });
      expect(await db.registryApprovedVersion.count({ where: { runId } })).toBe(0);
      expect(await db.registryPlanRefusal.count({ where: { runId } })).toBe(0);
      expect(await db.registryVersionFact.count({ where: { name } })).toBe(600);
    } finally {
      await db.registryVersionFact.deleteMany({ where: { name } });
      await db.run.deleteMany({ where: { id: runId } });
    }
  });

  it("reads the run's package audit mode and keeps audited allowances, approvals and records", async () => {
    const hash = `h3-${randomUUID()}`;
    const { runId, agentId } = await seedRun({ registryTokenHash: hash, allowlist: {}, packageAuditMode: "full" });
    runIds.push(runId);
    agentIds.push(agentId);
    const store = new PrismaRegistryStore(db);
    expect(await store.findRunByRegistryTokenHash(hash, new Date())).toMatchObject({ runId, packageAudit: "full" });

    expect(await store.findAllowance(runId, "npm", "expo-dev-client")).toBeNull();
    await store.addAuditedAllowances(runId, "npm", ["expo-dev-client"], "expo-dev-client");
    await store.addAuditedAllowances(runId, "npm", ["expo-dev-launcher", "expo-dev-launcher"], "expo-dev-client");
    expect(await store.findAllowance(runId, "npm", "expo-dev-launcher")).toEqual({ auditedVia: "expo-dev-client" });
    expect(await store.isAllowedDependency(runId, "npm", "expo-dev-launcher")).toBe(true);
    // The first writer wins: a later plain allowance (or another audited parent) keeps auditedVia.
    await store.addAllowances(runId, "npm", ["expo-dev-launcher", "react"]);
    await store.addAuditedAllowances(runId, "npm", ["expo-dev-launcher", "react"], "other");
    expect(await store.findAllowance(runId, "npm", "expo-dev-launcher")).toEqual({ auditedVia: "expo-dev-client" });
    expect(await store.findAllowance(runId, "npm", "react")).toEqual({ auditedVia: null });
    // An extra's row is never a package allowance.
    await store.addExtraAllowances(runId, "pypi", [{ name: "uvicorn", extras: ["standard"] }]);
    expect(await store.findAllowance(runId, "pypi", "uvicorn[standard]")).toBeNull();

    const record = {
      runId,
      ecosystem: "npm",
      name: "expo-dev-client",
      version: "5.1.2",
      relation: "top-level" as const,
      sizeBytes: 41210,
      advisories: [],
    };
    await store.recordAudit(record);
    await store.recordAudit({ ...record, sizeBytes: 1 });
    await store.recordAudit({
      runId,
      ecosystem: "npm",
      name: "lodash",
      version: "4.17.20",
      relation: "allowed",
      advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "Command injection" }],
    });
    expect(
      await db.registryAuditRecord.findMany({
        where: { runId },
        orderBy: { createdAt: "asc" },
        select: {
          ecosystem: true,
          name: true,
          version: true,
          relation: true,
          via: true,
          sizeBytes: true,
          advisories: true,
        },
      }),
    ).toEqual([
      {
        ecosystem: "npm",
        name: "expo-dev-client",
        version: "5.1.2",
        relation: "top-level",
        via: null,
        sizeBytes: 41210,
        advisories: [],
      },
      {
        ecosystem: "npm",
        name: "lodash",
        version: "4.17.20",
        relation: "allowed",
        via: null,
        sizeBytes: null,
        advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "Command injection" }],
      },
    ]);

    const name = `audited-fact-${randomUUID()}`;
    try {
      await store.putVersionFacts("npm", [
        {
          name,
          version: "1.0.0",
          publishedAt: new Date("2020-01-01T00:00:00Z"),
          integrity: "sha512-a",
          downloadUrl: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
          dependencies: [],
        },
      ]);
      await store.approveVersions(runId, "npm", [
        { name, version: "1.0.0", integrity: "sha512-a", audit: { relation: "transitive", via: "b" } },
      ]);
      expect(await store.findApprovedVersion(runId, "npm", name, "1.0.0")).toEqual({
        integrity: "sha512-a",
        downloadUrl: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
        acceptedAdvisories: [],
        audit: { relation: "transitive", via: "b" },
      });
    } finally {
      await db.registryVersionFact.deleteMany({ where: { name } });
    }
  });
});
