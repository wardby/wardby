import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { documentAccess, requireDocumentAccess } from "./access.js";

describe.skipIf(!process.env.DATABASE_URL)("plan documents: access follows the triggered agent (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  const planner = `acc-planner-${s}`;
  const lead = `acc-lead-${s}`;
  let p: Principal; // planner's owner, owns the plan documents
  let l: Principal; // the lead's (access agent's) owner
  let g: Principal; // read grant on the lead
  let x: Principal; // nothing
  let setId: string;
  let docId: string;
  let plainId: string;
  const as = (who: Principal) => ({ kind: "principal" as const, principalId: who.id });
  const agentGrant = (agentId: string, who: Principal | null, level: string) =>
    db.resourceGrant.create({
      data: {
        resourceType: "agent",
        resourceId: agentId,
        granteeKind: who ? "principal" : "everyone",
        granteePrincipalId: who?.id ?? null,
        granteeKey: who ? `principal:${who.id}` : "everyone",
        level,
      },
    });

  beforeAll(async () => {
    [p, l, g, x] = await Promise.all(
      ["p", "l", "g", "x"].map((n) => db.principal.create({ data: { subject: `acc-${n}-${s}` } })),
    );
    for (const [id, ownerId] of [
      [planner, p.id],
      [lead, l.id],
    ] as const) {
      await db.agent.create({ data: { id, name: id, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId } });
    }
    setId = (
      await db.planSet.create({
        data: {
          agentId: planner,
          accessAgentId: lead,
          repository: `o/r-${s}`,
          number: 1,
          store: "wardby",
          createdByRunId: "run-x",
        },
      })
    ).id;
    docId = (
      await db.document.create({ data: { title: "Plan", ownerId: p.id, planSetId: setId, planPath: "plan.md" } })
    ).id;
    plainId = (await db.document.create({ data: { title: "Plain", ownerId: p.id } })).id;
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: p.id } });
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: [planner, lead, docId, plainId] } } });
    await db.planSet.deleteMany({ where: { id: setId } });
    await db.agent.deleteMany({ where: { id: { in: [planner, lead] } } });
    await db.$disconnect();
  });

  it("the access agent's owner and its grantees comment; others get nothing; live on the grant", async () => {
    const grant = await agentGrant(lead, g, "read");
    expect(await documentAccess(db, docId, as(g))).toBe("comment");
    expect(await documentAccess(db, docId, as(l))).toBe("comment");
    expect(await documentAccess(db, docId, as(x))).toBe("none");
    expect(await documentAccess(db, docId, as(p))).toBe("owner");
    // Never write or owner through the agent, even with write on it.
    await db.resourceGrant.update({ where: { id: grant.id }, data: { level: "write" } });
    expect(await documentAccess(db, docId, as(g))).toBe("comment");
    await expect(requireDocumentAccess(db, docId, as(g), "write")).rejects.toThrow("document_access_denied");
    await expect(requireDocumentAccess(db, docId, as(g), "comment")).resolves.toMatchObject({ id: docId });
    // A document outside any plan set is unchanged.
    expect(await documentAccess(db, plainId, as(g))).toBe("none");
    expect(await documentAccess(db, plainId, as(l))).toBe("none");
    // Live: losing the agent grant loses the plan.
    await db.resourceGrant.delete({ where: { id: grant.id } });
    expect(await documentAccess(db, docId, as(g))).toBe("none");
  });

  it("explicit document grants add on top", async () => {
    await agentGrant(lead, g, "read");
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: docId,
        granteeKind: "principal",
        granteePrincipalId: g.id,
        granteeKey: `principal:${g.id}`,
        level: "write",
      },
    });
    expect(await documentAccess(db, docId, as(g))).toBe("write");
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: [lead, docId] } } });
    expect(await documentAccess(db, docId, as(g))).toBe("none");
  });

  it("an everyone grant on the agent is a grant on it: every principal comments", async () => {
    await agentGrant(lead, null, "read");
    expect(await documentAccess(db, docId, as(x))).toBe("comment");
    await db.resourceGrant.deleteMany({ where: { resourceId: lead } });
    expect(await documentAccess(db, docId, as(x))).toBe("none");
  });

  it("a share link adds to agent access; a guest gets only its link even with an everyone grant on the agent", async () => {
    await agentGrant(lead, g, "read");
    await agentGrant(lead, null, "read");
    const link = async (permission: string) =>
      db.documentShareLink.create({
        data: {
          documentId: docId,
          tokenHash: randomUUID(),
          permission,
          expiresAt: new Date(Date.now() + 86_400_000),
          createdById: p.id,
        },
      });
    const view = await link("view");
    // read grant on the agent plus a view link: comment (the higher).
    expect(await documentAccess(db, docId, { ...as(g), shareLinkId: view.id })).toBe("comment");
    // A guest on the view link gets read, not the agent's comment.
    const guest = { kind: "guest" as const, guestId: "gx", shareLinkId: view.id, permission: "view" as const };
    expect(await documentAccess(db, docId, guest)).toBe("read");
    await db.resourceGrant.deleteMany({ where: { resourceId: lead } });
    await db.documentShareLink.deleteMany({ where: { documentId: docId } });
  });

  it("a deleted access agent falls back to normal document access", async () => {
    const dl = `acc-del-${s}`;
    await db.agent.create({ data: { id: dl, name: dl, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: l.id } });
    const set = await db.planSet.create({
      data: {
        agentId: planner,
        accessAgentId: dl,
        repository: `o/d-${s}`,
        number: 2,
        store: "wardby",
        createdByRunId: "run-y",
      },
    });
    const d = (await db.document.create({ data: { title: "Del", ownerId: p.id, planSetId: set.id } })).id;
    await agentGrant(dl, g, "read");
    expect(await documentAccess(db, d, as(g))).toBe("comment");
    await db.agent.delete({ where: { id: dl } });
    expect((await db.planSet.findUniqueOrThrow({ where: { id: set.id } })).accessAgentId).toBeNull();
    expect(await documentAccess(db, d, as(l))).toBe("none");
    expect(await documentAccess(db, d, as(g))).toBe("none");
    expect(await documentAccess(db, d, as(p))).toBe("owner");
    await db.document.deleteMany({ where: { id: d } });
    await db.planSet.deleteMany({ where: { id: set.id } });
    await db.resourceGrant.deleteMany({ where: { resourceId: dl } });
  });
});
