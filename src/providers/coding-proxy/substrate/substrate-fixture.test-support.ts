import type { PrismaClient } from "#prisma";

/**
 * Test fixture: an Agent, Run, CodingRun and SubstrateRun for `token`. Any rows left by an earlier
 * run of the same token are removed first. The caller deletes the run (and its cascade) afterwards.
 */
export async function createSubstrateRunFixture(
  db: PrismaClient,
  token: string,
  overrides: { phase?: string; specHash?: string; deadlineAt?: Date } = {},
): Promise<{ runId: string; agentId: string }> {
  const runId = `substrate-run-${token}`;
  const agentId = `substrate-agent-${token}`;
  await db.codingRun.deleteMany({ where: { runId } });
  await db.run.deleteMany({ where: { id: runId } });
  await db.agent.deleteMany({ where: { id: agentId } });
  await db.agent.create({
    data: { id: agentId, name: agentId, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
  });
  await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
  await db.codingRun.create({
    data: {
      runId,
      task: "test",
      repository: "example/repo",
      baseRef: "main",
      headRef: `wardby/run-${runId}`,
      provider: "codex",
      model: "gpt-5.6-luna",
      timeoutSec: 60,
      allowedEgress: [],
      protectedPaths: [],
      budgetReservedUsd: 0.0002,
    },
  });
  await db.substrateRun.create({
    data: {
      runId,
      token,
      specHash: overrides.specHash ?? "spec-hash",
      phase: overrides.phase ?? "provisioning",
      deadlineAt: overrides.deadlineAt ?? new Date(Date.now() + 60_000),
    },
  });
  return { runId, agentId };
}
