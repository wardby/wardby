/**
 * The resource-grants migration's data steps, replayed in a scratch schema:
 * every earlier migration, then fixtures, then the new file. Proves the
 * everyone grant for owner-less agents, the capability stamps on trusted
 * attachments only, the Run.triggeredById backfill and the grantee CHECK.
 * See docs/private/2026-09-26-resource-sharing-grants-spec-and-plan.md §3.7.1.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const GRANTS_MIGRATION = "20260927010000_resource_grants";

describe.skipIf(!process.env.DATABASE_URL)("resource grants migration (PostgreSQL)", () => {
  const schema = `grants_mig_${randomUUID().replace(/-/g, "")}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    const earlier = readdirSync(MIGRATIONS)
      .filter((name) => /^\d{14}_/.test(name) && name < GRANTS_MIGRATION)
      .sort();
    for (const name of earlier) {
      await client.query(readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
    }

    // Fixtures, in the pre-migration shape.
    await client.query(`
      INSERT INTO "Principal" ("id", "subject") VALUES ('p-owner', 'owner'), ('p-other', 'other');
      INSERT INTO "Agent" ("id", "name", "systemPrompt", "model", "budgetUsd", "updatedAt", "ownerId") VALUES
        ('a-public', 'public', 'x', 'm', 1, now(), NULL),
        ('a-owned', 'owned', 'x', 'm', 1, now(), 'p-owner');
      INSERT INTO "Tool" ("id", "name", "description", "paramsZod", "jsonSchema", "code", "updatedAt", "ownerId") VALUES
        ('t-own', 'own', 'd', 'z', '{}', 'c', now(), 'p-owner'),
        ('t-public', 'pub', 'd', 'z', '{}', 'c', now(), NULL),
        ('t-foreign', 'foreign', 'd', 'z', '{}', 'c', now(), 'p-other');
      INSERT INTO "AgentTool" ("agentId", "toolId") VALUES
        ('a-owned', 't-own'), ('a-owned', 't-public'), ('a-owned', 't-foreign'),
        ('a-public', 't-own'), ('a-public', 't-public');
      INSERT INTO "Run" ("id", "agentId") VALUES ('r-task', 'a-owned'), ('r-bare', 'a-owned'), ('r-anon', 'a-public');
      INSERT INTO "Task" ("id", "kind", "runId", "principalId", "ttlAt", "updatedAt") VALUES
        ('k-1', 'run', 'r-task', 'p-other', now(), now()),
        ('k-2', 'run', 'r-anon', NULL, now(), now());
    `);

    await client.query(readFileSync(join(MIGRATIONS, GRANTS_MIGRATION, "migration.sql"), "utf8"));
  });

  afterAll(async () => {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("gives every owner-less agent one everyone/execute grant, and owned agents none", async () => {
    const { rows } = await client.query(
      `SELECT "resourceType", "resourceId", "granteeKind", "granteeKey", "granteePrincipalId", "level", "source"
       FROM "ResourceGrant" ORDER BY "resourceId"`,
    );
    expect(rows).toEqual([
      {
        resourceType: "agent",
        resourceId: "a-public",
        granteeKind: "everyone",
        granteeKey: "everyone",
        granteePrincipalId: null,
        level: "execute",
        source: "migration_public",
      },
    ]);
  });

  it("stamps capabilities only on an owned agent's own or owner-less tools", async () => {
    const { rows } = await client.query(
      `SELECT "agentId", "toolId", "capabilitiesGrantedById", "attachedById" FROM "AgentTool" ORDER BY "agentId", "toolId"`,
    );
    expect(rows).toEqual([
      { agentId: "a-owned", toolId: "t-foreign", capabilitiesGrantedById: null, attachedById: null },
      { agentId: "a-owned", toolId: "t-own", capabilitiesGrantedById: "p-owner", attachedById: "p-owner" },
      { agentId: "a-owned", toolId: "t-public", capabilitiesGrantedById: "p-owner", attachedById: "p-owner" },
      { agentId: "a-public", toolId: "t-own", capabilitiesGrantedById: null, attachedById: null },
      { agentId: "a-public", toolId: "t-public", capabilitiesGrantedById: null, attachedById: null },
    ]);
  });

  it("backfills Run.triggeredById from the run's Task where one recorded a principal", async () => {
    const { rows } = await client.query(`SELECT "id", "triggeredById" FROM "Run" ORDER BY "id"`);
    expect(rows).toEqual([
      { id: "r-anon", triggeredById: null },
      { id: "r-bare", triggeredById: null },
      { id: "r-task", triggeredById: "p-other" },
    ]);
  });

  it("the grantee CHECK rejects a malformed grantee", async () => {
    const insert = (kind: string, principalId: string | null, key: string, resourceId = "a-owned") =>
      client.query(
        `INSERT INTO "ResourceGrant" ("id", "resourceType", "resourceId", "granteeKind", "granteePrincipalId", "granteeKey", "level", "updatedAt")
         VALUES ($1, 'agent', $5, $2, $3, $4, 'read', now())`,
        [randomUUID(), kind, principalId, key, resourceId],
      );
    await expect(insert("principal", "p-other", "principal:p-owner")).rejects.toThrow(/ResourceGrant_grantee_shape/);
    await expect(insert("principal", null, "principal:")).rejects.toThrow(/ResourceGrant_grantee_shape/);
    await expect(insert("everyone", "p-other", "everyone")).rejects.toThrow(/ResourceGrant_grantee_shape/);
    await expect(insert("group", null, "group:x")).rejects.toThrow(/ResourceGrant_grantee_shape/);
    await expect(insert("principal", "p-other", "principal:p-other")).resolves.toBeDefined();
    await expect(insert("everyone", null, "everyone", "a-public")).rejects.toThrow(
      /ResourceGrant_resourceType_resourceId_granteeKey_key/,
    );
  });

  it("deleting a principal cascades to its grants", async () => {
    await client.query(
      `DELETE FROM "Task"; DELETE FROM "Run"; DELETE FROM "AgentTool"; DELETE FROM "Tool" WHERE "ownerId" = 'p-other'`,
    );
    await client.query(`DELETE FROM "Principal" WHERE "id" = 'p-other'`);
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM "ResourceGrant" WHERE "granteePrincipalId" = 'p-other'`,
    );
    expect(rows[0].n).toBe(0);
  });
});
