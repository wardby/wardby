import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { createPrismaClient } from "../core/db.js";
import { afterAll, describe, expect, it } from "vitest";

const db = createPrismaClient();
const agentIds: string[] = [];
const runIds: string[] = [];

describe.skipIf(!process.env.DATABASE_URL)("Phase 5 coding schema (PostgreSQL)", () => {
  afterAll(async () => {
    await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
    await db.run.deleteMany({ where: { id: { in: runIds } } });
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.$disconnect();
  });

  it("preserves native defaults and stores an immutable coding-run snapshot", async () => {
    const native = await db.agent.create({
      data: { name: `phase5-native-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(native.id);
    expect(native.kind).toBe("native");

    const coding = await db.agent.create({
      data: {
        name: `phase5-coding-${randomUUID()}`,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: {
          create: {
            repository: "openai/example",
            allowedEgress: ["registry.npmjs.org"],
            protectedPaths: [".github/workflows/**", "CODEOWNERS"],
          },
        },
      },
      include: { codingProfile: true },
    });
    agentIds.push(coding.id);
    expect(coding.codingProfile).toMatchObject({ provider: "codex", baseRef: "main", timeoutSec: 1800 });

    const run = await db.run.create({
      data: { agentId: coding.id, status: "cancelled", executionManaged: true },
    });
    runIds.push(run.id);
    expect(run.executionManaged).toBe(true);

    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "Fix the unit test.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 1800,
        allowedEgress: ["registry.npmjs.org"],
        protectedPaths: [".github/workflows/**", "CODEOWNERS"],
        budgetReservedUsd: 0.25,
      },
    });

    const snapshot = await db.run.findUniqueOrThrow({ where: { id: run.id }, include: { codingRun: true } });
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.codingRun).toMatchObject({
      repository: "openai/example",
      provider: "codex",
      model: "gpt-5.6-luna",
      resultSchema: 1,
    });
  });

  it("stores the exact Claude Code provider identifier in profiles and run snapshots", async () => {
    const coding = await db.agent.create({
      data: {
        name: `phase5-claude-coding-${randomUUID()}`,
        systemPrompt: "code safely",
        model: "claude-sonnet-5",
        budgetUsd: 0.25,
        kind: "coding",
        codingProfile: {
          create: {
            provider: "claude-code",
            repository: "openai/example",
            allowedEgress: [],
            protectedPaths: ["CODEOWNERS"],
          },
        },
      },
      include: { codingProfile: true },
    });
    agentIds.push(coding.id);
    expect(coding.codingProfile?.provider).toBe("claude-code");

    const run = await db.run.create({ data: { agentId: coding.id, status: "cancelled", executionManaged: true } });
    runIds.push(run.id);
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "Fix the unit test.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "claude-code",
        model: "claude-sonnet-5",
        timeoutSec: 1800,
        allowedEgress: [],
        protectedPaths: ["CODEOWNERS"],
        budgetReservedUsd: 0.25,
      },
    });

    const snapshot = await db.codingRun.findUniqueOrThrow({ where: { runId: run.id } });
    expect(snapshot.provider).toBe("claude-code");
    await expect(
      db.$executeRaw`UPDATE "CodingAgentProfile" SET "provider" = ${"unknown"} WHERE "agentId" = ${coding.id}`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`UPDATE "CodingRun" SET "provider" = ${"unknown"} WHERE "runId" = ${run.id}`,
    ).rejects.toThrow();
  });

  it("CodingRun stores prDescriptionSha256/RunId/Outcome as nullable text", async () => {
    const columns = await db.$queryRaw<{ column_name: string; data_type: string; is_nullable: string }[]>`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'CodingRun'
        AND column_name IN ('prDescriptionSha256', 'prDescriptionRunId', 'prDescriptionOutcome')
      ORDER BY column_name`;
    expect(columns).toEqual([
      { column_name: "prDescriptionOutcome", data_type: "text", is_nullable: "YES" },
      { column_name: "prDescriptionRunId", data_type: "text", is_nullable: "YES" },
      { column_name: "prDescriptionSha256", data_type: "text", is_nullable: "YES" },
    ]);

    const agent = await db.agent.create({
      data: { name: `pr-description-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1, kind: "coding" },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, status: "cancelled", executionManaged: true } });
    runIds.push(run.id);
    await db.codingRun.create({
      data: {
        runId: run.id,
        task: "Fix the unit test.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${run.id}`,
        provider: "codex",
        model: "m",
        timeoutSec: 1800,
        allowedEgress: [],
        protectedPaths: [],
        budgetReservedUsd: 0.25,
      },
    });
    const fresh = await db.codingRun.findUniqueOrThrow({ where: { runId: run.id } });
    expect(fresh).toMatchObject({ prDescriptionSha256: null, prDescriptionRunId: null, prDescriptionOutcome: null });

    const sha = "a".repeat(64);
    const updated = await db.codingRun.update({
      where: { runId: run.id },
      data: { prDescriptionSha256: sha, prDescriptionRunId: run.id, prDescriptionOutcome: "written" },
    });
    expect(updated).toMatchObject({
      prDescriptionSha256: sha,
      prDescriptionRunId: run.id,
      prDescriptionOutcome: "written",
    });
  });
});

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const LAST_BEFORE = "20261115000000_secret_oauth";
const MULTI_REPO = "20261116000000_multi_repo_runs";

describe.skipIf(!process.env.DATABASE_URL)("multi-repo migration backfills link names (PostgreSQL)", () => {
  it("names coding links by short name with suffixes, and other links <provider>:<repository>", async () => {
    const schema = `multi_repo_${randomUUID().replaceAll("-", "")}`;
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
      for (const dir of dirs.filter((d) => d <= LAST_BEFORE)) {
        await client.query(readFileSync(join(MIGRATIONS, dir, "migration.sql"), "utf8"));
      }

      const insertAgent = async (id: string, kind: string) => {
        await client.query(
          `INSERT INTO "Agent" ("id", "name", "systemPrompt", "model", "budgetUsd", "kind", "updatedAt")
           VALUES ($1, $1, 'x', 'm', 1, $2, now())`,
          [id, kind],
        );
      };
      const insertLink = async (n: number, agentId: string, provider: string, repository: string) => {
        await client.query(
          `INSERT INTO "AgentRepository" ("id", "agentId", "provider", "repository", "access", "triggers", "createdAt")
           VALUES ($1, $2, $3, $4, 'read', ARRAY[]::TEXT[], now() + ($5 || ' seconds')::interval)`,
          [`link-${n}`, agentId, provider, repository, String(n)],
        );
      };
      await insertAgent("coder", "coding");
      await insertLink(1, "coder", "github", "acme/web");
      await insertLink(2, "coder", "github", "other/web");
      await insertLink(3, "coder", "github", "acme/Workspace");
      await insertLink(4, "coder", "github", "acme/_x");
      await insertAgent("native", "native");
      await insertLink(5, "native", "github", "acme/web");
      await insertLink(6, "native", "bitbucket", "acme/web");

      await client.query(readFileSync(join(MIGRATIONS, MULTI_REPO, "migration.sql"), "utf8"));

      const { rows } = await client.query<{ agentId: string; repository: string; name: string }>(
        `SELECT "agentId", "repository", "name" FROM "AgentRepository" ORDER BY "id"`,
      );
      const names = (agentId: string) => rows.filter((r) => r.agentId === agentId).map((r) => r.name);
      expect(names("coder")).toEqual(["web", "web-2", "workspace-2", "x"]);
      expect(names("native")).toEqual(["github:acme/web", "bitbucket:acme/web"]);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.end();
    }
  });
});
