/**
 * Agent memory seam — persistent, agent-controlled key/content notes,
 * separate from the Datastore seam (`../datastore/types.ts`). Datastore is
 * opaque per-tool JSON state a sandboxed tool body reads/writes; memory is
 * curated free-text an agent reads/writes about itself, with its own
 * built-in tools (`memory_get`/`memory_set`/`memory_list`/`memory_search`,
 * see `../../core/memory-tools.ts`) rather than user-authored sandbox code.
 */

/** A key must fit a reasonable identifier; content is free text up to MEMORY_CONTENT_MAX_BYTES. */
export const MEMORY_KEY_MAX_BYTES = 200;
/** Bounds one entry's content — generous for free-text notes, far below the sandbox bridge's 1MiB guard. */
export const MEMORY_CONTENT_MAX_BYTES = 64 * 1024;
/** Caps rows per agent so a runaway loop writing unique keys every turn can't grow the table unbounded. */
export const MEMORY_MAX_KEYS_PER_AGENT = 500;
/** Default/maximum result count for `search`. */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 20;
export const MEMORY_SEARCH_MAX_LIMIT = 50;

export interface AgentMemorySearchHit {
  key: string;
  content: string;
  rank: number;
}

export interface AgentMemoryStore {
  get(agentId: string, key: string): Promise<string | undefined>;
  /** Upserts `key`. Throws `memory_key_limit`/`memory_content_limit` over the byte bounds, or `memory_limit_exceeded` if a brand-new key would exceed MEMORY_MAX_KEYS_PER_AGENT (overwriting an existing key never counts against the cap). */
  set(agentId: string, key: string, content: string): Promise<void>;
  /** Lists keys only (not content), sorted, scoped to the agent. */
  list(agentId: string): Promise<string[]>;
  /** Full-text search over content via Postgres `ts_rank`, best matches first. */
  search(agentId: string, query: string, limit?: number): Promise<AgentMemorySearchHit[]>;
  delete(agentId: string, key: string): Promise<void>;
}
