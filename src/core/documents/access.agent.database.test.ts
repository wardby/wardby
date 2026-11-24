import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, type Principal } from "#prisma";
import { createPrismaClient } from "../db.js";
import { agentGranteeKey } from "../grants.js";
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

  it("none is document_not_found, as for people", async () => {
    await expect(requireDocumentAccess(db, d2, viewer(C), "read")).rejects.toThrow("document_not_found");
    await expect(requireDocumentAccess(db, d1, viewer(B), "read")).rejects.toThrow("document_not_found");
  });
});
