// TEST ONLY (wardby-sim). The simulator's state: the call log, faults, and every service's
// own state (GitHub repos/PRs/issues/comments/reviews/checks/webhook subscriptions, Slack
// channels/messages, registry packages, Jira issues), each registered as a part that
// `reset()` clears.
import { FaultStore } from "./faults.js";

/** How a recorded call authenticated: the scheme only, never the credential. */
export type AuthScheme = "none" | "bearer" | "basic" | "token" | "other";

export interface RecordedCall {
  seq: number;
  at: string;
  service: string;
  method: string;
  path: string;
  query: string;
  status: number;
  auth: AuthScheme;
  /** Who the simulator decided the caller was ("app", "installation:42"), set by the route. */
  principal?: string;
  /** The JSON body, or text (cut at 64 KiB), or `{ bytes }` for a binary body. */
  body?: unknown;
  faultId?: string;
}

const MAX_TEXT_BODY = 64 * 1024;

export function authScheme(authorization: string | undefined): AuthScheme {
  if (!authorization) return "none";
  const scheme = authorization.split(" ", 1)[0].toLowerCase();
  if (scheme === "bearer" || scheme === "basic" || scheme === "token") return scheme;
  return "other";
}

/** A recorded body: JSON parsed, text cut, binary summarized. Never headers. */
export function recordedBody(raw: Buffer, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  const type = (contentType ?? "").toLowerCase();
  const textual =
    type.includes("json") ||
    type.startsWith("text/") ||
    type.includes("x-www-form-urlencoded") ||
    type === "" ||
    type.includes("graphql");
  if (!textual) return { bytes: raw.length };
  const value = raw.toString("utf8");
  if (type.includes("json") || type === "") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      // fall through to text
    }
  }
  return value.length > MAX_TEXT_BODY ? value.slice(0, MAX_TEXT_BODY) : value;
}

export class CallLog {
  private calls: RecordedCall[] = [];
  private seq = 0;

  add(call: Omit<RecordedCall, "seq" | "at">): RecordedCall {
    this.seq += 1;
    const entry: RecordedCall = { seq: this.seq, at: new Date().toISOString(), ...call };
    this.calls.push(entry);
    return entry;
  }

  list(filter: { service?: string; since?: number; method?: string; pathPrefix?: string } = {}): RecordedCall[] {
    return this.calls.filter(
      (call) =>
        (filter.service === undefined || call.service === filter.service) &&
        (filter.since === undefined || call.seq > filter.since) &&
        (filter.method === undefined || call.method === filter.method.toUpperCase()) &&
        (filter.pathPrefix === undefined || call.path.startsWith(filter.pathPrefix)),
    );
  }

  reset(): void {
    this.calls = [];
    this.seq = 0;
  }
}

/** A piece of service state that `/__sim/reset` clears. */
export interface StatePart {
  reset(): void;
}

export class SimState {
  readonly calls = new CallLog();
  readonly faults = new FaultStore();
  private readonly parts = new Map<string, StatePart>();

  register<T extends StatePart>(name: string, part: T): T {
    if (this.parts.has(name)) throw new Error(`state part already registered: ${name}`);
    this.parts.set(name, part);
    return part;
  }

  part<T extends StatePart>(name: string): T | undefined {
    return this.parts.get(name) as T | undefined;
  }

  reset(): void {
    this.calls.reset();
    this.faults.reset();
    for (const part of this.parts.values()) part.reset();
  }
}
