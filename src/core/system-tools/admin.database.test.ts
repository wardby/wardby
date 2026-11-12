/**
 * System tool admin operations against real PostgreSQL (#529): making a tool
 * public (refusals and effect), connection grants (public only, upsert,
 * cascade on delete), and a public-tool update clearing other owners'
 * capability consent instead of refusing. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { updateToolGuarded } from "../tool-admin.js";
import { grantToolConnection, makeToolPublic, revokeToolConnection, SystemToolError } from "./admin.js";

describe.skipIf(!process.env.DATABASE_URL)("system tool admin (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  const id = (name: string) => `systool-${name}-${s}`;
  const alice = id("alice");
  const bob = id("bob");
  const aliceAgent = id("alice-agent");
  const bobAgent = id("bob-agent");

  const tool = (name: string, ownerId: string | null) =>
    db.tool.create({
      data: {
        id: id(name),
        name: id(name),
        description: "t",
        paramsZod: "z.object({})",
        jsonSchema: {},
        code: "return 1;",
        ownerId,
      },
    });
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      return err instanceof SystemToolError ? err.code : String(err);
    }
    return "resolved";
  };

  beforeAll(async () => {
    await db.principal.createMany({
      data: [
        { id: alice, subject: alice },
        { id: bob, subject: bob },
      ],
    });
    await db.agent.createMany({
      data: [
        { id: aliceAgent, name: aliceAgent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: alice },
        { id: bobAgent, name: bobAgent, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: bob },
      ],
    });
  });

  afterAll(async () => {
    await db.runHook.deleteMany({ where: { agentId: { in: [aliceAgent, bobAgent] } } });
    await db.agentTool.deleteMany({ where: { agentId: { in: [aliceAgent, bobAgent] } } });
    await db.tool.deleteMany({ where: { name: { endsWith: s } } });
    await db.agent.deleteMany({ where: { id: { in: [aliceAgent, bobAgent] } } });
    await db.principal.deleteMany({ where: { id: { in: [alice, bob] } } });
    await db.$disconnect();
  });

  it("makes an owned tool public, keeping the owner's own attachments", async () => {
    await tool("pub", alice);
    await db.agentTool.create({ data: { agentId: aliceAgent, toolId: id("pub"), capabilitiesGrantedById: alice } });
    const published = await makeToolPublic(db, id("pub"), alice);
    expect(published).toMatchObject({ ownerId: null, publishedById: alice });
    expect(published.publishedAt).toBeInstanceOf(Date);
    expect(await db.agentTool.findFirst({ where: { toolId: id("pub") } })).toMatchObject({
      capabilitiesGrantedById: alice,
    });
    expect(await code(makeToolPublic(db, id("pub"), alice))).toBe("tool_already_public");
  });

  it("refuses a tool another owner's agent uses, and a taken public name", async () => {
    await tool("shared", alice);
    await db.agentTool.create({ data: { agentId: bobAgent, toolId: id("shared") } });
    expect(await code(makeToolPublic(db, id("shared"), alice))).toBe("tool_used_by_other_owners");

    await tool("dup", null);
    await db.tool.create({
      data: {
        id: id("dup2"),
        name: id("dup"),
        description: "t",
        paramsZod: "z.object({})",
        jsonSchema: {},
        code: "1",
        ownerId: bob,
      },
    });
    expect(await code(makeToolPublic(db, id("dup2"), bob))).toBe("public_tool_name_taken");
    expect(await code(makeToolPublic(db, id("missing"), bob))).toBe("tool_not_found");
  });

  it("grants only to public tools, replaces on re-grant, and cascades on delete", async () => {
    await tool("owned", alice);
    expect(await code(grantToolConnection(db, id("owned"), "slack", ["*"], alice))).toBe("tool_not_public");
    await tool("granted", null);
    await grantToolConnection(db, id("granted"), "slack", ["C0ABC"], alice);
    const again = await grantToolConnection(db, id("granted"), "slack", ["linked"], bob);
    expect(again).toMatchObject({ channels: ["linked"], grantedById: bob });
    expect(await db.toolConnectionGrant.count({ where: { toolId: id("granted") } })).toBe(1);
    expect(await revokeToolConnection(db, id("granted"), "slack")).toBe(true);
    expect(await revokeToolConnection(db, id("granted"), "slack")).toBe(false);
    await grantToolConnection(db, id("granted"), "slack", ["*"], null);
    await db.tool.delete({ where: { id: id("granted") } });
    expect(await db.toolConnectionGrant.count({ where: { toolId: id("granted") } })).toBe(0);
  });

  it("updates a public tool used by owned agents, clearing their consent", async () => {
    await tool("system", null);
    await db.agentTool.create({ data: { agentId: aliceAgent, toolId: id("system"), capabilitiesGrantedById: alice } });
    await db.runHook.create({
      data: { agentId: bobAgent, toolId: id("system"), createdById: bob, capabilitiesGrantedById: bob },
    });
    const updated = await updateToolGuarded(db, id("system"), { code: "return 2;" }, () => undefined);
    expect(updated.code).toBe("return 2;");
    expect(updated.consentCleared).toEqual({ attachments: 1, hooks: 1 });
    expect(await db.agentTool.findFirst({ where: { toolId: id("system") } })).toMatchObject({
      capabilitiesGrantedById: null,
    });
    expect(await db.runHook.findFirst({ where: { toolId: id("system") } })).toMatchObject({
      capabilitiesGrantedById: null,
    });
  });

  it("still refuses an owned tool used by another owner", async () => {
    await tool("owned2", alice);
    await db.agentTool.create({ data: { agentId: bobAgent, toolId: id("owned2") } });
    await expect(updateToolGuarded(db, id("owned2"), { code: "x" }, () => undefined)).rejects.toThrow(
      "tool_attached_other_owners",
    );
  });
});
