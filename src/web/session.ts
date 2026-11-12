import { createHash, randomBytes } from "node:crypto";
import type { PrismaClient } from "#prisma";
import { readCookie, secureCookies, selfHostedCookieNames } from "../mcp/auth/self-hosted/cookies.js";

/**
 * Browser sessions for the document pages. The token and the CSRF value are
 * 32 random bytes each (base64url); only their sha256 hex digests are stored.
 * Neither value is ever logged: the token travels only in the Set-Cookie
 * header, the CSRF value only in the page bootstrap JSON.
 */
export const WEB_IDLE_MS = 12 * 60 * 60 * 1000;
export const WEB_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export interface WebCookieOptions {
  /** Secure `__Host-wardby-web` cookie (https) or dev `wardby-dev-web` (http). */
  secure: boolean;
}

/** Same dev/secure rule as the self-hosted login pages. */
export function webCookieOptions(canonicalUri: string): WebCookieOptions {
  return { secure: secureCookies(canonicalUri) };
}

const SECURE: WebCookieOptions = { secure: true };
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export interface WebSessionView {
  id: string;
  principalId?: string;
  guestId?: string;
  shareLinkId?: string;
  csrfHash: string;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieName = (o: WebCookieOptions) => (o.secure ? "__Host-wardby-web" : "wardby-dev-web");
const setCookie = (o: WebCookieOptions, value: string, maxAgeSeconds: number) =>
  `${cookieName(o)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${o.secure ? "; Secure" : ""}`;

function tokenFrom(cookieHeader: string | undefined, o: WebCookieOptions): string | null {
  const token = readCookie(cookieHeader, cookieName(o));
  return token && TOKEN.test(token) ? token : null;
}

export async function createWebSession(
  db: PrismaClient,
  owner: { principalId?: string; guestId?: string; shareLinkId?: string },
  options: WebCookieOptions = SECURE,
): Promise<{ token: string; csrf: string; cookie: string }> {
  if (!owner.principalId && !owner.guestId) throw new Error("web session needs a principal or a guest");
  const token = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const now = Date.now();
  await db.webSession.create({
    data: {
      tokenHash: sha256(token),
      csrfHash: sha256(csrf),
      principalId: owner.principalId ?? null,
      guestId: owner.guestId ?? null,
      shareLinkId: owner.shareLinkId ?? null,
      expiresAt: new Date(now + WEB_MAX_MS),
      lastSeenAt: new Date(now),
    },
  });
  return { token, csrf, cookie: setCookie(options, token, WEB_MAX_MS / 1000) };
}

/** The live session for this Cookie header, or null (missing, unknown, expired or idle). */
export async function readWebSession(
  db: PrismaClient,
  cookieHeader: string | undefined,
  options: WebCookieOptions = SECURE,
): Promise<WebSessionView | null> {
  const token = tokenFrom(cookieHeader, options);
  if (!token) return null;
  const tokenHash = sha256(token);
  const now = new Date();
  // Refresh and liveness check in one statement, so an idle or expired
  // session can never be revived by a concurrent read.
  const live = await db.webSession.updateMany({
    where: { tokenHash, expiresAt: { gt: now }, lastSeenAt: { gt: new Date(now.getTime() - WEB_IDLE_MS) } },
    data: { lastSeenAt: now },
  });
  if (live.count !== 1) return null;
  const row = await db.webSession.findUnique({ where: { tokenHash } });
  if (!row) return null;
  return {
    id: row.id,
    ...(row.principalId ? { principalId: row.principalId } : {}),
    ...(row.guestId ? { guestId: row.guestId } : {}),
    ...(row.shareLinkId ? { shareLinkId: row.shareLinkId } : {}),
    csrfHash: row.csrfHash,
  };
}

/** Deletes the session (if any) and returns a Set-Cookie value that clears it. */
export async function endWebSession(
  db: PrismaClient,
  cookieHeader: string | undefined,
  options: WebCookieOptions = SECURE,
): Promise<string> {
  const token = tokenFrom(cookieHeader, options);
  if (token) await db.webSession.deleteMany({ where: { tokenHash: sha256(token) } });
  return setCookie(options, "", 0);
}

/** The parts of the self-hosted auth provider the bridge reads. */
export interface SelfHostedSessionSource {
  config: { canonicalUri: string };
  sessions: { get(token: string): Promise<{ user: { principalId: string } }> };
}

/**
 * The principal id behind an existing self-hosted login cookie, or null. It
 * validates through `Sessions.get` (which enforces revocation, expiry, the
 * user's status and the 12 h idle window) and never mints anything.
 */
export async function bridgeSelfHostedSession(
  _db: PrismaClient,
  selfHosted: SelfHostedSessionSource,
  cookieHeader: string | undefined,
): Promise<string | null> {
  const token = readCookie(cookieHeader, selfHostedCookieNames(selfHosted.config.canonicalUri).session);
  if (!token) return null;
  try {
    return (await selfHosted.sessions.get(token)).user.principalId;
  } catch {
    return null;
  }
}
