/**
 * Datastore seam — key/value state scoped per agent, exposed to sandboxed
 * tools as `datastore.*`. The one new seam Phase 3 introduces (Medium host
 * API surface); a cloud KV can swap in later via the same provider-config
 * pattern as the other seams.
 */

export type DatastoreValue = null | boolean | number | string | DatastoreValue[] | { [key: string]: DatastoreValue };

export interface DatastoreSetOptions {
  /**
   * Opt-in, never inferred: encrypts the value at rest (AES-256-GCM, same
   * cipher as Secret) instead of storing it as plain JSON. Costs an
   * encrypt/decrypt round trip on every set/get of that key, so reserve it
   * for values that actually carry PII.
   */
  pii?: boolean;
}

export interface Datastore {
  get(agentId: string, key: string): Promise<DatastoreValue | undefined>;
  set(agentId: string, key: string, value: DatastoreValue, opts?: DatastoreSetOptions): Promise<void>;
  delete(agentId: string, key: string): Promise<void>;
  /** Lists keys (not values) under an optional prefix, scoped to the agent. */
  list(agentId: string, prefix?: string): Promise<string[]>;
}
