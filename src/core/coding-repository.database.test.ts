import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveCodingRepository, RepositoryChoiceRefusedError } from "./coding-repository.js";
import { createPrismaClient } from "./db.js";

describe.skipIf(!process.env.DATABASE_URL)("resolveCodingRepository (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `cr-owner-${tag}`;
  const agentId = `cr-agent-${tag}`;
  const profile = { repository: `acme/default-${tag}`, baseRef: "main" };
  const listed = `acme/listed-${tag}`;
  const withTrigger = `acme/triggered-${tag}`;
  const readOnly = `acme/readonly-${tag}`;
  const other = `acme/other-${tag}`;
  const runIds = [`cr-root-${tag}`, `cr-child-${tag}`];

  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "s",
        model: "gpt-5.6-luna",
        budgetUsd: 2,
        kind: "coding",
        ownerId,
        codingProfile: { create: { provider: "codex", repository: profile.repository, protectedPaths: [] } },
      },
    });
    await db.agentRepository.createMany({
      data: [
        { agentId, provider: "github", repository: listed, access: "write", triggers: [], baseRef: "develop" },
        { agentId, provider: "github", repository: withTrigger, access: "write", triggers: ["mention"] },
        { agentId, provider: "github", repository: readOnly, access: "read", triggers: [] },
      ],
    });
    for (const id of runIds) await db.run.create({ data: { id, agentId, status: "succeeded" } });
    const codingRun = (runId: string, repository: string, rootCodingRunId: string | null) =>
      db.codingRun.create({
        data: {
          runId,
          task: "t",
          repository,
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 60,
          protectedPaths: [],
          budgetReservedUsd: 1,
          rootCodingRunId,
        },
      });
    await codingRun(runIds[0], listed, null);
    // A continuation's own row can name another repository; the root's is the one that counts.
    await codingRun(runIds[1], other, runIds[0]);
  });

  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agentRepository.deleteMany({ where: { agentId } });
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: ownerId } });
    await db.$disconnect();
  });

  const resolve = (requested: string) => resolveCodingRepository(db, { agentId, profile, requested });

  it("accepts a write link without triggers, with its base branch", async () => {
    await expect(resolve(listed)).resolves.toEqual({
      repository: listed,
      baseRef: "develop",
      viaRepositoryLink: true,
    });
  });

  it.each([
    ["a write link with a trigger", withTrigger],
    ["a read link", readOnly],
  ])("refuses %s as not listed", async (_name, repository) => {
    const attempt = resolve(repository);
    await expect(attempt).rejects.toBeInstanceOf(RepositoryChoiceRefusedError);
    await expect(attempt).rejects.toMatchObject({ code: "repository_not_listed" });
    await expect(attempt).rejects.toMatchObject({ allowed: [profile.repository, listed] });
  });

  it("resolves a continuation to its root's repository, not the child row's", async () => {
    const target = await resolveCodingRepository(db, {
      agentId,
      profile,
      continuesCodingRunId: runIds[1],
    });
    expect(target).toMatchObject({ repository: listed, viaRepositoryLink: true });
  });
});
