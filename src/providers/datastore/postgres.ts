/**
 * Postgres-backed default Datastore adapter, via the `DatastoreEntry` table.
 */

import type { PrismaClient } from "@prisma/client";
import type { Datastore, DatastoreSetOptions, DatastoreValue } from "./types.js";
import type { SecretCipher } from "../secrets/types.js";
import { boundedJson, boundedString } from "../../sandbox/bounded-json.js";
import { BRIDGE_INPUT_BYTES } from "../../sandbox/limits.js";

export type DatastoreDb = Pick<PrismaClient, "datastoreEntry" | "datastore" | "$queryRaw">;

/**
 * A `pii: true` value is stored as a base64url cipher blob, which runs
 * ~33% larger than its plaintext plus a small fixed iv/tag overhead. Capping
 * the plaintext here (rather than at BRIDGE_INPUT_BYTES) guarantees the
 * encrypted blob still clears the read-side BRIDGE_INPUT_BYTES guard below —
 * a plaintext allowed right up to that guard would otherwise encrypt into an
 * unreadable row.
 */
const PII_PLAINTEXT_BYTES = 750_000;

export class PostgresDatastore implements Datastore {
  constructor(
    private readonly db: DatastoreDb,
    private readonly cipher?: SecretCipher,
  ) {}

  async get(agentId: string, key: string): Promise<DatastoreValue | undefined> {
    boundedString(key, 1024);
    const rows = await this.db.$queryRaw<{ value: DatastoreValue; oversized: boolean; pii: boolean }[]>`
      SELECT CASE WHEN octet_length("value"::text) <= ${BRIDGE_INPUT_BYTES} THEN "value" ELSE NULL END AS "value",
             octet_length("value"::text) > ${BRIDGE_INPUT_BYTES} AS "oversized",
             "pii" AS "pii"
      FROM "DatastoreEntry" WHERE "agentId" = ${agentId} AND "key" = ${key}`;
    const row = rows[0];
    if (!row) return undefined;
    if (row.oversized) throw new Error("datastore_value_limit");
    if (!row.pii) return row.value;
    if (!this.cipher) throw new Error("datastore_pii_cipher_unavailable");
    const plaintext = await this.cipher.decrypt(row.value as unknown as string);
    return JSON.parse(plaintext) as DatastoreValue;
  }

  async set(agentId: string, key: string, value: DatastoreValue, opts?: DatastoreSetOptions): Promise<void> {
    boundedString(key, 1024);
    if (!opts?.pii) {
      boundedJson(value, BRIDGE_INPUT_BYTES);
      await this.db.datastoreEntry.upsert({
        where: { agentId_key: { agentId, key } },
        create: { agentId, key, value: value as object, pii: false, keyId: null },
        update: { value: value as object, pii: false, keyId: null },
      });
      return;
    }
    if (!this.cipher) throw new Error("datastore_pii_cipher_unavailable");
    const plaintext = boundedJson(value, PII_PLAINTEXT_BYTES);
    const ciphertext = await this.cipher.encrypt(plaintext);
    const keyId = this.cipher.keyId();
    await this.db.datastoreEntry.upsert({
      where: { agentId_key: { agentId, key } },
      create: { agentId, key, value: ciphertext, pii: true, keyId },
      update: { value: ciphertext, pii: true, keyId },
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

  async getShared(datastoreId: string, key: string): Promise<DatastoreValue | undefined> {
    boundedString(key, 1024);
    const rows = await this.db.$queryRaw<{ value: DatastoreValue; oversized: boolean; pii: boolean }[]>`
      SELECT CASE WHEN octet_length("value"::text) <= ${BRIDGE_INPUT_BYTES} THEN "value" ELSE NULL END AS "value",
             octet_length("value"::text) > ${BRIDGE_INPUT_BYTES} AS "oversized",
             "pii" AS "pii"
      FROM "DatastoreEntry" WHERE "datastoreId" = ${datastoreId} AND "key" = ${key}`;
    const row = rows[0];
    if (!row) return undefined;
    if (row.oversized) throw new Error("datastore_value_limit");
    if (!row.pii) return row.value;
    if (!this.cipher) throw new Error("datastore_pii_cipher_unavailable");
    const plaintext = await this.cipher.decrypt(row.value as unknown as string);
    return JSON.parse(plaintext) as DatastoreValue;
  }

  async setShared(datastoreId: string, key: string, value: DatastoreValue, opts?: DatastoreSetOptions): Promise<void> {
    boundedString(key, 1024);
    if (!opts?.pii) {
      boundedJson(value, BRIDGE_INPUT_BYTES);
      await this.db.datastoreEntry.upsert({
        where: { datastoreId_key: { datastoreId, key } },
        create: { datastoreId, key, value: value as object, pii: false, keyId: null },
        update: { value: value as object, pii: false, keyId: null },
      });
      return;
    }
    if (!this.cipher) throw new Error("datastore_pii_cipher_unavailable");
    const plaintext = boundedJson(value, PII_PLAINTEXT_BYTES);
    const ciphertext = await this.cipher.encrypt(plaintext);
    const keyId = this.cipher.keyId();
    await this.db.datastoreEntry.upsert({
      where: { datastoreId_key: { datastoreId, key } },
      create: { datastoreId, key, value: ciphertext, pii: true, keyId },
      update: { value: ciphertext, pii: true, keyId },
    });
  }

  async deleteShared(datastoreId: string, key: string): Promise<void> {
    await this.db.datastoreEntry.deleteMany({ where: { datastoreId, key } });
  }

  async listShared(datastoreId: string, prefix?: string): Promise<string[]> {
    boundedString(prefix ?? "", 1024);
    const entries = await this.db.$queryRaw<{ key: string | null }[]>`
      SELECT CASE WHEN octet_length("key") <= 1024 THEN "key" ELSE NULL END AS "key"
      FROM "DatastoreEntry" WHERE "datastoreId" = ${datastoreId} AND starts_with("key", ${prefix ?? ""})
      ORDER BY "key" LIMIT 1001`;
    if (entries.length > 1000 || entries.some((e) => e.key === null)) throw new Error("datastore_list_limit");
    return entries.map((e) => e.key!);
  }
}
