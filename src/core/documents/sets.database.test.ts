/**
 * Document sets (#646, spec §6) against real PostgreSQL: a native writer's named set is one per run and name,
 * a plan's shared set records the router of its run, and claimSetApproval decides a set's approval once, for
 * either home (a plan set's PlanSet row, a native set's DocumentSet row). Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { createPlanSetFixture } from "../plans/build.test-support.js";
import { createDocument } from "./service.js";
import { claimSetApproval, createPlanDocumentSet, ensureNamedSet } from "./sets.js";

describe.skipIf(!process.env.DATABASE_URL)("document sets (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID().slice(0, 8);
  const owner = `sets-owner-${s}`;
  const actor = `sets-actor-${s}`;
  const agents: string[] = [];
  let writer: string;
  let router: string;

  const agent = async (extra: { router?: boolean; description?: string } = {}) => {
    const row = await db.agent.create({
      data: {
        name: `sets-${s}-${agents.length}`,
        systemPrompt: "p",
        model: "m",
        budgetUsd: 1,
        ownerId: owner,
        ...extra,
      },
    });
    agents.push(row.id);
    return row.id;
  };

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.principal.create({ data: { id: actor, subject: actor } });
    router = await agent({ router: true, description: "routes" });
    writer = await agent();
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner } });
    await db.planSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.documentSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.run.deleteMany({ where: { agentId: { in: agents } } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.principal.deleteMany({ where: { id: { in: [owner, actor] } } });
    await db.$disconnect();
  });

  const routedRun = async () => {
    const top = await db.run.create({ data: { agentId: router } });
    return (await db.run.create({ data: { agentId: writer, parentRunId: top.id } })).id;
  };

  it("ensureNamedSet: one set per run and name, with the run tree's router", async () => {
    const runId = await routedRun();
    const input = { agentId: writer, ownerId: owner, runId, name: "concepts" };
    const first = await ensureNamedSet(db, input);
    expect(await ensureNamedSet(db, input)).toBe(first);
    const other = await ensureNamedSet(db, { ...input, name: "go-no-go" });
    expect(other).not.toBe(first);
    const row = await db.documentSet.findUniqueOrThrow({ where: { id: first } });
    expect(row).toMatchObject({ agentId: writer, ownerId: owner, name: "concepts", createdByRunId: runId });
    expect(row.routerAgentId).toBe(router);
    // Another run's set of the same name is its own.
    const later = await ensureNamedSet(db, {
      ...input,
      runId: (await db.run.create({ data: { agentId: writer } })).id,
    });
    expect(later).not.toBe(first);
    expect((await db.documentSet.findUniqueOrThrow({ where: { id: later } })).routerAgentId).toBeNull();
  });

  it("ensureNamedSet: concurrent first uses agree on one set", async () => {
    const runId = await routedRun();
    const input = { agentId: writer, ownerId: owner, runId, name: "race" };
    const ids = await Promise.all([1, 2, 3, 4].map(() => ensureNamedSet(db, input)));
    expect(new Set(ids).size).toBe(1);
  });

  it("createPlanDocumentSet: an unnamed set with the run tree's router", async () => {
    const runId = await routedRun();
    const id = await db.$transaction((tx) => createPlanDocumentSet(tx, { agentId: writer, ownerId: owner, runId }));
    expect(await db.documentSet.findUniqueOrThrow({ where: { id } })).toMatchObject({
      name: null,
      createdByRunId: runId,
      routerAgentId: router,
      ownerId: owner,
    });
  });

  const approveAll = (ids: string[]) =>
    db.document.updateMany({ where: { id: { in: ids } }, data: { reviewState: "approved" } });

  it("claimSetApproval on a native set: claims once, ends after a reopen", async () => {
    const runId = await routedRun();
    const setId = await ensureNamedSet(db, { agentId: writer, ownerId: owner, runId, name: "claim" });
    const ids: string[] = [];
    for (const option of ["concept-a", "concept-b"]) {
      const doc = await createDocument(db, cipher, {
        ownerId: owner,
        title: option,
        markdown: `# ${option}\n`,
        agentId: writer,
        via: "agent",
        runId,
        setId,
        option,
      });
      ids.push(doc.id);
    }
    expect(
      await db.document.findMany({ where: { setId }, select: { option: true }, orderBy: { option: "asc" } }),
    ).toEqual([{ option: "concept-a" }, { option: "concept-b" }]);
    const ref = { kind: "documents" as const, setId };
    expect(await claimSetApproval(db, ref, actor)).toBeNull();
    await approveAll(ids);
    const claimed = await claimSetApproval(db, ref, actor);
    expect(claimed).toMatchObject({ approved: true });
    expect(await db.documentSet.findUniqueOrThrow({ where: { id: setId } })).toMatchObject({ approvedById: actor });
    expect(await claimSetApproval(db, ref, actor)).toBeNull();
    // A removed (rejected) document no longer counts; a document with no current version never counts.
    await db.document.update({ where: { id: ids[1] }, data: { reviewState: "in_review" } });
    expect(await claimSetApproval(db, ref, actor)).toEqual({ approved: false, ended: true });
    expect(await db.documentSet.findUniqueOrThrow({ where: { id: setId } })).toMatchObject({
      approvedAt: null,
      approvedById: null,
    });
    expect(await claimSetApproval(db, ref, actor)).toBeNull();
    await db.document.update({ where: { id: ids[1] }, data: { removedFromPlan: true } });
    expect(await claimSetApproval(db, ref, null)).toMatchObject({ approved: true });
  });

  it("claimSetApproval on a plan set: decides on the PlanSet row and counts plan documents only", async () => {
    const fixture = await createPlanSetFixture(db, {
      plannerId: writer,
      ownerId: owner,
      repository: `o/sets-${s}`,
      number: 1,
      documents: [
        { path: "plan.md", content: "# Plan\n", version: 1, reviewState: "in_review" },
        { path: "api.md", content: "# API\n", version: 1 },
      ],
    });
    const ref = { kind: "plan" as const, planSetId: fixture.planSetId };
    expect(await claimSetApproval(db, ref, actor)).toBeNull();
    await approveAll([fixture.documentIds["plan.md"]]);
    expect(await claimSetApproval(db, ref, actor)).toMatchObject({ approved: true });
    expect(await db.planSet.findUniqueOrThrow({ where: { id: fixture.planSetId } })).toMatchObject({
      approvedById: actor,
    });
    expect(await claimSetApproval(db, ref, actor)).toBeNull();
    await db.document.update({ where: { id: fixture.documentIds["api.md"] }, data: { reviewState: "draft" } });
    expect(await claimSetApproval(db, ref, actor)).toEqual({ approved: false, ended: true });
    expect((await db.planSet.findUniqueOrThrow({ where: { id: fixture.planSetId } })).approvedAt).toBeNull();
  });

  it("claimSetApproval: a set that does not exist, or has no counted documents, is null", async () => {
    expect(await claimSetApproval(db, { kind: "documents", setId: `missing-${s}` }, actor)).toBeNull();
    expect(await claimSetApproval(db, { kind: "plan", planSetId: `missing-${s}` }, actor)).toBeNull();
    const empty = await ensureNamedSet(db, {
      agentId: writer,
      ownerId: owner,
      runId: await routedRun(),
      name: "empty",
    });
    expect(await claimSetApproval(db, { kind: "documents", setId: empty }, actor)).toBeNull();
  });
});
