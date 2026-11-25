import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { checkDocumentToolsSetting, DocumentToolsSchema, parseStoredDocumentTools } from "./tools-setting.js";

describe.skipIf(!process.env.DATABASE_URL)("documentTools setting (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  let ownerId: string;
  let strangerId: string;
  let nativeAgent: { id: string; ownerId: string; kind: "native" };
  let codingAgent: { id: string; ownerId: string; kind: "coding" };
  let plannerId: string;
  let plainId: string;
  const agentIds: string[] = [];

  async function makeAgent(owner: string, extra: Record<string, unknown> = {}) {
    const a = await db.agent.create({
      data: { name: `dt-${randomUUID()}`, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner, ...extra },
    });
    agentIds.push(a.id);
    return a;
  }

  beforeAll(async () => {
    ownerId = (await db.principal.create({ data: { subject: `dt-owner-${s}` } })).id;
    strangerId = (await db.principal.create({ data: { subject: `dt-stranger-${s}` } })).id;
    nativeAgent = { id: (await makeAgent(ownerId)).id, ownerId, kind: "native" };
    codingAgent = { id: nativeAgent.id, ownerId, kind: "coding" };
    // A planner is owned by someone else, so the saver needs an explicit grant.
    plannerId = (
      await makeAgent(strangerId, {
        kind: "coding",
        codingProfile: {
          create: {
            repository: "o/r",
            protectedPaths: [],
            planDocument: { store: "wardby", onApproved: "none", reviewers: [strangerId] },
          },
        },
      })
    ).id;
    plainId = (await makeAgent(ownerId)).id;
  });

  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
    await db.$disconnect();
  });

  it("fills defaults", async () => {
    expect(await checkDocumentToolsSetting(db, nativeAgent, ownerId, { access: "write" })).toEqual({
      access: "write",
      reviewers: [ownerId],
      finalApproverId: null,
      maxNewPerRun: 5,
      plans: [],
    });
  });

  it("rejects a coding agent", async () => {
    await expect(checkDocumentToolsSetting(db, codingAgent, ownerId, { access: "write" })).rejects.toThrow(
      "document_tools_invalid",
    );
  });

  it("rejects a reviewer who cannot read the agent", async () => {
    await expect(
      checkDocumentToolsSetting(db, nativeAgent, ownerId, { access: "write", reviewers: [strangerId] }),
    ).rejects.toThrow("document_tools_invalid");
  });

  it("rejects an unknown principal id", async () => {
    await expect(
      checkDocumentToolsSetting(db, nativeAgent, ownerId, { access: "write", reviewers: ["nope"] }),
    ).rejects.toThrow("document_tools_invalid");
  });

  it("rejects maxNewPerRun outside 1..20", () => {
    expect(DocumentToolsSchema.safeParse({ access: "write", maxNewPerRun: 0 }).success).toBe(false);
    expect(DocumentToolsSchema.safeParse({ access: "write", maxNewPerRun: 21 }).success).toBe(false);
    expect(DocumentToolsSchema.safeParse({ access: "write", maxNewPerRun: 20 }).success).toBe(true);
  });

  it("rejects a plan naming an agent with no planDocument", async () => {
    await expect(
      checkDocumentToolsSetting(db, nativeAgent, ownerId, { access: "read", plans: [plainId] }),
    ).rejects.toThrow("document_tools_invalid");
  });

  it("requires execute on the planner, accepted once granted", async () => {
    const input = { access: "read" as const, plans: [plannerId] };
    await expect(checkDocumentToolsSetting(db, nativeAgent, ownerId, input)).rejects.toThrow("document_tools_invalid");
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: plannerId,
        granteeKind: "principal",
        granteePrincipalId: ownerId,
        granteeKey: `principal:${ownerId}`,
        level: "execute",
      },
    });
    const saved = await checkDocumentToolsSetting(db, nativeAgent, ownerId, input);
    expect(saved.plans).toEqual([plannerId]);
  });

  it("parses stored values, failing closed", () => {
    expect(parseStoredDocumentTools(null)).toBeNull();
    expect(parseStoredDocumentTools({ access: "bogus" })).toBeNull();
    expect(parseStoredDocumentTools({ access: "read", reviewers: ["a"] })).toEqual({
      access: "read",
      reviewers: ["a"],
      finalApproverId: null,
      maxNewPerRun: 5,
      plans: [],
    });
  });
});
