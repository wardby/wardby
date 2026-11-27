import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";

describe.skipIf(!process.env.DATABASE_URL)("review router schema (database)", () => {
  const db = createPrismaClient();
  afterAll(() => db.$disconnect());

  it("has the router fields with their defaults", async () => {
    const owner = await db.principal.create({ data: { subject: `rr-${randomUUID()}` } });
    const agent = await db.agent.create({
      data: { name: `rr-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, ownerId: owner.id },
    });
    expect(agent.router).toBe(false);
    expect(agent.maxStartsPerDecision).toBe(20);
    expect(agent.description).toBeNull();
    expect(agent.reviewRouterId).toBeNull();
  });

  it("claims a review job once per review event", async () => {
    const eventId = randomUUID();
    const router = await db.agent.create({
      data: { name: `rr-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    await db.reviewJob.create({ data: { reviewEventId: eventId, routerAgentId: router.id } });
    await expect(db.reviewJob.create({ data: { reviewEventId: eventId, routerAgentId: router.id } })).rejects.toThrow();
  });

  it("deleting an agent removes its plan set and shared set", async () => {
    const owner = await db.principal.create({ data: { subject: `rr-${randomUUID()}` } });
    const agent = await db.agent.create({
      data: { name: `rr-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, ownerId: owner.id },
    });
    const set = await db.documentSet.create({ data: { agentId: agent.id, ownerId: owner.id } });
    const planSet = await db.planSet.create({
      data: { agentId: agent.id, repository: "o/r", number: 1, store: "wardby", createdByRunId: "run", setId: set.id },
    });
    const doc = await db.document.create({
      data: {
        title: "t",
        ownerId: owner.id,
        agentId: agent.id,
        planSetId: planSet.id,
        planPath: "a.md",
        setId: set.id,
      },
    });
    await db.agent.delete({ where: { id: agent.id } });
    expect(await db.planSet.findUnique({ where: { id: planSet.id } })).toBeNull();
    expect(await db.documentSet.findUnique({ where: { id: set.id } })).toBeNull();
    const kept = await db.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(kept.setId).toBeNull();
  });
});

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const ROUTER_MIGRATION = "20261228000000_review_router";

function migrationSql(filter: (name: string) => boolean): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => /^\d{14}_/.test(name) && filter(name))
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
}

describe.skipIf(!process.env.DATABASE_URL)("review router backfill (scratch schema)", () => {
  const schema = `rr_backfill_${randomUUID().replace(/-/g, "")}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
  });
  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("gives every plan set a shared set carrying its approval, and its documents join it", async () => {
    for (const sql of migrationSql((name) => name < ROUTER_MIGRATION)) await client.query(sql);
    await client.query(`
      INSERT INTO "Principal" ("id", "subject") VALUES ('alice', 'sub-alice');
      INSERT INTO "Agent" ("id", "name", "systemPrompt", "model", "budgetUsd", "updatedAt", "ownerId") VALUES
        ('a-owned', 'owned', 'x', 'm', 1, now(), 'alice'),
        ('a-none', 'ownerless', 'x', 'm', 1, now(), NULL);
      INSERT INTO "PlanSet" ("id", "agentId", "repository", "number", "store", "createdByRunId", "approvedAt", "approvedById", "updatedAt") VALUES
        ('ps1', 'a-owned', 'o/r', 1, 'wardby', 'run1', '2026-11-20T10:00:00Z', 'alice', now()),
        ('ps2', 'a-none', 'o/r', 2, 'wardby', 'run2', NULL, NULL, now());
      INSERT INTO "Document" ("id", "title", "ownerId", "planSetId", "planPath", "removedFromPlan", "updatedAt") VALUES
        ('d1', 'one', 'alice', 'ps1', 'plan/one.md', false, now()),
        ('d2', 'two', 'alice', 'ps1', 'plan/two.md', true, now()),
        ('d3', 'three', 'alice', 'ps2', 'plan/three.md', false, now()),
        ('d4', 'loose', 'alice', NULL, NULL, false, now());
    `);

    for (const sql of migrationSql((name) => name >= ROUTER_MIGRATION)) await client.query(sql);

    const sets = (
      await client.query(
        `SELECT p."id" AS "planSetId", p."setId", s."agentId", s."ownerId", s."approvedAt"::text AS "approvedAt", s."approvedById", s."createdByRunId"
         FROM "PlanSet" p JOIN "DocumentSet" s ON s."id" = p."setId" ORDER BY p."id"`,
      )
    ).rows;
    expect(sets).toHaveLength(2);
    expect((await client.query(`SELECT count(*)::int AS n FROM "DocumentSet"`)).rows[0].n).toBe(2);
    expect(sets[0]).toMatchObject({
      agentId: "a-owned",
      ownerId: "alice",
      approvedById: "alice",
      createdByRunId: "run1",
    });
    expect(sets[0].approvedAt).toBe("2026-11-20 10:00:00");
    expect(sets[1]).toMatchObject({ agentId: "a-none", ownerId: null, approvedAt: null, approvedById: null });
    for (const row of sets) expect(row.setId).not.toBeNull();

    const docs = (await client.query(`SELECT "id", "setId", "option", "planPath" FROM "Document" ORDER BY "id"`)).rows;
    expect(docs.map((d) => d.setId)).toEqual([sets[0].setId, sets[0].setId, sets[1].setId, null]);
    for (const d of docs.slice(0, 3)) expect(d.option).toBe(d.planPath);
    expect(docs[3].option).toBeNull();
  });
});
