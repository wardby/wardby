/**
 * Postgres-backed default AgentMemory adapter, via the `AgentMemory` table.
 * `content`/`contentTsv` are always written together in one raw statement
 * (`contentTsv` is an `Unsupported("tsvector")` column — unreachable through
 * Prisma Client, and deliberately not a Postgres GENERATED column; see
 * schema.prisma). Every other operation goes through the normal Prisma
 * Client since it never touches `contentTsv`.
 */

import type { PrismaClient } from "#prisma";
import type { AgentMemorySearchHit, AgentMemoryStore } from "./types.js";
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_KEY_MAX_BYTES,
  MEMORY_MAX_KEYS_PER_AGENT,
  MEMORY_SEARCH_DEFAULT_LIMIT,
  MEMORY_SEARCH_MAX_LIMIT,
} from "./types.js";

export type AgentMemoryDb = Pick<PrismaClient, "agentMemory" | "$executeRaw" | "$queryRaw">;

function checkKey(key: string): void {
  if (typeof key !== "string" || Buffer.byteLength(key) < 1 || Buffer.byteLength(key) > MEMORY_KEY_MAX_BYTES) {
    throw new Error("memory_key_limit");
  }
}

function checkContent(content: string): void {
  if (typeof content !== "string" || Buffer.byteLength(content) > MEMORY_CONTENT_MAX_BYTES) {
    throw new Error("memory_content_limit");
  }
}

export class PostgresAgentMemory implements AgentMemoryStore {
  constructor(private readonly db: AgentMemoryDb) {}

  async get(agentId: string, key: string): Promise<string | undefined> {
    checkKey(key);
    const row = await this.db.agentMemory.findUnique({
      where: { agentId_key: { agentId, key } },
      select: { content: true },
    });
    return row?.content;
  }

  async set(agentId: string, key: string, content: string): Promise<void> {
    checkKey(key);
    checkContent(content);
    // Single atomic statement: the INSERT...SELECT's WHERE only yields a row
    // (so the INSERT proceeds) when the agent is under its key cap, or the
    // key already exists (in which case ON CONFLICT overwrites regardless of
    // the cap) — overwriting an existing key never counts against the cap.
    const affected = await this.db.$executeRaw`
      INSERT INTO "AgentMemory" ("agentId", "key", "content", "contentTsv", "updatedAt")
      SELECT ${agentId}, ${key}, ${content}, to_tsvector('english', ${content}), now()
      WHERE (SELECT count(*) FROM "AgentMemory" WHERE "agentId" = ${agentId}) < ${MEMORY_MAX_KEYS_PER_AGENT}
         OR EXISTS (SELECT 1 FROM "AgentMemory" WHERE "agentId" = ${agentId} AND "key" = ${key})
      ON CONFLICT ("agentId", "key")
      DO UPDATE SET "content" = EXCLUDED."content", "contentTsv" = EXCLUDED."contentTsv", "updatedAt" = now()
    `;
    if (affected === 0) throw new Error("memory_limit_exceeded");
  }

  async list(agentId: string): Promise<string[]> {
    const rows = await this.db.agentMemory.findMany({
      where: { agentId },
      select: { key: true },
      orderBy: { key: "asc" },
    });
    return rows.map((r) => r.key);
  }

  async search(agentId: string, query: string, limit?: number): Promise<AgentMemorySearchHit[]> {
    const cappedLimit = Math.min(Math.max(1, limit ?? MEMORY_SEARCH_DEFAULT_LIMIT), MEMORY_SEARCH_MAX_LIMIT);
    return this.db.$queryRaw<AgentMemorySearchHit[]>`
      SELECT "key", "content", ts_rank("contentTsv", plainto_tsquery('english', ${query}))::float8 AS rank
      FROM "AgentMemory"
      WHERE "agentId" = ${agentId} AND "contentTsv" @@ plainto_tsquery('english', ${query})
      ORDER BY rank DESC
      LIMIT ${cappedLimit}
    `;
  }

  async delete(agentId: string, key: string): Promise<void> {
    await this.db.agentMemory.deleteMany({ where: { agentId, key } });
  }
}
