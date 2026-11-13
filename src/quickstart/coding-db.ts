/**
 * The Prisma side of the quickstart coding step: the default seed, catalog,
 * and local-agent lookups behind CodingDeps / CodingDoctorDeps. Each opens its
 * own client on the quickstart database (like seedDemo) and closes it.
 */
import type { Prisma, PrismaClient } from "#prisma";
import { LOCAL_REPO_PREFIX } from "../coding/local-repo.js";
import type { DeclaredService } from "../coding/services/declaration.js";
import type { LocalAgent } from "./coding-doctor.js";
import { seedCodingAgents, type CodingSeedInput, type CodingSeedResult, type SeedDb } from "./coding-seed.js";
import { readQuickstartEnv, type QuickstartPaths } from "./config.js";

async function withDb<T>(
  paths: QuickstartPaths,
  use: (db: PrismaClient, env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const { createPrismaClient } = await import("../core/db.js");
  const env = readQuickstartEnv(paths);
  const db = createPrismaClient(env.DATABASE_URL);
  try {
    return await use(db, env);
  } finally {
    await db.$disconnect();
  }
}

export function seedDb(db: PrismaClient): SeedDb {
  return {
    findAgent: (name) => db.agent.findUnique({ where: { name }, select: { id: true, kind: true, systemPrompt: true } }),
    createAgent: (data) => db.agent.create({ data, select: { id: true } }),
    updateAgent: async (id, data) => {
      await db.agent.update({ where: { id }, data });
    },
    upsertCodingProfile: async (agentId, profile) => {
      const fields = profile as Omit<Prisma.CodingAgentProfileUncheckedCreateInput, "agentId">;
      await db.codingAgentProfile.upsert({ where: { agentId }, create: { agentId, ...fields }, update: fields });
    },
    upsertLocalLink: async (agentId, link) => {
      const fields = { access: link.access, triggers: [], checkName: null, ...link.stamp };
      await db.agentRepository.upsert({
        where: { agentId_name: { agentId, name: `local:${link.repository}` } },
        create: {
          agentId,
          provider: "local",
          repository: link.repository,
          name: `local:${link.repository}`,
          ...fields,
        },
        update: fields,
      });
    },
  };
}

export async function prismaSeedCodingAgents(
  paths: QuickstartPaths,
  input: Omit<CodingSeedInput, "ownerId">,
): Promise<CodingSeedResult> {
  const { resolvePrincipal } = await import("../mcp/auth/principal.js");
  return await withDb(paths, async (db, env) => {
    const owner = await resolvePrincipal(env.LOCAL_PRINCIPAL || "local", db);
    return await seedCodingAgents(seedDb(db), { ...input, ownerId: owner.id });
  });
}

export async function prismaCatalogImages(
  paths: QuickstartPaths,
  services: DeclaredService[],
): Promise<Array<{ service: DeclaredService; image?: string }>> {
  if (services.length === 0) return [];
  return await withDb(paths, async (db) => {
    const rows = await db.codingService.findMany({
      where: { OR: services.map(({ name, version }) => ({ name, version })) },
      select: { name: true, version: true, image: true },
    });
    return services.map((service) => ({
      service,
      image: rows.find((row) => row.name === service.name && row.version === service.version)?.image,
    }));
  });
}

/** Coding agents with a local repository, and native agents with a local link. */
export async function prismaLocalAgents(paths: QuickstartPaths): Promise<LocalAgent[]> {
  return await withDb(paths, async (db) => {
    const [coding, links] = await Promise.all([
      db.codingAgentProfile.findMany({
        where: { repository: { startsWith: LOCAL_REPO_PREFIX } },
        select: {
          repository: true,
          baseRef: true,
          toolchain: true,
          toolchainVersion: true,
          agent: { select: { name: true } },
        },
      }),
      db.agentRepository.findMany({
        where: { provider: "local" },
        select: { repository: true, agent: { select: { name: true } } },
      }),
    ]);
    return [
      ...coding.map((row) => ({
        name: row.agent.name,
        repository: row.repository,
        ref: row.baseRef,
        toolchain: row.toolchain,
        toolchainVersion: row.toolchainVersion,
      })),
      ...links.map((row) => ({ name: row.agent.name, repository: row.repository })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  });
}
