// Proves deploy/gke/database-grants.sql against a real Postgres: the coding
// proxy can do everything its ledger does and nothing else, the app can read
// and write data but not change the schema, and the migrator acts as the owner.
// Runs in CI (DATABASE_URL set); the test user must be able to create roles.
// The test renders the script against per-run copies of the wardby_app /
// wardby_proxy group roles (t_wardby_app_<suffix> / t_wardby_proxy_<suffix>),
// so it never creates, drops, or otherwise touches the real group roles a
// live bootstrap created, and concurrent runs of this suite don't collide.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaProxyLedger } from "../../src/providers/coding-proxy/prisma-ledger.ts";

const GRANTS = readFileSync(new URL("./database-grants.sql", import.meta.url), "utf8");
const suffix = randomUUID().slice(0, 8);
const roles = { app: `t_app_${suffix}`, proxy: `t_proxy_${suffix}`, migrator: `t_migrator_${suffix}` };
const groups = { app: `t_wardby_app_${suffix}`, proxy: `t_wardby_proxy_${suffix}` };
const PASSWORD = "test-only-grants";

function render(owner) {
  return GRANTS.replaceAll("{{owner}}", owner)
    .replaceAll("{{migrator}}", roles.migrator)
    .replaceAll("{{app}}", roles.app)
    .replaceAll("{{proxy}}", roles.proxy)
    .replace(/\bwardby_app\b/g, groups.app)
    .replace(/\bwardby_proxy\b/g, groups.proxy);
}
// Each statement in the SQL file ends with a "-- ;;" line (the file has a DO
// block with inner semicolons, so splitting on ';' would break it).
function statements(sql) {
  return sql
    .split(/^-- ;;$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}
function clientAs(role) {
  const url = new URL(process.env.DATABASE_URL);
  url.username = role;
  url.password = PASSWORD;
  return new PrismaClient({ datasources: { db: { url: url.toString() } } });
}

describe.skipIf(!process.env.DATABASE_URL)("database-grants.sql (PostgreSQL)", () => {
  const admin = new PrismaClient();
  let owner;
  const clients = [];
  const agentId = `grants-agent-${suffix}`;
  const runId = `grants-run-${suffix}`;
  const sessionId = `grants-session-${suffix}`;

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
    await admin.$executeRaw`DELETE FROM "CodingProxySession" WHERE "id" = ${sessionId}`;
    await admin.codingRun.deleteMany({ where: { runId } });
    await admin.run.deleteMany({ where: { id: runId } });
    await admin.agent.deleteMany({ where: { id: agentId } });
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

    await expect(proxy.$queryRawUnsafe(`SELECT "id" FROM "Agent" LIMIT 1`)).rejects.toThrow(/permission denied/);
    await expect(proxy.$queryRawUnsafe(`SELECT "agentId" FROM "Run" LIMIT 1`)).rejects.toThrow(/permission denied/);
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
});
