import type { Datastore } from "../providers/datastore/types.js";
import type { AgentMemoryStore } from "../providers/memory/types.js";
import { SecretCheckUnavailableError, type SecretWriteGuard } from "./secret-guard.js";

/**
 * Datastore that refuses a key or value holding an attached secret's value. Shared
 * writes are checked against `opts.writerAgentId`; without it the writer is
 * unknown, so the write is refused (fail closed). `writerAgentId` is stripped
 * before the inner store sees it.
 */
export function guardDatastore(inner: Datastore, guard: SecretWriteGuard): Datastore {
  return {
    get: (agentId, key) => inner.get(agentId, key),
    async set(agentId, key, value, opts) {
      await guard.assertNoSecrets(agentId, [key, value]);
      return inner.set(agentId, key, value, opts);
    },
    delete: (agentId, key) => inner.delete(agentId, key),
    list: (agentId, prefix) => inner.list(agentId, prefix),
    getShared: (datastoreId, key) => inner.getShared(datastoreId, key),
    async setShared(datastoreId, key, value, opts) {
      const { writerAgentId, ...rest } = opts ?? {};
      if (!writerAgentId) throw new SecretCheckUnavailableError();
      await guard.assertNoSecrets(writerAgentId, [key, value]);
      return inner.setShared(datastoreId, key, value, rest);
    },
    deleteShared: (datastoreId, key) => inner.deleteShared(datastoreId, key),
    listShared: (datastoreId, prefix) => inner.listShared(datastoreId, prefix),
  };
}

/** Agent memory that refuses a key or content holding an attached secret's value. */
export function guardAgentMemory(inner: AgentMemoryStore, guard: SecretWriteGuard): AgentMemoryStore {
  return {
    get: (agentId, key) => inner.get(agentId, key),
    async set(agentId, key, content) {
      await guard.assertNoSecrets(agentId, [key, content]);
      return inner.set(agentId, key, content);
    },
    list: (agentId) => inner.list(agentId),
    search: (agentId, query, limit) => inner.search(agentId, query, limit),
    delete: (agentId, key) => inner.delete(agentId, key),
  };
}
