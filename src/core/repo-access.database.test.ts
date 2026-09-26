import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "./db.js";

const MIGRATION = "20260926050000_repo_access_authorization";
const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

const db = createPrismaClient();
const agentIds: string[] = [];
const principalIds: string[] = [];

function databaseUrl(name: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function migrationSql(filter: (name: string) => boolean): Promise<string[]> {
  const names = (await readdir(MIGRATIONS_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .filter(filter);
  return Promise.all(names.map((n) => readFile(join(MIGRATIONS_DIR, n, "migration.sql"), "utf8")));
}

describe.skipIf(!process.env.DATABASE_URL)("repository access authorization schema (PostgreSQL)", () => {
  afterAll(async () => {
    await db.agent.deleteMany({ where: { id: { in: agentIds } } });
    await db.principal.deleteMany({ where: { id: { in: principalIds } } });
    await db.$disconnect();
  });

  it("the migration stamps pre-existing links and profiles grandfathered, and clears check names off non-PR links", async () => {
    const name = `wardby_replay_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}"`);
    const replay = new pg.Client({ connectionString: databaseUrl(name) });
    try {
      await replay.connect();
      for (const sql of await migrationSql((n) => n < MIGRATION)) await replay.query(sql);
      await replay.query(
        `INSERT INTO "Agent" ("id","name","systemPrompt","model","budgetUsd","updatedAt") VALUES
           ('a1','reviewer','x','m',1,now()), ('a2','coder','x','m',1,now())`,
      );
      await replay.query(
        `INSERT INTO "AgentRepository" ("id","agentId","provider","repository","access","triggers","checkName") VALUES
           ('l1','a1','github','o/r','write',ARRAY['pull_request'],'wardby review'),
           ('l2','a1','github','o/s','write',ARRAY[]::TEXT[],'orphan name')`,
      );
      await replay.query(
        `INSERT INTO "CodingAgentProfile" ("agentId","repository","protectedPaths") VALUES ('a2','o/r','[]')`,
      );
      for (const sql of await migrationSql((n) => n === MIGRATION)) await replay.query(sql);

      const links = await replay.query(
        `SELECT "id","authorizedVia","authorizedById","authorizedAt","checkName" FROM "AgentRepository" ORDER BY "id"`,
      );
      expect(links.rows).toEqual([
        expect.objectContaining({
          id: "l1",
          authorizedVia: "grandfathered",
          authorizedById: null,
          checkName: "wardby review",
        }),
        expect.objectContaining({ id: "l2", authorizedVia: "grandfathered", authorizedById: null, checkName: null }),
      ]);
      expect(links.rows.every((r: { authorizedAt: unknown }) => r.authorizedAt instanceof Date)).toBe(true);
      const profile = await replay.query(
        `SELECT "repositoryAuthorizedVia","repositoryAuthorizedById","repositoryAuthorizedAt" FROM "CodingAgentProfile"`,
      );
      expect(profile.rows[0]).toMatchObject({
        repositoryAuthorizedVia: "grandfathered",
        repositoryAuthorizedById: null,
      });
      expect(profile.rows[0].repositoryAuthorizedAt).toBeInstanceOf(Date);
    } finally {
      await replay.end().catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.end();
    }
  });

  it("a check name is unique per repository across all links; unnamed links never collide", async () => {
    const repository = `test/${randomUUID()}`;
    const make = async () => {
      const agent = await db.agent.create({
        data: { name: `repo-access-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
      });
      agentIds.push(agent.id);
      return agent.id;
    };
    const [a, b, c, d] = [await make(), await make(), await make(), await make()];
    const link = (agentId: string, checkName: string | null) =>
      db.agentRepository.create({
        data: { agentId, provider: "github", repository, access: "write", triggers: ["pull_request"], checkName },
      });
    await link(a, "wardby review");
    await expect(link(b, "wardby review")).rejects.toMatchObject({ code: "P2002" });
    await link(c, null);
    await link(d, null);
    expect(await db.agentRepository.count({ where: { repository } })).toBe(3);
  });

  it("a host user id belongs to one principal, and deleting a principal cascades its identity and link requests", async () => {
    const p1 = await db.principal.create({ data: { subject: `repo-access-${randomUUID()}` } });
    const p2 = await db.principal.create({ data: { subject: `repo-access-${randomUUID()}` } });
    principalIds.push(p1.id, p2.id);
    const hostUserId = String(Date.now());
    await db.hostIdentity.create({ data: { principalId: p1.id, provider: "github", hostUserId, login: "octo" } });
    await expect(
      db.hostIdentity.create({ data: { principalId: p2.id, provider: "github", hostUserId, login: "octo" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await db.hostIdentityLinkRequest.create({
      data: {
        principalId: p1.id,
        provider: "github",
        stateHash: randomUUID(),
        codeVerifier: "v".repeat(43),
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    await db.principal.delete({ where: { id: p1.id } });
    expect(await db.hostIdentity.count({ where: { principalId: p1.id } })).toBe(0);
    expect(await db.hostIdentityLinkRequest.count({ where: { principalId: p1.id } })).toBe(0);
  });

  it("a run's host check records the pull request it was dispatched for", async () => {
    const agent = await db.agent.create({
      data: { name: `repo-access-${randomUUID()}`, systemPrompt: "x", model: "m", budgetUsd: 1 },
    });
    agentIds.push(agent.id);
    const run = await db.run.create({ data: { agentId: agent.id, trigger: "host_event" } });
    await db.runHostCheck.create({
      data: {
        runId: run.id,
        provider: "github",
        repository: "o/r",
        checkId: "1",
        headSha: "a".repeat(40),
        prNumber: 7,
      },
    });
    expect((await db.runHostCheck.findUniqueOrThrow({ where: { runId: run.id } })).prNumber).toBe(7);
    await db.run.delete({ where: { id: run.id } });
  });
});
