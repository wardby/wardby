import { capabilityHash } from "./capability-hash.js";
import type { TunnelAuthenticator, TunnelAuthResult } from "./tunnel-auth.js";

interface FakeSession {
  runId: string;
  deadlineAt: Date;
  tunnelHosts: string[];
  cancelled: boolean;
}

/** A TunnelAuthenticator over a map keyed by token hash, like the ledger will be: for tests. */
export class InMemoryTunnelAuthenticator implements TunnelAuthenticator {
  private readonly sessions = new Map<string, FakeSession>();

  constructor(private readonly now: () => number = Date.now) {}

  register(token: string, session: { runId: string; deadlineAt?: Date; tunnelHosts?: string[] }): void {
    this.sessions.set(capabilityHash(token), {
      runId: session.runId,
      deadlineAt: session.deadlineAt ?? new Date(this.now() + 60_000),
      tunnelHosts: [...(session.tunnelHosts ?? [])],
      cancelled: false,
    });
  }

  cancel(runId: string): void {
    for (const session of this.sessions.values()) if (session.runId === runId) session.cancelled = true;
  }

  async authenticate(token: string): Promise<TunnelAuthResult> {
    const session = this.sessions.get(capabilityHash(token));
    if (!session) return { ok: false, reason: "invalid" };
    if (session.cancelled || session.deadlineAt.getTime() <= this.now()) return { ok: false, reason: "inactive" };
    return {
      ok: true,
      identity: { runId: session.runId, deadlineAt: session.deadlineAt, tunnelHosts: [...session.tunnelHosts] },
    };
  }

  async isActive(runId: string): Promise<boolean> {
    for (const session of this.sessions.values()) {
      if (session.runId === runId && !session.cancelled && session.deadlineAt.getTime() > this.now()) return true;
    }
    return false;
  }
}
