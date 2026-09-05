/**
 * Postgres-backed default Datastore adapter, via the `DatastoreEntry` table.
 */

import type { PrismaClient } from "@prisma/client";
import type { Datastore, DatastoreValue } from "./types.js";

export type DatastoreDb = Pick<PrismaClient, "datastoreEntry">;

export class PostgresDatastore implements Datastore {
  constructor(private readonly db: DatastoreDb) {}

  async get(agentId: string, key: string): Promise<DatastoreValue | undefined> {
    const entry = await this.db.datastoreEntry.findUnique({
      where: { agentId_key: { agentId, key } },
    });
    return entry ? (entry.value as DatastoreValue) : undefined;
  }

  async set(agentId: string, key: string, value: DatastoreValue): Promise<void> {
    await this.db.datastoreEntry.upsert({
      where: { agentId_key: { agentId, key } },
      create: { agentId, key, value: value as object },
      update: { value: value as object },
    });
  }

  async delete(agentId: string, key: string): Promise<void> {
    await this.db.datastoreEntry.deleteMany({ where: { agentId, key } });
  }

  async list(agentId: string, prefix?: string): Promise<string[]> {
    const entries = await this.db.datastoreEntry.findMany({
      where: { agentId, ...(prefix ? { key: { startsWith: prefix } } : {}) },
      select: { key: true },
      orderBy: { key: "asc" },
    });
    return entries.map((e) => e.key);
  }
}
