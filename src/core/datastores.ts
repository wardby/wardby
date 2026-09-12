/**
 * Named datastores shared across agents: an owned resource (like Secret)
 * attached to agents via AgentDatastore, addressed at sandbox point-of-use
 * by a per-attachment `boundName` (sharedDatastore.get(boundName, key)) —
 * same boundName convention as AgentSecret.
 */
import type { PrismaClient, Datastore as DatastoreRow } from "@prisma/client";
import type { Datastore, DatastoreSetOptions, DatastoreValue } from "../providers/datastore/types.js";
import { boundedString } from "../sandbox/bounded-json.js";

export type DatastoreMetadata = Pick<DatastoreRow, "id" | "name" | "ownerId" | "createdAt" | "updatedAt">;

export interface SharedDatastoreAccessor {
  get(boundName: string, key: string): Promise<DatastoreValue | undefined>;
  set(boundName: string, key: string, value: DatastoreValue, opts?: DatastoreSetOptions): Promise<void>;
  delete(boundName: string, key: string): Promise<void>;
  list(boundName: string, prefix?: string): Promise<string[]>;
}

/** Creates a named datastore owned by `ownerId`. */
export async function createDatastore(name: string, ownerId: string, db: PrismaClient): Promise<DatastoreRow> {
  boundedString(name, 1024);
  return db.datastore.create({ data: { name, ownerId } });
}

export async function listDatastores(ownerId: string, db: PrismaClient): Promise<DatastoreMetadata[]> {
  const rows = await db.datastore.findMany({ where: { ownerId } });
  return rows.map(({ id, name, ownerId: owner, createdAt, updatedAt }) => ({
    id,
    name,
    ownerId: owner,
    createdAt,
    updatedAt,
  }));
}

export async function deleteDatastore(datastoreId: string, db: PrismaClient): Promise<void> {
  await db.datastore.delete({ where: { id: datastoreId } });
}

/** Attaches a datastore (by id — the caller already resolved/verified ownership) to an agent under `boundName`. */
export async function attachDatastore(
  agentId: string,
  datastoreId: string,
  db: PrismaClient,
  boundName: string,
): Promise<void> {
  await db.agentDatastore.create({ data: { agentId, datastoreId, boundName } });
}

/** Detaches by point-of-use name — (agentId, boundName) uniquely identifies the edge. */
export async function detachDatastore(agentId: string, boundName: string, db: PrismaClient): Promise<void> {
  await db.agentDatastore.deleteMany({ where: { agentId, boundName } });
}

async function resolveDatastoreId(
  agentId: string,
  boundName: string,
  db: Pick<PrismaClient, "agentDatastore">,
): Promise<string | undefined> {
  const attachment = await db.agentDatastore.findFirst({ where: { agentId, boundName } });
  return attachment?.datastoreId;
}

/**
 * Resolves `boundName` to the Datastore attached to this agent under that
 * name, then delegates to its *Shared methods. A `boundName` with no
 * attachment behaves like a cache-miss for get/list (undefined/[]), and
 * throws for set (a write must never silently no-op) — delete is a no-op,
 * matching scopeDatastore's existing "disallowed delete is a no-op"
 * convention for the private per-agent store.
 */
export function buildSharedDatastoreAccessor(
  agentId: string,
  datastore: Datastore,
  db: Pick<PrismaClient, "agentDatastore">,
): SharedDatastoreAccessor {
  return {
    async get(boundName, key) {
      const datastoreId = await resolveDatastoreId(agentId, boundName, db);
      if (!datastoreId) return undefined;
      return datastore.getShared(datastoreId, key);
    },
    async set(boundName, key, value, opts) {
      const datastoreId = await resolveDatastoreId(agentId, boundName, db);
      if (!datastoreId) throw new Error("datastore_not_bound");
      await datastore.setShared(datastoreId, key, value, opts);
    },
    async delete(boundName, key) {
      const datastoreId = await resolveDatastoreId(agentId, boundName, db);
      if (!datastoreId) return;
      await datastore.deleteShared(datastoreId, key);
    },
    async list(boundName, prefix) {
      const datastoreId = await resolveDatastoreId(agentId, boundName, db);
      if (!datastoreId) return [];
      return datastore.listShared(datastoreId, prefix);
    },
  };
}

/**
 * Wraps a `SharedDatastoreAccessor` so every operation is confined to a
 * bound name explicitly granted a prefix list, and within it, keys under one
 * of those prefixes — mirrors scopeDatastore's OWASP LLM08 fix, per bound
 * name instead of one flat prefix list. A boundName absent from the map
 * denies everything, the same default-deny convention as an empty
 * allowedDatastorePrefixes.
 */
export function scopeSharedDatastoreAccessor(
  accessor: SharedDatastoreAccessor,
  allowedPrefixes: Readonly<Record<string, readonly string[]>>,
): SharedDatastoreAccessor {
  function isAllowed(boundName: string, key: string): boolean {
    const prefixes = allowedPrefixes[boundName];
    return prefixes !== undefined && prefixes.some((prefix) => key.startsWith(prefix));
  }
  return {
    async get(boundName, key) {
      if (!isAllowed(boundName, key)) return undefined;
      return accessor.get(boundName, key);
    },
    async set(boundName, key, value, opts) {
      if (!isAllowed(boundName, key)) throw new Error("datastore_prefix_not_allowed");
      await accessor.set(boundName, key, value, opts);
    },
    async delete(boundName, key) {
      if (!isAllowed(boundName, key)) return;
      await accessor.delete(boundName, key);
    },
    async list(boundName, prefix) {
      const prefixes = allowedPrefixes[boundName];
      if (!prefixes) return [];
      const keys = await accessor.list(boundName, prefix);
      return keys.filter((key) => prefixes.some((p) => key.startsWith(p)));
    },
  };
}
