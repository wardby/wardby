/**
 * Postgres-backed default Datastore adapter, via the `DatastoreEntry` table.
 */

import type { PrismaClient } from "@prisma/client";
import type { Datastore, DatastoreValue } from "./types.js";
import { boundedJson, boundedString } from "../../sandbox/bounded-json.js";
import { BRIDGE_INPUT_BYTES } from "../../sandbox/limits.js";

export type DatastoreDb = Pick<PrismaClient, "datastoreEntry" | "$queryRaw">;

export class PostgresDatastore implements Datastore {
  constructor(private readonly db: DatastoreDb) {}

  async get(agentId: string, key: string): Promise<DatastoreValue | undefined> {
    boundedString(key, 1024);
    const rows = await this.db.$queryRaw<{ value: DatastoreValue; oversized: boolean }[]>`
      SELECT CASE WHEN octet_length("value"::text) <= ${BRIDGE_INPUT_BYTES} THEN "value" ELSE NULL END AS "value",
             octet_length("value"::text) > ${BRIDGE_INPUT_BYTES} AS "oversized"
      FROM "DatastoreEntry" WHERE "agentId" = ${agentId} AND "key" = ${key}`;
    if (rows[0]?.oversized) throw new Error("datastore_value_limit");
    return rows[0]?.value;
  }

  async set(agentId: string, key: string, value: DatastoreValue): Promise<void> {
    boundedString(key, 1024);
    boundedJson(value, BRIDGE_INPUT_BYTES);
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
    boundedString(prefix ?? "", 1024);
    const entries = await this.db.$queryRaw<{ key: string | null }[]>`
      SELECT CASE WHEN octet_length("key") <= 1024 THEN "key" ELSE NULL END AS "key"
      FROM "DatastoreEntry" WHERE "agentId" = ${agentId} AND starts_with("key", ${prefix ?? ""})
      ORDER BY "key" LIMIT 1001`;
    if (entries.length > 1000 || entries.some((e) => e.key === null)) throw new Error("datastore_list_limit");
    return entries.map((e) => e.key!);
  }
}
