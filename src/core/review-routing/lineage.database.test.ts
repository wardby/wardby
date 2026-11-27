import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { resolveRouter, routerForRun } from "./lineage.js";

describe.skipIf(!process.env.DATABASE_URL)("router lineage (database)", () => {
  const db = createPrismaClient();
  const tag = randomUUID().slice(0, 8);
  const ownerId = `ln-owner-${tag}`;
  const otherOwnerId = `ln-other-${tag}`;
  beforeAll(async () => {
    await db.principal.create({ data: { id: ownerId, subject: ownerId } });
    await db.principal.create({ data: { id: otherOwnerId, subject: otherOwnerId } });
  });
  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { granteePrincipalId: { in: [ownerId, otherOwnerId] } } });
    await db.$disconnect();
  });
  const agent = (router = false, extra: { reviewRouterId?: string; ownerId?: string | null } = {}) =>
    db.agent.create({
      data: {
        name: `ln-${randomUUID()}`,
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        router,
        ownerId,
        ...(router ? { description: "routes" } : {}),
        ...extra,
      },
    });
  const run = (agentId: string, parentRunId?: string) =>
    db.run.create({ data: { agentId, ...(parentRunId ? { parentRunId } : {}) } });
  const target = (
    routerAgentId: string | null,
    writerAgentId: string | null,
    recordedByRunId: string | null = null,
  ) => ({
    routerAgentId,
    writerAgentId,
    ownerId,
    recordedByRunId,
  });

  it("finds the router two levels up", async () => {
    const r = await agent(true);
    const lead = await agent();
    const writer = await agent();
    const r1 = await run(r.id);
    const r2 = await run(lead.id, r1.id);
    const r3 = await run(writer.id, r2.id);
    expect(await routerForRun(db, r3.id)).toBe(r.id);
  });
  it("is null when no router started the work", async () => {
    const writer = await agent();
    expect(await routerForRun(db, (await run(writer.id)).id)).toBeNull();
    expect(await routerForRun(db, null)).toBeNull();
  });
  it("falls back to the writer's reviewRouter", async () => {
    const r = await agent(true);
    const writer = await agent(false, { reviewRouterId: r.id });
    expect(await resolveRouter(db, target(null, writer.id))).toBe(r.id);
    expect(await resolveRouter(db, target(null, null))).toBeNull();
  });
  it("prefers the recorded router while it is still a router", async () => {
    const recorded = await agent(true);
    const other = await agent(true);
    const writer = await agent(false, { reviewRouterId: other.id });
    expect(await resolveRouter(db, target(recorded.id, writer.id))).toBe(recorded.id);
  });
  it("skips a recorded router that is no longer a router", async () => {
    const recorded = await agent(true);
    const other = await agent(true);
    const writer = await agent(false, { reviewRouterId: other.id });
    await db.agent.update({ where: { id: recorded.id }, data: { router: false } });
    expect(await resolveRouter(db, target(recorded.id, writer.id))).toBe(other.id);
  });
  it("is null when neither is a router", async () => {
    const recorded = await agent(true);
    const other = await agent(true);
    const writer = await agent(false, { reviewRouterId: other.id });
    await db.agent.update({ where: { id: recorded.id }, data: { router: false } });
    await db.agent.update({ where: { id: other.id }, data: { router: false } });
    expect(await resolveRouter(db, target(recorded.id, writer.id))).toBeNull();
    expect(await resolveRouter(db, target(recorded.id, null))).toBeNull();
  });
  it("a router the person cannot execute is none: the owner's for a recorded one, the writer's owner's for a reviewRouter", async () => {
    const theirs = await agent(true, { ownerId: otherOwnerId });
    const writer = await agent(false, { reviewRouterId: theirs.id });
    expect(await resolveRouter(db, target(theirs.id, null))).toBeNull();
    expect(await resolveRouter(db, target(null, writer.id))).toBeNull();
    const grant = await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: theirs.id,
        granteeKind: "principal",
        granteePrincipalId: ownerId,
        granteeKey: `principal:${ownerId}`,
        level: "execute",
      },
    });
    expect(await resolveRouter(db, target(theirs.id, null))).toBe(theirs.id);
    expect(await resolveRouter(db, target(null, writer.id))).toBe(theirs.id);
    await db.resourceGrant.delete({ where: { id: grant.id } });
    // A recorded router its own run tree wrote needs no execute.
    const treeRun = await run((await agent()).id, (await run(theirs.id)).id);
    expect(await resolveRouter(db, target(theirs.id, null, treeRun.id))).toBe(theirs.id);
    // A writer with no owner reaches no reviewRouter.
    const ownerless = await agent(false, { reviewRouterId: (await agent(true)).id, ownerId: null });
    expect(await resolveRouter(db, target(null, ownerless.id))).toBeNull();
  });
});
