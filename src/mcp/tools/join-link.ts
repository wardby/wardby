/**
 * The link `join_run` returns for `wardby join -`, the terminal way to join a running run. Like
 * create_secret's loopback link, it is `<origin>/join#<token>`: the token sits in the URL fragment,
 * so pasting the link into a browser sends nothing to any server. The CLI parses origin and token
 * out of it and sends the token only as `Authorization: Bearer` to the join API routes below; it
 * never requests the link as a URL.
 *
 * The token is the MCP server's requestState codec (HMAC + its own 10-minute expiry), naming one
 * run and the principal it was minted for. A join session lasts longer than 10 minutes, so every
 * answer of the join API carries a fresh token with the same payload: the CLI keeps the newest one
 * and its polling keeps the session alive. The payload's `exp` bounds the whole session (the run's
 * deadline plus a short grace). Every call checks access again, as the MCP tools do.
 *
 * The token is a bearer capability: nothing logs it, and no answer or refusal echoes it.
 *
 * Import-free (types only), so the CLI side loads nothing of the server.
 */
import type { RunTranscriptLinkAudience } from "./run-transcript-download.js";

/** The path of the link (never requested: the token is in its fragment). */
export const JOIN_LINK_PATH = "/join";
/** The join API the CLI calls (POST, Bearer token, JSON). */
export const JOIN_API_PATHS = {
  join: "/join/api/join",
  steps: "/join/api/steps",
  send: "/join/api/send",
  leave: "/join/api/leave",
  stop: "/join/api/stop",
  status: "/join/api/status",
} as const;
export type JoinApiAction = keyof typeof JOIN_API_PATHS;
/** The command join_run hands out. It reads the link from stdin, never from the command line. */
export const JOIN_COMMAND = "npx @wardby/cli@latest join -";
/** After the run's deadline, how long a session may still read the run's last steps and status. */
export const JOIN_LINK_GRACE_MS = 10 * 60_000;
/** The longest a join session may last, whatever the run's timeout. */
export const JOIN_LINK_MAX_MS = 6 * 60 * 60_000;
/** The largest join API request body. */
export const JOIN_API_BODY_LIMIT = 64 * 1024;

export interface JoinLinkPayload {
  kind: "run-join";
  runId: string;
  principalId: string;
  /** The host that minted the link, and the only one that accepts it. */
  aud: RunTranscriptLinkAudience;
  /** The stdio local operator. Only ever on a stdio link. */
  operator?: boolean;
  /**
   * An owner-all caller (the owner:all scope and a role granting it) on the HTTP server. Never on a
   * stdio link. The join API re-checks the role on every call (ownerAllStill, join-api.ts).
   */
  ownerAll?: boolean;
  /**
   * With ownerAll: the caller's direct roles when the link was made, used on later calls only when
   * the principal has no self-hosted AuthUser to read them from live (a delegating identity
   * provider's role claim cannot be re-read without a token). Team roles are always read live.
   */
  roles?: string[];
  /** Epoch ms after which the session is refused (the run's deadline plus the grace). */
  exp: number;
}

export function isJoinLinkPayload(value: unknown): value is JoinLinkPayload {
  const v = value as Partial<JoinLinkPayload> | null;
  return (
    !!v &&
    typeof v === "object" &&
    v.kind === "run-join" &&
    typeof v.runId === "string" &&
    typeof v.principalId === "string" &&
    typeof v.exp === "number" &&
    (v.aud === "stdio" || v.aud === "http") &&
    (v.operator === undefined || typeof v.operator === "boolean") &&
    // The operator flag belongs to stdio only; the owner-all flag to HTTP only.
    !(v.aud === "http" && v.operator !== undefined) &&
    (v.ownerAll === undefined || (v.ownerAll === true && v.aud === "http")) &&
    (v.roles === undefined ||
      (v.ownerAll === true &&
        Array.isArray(v.roles) &&
        v.roles.length <= 32 &&
        v.roles.every((role) => typeof role === "string" && role.length <= 64)))
  );
}

/** Builds the link `<origin>/join#<token>`. */
export function joinLink(origin: string, token: string): string {
  return `${new URL(origin).origin}${JOIN_LINK_PATH}#${token}`;
}

/** The origin and token of a pasted join link, or null when it is not one. */
export function parseJoinLink(link: string): { origin: string; token: string } | null {
  if (!URL.canParse(link)) return null;
  const url = new URL(link);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== JOIN_LINK_PATH || url.search !== "") return null;
  const token = url.hash.slice(1);
  if (token === "") return null;
  return { origin: url.origin, token };
}

/**
 * When a join session made now must end: the run's deadline (its start plus its timeout) plus the
 * grace, capped at JOIN_LINK_MAX_MS from now. A run with no start time yet counts from now.
 */
export function joinSessionExpiry(now: number, startedAt: Date | null, timeoutSec: number): number {
  const deadline = (startedAt?.getTime() ?? now) + timeoutSec * 1000;
  return Math.min(deadline + JOIN_LINK_GRACE_MS, now + JOIN_LINK_MAX_MS);
}
