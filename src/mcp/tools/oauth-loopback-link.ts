/**
 * The loopback link `create_secret` returns for `oauth.callback: "loopback"`: a short-lived signed
 * capability (the MCP server's requestState codec, so HMAC + expiry, as get_run_transcript's link)
 * naming one principal, one secret name and what to connect. `wardby secret connect <link>` runs on
 * the owner's machine, catches the provider's redirect on 127.0.0.1 and hands the code to wardby.
 *
 * The link is `<origin>/oauth/loopback#<token>`: the token sits in the URL fragment, so pasting the
 * link into a browser sends nothing to any server. The CLI parses origin and token out of it and
 * sends the token only as `Authorization: Bearer` to the loopback routes; it never requests the
 * link as a URL. The token is a bearer capability: nothing here logs it, and no refusal echoes it.
 */
import type { RunTranscriptLinkAudience } from "./run-transcript-download.js";

/** The path of the link (never requested: the token is in its fragment). */
export const OAUTH_LOOPBACK_LINK_PATH = "/oauth/loopback";
/** How long a loopback link works: the requestState codec's own TTL. */
export const OAUTH_LOOPBACK_LINK_TTL_MS = 10 * 60_000;
/** The command `create_secret` hands out; the link follows as one single-quoted argument. */
export const OAUTH_LOOPBACK_COMMAND = "npx @wardby/cli@latest secret connect";

/**
 * Which host minted the link and is the only one that accepts it, as transcript links: a stdio
 * link (which may carry the operator flag) is never accepted over HTTP, and vice versa.
 */
export type OAuthLoopbackLinkAudience = RunTranscriptLinkAudience;

export interface OAuthLoopbackLinkPayload {
  kind: "oauth-loopback";
  /** The owner: the only principal the connect runs for, and who must confirm the code. */
  principalId: string;
  /** The secret's name. */
  name: string;
  /** The OAuth-protected resource, normalised (precheckOAuthSecretConnect). */
  resource: string;
  scope?: string;
  clientId?: string;
  aud: OAuthLoopbackLinkAudience;
  /** The stdio local operator. Only ever on a stdio link. */
  operator?: boolean;
  /** Epoch ms after which the link is refused. */
  exp: number;
}

const optionalString = (v: unknown) => v === undefined || (typeof v === "string" && v.length > 0);

export function isOAuthLoopbackLinkPayload(value: unknown): value is OAuthLoopbackLinkPayload {
  const v = value as Partial<OAuthLoopbackLinkPayload> | null;
  return (
    !!v &&
    typeof v === "object" &&
    v.kind === "oauth-loopback" &&
    typeof v.principalId === "string" &&
    typeof v.name === "string" &&
    typeof v.resource === "string" &&
    optionalString(v.scope) &&
    optionalString(v.clientId) &&
    typeof v.exp === "number" &&
    (v.aud === "stdio" || v.aud === "http") &&
    (v.operator === undefined || typeof v.operator === "boolean") &&
    // The operator flag belongs to stdio only.
    !(v.aud === "http" && v.operator !== undefined)
  );
}

/** Mints the token and builds the link `<origin>/oauth/loopback#<token>`. */
export async function mintOAuthLoopbackLink(
  mint: (payload: OAuthLoopbackLinkPayload) => Promise<string>,
  origin: string,
  payload: OAuthLoopbackLinkPayload,
): Promise<string> {
  return `${new URL(origin).origin}${OAUTH_LOOPBACK_LINK_PATH}#${await mint(payload)}`;
}

/** The single-quoted shell command for a link (a link never contains a quote). */
export function oauthLoopbackCommand(link: string): string {
  if (link.includes("'")) throw new Error("oauth loopback link: unexpected character");
  return `${OAUTH_LOOPBACK_COMMAND} '${link}'`;
}

export type OAuthLoopbackLinkRefusal = "link_invalid";

/**
 * Checks a presented token: signature and codec expiry (`verify`), shape, audience, and `exp`.
 * Returns the payload, or `link_invalid` for every refusal (one fixed code, no detail, never the token).
 */
export async function verifyOAuthLoopbackLink(
  token: string | null | undefined,
  deps: {
    verify: (token: string) => Promise<unknown>;
    /** The host checking the link: only links minted for it are accepted. */
    audience: OAuthLoopbackLinkAudience;
    now?: () => Date;
  },
): Promise<{ ok: true; payload: OAuthLoopbackLinkPayload } | { ok: false; error: OAuthLoopbackLinkRefusal }> {
  const now = (deps.now ?? (() => new Date()))();
  let payload: unknown;
  try {
    if (!token) throw new Error("missing");
    payload = await deps.verify(token);
  } catch {
    return { ok: false, error: "link_invalid" };
  }
  if (!isOAuthLoopbackLinkPayload(payload) || payload.aud !== deps.audience || payload.exp <= now.getTime()) {
    return { ok: false, error: "link_invalid" };
  }
  return { ok: true, payload };
}

/**
 * Splits a loopback link into the origin to call and the token, or null when it is not one:
 * http(s), no userinfo, exactly the link path, no query, a non-empty fragment.
 */
export function parseOAuthLoopbackLink(link: string): { origin: string; token: string } | null {
  if (!URL.canParse(link)) return null;
  const url = new URL(link);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== OAUTH_LOOPBACK_LINK_PATH || url.search !== "") return null;
  const token = url.hash.slice(1);
  if (token === "") return null;
  return { origin: url.origin, token };
}
