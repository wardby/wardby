import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { agentGranteeKey, principalGranteeKey } from "../grants.js";
import { documentAccess, requireDocumentAccess, type Viewer } from "./access.js";

describe.skipIf(!process.env.DATABASE_URL)("agent viewer: access never comes from the owner (database)", () => {
  const db = createPrismaClient();
  const s = randomUUID();
  const [A, B, C, P] = ["a", "b", "c", "p"].map((n) => `agdoc-${n}-${s}`);
  let o: Principal;
  let setId: string;
  let d1: string; // linked to A
  let d2: string; // owned by o, not linked
  let d3: string; // linked to A, in P's plan set
  let pd: string; // plan document in P's plan set, not linked
  let dC: string; // linked to C
  const viewer = (agentId: string): Viewer => ({ kind: "agent", agentId, runId: "run-x" });
  const setting = (access: "read" | "write", plans: string[] = []) => ({
    access,
    reviewers: ["someone"],
    finalApproverId: null,
    maxNewPerRun: 5,
    plans,
  });
  const grant = (agentId: string, resourceId: string, level: string) =>
    db.resourceGrant.upsert({
      where: {
        resourceType_resourceId_granteeKey: {
          resourceType: "document",
          resourceId,
          granteeKey: agentGranteeKey(agentId),
        },
      },
      create: {
        resourceType: "document",
        resourceId,
        granteeKind: "agent",
        granteeAgentId: agentId,
        granteeKey: agentGranteeKey(agentId),
        level,
      },
      update: { level },
    });

  beforeAll(async () => {
    o = await db.principal.create({ data: { subject: `agdoc-o-${s}` } });
    const base = { systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: o.id };
    await db.agent.create({ data: { id: A, name: A, ...base, documentTools: setting("write", [P]) } });
    await db.agent.create({ data: { id: B, name: B, ...base, documentTools: setting("read") } });
    await db.agent.create({ data: { id: C, name: C, ...base } });
    await db.agent.create({ data: { id: P, name: P, ...base, kind: "coding" } });
    setId = (
      await db.planSet.create({
        data: { agentId: P, repository: `o/r-${s}`, number: 1, store: "wardby", createdByRunId: "run-x" },
      })
    ).id;
    const mk = async (data: object) => (await db.document.create({ data: { title: "D", ownerId: o.id, ...data } })).id;
    d1 = await mk({ agentId: A });
    d2 = await mk({});
    d3 = await mk({ agentId: A, planSetId: setId, planPath: "d3.md" });
    pd = await mk({ planSetId: setId, planPath: "pd.md" });
    dC = await mk({ agentId: C });
  });
  afterAll(async () => {
    await db.resourceGrant.deleteMany({ where: { resourceId: { in: [d1, d2, d3, pd, dC] } } });
    await db.document.deleteMany({ where: { ownerId: o.id } });
    await db.planSet.deleteMany({ where: { id: setId } });
    await db.agent.deleteMany({ where: { id: { in: [A, B, C, P] } } });
    await db.principal.delete({ where: { id: o.id } });
    await db.$disconnect();
  });

  it("writes the documents it is linked to", async () => {
    expect(await documentAccess(db, d1, viewer(A))).toBe("write");
  });

  it("never reaches a document through its owner", async () => {
    expect(await documentAccess(db, d2, viewer(A))).toBe("none");
  });

  it("grants are capped by the setting and by comment", async () => {
    await grant(B, d2, "read");
    expect(await documentAccess(db, d2, viewer(B))).toBe("read");
    await grant(B, d2, "comment");
    expect(await documentAccess(db, d2, viewer(B))).toBe("read");
    await grant(A, d2, "comment");
    expect(await documentAccess(db, d2, viewer(A))).toBe("comment");
    await grant(A, d2, "write");
    expect(await documentAccess(db, d2, viewer(A))).toBe("comment");
  });

  it("comments on plan documents of the planners it names, and no one else does", async () => {
    expect(await documentAccess(db, pd, viewer(A))).toBe("comment");
    expect(await documentAccess(db, pd, viewer(B))).toBe("none");
  });

  it("a linked document inside a plan set is comment, never write", async () => {
    expect(await documentAccess(db, d3, viewer(A))).toBe("comment");
  });

  it("an agent without the setting gets nothing, even on its own document", async () => {
    expect(await documentAccess(db, dC, viewer(C))).toBe("none");
  });

  it("an unknown agent gets nothing", async () => {
    expect(await documentAccess(db, d1, viewer(`missing-${s}`))).toBe("none");
  });

  it("turning the setting off removes access on the next call", async () => {
    await db.agent.update({ where: { id: A }, data: { documentTools: Prisma.DbNull } });
    expect(await documentAccess(db, d1, viewer(A))).toBe("none");
    await db.agent.update({ where: { id: A }, data: { documentTools: setting("write", [P]) } });
    expect(await documentAccess(db, d1, viewer(A))).toBe("write");
  });

  it("a linked document gives nothing once its owner loses execute on the agent", async () => {
    const q = await db.principal.create({ data: { subject: `agdoc-q-${s}` } });
    const key = principalGranteeKey(q.id);
    const execute = () =>
      db.resourceGrant.create({
        data: {
          resourceType: "agent",
          resourceId: A,
          granteeKind: "principal",
          granteePrincipalId: q.id,
          granteeKey: key,
          level: "execute",
        },
      });
    await execute();
    const dq = (await db.document.create({ data: { title: "Q", ownerId: q.id, agentId: A } })).id;
    try {
      expect(await documentAccess(db, dq, viewer(A))).toBe("write");
      await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: A, granteeKey: key } });
      expect(await documentAccess(db, dq, viewer(A))).toBe("none");
      // An agent grant on the document still counts on its own.
      await grant(A, dq, "comment");
      expect(await documentAccess(db, dq, viewer(A))).toBe("comment");
    } finally {
      await db.resourceGrant.deleteMany({
        where: { resourceId: { in: [dq, A] }, granteeKey: { in: [key, agentGranteeKey(A)] } },
      });
      await db.document.deleteMany({ where: { id: dq } });
      await db.principal.delete({ where: { id: q.id } });
    }
  });

  it("a named planner gives nothing once the agent's owner loses execute on it", async () => {
    const q = await db.principal.create({ data: { subject: `agdoc-q2-${s}` } });
    const key = principalGranteeKey(o.id);
    await db.agent.update({ where: { id: P }, data: { ownerId: q.id } });
    try {
      expect(await documentAccess(db, pd, viewer(A))).toBe("none");
      await db.resourceGrant.create({
        data: {
          resourceType: "agent",
          resourceId: P,
          granteeKind: "principal",
          granteePrincipalId: o.id,
          granteeKey: key,
          level: "execute",
        },
      });
      expect(await documentAccess(db, pd, viewer(A))).toBe("comment");
      await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: P, granteeKey: key } });
      expect(await documentAccess(db, pd, viewer(A))).toBe("none");
    } finally {
      await db.resourceGrant.deleteMany({ where: { resourceType: "agent", resourceId: P } });
      await db.agent.update({ where: { id: P }, data: { ownerId: o.id } });
      await db.principal.delete({ where: { id: q.id } });
    }
  });

  it("none is document_not_found, as for people", async () => {
    await expect(requireDocumentAccess(db, d2, viewer(C), "read")).rejects.toThrow("document_not_found");
    await expect(requireDocumentAccess(db, d1, viewer(B), "read")).rejects.toThrow("document_not_found");
  });

  it("a grant on a run above gives read to its tree, never to other runs, and still needs the tool setting", async () => {
    const [gp, parent, child, other] = ["gp", "pa", "ch", "ot"].map((n) => `rt-${n}-${s}`);
    const mkRun = (id: string, agentId: string, parentRunId?: string) =>
      db.run.create({ data: { id, agentId, ...(parentRunId ? { parentRunId } : {}) } });
    await mkRun(gp, B);
    await mkRun(parent, B, gp);
    await mkRun(child, B, parent);
    await mkRun(other, B);
    await mkRun(`${child}-c`, C, parent);
    const d4 = (await db.document.create({ data: { title: "D4", ownerId: o.id } })).id;
    await db.runDocumentGrant.create({ data: { runId: gp, documentId: d4 } });
    try {
      const v = (agentId: string, runId: string): Viewer => ({ kind: "agent", agentId, runId });
      expect(await documentAccess(db, d4, viewer(B))).toBe("none");
      expect(await documentAccess(db, d4, v(B, child))).toBe("read");
      expect(await documentAccess(db, d4, v(B, other))).toBe("none");
      expect(await documentAccess(db, d4, v(C, `${child}-c`))).toBe("none");
    } finally {
      await db.runDocumentGrant.deleteMany({ where: { documentId: d4 } });
      await db.run.deleteMany({ where: { id: { in: [gp, parent, child, other, `${child}-c`] } } });
    }
  });
});
