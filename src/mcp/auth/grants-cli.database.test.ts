/**
 * `wardby grants migration-report | adopt-public | prune-bindings` against a
 * scratch schema of the throwaway test database: first with every
 * migration before the grants one (the report must run on the old schema,
 * before `migrate deploy`), then with it applied. A scratch schema keeps
 * adopt-public ("every owner-less agent") away from other suites' rows.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "#prisma";
import { adoptPublic, grantsCommand, migrationReport, pruneBindings, type ReportDb } from "./grants-cli.js";
import { createFromBundle } from "../../import/create.js";
import type { Bundle } from "../../import/bundle.js";
import type { Reconciliation } from "../../import/preflight.js";

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const GRANTS_MIGRATION = "20260927010000_resource_grants";

function migrationFiles(filter: (name: string) => boolean): string[] {
  return readdirSync(MIGRATIONS)
    .filter((name) => /^\d{14}_/.test(name) && filter(name))
    .sort()
    .map((name) => readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8"));
}

/** $queryRaw over a plain pg client, so the report can run on a schema Prisma's client doesn't match. */
function rawDb(client: pg.Client): ReportDb {
  return {
    $queryRaw: async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.reduce((sql, part, i) => sql + (i > 0 ? `$${i}` : "") + part, "");
      return (await client.query(text, values)).rows as T;
    },
  };
}

describe.skipIf(!process.env.DATABASE_URL)("wardby grants CLI (PostgreSQL)", () => {
  const schema = `grants_cli_${randomUUID().replace(/-/g, "")}`;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  let db: PrismaClient;

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    for (const sql of migrationFiles((name) => name < GRANTS_MIGRATION)) await client.query(sql);
    db = new PrismaClient({
      adapter: new PrismaPg(
        { connectionString: process.env.DATABASE_URL, options: `-c search_path="${schema}"` },
        { schema },
      ),
    });

    // Pre-migration fixtures.
    await client.query(`
      INSERT INTO "Principal" ("id", "subject") VALUES ('alice', 'sub-alice'), ('bob', 'sub-bob'), ('carol', 'sub-carol');
      INSERT INTO "Agent" ("id", "name", "systemPrompt", "model", "budgetUsd", "updatedAt", "ownerId") VALUES
        ('pub', 'formerly-public', 'x', 'm', 1, now(), NULL),
        ('owned', 'alice-agent', 'x', 'm', 1, now(), 'alice'),
        ('bobs', 'bob-agent', 'x', 'm', 1, now(), 'bob');
      INSERT INTO "Secret" ("id", "name", "ciphertext", "keyId", "updatedAt", "ownerId") VALUES
        ('s-alice', 'A', 'c', 'k', now(), 'alice'), ('s-bob', 'B', 'c', 'k', now(), 'bob');
      INSERT INTO "AgentSecret" ("agentId", "secretId", "boundName") VALUES
        ('pub', 's-alice', 'ALICE'), ('pub', 's-bob', 'BOB'), ('owned', 's-bob', 'BOB_ON_ALICE');
      INSERT INTO "Datastore" ("id", "name", "updatedAt", "ownerId") VALUES
        ('d-alice', 'alice-store', now(), 'alice'), ('d-bob', 'bob-store', now(), 'bob');
      INSERT INTO "AgentDatastore" ("agentId", "datastoreId", "boundName") VALUES
        ('pub', 'd-alice', 'alice-kb'), ('pub', 'd-bob', 'bob-kb'), ('owned', 'd-bob', 'bob-kb-on-alice');
      INSERT INTO "Tool" ("id", "name", "description", "paramsZod", "jsonSchema", "code", "updatedAt", "ownerId") VALUES
        ('t-alice', 'alice-tool', 'd', 'z', '{}', 'c', now(), 'alice'),
        ('t-bob', 'bob-tool', 'd', 'z', '{}', 'c', now(), 'bob'),
        ('t-pub', 'pub-tool', 'd', 'z', '{}', 'c', now(), NULL);
      INSERT INTO "AgentTool" ("agentId", "toolId", "allowedSecrets", "allowedHosts") VALUES
        ('pub', 't-alice', '["ALICE"]', '[]'),
        ('pub', 't-pub', '[]', '["x.example"]'),
        ('owned', 't-bob', '["BOB_ON_ALICE"]', '[]'),
        ('owned', 't-alice', '[]', '[]');
      INSERT INTO "AgentSubAgent" ("parentAgentId", "childAgentId", "boundName") VALUES
        ('owned', 'bobs', 'bob-child'), ('pub', 'owned', 'alice-child'), ('owned', 'pub', 'public-child');
      INSERT INTO "Webhook" ("id", "agentId", "secretHash", "ownerId") VALUES
        ('w-carol', 'owned', 'h1', 'carol'), ('w-pub', 'pub', 'h2', 'carol'), ('w-alice', 'owned', 'h3', 'alice');
    `);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  it("migration-report runs on the pre-migration schema, predicting what the migration changes", async () => {
    const report = await migrationReport(rawDb(client));
    expect(report.grantsTable).toBe(false);
    expect(report.ownerlessAgents).toEqual([
      { agentId: "pub", name: "formerly-public", everyoneGrant: "execute (pending migration)" },
    ]);
    expect(report.inertBindings.map((b) => `${b.agentId}/${b.boundName}`).sort()).toEqual([
      "owned/BOB_ON_ALICE",
      "owned/bob-kb-on-alice",
      "pub/ALICE",
      "pub/BOB",
      "pub/alice-kb",
      "pub/bob-kb",
    ]);
    expect(report.inertBindings.find((b) => b.boundName === "BOB_ON_ALICE")).toMatchObject({
      kind: "secret",
      agentOwnerId: "alice",
      resourceOwnerId: "bob",
      prunable: true,
    });
    expect(report.suspendedCapabilities.map((c) => `${c.agentId}/${c.toolId}`).sort()).toEqual([
      "owned/t-bob",
      "pub/t-alice",
      "pub/t-pub",
    ]);
    expect(report.suspendedCapabilities.find((c) => c.toolId === "t-bob")?.regrant).toContain(
      '"allowedSecrets":["BOB_ON_ALICE"]',
    );
    expect(report.failingEdges.map((e) => e.boundName).sort()).toEqual(["alice-child", "bob-child"]);
    expect(report.webhooks.onOwnerlessAgents.map((w) => w.id)).toEqual(["w-pub"]);
    expect(report.webhooks.creatorLacksExecute.map((w) => w.id)).toEqual(["w-carol"]);
    expect(report.orphanGrants).toBeNull();
  });

  it("migration-report runs after the migration too, reading the grants and consent stamps", async () => {
    for (const sql of migrationFiles((name) => name === GRANTS_MIGRATION)) await client.query(sql);
    await client.query(`
      INSERT INTO "ResourceGrant" ("id", "resourceType", "resourceId", "granteeKind", "granteeKey", "level", "updatedAt")
      VALUES ('orphan', 'agent', 'deleted-agent', 'everyone', 'everyone', 'read', now());
    `);
    const report = await migrationReport(rawDb(client));
    expect(report.grantsTable).toBe(true);
    expect(report.ownerlessAgents).toEqual([{ agentId: "pub", name: "formerly-public", everyoneGrant: "execute" }]);
    expect(report.suspendedCapabilities.map((c) => `${c.agentId}/${c.toolId}`).sort()).toEqual([
      "owned/t-bob",
      "pub/t-alice",
      "pub/t-pub",
    ]);
    expect(report.failingEdges.map((e) => e.boundName).sort()).toEqual(["alice-child", "bob-child"]);
    expect(report.webhooks.creatorLacksExecute.map((w) => w.id)).toEqual(["w-carol"]);
    expect(report.orphanGrants).toEqual([{ id: "orphan", resourceType: "agent", resourceId: "deleted-agent" }]);
    await client.query(`DELETE FROM "ResourceGrant" WHERE "id" = 'orphan'`);

    const lines: string[] = [];
    await grantsCommand(["migration-report"], db, (line) => lines.push(line));
    const text = lines.join("\n");
    expect(text).toMatch(/Owner-less agents/);
    expect(text).toContain("formerly-public");
    expect(text).toMatch(/Behaviour changes/);
    const json: string[] = [];
    await grantsCommand(["migration-report", "--json"], db, (line) => json.push(line));
    expect(JSON.parse(json.join("\n")).grantsTable).toBe(true);
  });

  it("adopt-public refuses an unknown subject (never creates a principal)", async () => {
    await expect(adoptPublic(db, { ownerSubject: "sub-nobody", dryRun: false })).rejects.toThrow(/sub-nobody/);
    expect(await db.principal.count({ where: { subject: "sub-nobody" } })).toBe(0);
  });

  it("adopt-public --dry-run changes nothing and reports the same as a real run", async () => {
    const before = await db.agent.findUniqueOrThrow({ where: { id: "pub" } });
    const dry = await adoptPublic(db, { ownerSubject: "sub-alice", dryRun: true });
    expect((await db.agent.findUniqueOrThrow({ where: { id: "pub" } })).ownerId).toBe(before.ownerId);
    expect(await db.agentSecret.count({ where: { agentId: "pub" } })).toBe(2);
    expect(dry.dryRun).toBe(true);
    expect(dry.agents.map((a) => a.agentId)).toEqual(["pub"]);

    const real = await adoptPublic(db, { ownerSubject: "sub-alice", dryRun: false });
    expect({ ...real, dryRun: true }).toEqual(dry);
  });

  it("adopt-public kept own bindings, pruned foreign ones, stamped own-tool capabilities and kept grants", async () => {
    const agent = await db.agent.findUniqueOrThrow({ where: { id: "pub" } });
    expect(agent.ownerId).toBe("alice");
    expect((await db.agentSecret.findMany({ where: { agentId: "pub" } })).map((b) => b.boundName)).toEqual(["ALICE"]);
    expect((await db.agentDatastore.findMany({ where: { agentId: "pub" } })).map((b) => b.boundName)).toEqual([
      "alice-kb",
    ]);
    const attachments = await db.agentTool.findMany({ where: { agentId: "pub" }, orderBy: { toolId: "asc" } });
    expect(attachments.map((a) => [a.toolId, a.capabilitiesGrantedById])).toEqual([
      ["t-alice", "alice"],
      ["t-pub", null],
    ]);
    expect(
      await db.resourceGrant.findMany({ where: { resourceId: "pub" }, select: { granteeKey: true, level: true } }),
    ).toEqual([{ granteeKey: "everyone", level: "execute" }]);
    // Nothing owner-less is left to adopt.
    expect((await adoptPublic(db, { ownerSubject: "sub-alice", dryRun: false })).agents).toEqual([]);
  });

  it("adopt-public's report names what it removed, what stays inert and which edges now fail", async () => {
    // Re-create the scenario on a second owner-less agent to inspect a real run's output.
    await client.query(`
      INSERT INTO "Agent" ("id", "name", "systemPrompt", "model", "budgetUsd", "updatedAt", "ownerId")
        VALUES ('pub2', 'formerly-public-2', 'x', 'm', 1, now(), NULL);
      INSERT INTO "AgentSecret" ("agentId", "secretId", "boundName") VALUES ('pub2', 's-bob', 'BOB');
      INSERT INTO "AgentTool" ("agentId", "toolId", "allowedSecrets") VALUES ('pub2', 't-pub', '["BOB"]');
      INSERT INTO "AgentSubAgent" ("parentAgentId", "childAgentId", "boundName") VALUES ('pub2', 'bobs', 'bob-child');
    `);
    const lines: string[] = [];
    await grantsCommand(["adopt-public", "--owner", "sub-alice"], db, (line) => lines.push(line));
    const text = lines.join("\n");
    expect(text).toContain("formerly-public-2");
    expect(text).toMatch(/removed secret binding "BOB"/);
    expect(text).toMatch(/attach_tool/);
    expect(text).toMatch(/sub-agent edge .*bob-child/);
    // The failing edge is reported, not deleted: the runner refuses it.
    expect(await db.agentSubAgent.count({ where: { parentAgentId: "pub2" } })).toBe(1);
  });

  it("prune-bindings removes exactly the cross-owner bindings on owned agents and prints each", async () => {
    const dry: string[] = [];
    await grantsCommand(["prune-bindings", "--dry-run"], db, (line) => dry.push(line));
    expect(await db.agentSecret.count({ where: { agentId: "owned" } })).toBe(1);

    const result = await pruneBindings(db, { dryRun: false });
    expect(result.removed.map((b) => `${b.agentId}/${b.kind}/${b.boundName}`).sort()).toEqual([
      "owned/datastore/bob-kb-on-alice",
      "owned/secret/BOB_ON_ALICE",
    ]);
    expect(dry.join("\n")).toContain("BOB_ON_ALICE");
    expect(dry.join("\n")).toContain("bob-kb-on-alice");
    expect(await db.agentSecret.count({ where: { agentId: "owned" } })).toBe(0);
    expect(await db.agentDatastore.count({ where: { agentId: "owned" } })).toBe(0);
    // The owners' own bindings are untouched.
    expect(await db.agentSecret.count({ where: { agentId: "pub" } })).toBe(1);
    expect((await pruneBindings(db, { dryRun: false })).removed).toEqual([]);
  });

  it("import --public gives agents owned by the importer, shared with everyone at execute", async () => {
    const bundle = {
      manifest: { secretMode: "references", capabilities: [] },
      readAgents: () => [
        {
          name: "imported-public",
          systemPrompt: "x",
          provider: "bedrock",
          model: "m",
          region: null,
          schedule: null,
          timezone: "UTC",
          scheduleEnabled: false,
          maxTurns: 5,
          budgetUsd: "1.00",
          ownerEmail: null,
          kind: "native",
          memoryEnabled: false,
          unmodeled: {},
        },
      ],
      readTools: () => [],
      readAgentTools: () => [],
      readSecrets: () => [],
      readAgentSecrets: () => [],
      readSingleDatastores: () => [],
      readSharedDatastores: () => [],
      readWebhooks: () => [],
      readBudgets: () => [],
    } as unknown as Bundle;
    const recon = { agents: [], tools: [], nameRemap: new Map() } as unknown as Reconciliation;
    await createFromBundle(bundle, recon, {
      db,
      cipher: {} as never,
      ownerId: null,
      agentOwnerId: "carol",
      publicAgents: true,
      defaultBudget: "1.00",
      secretMode: "references",
      allowOpenFetch: false,
    });
    const agent = await db.agent.findUniqueOrThrow({ where: { name: "imported-public" } });
    expect(agent.ownerId).toBe("carol");
    expect(
      await db.resourceGrant.findMany({
        where: { resourceId: agent.id },
        select: { granteeKey: true, level: true, source: true },
      }),
    ).toEqual([{ granteeKey: "everyone", level: "execute", source: "import" }]);
  });

  it("an unknown grants subcommand prints usage", async () => {
    await expect(grantsCommand(["nope"], db, () => {})).rejects.toThrow(/migration-report/);
  });
});
