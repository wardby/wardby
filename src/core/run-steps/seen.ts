/**
 * The coding proxy's memory of which tool results it already handed over, per proxy session: every
 * request resends the history, so the same result arrives many times. Bounded (oldest sessions and
 * ids forgotten first); the control plane's writer ignores a repeat anyway (first status wins).
 */
export class SeenIds {
  private readonly bySession = new Map<string, Set<string>>();

  constructor(
    private readonly maxSessions = 512,
    private readonly maxIdsPerSession = 1024,
  ) {}

  fresh<T extends { callId: string }>(sessionId: string, items: readonly T[]): T[] {
    let seen = this.bySession.get(sessionId);
    if (!seen) {
      if (this.bySession.size >= this.maxSessions) this.bySession.delete(this.bySession.keys().next().value as string);
      seen = new Set();
      this.bySession.set(sessionId, seen);
    }
    const ids = seen;
    const out = items.filter((item) => !ids.has(item.callId));
    for (const item of out) {
      ids.add(item.callId);
      if (ids.size > this.maxIdsPerSession) ids.delete(ids.values().next().value as string);
    }
    return out;
  }
}
