/**
 * How the tunnel listener learns who a `Proxy-Authorization` token belongs to. The listener never
 * sees a ledger: it is given one of these, so the credential store can change (the session ledger in a
 * deployment, an in-memory fake in tests) without touching the tunnel.
 */
import { capabilityHash } from "./capability-hash.js";
import type { ProxyLedger } from "./types.js";

/** The run a tunnel token belongs to, and when its session stops being valid. */
export interface TunnelIdentity {
  runId: string;
  deadlineAt: Date;
}

export type TunnelAuthResult =
  | { ok: true; identity: TunnelIdentity }
  /** `invalid`: no session has this token. `inactive`: its session ended, was cancelled or ran out of time. */
  | { ok: false; reason: "invalid" | "inactive" };

export interface TunnelAuthenticator {
  /** Looks the token up by its hash. The token itself is never stored, logged or returned. */
  authenticate(token: string): Promise<TunnelAuthResult>;
  /** Whether the run's session is still active; polled while its tunnels are open. */
  isActive(runId: string): Promise<boolean>;
}

/**
 * The deployment's authenticator: the session ledger, looked up by the SHA-256 of the presented token.
 * Only a tunnel token matches; the run's capability, registry token and MCP token hash differently and
 * find no session here.
 */
export class LedgerTunnelAuthenticator implements TunnelAuthenticator {
  constructor(
    private readonly ledger: Pick<ProxyLedger, "findSessionByTunnelTokenHash" | "sessionActiveForRun">,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authenticate(token: string): Promise<TunnelAuthResult> {
    const session = await this.ledger.findSessionByTunnelTokenHash(capabilityHash(token));
    if (!session) return { ok: false, reason: "invalid" };
    if (session.status !== "active" || session.deadlineAt.getTime() <= this.now().getTime()) {
      return { ok: false, reason: "inactive" };
    }
    return { ok: true, identity: { runId: session.runId, deadlineAt: session.deadlineAt } };
  }

  isActive(runId: string): Promise<boolean> {
    return this.ledger.sessionActiveForRun(runId);
  }
}
