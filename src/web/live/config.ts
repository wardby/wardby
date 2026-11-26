/**
 * Live co-editing across control-plane replicas. WARDBY_LIVE_REDIS_URL (redis:// or rediss://; it may carry a
 * password, so it is a secret and never logged): set, every replica serves every document and edits pass
 * between replicas through Redis, with one leader per document (its lease) saving versions and merging
 * publishes. Unset: each document is served by one replica (the lease holder) and the others forward its
 * connections there. The mode comes from configuration only, never from whether Redis answers, so replicas
 * always agree on it.
 */
export interface LiveConfig {
  redisUrl?: string;
}

export function loadLiveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const url = env.WARDBY_LIVE_REDIS_URL?.trim();
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // The value is never quoted: it may carry a password.
    throw new Error("WARDBY_LIVE_REDIS_URL must be a redis:// or rediss:// URL.");
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new Error("WARDBY_LIVE_REDIS_URL must be a redis:// or rediss:// URL.");
  }
  return { redisUrl: url };
}
