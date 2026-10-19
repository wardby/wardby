/**
 * findDelegationChild against real PostgreSQL: a re-executed delegate step finds the child its
 * own call created (Run.parentCallId), never another call's, and adopts a drivable legacy child
 * that predates the key. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";
import { findDelegationChild } from "./delegation-child.js";

describe.skipIf(!process.env.DATABASE_URL)("findDelegationChild (database)", () => {
  const db = createPrismaClient();
  const suffix = randomUUID();
  const owner = `delegchild-owner-${suffix}`;
  const leadAgent = `delegchild-lead-${suffix}`;
  const childAgent = `delegchild-child-${suffix}`;
  let parent = "";

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    for (const agentId of [leadAgent, childAgent]) {
      await db.agent.create({
        data: { id: agentId, name: agentId, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner },
      });
    }
    parent = (await db.run.create({ data: { agentId: leadAgent, status: "running" } })).id;
  });

  afterEach(async () => {
    await db.run.deleteMany({ where: { parentRunId: parent } });
  });

  afterAll(async () => {
    await db.run.deleteMany({ where: { parentRunId: parent } });
    await db.run.deleteMany({ where: { id: parent } });
    await db.agent.deleteMany({ where: { id: { in: [leadAgent, childAgent] } } });
    await db.principal.deleteMany({ where: { id: owner } });
    await db.$disconnect();
  });

  it("finds the child created by the same call", async () => {
    const child = await db.run.create({ data: { agentId: childAgent, parentRunId: parent, parentCallId: "toolu_1" } });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_1")).toMatchObject({ id: child.id });
  });

  it("finds the same call's child even once it has finished", async () => {
    const child = await db.run.create({
      data: { agentId: childAgent, parentRunId: parent, parentCallId: "toolu_1", status: "succeeded" },
    });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_1")).toMatchObject({ id: child.id });
  });

  it("does not adopt another call's child", async () => {
    await db.run.create({ data: { agentId: childAgent, parentRunId: parent, parentCallId: "toolu_1" } });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_2")).toBeNull();
  });

  it("does not adopt another sub-agent's child under the same call id", async () => {
    await db.run.create({ data: { agentId: leadAgent, parentRunId: parent, parentCallId: "toolu_1" } });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_1")).toBeNull();
  });

  it("adopts the single drivable legacy child with no call id", async () => {
    const child = await db.run.create({ data: { agentId: childAgent, parentRunId: parent, status: "pending" } });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_9")).toMatchObject({ id: child.id });
  });

  it("adopts the single drivable legacy child when the caller has no call id", async () => {
    const child = await db.run.create({ data: { agentId: childAgent, parentRunId: parent, status: "running" } });
    expect(await findDelegationChild(db, parent, childAgent, undefined)).toMatchObject({ id: child.id });
  });

  it("adopts the single legacy child even once it has finished, so its result is not lost", async () => {
    const child = await db.run.create({ data: { agentId: childAgent, parentRunId: parent, status: "succeeded" } });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_9")).toMatchObject({ id: child.id });
  });

  it("does not adopt a keyed child through the legacy lookup, finished or not", async () => {
    await db.run.create({
      data: { agentId: childAgent, parentRunId: parent, parentCallId: "toolu_1", status: "succeeded" },
    });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_2")).toBeNull();
  });

  it("does not adopt a finished legacy child of another sub-agent", async () => {
    await db.run.create({ data: { agentId: leadAgent, parentRunId: parent, status: "succeeded" } });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_9")).toBeNull();
  });

  it("does not adopt when two drivable legacy children are ambiguous", async () => {
    await db.run.create({ data: { agentId: childAgent, parentRunId: parent, status: "pending" } });
    await db.run.create({ data: { agentId: childAgent, parentRunId: parent, status: "running" } });
    expect(await findDelegationChild(db, parent, childAgent, "toolu_9")).toBeNull();
  });

  it("refuses a second child for the same call (unique index)", async () => {
    await db.run.create({ data: { agentId: childAgent, parentRunId: parent, parentCallId: "toolu_1" } });
    await expect(
      db.run.create({ data: { agentId: childAgent, parentRunId: parent, parentCallId: "toolu_1" } }),
    ).rejects.toThrow();
  });
});
