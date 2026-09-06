/**
 * Wraps a `Datastore` so every operation is confined to keys under one of
 * the tool attachment's declared prefixes (OWASP LLM08 — Excessive Agency
 * fix). Reads/lists on a disallowed key behave like the key doesn't exist
 * (consistent with a plain cache-miss); a write outside every allowed
 * prefix throws loudly instead — a tool author needs to know their write
 * was rejected, not silently believe it landed.
 */
import type { Datastore, DatastoreSetOptions, DatastoreValue } from "./types.js";

function isAllowed(key: string, allowedPrefixes: readonly string[]): boolean {
  return allowedPrefixes.some((prefix) => key.startsWith(prefix));
}

export function scopeDatastore(datastore: Datastore, allowedPrefixes: readonly string[]): Datastore {
  return {
    async get(agentId: string, key: string): Promise<DatastoreValue | undefined> {
      if (!isAllowed(key, allowedPrefixes)) return undefined;
      return datastore.get(agentId, key);
    },
    async set(agentId: string, key: string, value: DatastoreValue, opts?: DatastoreSetOptions): Promise<void> {
      if (!isAllowed(key, allowedPrefixes)) throw new Error("datastore_prefix_not_allowed");
      await datastore.set(agentId, key, value, opts);
    },
    async delete(agentId: string, key: string): Promise<void> {
      if (!isAllowed(key, allowedPrefixes)) return;
      await datastore.delete(agentId, key);
    },
    async list(agentId: string, prefix?: string): Promise<string[]> {
      const keys = await datastore.list(agentId, prefix);
      return keys.filter((key) => isAllowed(key, allowedPrefixes));
    },
  };
}
