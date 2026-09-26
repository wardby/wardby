// Proves deploy/gke/database-grants.sql against a real Postgres: the coding
// proxy can do everything its ledger and package registry do and nothing else, the app can read
// and write data but not change the schema, and the migrator acts as the owner.
// It also proves the durable executor's `dbos` schema: the migrator creates and
// migrates it with DBOS's own CLI (as the migration Job does), and the app can
// then launch DBOS on it and use its tables, but not change them.
// Runs in CI (DATABASE_URL set); the test user must be able to create roles.
// The test renders the script against per-run copies of the wardby_app /
// wardby_proxy group roles (t_wardby_app_<suffix> / t_wardby_proxy_<suffix>),
// so it never creates, drops, or otherwise touches the real group roles a
// live bootstrap created, and concurrent runs of this suite don't collide.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../../src/core/db.ts";
import { PrismaProxyLedger } from "../../src/providers/coding-proxy/prisma-ledger.ts";
import { PrismaRegistryStore } from "../../src/providers/coding-proxy/registry/prisma-store.ts";

const GRANTS = readFileSync(new URL("./database-grants.sql", import.meta.url), "utf8");
const suffix = randomUUID().slice(0, 8);
const rolesFor = (s) => ({ app: `t_app_${s}`, proxy: `t_proxy_${s}`, migrator: `t_migrator_${s}` });
const groupsFor = (s) => ({ app: `t_wardby_app_${s}`, proxy: `t_wardby_proxy_${s}` });
const roles = rolesFor(suffix);
const groups = groupsFor(suffix);
const PASSWORD = "test-only-grants";
// A per-run copy of the `dbos` schema, for the same reason as the group roles.
const dbosSchema = `t_dbos_${suffix}`;
const DBOS_CLI = fileURLToPath(new URL("../../node_modules/@dbos-inc/dbos-sdk/dist/src/cli/cli.js", import.meta.url));

function render(owner, r = roles, g = groups) {
  return GRANTS.replaceAll("{{owner}}", owner)
    .replaceAll("{{migrator}}", r.migrator)
    .replaceAll("{{app}}", r.app)
    .replaceAll("{{proxy}}", r.proxy)
    .replace(/\bwardby_app\b/g, g.app)
    .replace(/\bwardby_proxy\b/g, g.proxy)
    .replace(/\bdbos\b/g, dbosSchema);
}
// Each statement in the SQL file ends with a "-- ;;" line (the file has a DO
// block with inner semicolons, so splitting on ';' would break it).
function statements(sql) {
  return sql
    .split(/^-- ;;$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
function urlAs(role) {
  const url = new URL(process.env.DATABASE_URL);
  url.username = role;
  url.password = PASSWORD;
  return url.toString();
}
function clientAs(role) {
  return createPrismaClient(urlAs(role));
}
// `dbos schema <url>`: the migration Job's `npm run dbos:migrate`. It is also
// what DBOS.launch() runs against the system database (the SDK's
// ensureSystemDatabase), so running it as the app proves the app can launch.
function dbosSchemaAs(role) {
  return execFileSync(process.execPath, [DBOS_CLI, "schema", urlAs(role), "--schema", dbosSchema], {
    env: { PATH: process.env.PATH },
    stdio: "pipe",
  }).toString();
}

describe.skipIf(!process.env.DATABASE_URL)("database-grants.sql (PostgreSQL)", () => {
  const admin = createPrismaClient();
  let owner;
  const clients = [];
  const agentId = `grants-agent-${suffix}`;
  const runId = `grants-run-${suffix}`;
  const sessionId = `grants-session-${suffix}`;
  const factName = `grants-fact-${suffix}`;

  beforeAll(async () => {
    [{ owner }] = await admin.$queryRawUnsafe(`SELECT current_user AS owner`);
    for (const role of Object.values(roles)) {
      await admin.$executeRawUnsafe(`CREATE ROLE "${role}" LOGIN PASSWORD '${PASSWORD}'`);
    }
    // Twice: the script must be idempotent.
    for (let i = 0; i < 2; i++) for (const s of statements(render(owner))) await admin.$executeRawUnsafe(s);
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.$disconnect()));
    await admin.registryFetch.deleteMany({ where: { runId } });
    await admin.registryAllowance.deleteMany({ where: { runId } });
    await admin.registryApprovedVersion.deleteMany({ where: { runId } });
    await admin.registryPlanRefusal.deleteMany({ where: { runId } });
    await admin.registryVersionFact.deleteMany({ where: { name: factName } });
    await admin.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${sessionId}`;
    await admin.codingRun.deleteMany({ where: { runId } });
    await admin.run.deleteMany({ where: { id: runId } });
    await admin.agent.deleteMany({ where: { id: agentId } });
    await admin.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${dbosSchema}" CASCADE`);
    for (const role of [...Object.values(roles), ...Object.values(groups)]) {
      await admin.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
    }
    await admin.$disconnect();
  });

  it("lets the coding proxy run its whole ledger and nothing else", async () => {
    await admin.agent.create({
      data: { id: agentId, name: agentId, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1 },
    });
    await admin.run.create({ data: { id: runId, agentId, executionManaged: true } });
    await admin.codingRun.create({
      data: {
        runId,
        task: "t",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 60,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 0.0002,
        packageAllowlist: { npm: ["react@^19"] },
        packagePolicy: { minReleaseAgeDays: 3 },
      },
    });
    const proxy = clientAs(roles.proxy);
    clients.push(proxy);
    const ledger = new PrismaProxyLedger(proxy);
    await ledger.createSession({
      id: sessionId,
      runId,
      capabilityHash: `hash-${suffix}`,
      credentialRef: "openai/test",
      protocol: "openai-responses",
      allowedModels: ["gpt-5.6-luna"],
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 0.0002,
      registryTokenHash: `registry-hash-${suffix}`,
    });
    expect(await ledger.findSessionByCapabilityHash(`hash-${suffix}`)).toMatchObject({ protocol: "openai-responses" });
    const reserved = await ledger.reserve({
      id: `req-${suffix}`,
      sessionId,
      requestKey: "a",
      requestFingerprint: "fp-a",
      model: "gpt-5.6-luna",
      reservationUsd: 0.0001,
      pricing: { version: "test", encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 },
      now: new Date(),
    });
    expect(reserved.outcome).toBe("reserved");
    const usage = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    await ledger.complete(reserved.request.id, usage, 0.00005, 200);
    const run = await admin.run.findUniqueOrThrow({ where: { id: runId } });
    expect(run.tokensIn).toBe(10);

    // The package registry: every store operation, as the proxy.
    const registry = new PrismaRegistryStore(proxy);
    const context = await registry.findRunByRegistryTokenHash(`registry-hash-${suffix}`, new Date());
    expect(context).toMatchObject({ runId, allowlist: { npm: ["react@^19"] }, policy: { minReleaseAgeDays: 3 } });
    await registry.addAllowances(runId, "npm", ["loose-envify", "loose-envify"]);
    expect(await registry.isAllowedDependency(runId, "npm", "loose-envify")).toBe(true);
    expect(await registry.isAllowedDependency(runId, "npm", "left-pad")).toBe(false);
    await registry.recordFetch({
      runId,
      ecosystem: "npm",
      name: "react",
      version: "19.3.0",
      filename: "react-19.3.0.tgz",
      integrity: "sha512-x",
      sizeBytes: 1000,
      outcome: "served",
    });
    await registry.recordFetch({
      runId,
      ecosystem: "npm",
      name: "left-pad",
      outcome: "refused",
      reason: "wardby_package_not_allowed",
    });
    expect(await registry.usage(runId)).toMatchObject({ files: 1, bytes: 1000 });
    expect(await registry.refusalCount(runId)).toBe(1);
    expect(await registry.listFetches(runId)).toHaveLength(2);
    // ...and it may not change what it recorded, or read the rest of a coding run.
    await expect(proxy.$executeRawUnsafe(`DELETE FROM "RegistryFetch" WHERE false`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(proxy.$executeRawUnsafe(`UPDATE "RegistryAllowance" SET "name" = 'x' WHERE false`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(proxy.$queryRawUnsafe(`SELECT "task" FROM "CodingRun" LIMIT 1`)).rejects.toThrow(/permission denied/);

    // Lockfile verification: facts and approvals, as the proxy.
    const fact = {
      name: factName,
      version: "1.0.0",
      publishedAt: new Date("2020-01-01T00:00:00Z"),
      integrity: "sha512-f",
      downloadUrl: `https://registry.npmjs.org/${factName}/-/${factName}-1.0.0.tgz`,
      dependencies: [{ key: "a", name: "a", range: "^1" }],
    };
    await registry.putVersionFacts("npm", [fact]);
    await registry.putVersionFacts("npm", [{ ...fact, integrity: "sha512-other" }]); // kept as first stored
    expect(await registry.getVersionFacts("npm", [{ name: factName, version: "1.0.0" }])).toEqual([fact]);
    await registry.approveVersions(runId, "npm", [{ name: factName, version: "1.0.0", integrity: "sha512-f" }]);
    await registry.approveVersions(runId, "npm", [{ name: factName, version: "1.0.0", integrity: "sha512-f" }]);
    expect(await registry.findApprovedVersion(runId, "npm", factName, "1.0.0")).toEqual({
      integrity: "sha512-f",
      downloadUrl: fact.downloadUrl,
    });
    expect(await registry.findApprovedVersion(runId, "npm", factName, "2.0.0")).toBeNull();
    const refusal = { name: factName, version: "3.0.0", code: "wardby_version_filtered", reason: "too new" };
    await registry.refusePlanVersions(runId, "npm", [refusal]);
    await registry.refusePlanVersions(runId, "npm", [refusal]);
    expect(await registry.findPlanRefusal(runId, "npm", factName, "3.0.0")).toEqual({
      code: "wardby_version_filtered",
      reason: "too new",
    });
    for (const table of ["RegistryVersionFact", "RegistryApprovedVersion", "RegistryPlanRefusal"]) {
      await expect(proxy.$executeRawUnsafe(`UPDATE "${table}" SET "version" = 'x' WHERE false`)).rejects.toThrow(
        /permission denied/,
      );
      await expect(proxy.$executeRawUnsafe(`DELETE FROM "${table}" WHERE false`)).rejects.toThrow(/permission denied/);
    }

    await expect(proxy.$queryRawUnsafe(`SELECT "id" FROM "Agent" LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(proxy.$queryRawUnsafe(`SELECT "agentId" FROM "Run" LIMIT 1`)).rejects.toThrow(/permission denied/);
    // The ledger only ever writes these three columns; it may not read them back.
    for (const column of ["tokensIn", "tokensOut", "costUsd"]) {
      await expect(proxy.$queryRawUnsafe(`SELECT "${column}" FROM "Run" LIMIT 1`)).rejects.toThrow(/permission denied/);
    }
  });

  it("lets the app read and write data but not change the schema", async () => {
    const app = clientAs(roles.app);
    clients.push(app);
    await expect(app.$queryRawUnsafe(`SELECT count(*) FROM "Agent"`)).resolves.toBeDefined();
    await expect(app.$executeRawUnsafe(`CREATE TABLE "grants_probe_${suffix}" (id int)`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.$executeRawUnsafe(`TRUNCATE "CodingProxyRequest"`)).rejects.toThrow(/permission denied/);
  });

  it("keeps the app out of the migration history", async (ctx) => {
    const [{ exists }] = await admin.$queryRawUnsafe(
      `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS exists`,
    );
    if (!exists) ctx.skip();
    const app = clientAs(roles.app);
    clients.push(app);
    // WHERE false: the privilege check still runs, and nothing is changed.
    await expect(app.$executeRawUnsafe(`UPDATE "_prisma_migrations" SET "logs" = NULL WHERE false`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.$executeRawUnsafe(`DELETE FROM "_prisma_migrations" WHERE false`)).rejects.toThrow(
      /permission denied/,
    );
  });

  it("applies on an unmigrated database, skipping the grants on tables that do not exist yet", async () => {
    // The real tables exist here and the names are unqualified, so a search_path
    // trick cannot hide them. Instead the guarded names are renamed to tables
    // that do not exist: the guard must skip them, and nothing may be granted.
    const s = `${suffix}_m`;
    const r = rolesFor(s);
    const g = groupsFor(s);
    const missing = `_missing_${suffix}`;
    for (const role of Object.values(r)) await admin.$executeRawUnsafe(`CREATE ROLE "${role}" NOLOGIN`);
    try {
      const sql = render(owner, r, g)
        .replace(/\bCodingProxySession\b/g, `CodingProxySession${missing}`)
        .replace(/\bCodingProxyRequest\b/g, `CodingProxyRequest${missing}`)
        .replace(/\bRun\b/g, `Run${missing}`)
        .replace(/\bCodingRun\b/g, `CodingRun${missing}`)
        .replace(/\bRegistryAllowance\b/g, `RegistryAllowance${missing}`)
        .replace(/\bRegistryFetch\b/g, `RegistryFetch${missing}`)
        .replace(/\bRegistryVersionFact\b/g, `RegistryVersionFact${missing}`)
        .replace(/\bRegistryApprovedVersion\b/g, `RegistryApprovedVersion${missing}`)
        .replace(/\bRegistryPlanRefusal\b/g, `RegistryPlanRefusal${missing}`)
        .replace(/\b_prisma_migrations\b/g, `_prisma_migrations${missing}`);
      expect(sql).not.toMatch(
        /"(CodingProxySession|CodingProxyRequest|Run|CodingRun|RegistryAllowance|RegistryFetch|RegistryVersionFact|RegistryApprovedVersion|RegistryPlanRefusal|_prisma_migrations)"/,
      );
      for (const st of statements(sql)) await admin.$executeRawUnsafe(st);
      const [{ tables, columns }] = await admin.$queryRawUnsafe(
        `SELECT (SELECT count(*) FROM information_schema.role_table_grants WHERE grantee = $1)::int AS tables,
                (SELECT count(*) FROM information_schema.role_column_grants WHERE grantee = $1)::int AS columns`,
        g.proxy,
      );
      expect({ tables, columns }).toEqual({ tables: 0, columns: 0 });
      // ...while the memberships, which the migrations need, were applied.
      const [{ member }] = await admin.$queryRawUnsafe(
        `SELECT pg_has_role($1, $2, 'MEMBER') AS member`,
        r.migrator,
        owner,
      );
      expect(member).toBe(true);
    } finally {
      for (const role of [...Object.values(r), ...Object.values(g)]) {
        await admin.$executeRawUnsafe(`DROP OWNED BY "${role}"`);
        await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${role}"`);
      }
    }
  });

  it("makes every migrator session act as the owner, so new tables stay owned by it", async () => {
    const migrator = clientAs(roles.migrator);
    clients.push(migrator);
    const [{ who }] = await migrator.$queryRawUnsafe(`SELECT current_user AS who`);
    expect(who).toBe(owner);
    const table = `grants_migrator_${suffix}`;
    await migrator.$executeRawUnsafe(`CREATE TABLE "${table}" (id int)`);
    const [{ tableowner }] = await admin.$queryRawUnsafe(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = '${table}'`,
    );
    expect(tableowner).toBe(owner);
    // ...and the app can use it through the owner's default privileges.
    const app = clientAs(roles.app);
    clients.push(app);
    await expect(app.$executeRawUnsafe(`INSERT INTO "${table}" VALUES (1)`)).resolves.toBe(1);
    await admin.$executeRawUnsafe(`DROP TABLE "${table}"`);
  });

  it("lets the migrator create and migrate the dbos schema, owned by the owner", async () => {
    dbosSchemaAs(roles.migrator);
    const owners = await admin.$queryRawUnsafe(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1`,
      dbosSchema,
    );
    expect(owners).toEqual([{ tableowner: owner }]);
    const [{ tables }] = await admin.$queryRawUnsafe(
      `SELECT count(*)::int AS tables FROM pg_tables
        WHERE schemaname = $1 AND tablename IN ('workflow_status', 'operation_outputs', 'dbos_migrations')`,
      dbosSchema,
    );
    expect(tables).toBe(3);
  });

  it("lets the app launch DBOS on the migrated schema and use its tables, but not change them", async () => {
    // The launch path: finds the schema current and changes nothing. Without
    // the grants the app cannot see dbos_migrations, takes the schema for a new
    // one, and fails on CREATE SCHEMA ("permission denied for database").
    dbosSchemaAs(roles.app);
    const app = clientAs(roles.app);
    clients.push(app);
    const wf = `grants-wf-${suffix}`;
    await app.$executeRawUnsafe(
      `INSERT INTO "${dbosSchema}".workflow_status (workflow_uuid, status, executor_id) VALUES ($1, 'PENDING', 'a')`,
      wf,
    );
    await app.$executeRawUnsafe(
      `INSERT INTO "${dbosSchema}".operation_outputs (workflow_uuid, function_id, output) VALUES ($1, 0, 'x')`,
      wf,
    );
    // Adoption and dequeue claim rows under a row lock and rewrite the owner.
    await app.$transaction([
      app.$queryRawUnsafe(`SELECT 1 FROM "${dbosSchema}".workflow_status WHERE workflow_uuid = $1 FOR UPDATE`, wf),
      app.$executeRawUnsafe(
        `UPDATE "${dbosSchema}".workflow_status SET executor_id = 'b' WHERE workflow_uuid = $1`,
        wf,
      ),
    ]);
    // Pruning (DBOS.deleteWorkflow) deletes a workflow's rows.
    await expect(
      app.$executeRawUnsafe(`DELETE FROM "${dbosSchema}".operation_outputs WHERE workflow_uuid = $1`, wf),
    ).resolves.toBe(1);
    await expect(
      app.$executeRawUnsafe(`DELETE FROM "${dbosSchema}".workflow_status WHERE workflow_uuid = $1`, wf),
    ).resolves.toBe(1);

    await expect(app.$executeRawUnsafe(`CREATE TABLE "${dbosSchema}".probe (id int)`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(app.$executeRawUnsafe(`TRUNCATE "${dbosSchema}".operation_outputs`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      app.$executeRawUnsafe(`ALTER TABLE "${dbosSchema}".operation_outputs ADD COLUMN probe int`),
    ).rejects.toThrow(/must be owner/);
  });

  it("gives the app the tables a later DBOS migration adds, through the owner's default privileges", async () => {
    const migrator = clientAs(roles.migrator);
    clients.push(migrator);
    await migrator.$executeRawUnsafe(`CREATE TABLE "${dbosSchema}".later_table (id int)`);
    const app = clientAs(roles.app);
    clients.push(app);
    await expect(app.$executeRawUnsafe(`INSERT INTO "${dbosSchema}".later_table VALUES (1)`)).resolves.toBe(1);
  });
});
