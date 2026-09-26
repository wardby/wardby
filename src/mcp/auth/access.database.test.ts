import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../core/db.js";
import { principalGranteeKey } from "../../core/grants.js";
import type { McpRequestContext } from "../context.js";
import { requireAgentAccess } from "./access.js";

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];

function ctx(principal: { id: string; subject: string; createdAt: Date }): McpRequestContext {
  return {
    principal,
    scopes: new Set(),
    roles: [],
    canonicalUri: "https://host/mcp",
    providers: {} as never,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

describe.skipIf(!process.env.DATABASE_URL)("agent access checks (PostgreSQL)", () => {
  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: agentIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("the transaction variant sees a revoke made in the same transaction", async () => {
    const owner = await db.principal.create({ data: { subject: `access-owner-${randomUUID()}` } });
    const grantee = await db.principal.create({ data: { subject: `access-grantee-${randomUUID()}` } });
    principalIds.push(owner.id, grantee.id);
    const agent = await db.agent.create({
      data: { name: `access-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, ownerId: owner.id },
    });
    agentIds.push(agent.id);
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agent.id,
        granteeKind: "principal",
        granteePrincipalId: grantee.id,
        granteeKey: principalGranteeKey(grantee.id),
        level: "execute",
      },
    });

    expect((await requireAgentAccess(ctx(grantee), agent.id, "execute")).access).toBe("execute");
    await expect(
      db.$transaction(async (tx) => {
        await tx.resourceGrant.deleteMany({ where: { resourceId: agent.id, granteePrincipalId: grantee.id } });
        await requireAgentAccess(ctx(grantee), agent.id, "execute", tx);
      }),
    ).rejects.toThrow(`Agent "${agent.id}" not found.`);
    // Rolled back with the transaction: the grant still holds outside it.
    expect((await requireAgentAccess(ctx(grantee), agent.id, "read")).access).toBe("execute");
  });

  it("a principal delete cascades to the grants it holds", async () => {
    const owner = await db.principal.create({ data: { subject: `access-o-${randomUUID()}` } });
    const grantee = await db.principal.create({ data: { subject: `access-g-${randomUUID()}` } });
    principalIds.push(owner.id);
    const agent = await db.agent.create({
      data: { name: `access-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, ownerId: owner.id },
    });
    agentIds.push(agent.id);
    await db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agent.id,
        granteeKind: "principal",
        granteePrincipalId: grantee.id,
        granteeKey: principalGranteeKey(grantee.id),
        level: "read",
      },
    });
    await db.principal.delete({ where: { id: grantee.id } });
    expect(await db.resourceGrant.count({ where: { resourceId: agent.id } })).toBe(0);
  });
});
