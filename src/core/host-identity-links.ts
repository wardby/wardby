/**
 * Linking a wardby principal to its verified host identity (GitHub today).
 *
 *  1. startHostIdentityLink: a single-use OAuth state and a PKCE verifier are
 *     stored (the state only as a hash) for 10 minutes; the caller gets the
 *     host's authorize URL.
 *  2. completeHostIdentityCallback: the host redirects the browser back with
 *     the state; it is consumed atomically, the code is exchanged (the user
 *     token is revoked at once by the authorizer), and a one-time
 *     confirmation code is shown to the person in the browser.
 *  3. confirmHostIdentityLink: the SAME principal that started the link
 *     submits the code (at most 5 tries). Only then is the identity stored.
 *
 * Step 3 is what stops an attacker from sending a victim their own authorize
 * URL: the host skips its consent screen for users who already authorized the
 * App, so one click would otherwise bind the victim's identity to the
 * attacker's principal. The code is shown only in the victim's browser.
 * A host user belongs to at most one principal.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "#prisma";
import type { HostUserAuthorizer, ReviewHostProvider } from "../providers/review-host/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "host-identity-links" });

export const HOST_LINK_TTL_MS = 10 * 60_000;
export const HOST_LINK_MAX_ATTEMPTS = 5;
export const HOST_LINK_MAX_PENDING = 5;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 8;

export type HostLinkDb = Pick<PrismaClient, "hostIdentity" | "hostIdentityLinkRequest" | "$transaction">;

export class HostLinkError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429,
    message: string,
  ) {
    super(message);
    this.name = "HostLinkError";
  }
}

/** The browser callback a provider's link flow returns to (registered as the App's Callback URL). */
export function userCallbackPath(provider: ReviewHostProvider): string {
  return `/hosts/${provider}/user-callback`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function confirmationCode(): string {
  // 5 bits per character from a uniformly random byte's low bits (256 % 32 === 0: no bias).
  return [...randomBytes(CODE_LENGTH)].map((b) => BASE32[b & 31]).join("");
}

export async function startHostIdentityLink(input: {
  db: HostLinkDb;
  authorizer: HostUserAuthorizer;
  principalId: string;
  redirectUri: string;
  now?: Date;
}): Promise<{ authorizeUrl: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const provider = input.authorizer.provider;
  await input.db.hostIdentityLinkRequest.deleteMany({ where: { expiresAt: { lte: now } } });
  const pending = await input.db.hostIdentityLinkRequest.count({
    where: { principalId: input.principalId, provider },
  });
  if (pending >= HOST_LINK_MAX_PENDING) {
    throw new HostLinkError(429, "Too many account links in progress; finish one or wait 10 minutes.");
  }
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const expiresAt = new Date(now.getTime() + HOST_LINK_TTL_MS);
  await input.db.hostIdentityLinkRequest.create({
    data: { principalId: input.principalId, provider, stateHash: sha256(state), codeVerifier, expiresAt },
  });
  return {
    authorizeUrl: input.authorizer.authorizeUrl({ state, codeChallenge, redirectUri: input.redirectUri }),
    expiresAt,
  };
}

export type CallbackOutcome =
  | { kind: "confirm"; code: string; login: string; subject: string }
  /** Unknown, used, or expired state: nothing was sent to the host. */
  | { kind: "invalid" }
  /** The host refused the exchange or the user lookup; the request is spent. */
  | { kind: "failed" };

export async function completeHostIdentityCallback(input: {
  db: Pick<PrismaClient, "hostIdentityLinkRequest">;
  authorizer: HostUserAuthorizer;
  state: string | null;
  code: string | null;
  redirectUri: string;
  now?: Date;
}): Promise<CallbackOutcome> {
  const now = input.now ?? new Date();
  if (!input.state || !input.code || input.state.length > 256 || input.code.length > 256) return { kind: "invalid" };
  const stateHash = sha256(input.state);
  // Single use: only the first callback for a live state wins.
  const { count } = await input.db.hostIdentityLinkRequest.updateMany({
    where: { stateHash, provider: input.authorizer.provider, callbackAt: null, expiresAt: { gt: now } },
    data: { callbackAt: now },
  });
  if (count !== 1) return { kind: "invalid" };
  const request = await input.db.hostIdentityLinkRequest.findUnique({
    where: { stateHash },
    include: { principal: { select: { subject: true } } },
  });
  if (!request) return { kind: "invalid" };

  let user: { hostUserId: string; login: string };
  try {
    user = await input.authorizer.complete({
      code: input.code,
      codeVerifier: request.codeVerifier,
      redirectUri: input.redirectUri,
    });
  } catch (err) {
    log.warn({ err, provider: request.provider }, "host account link: the host refused the authorization");
    await input.db.hostIdentityLinkRequest.delete({ where: { id: request.id } }).catch(() => undefined);
    return { kind: "failed" };
  }
  const code = confirmationCode();
  await input.db.hostIdentityLinkRequest.update({
    where: { id: request.id },
    // The verifier has done its job; keep nothing reusable.
    data: { hostUserId: user.hostUserId, login: user.login, confirmHash: sha256(code), codeVerifier: "" },
  });
  return {
    kind: "confirm",
    code: `${code.slice(0, 4)}-${code.slice(4)}`,
    login: user.login,
    subject: request.principal.subject,
  };
}

export async function confirmHostIdentityLink(input: {
  db: HostLinkDb;
  principalId: string;
  provider: ReviewHostProvider;
  confirmationCode: string;
  now?: Date;
}): Promise<{ hostUserId: string; login: string }> {
  const now = input.now ?? new Date();
  const code = input.confirmationCode.toUpperCase().replace(/[\s-]/g, "");
  if (!new RegExp(`^[${BASE32}]{${CODE_LENGTH}}$`).test(code)) {
    throw new HostLinkError(400, "The confirmation code is 8 letters and digits, as shown on the page (XXXX-XXXX).");
  }
  const request = await input.db.hostIdentityLinkRequest.findFirst({
    where: {
      principalId: input.principalId,
      provider: input.provider,
      confirmHash: { not: null },
      hostUserId: { not: null },
      login: { not: null },
      attempts: { lt: HOST_LINK_MAX_ATTEMPTS },
      expiresAt: { gt: now },
    },
    orderBy: { callbackAt: "desc" },
  });
  if (!request?.confirmHash || !request.hostUserId || !request.login) {
    throw new HostLinkError(
      404,
      "No account link is waiting for a confirmation code from you. Start again with link_host_account (no code).",
    );
  }
  const presented = Buffer.from(sha256(code), "hex");
  const expected = Buffer.from(request.confirmHash, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    await input.db.hostIdentityLinkRequest.updateMany({
      where: { id: request.id, attempts: { lt: HOST_LINK_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    const left = HOST_LINK_MAX_ATTEMPTS - request.attempts - 1;
    throw new HostLinkError(
      400,
      left > 0
        ? `That confirmation code is not right; ${left} attempt${left === 1 ? "" : "s"} left.`
        : "That confirmation code is not right, and this link attempt is used up. Start again with link_host_account.",
    );
  }
  const hostUserId = request.hostUserId;
  const login = request.login;
  try {
    await input.db.$transaction(
      async (tx) => {
        // Consume the request first: a concurrent confirmation of the same code loses here.
        const consumed = await tx.hostIdentityLinkRequest.deleteMany({
          where: { id: request.id, attempts: { lt: HOST_LINK_MAX_ATTEMPTS }, expiresAt: { gt: now } },
        });
        if (consumed.count !== 1) throw new HostLinkError(404, "This link attempt is no longer valid; start again.");
        const holder = await tx.hostIdentity.findUnique({
          where: { provider_hostUserId: { provider: input.provider, hostUserId } },
        });
        if (holder && holder.principalId !== input.principalId) throw alreadyLinked();
        await tx.hostIdentity.upsert({
          where: { principalId_provider: { principalId: input.principalId, provider: input.provider } },
          create: { principalId: input.principalId, provider: input.provider, hostUserId, login },
          update: { hostUserId, login, linkedAt: now },
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  } catch (err) {
    if (err instanceof HostLinkError) throw err;
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw alreadyLinked();
    throw err;
  }
  return { hostUserId, login };
}

function alreadyLinked(): HostLinkError {
  return new HostLinkError(
    409,
    "That GitHub account is already linked to another wardby account. An operator can unlink it " +
      "(`wardby auth host-account unlink --subject <subject>`) if it should move to you.",
  );
}
