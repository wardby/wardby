import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { resolveRouter, routerForRun } from "./lineage.js";

describe.skipIf(!process.env.DATABASE_URL)("router lineage (database)", () => {
  const db = createPrismaClient();
  afterAll(() => db.$disconnect());
  const agent = (router = false, extra: { reviewRouterId?: string } = {}) =>
    db.agent.create({
      data: {
        name: `ln-${randomUUID()}`,
        systemPrompt: "x",
        model: "m",
        budgetUsd: 1,
        router,
        ...(router ? { description: "routes" } : {}),
        ...extra,
      },
    });
  const run = (agentId: string, parentRunId?: string) =>
    db.run.create({ data: { agentId, ...(parentRunId ? { parentRunId } : {}) } });

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
    expect(await resolveRouter(db, { routerAgentId: null, writerAgentId: writer.id })).toBe(r.id);
    expect(await resolveRouter(db, { routerAgentId: null, writerAgentId: null })).toBeNull();
  });
  it("prefers the recorded router while it is still a router", async () => {
    const recorded = await agent(true);
    const other = await agent(true);
    const writer = await agent(false, { reviewRouterId: other.id });
    expect(await resolveRouter(db, { routerAgentId: recorded.id, writerAgentId: writer.id })).toBe(recorded.id);
  });
  it("skips a recorded router that is no longer a router", async () => {
    const recorded = await agent(true);
    const other = await agent(true);
    const writer = await agent(false, { reviewRouterId: other.id });
    await db.agent.update({ where: { id: recorded.id }, data: { router: false } });
    expect(await resolveRouter(db, { routerAgentId: recorded.id, writerAgentId: writer.id })).toBe(other.id);
  });
  it("is null when neither is a router", async () => {
    const recorded = await agent(true);
    const other = await agent(true);
    const writer = await agent(false, { reviewRouterId: other.id });
    await db.agent.update({ where: { id: recorded.id }, data: { router: false } });
    await db.agent.update({ where: { id: other.id }, data: { router: false } });
    expect(await resolveRouter(db, { routerAgentId: recorded.id, writerAgentId: writer.id })).toBeNull();
    expect(await resolveRouter(db, { routerAgentId: recorded.id, writerAgentId: null })).toBeNull();
  });
});
