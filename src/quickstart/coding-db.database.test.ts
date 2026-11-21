import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { authorizeRepositoryLink } from "../core/runner.js";
import { createPrismaClient } from "../core/db.js";
import type { RepoAccessGate } from "../core/repo-access.js";
import { seedDb } from "./coding-db.js";
import { BUILDER_AGENT, REVIEWER_AGENT, seedCodingAgents } from "./coding-seed.js";

const db = createPrismaClient();
const agentIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("quickstart reviewer link (PostgreSQL)", () => {
  afterAll(async () => {
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  it("names the native reviewer's link <provider>:<repository> so the runner authorizes it, and re-seeding does not duplicate", async () => {
    const agent = await db.agent.create({
      data: { name: `qs-reviewer-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    const repository = "/Users/me/My-Fork";
    const link = { repository, access: "write" as const, stamp: { authorizedVia: "grandfathered" } };
    await seedDb(db).upsertLocalLink(agent.id, link as never);
    await seedDb(db).upsertLocalLink(agent.id, link as never);

    const rows = await db.agentRepository.findMany({ where: { agentId: agent.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(`local:${repository}`);

    const authorizeUse = vi.fn(async () => ({ ok: true as const }));
    const gate = { authorizeUse } as unknown as RepoAccessGate;
    const result = await authorizeRepositoryLink(db, gate, agent.id, {
      provider: "local",
      repository,
      access: "write",
    });
    expect(result).toEqual({ ok: true });
    expect(authorizeUse).toHaveBeenCalledWith(expect.objectContaining({ provider: "local", repository }));
  });

  it("seeds the coding builder's profile as create_agent stores it (gitHistory as its two columns)", async () => {
    const owner = await db.principal.create({
      data: { id: `qs-owner-${randomUUID()}`, subject: `qs-${randomUUID()}` },
    });
    try {
      const result = await seedCodingAgents(seedDb(db), {
        ownerId: owner.id,
        provider: "claude-code",
        builderModel: "claude-haiku-4-5",
        reviewerModel: "claude-haiku-4-5",
        repository: "local:/tmp/qs-seed-test",
        baseRef: "main",
        services: [],
      });
      expect(result.builder).toMatchObject({ status: "created" });
      const builder = await db.agent.findUniqueOrThrow({ where: { name: BUILDER_AGENT } });
      const profile = await db.codingAgentProfile.findUniqueOrThrow({ where: { agentId: builder.id } });
      expect(profile).toMatchObject({
        repository: "local:/tmp/qs-seed-test",
        gitHistoryDepth: null,
        gitHistoryFull: false,
        planDocument: null,
      });
    } finally {
      await db.agent.deleteMany({ where: { name: { in: [BUILDER_AGENT, REVIEWER_AGENT] }, ownerId: owner.id } });
      await db.principal.delete({ where: { id: owner.id } });
    }
  });
});
