import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../../core/db.js";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaRegistryStore } from "./prisma-store.js";

const db = createPrismaClient();

async function seedRun(options: { registryTokenHash: string; allowlist: Record<string, string[]> }) {
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
    expect(context).toMatchObject({ runId, allowlist: { npm: ["react"] } });

    expect(await store.isAllowedDependency(runId, "npm", "loose-envify")).toBe(false);
    await store.addAllowances(runId, "npm", ["loose-envify", "loose-envify"]);
    expect(await store.isAllowedDependency(runId, "npm", "loose-envify")).toBe(true);

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
});
