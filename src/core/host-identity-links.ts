/**
 * Linking a wardby principal to its verified host identity (GitHub today), on
 * the shared OAuth link flow (core/oauth-link.ts): this module is its adapter
 * plus the host-specific last step.
 *
 *  1. startHostIdentityLink: the host's authorize URL, with a single-use
 *     state and a PKCE challenge.
 *  2. completeHostIdentityCallback: the host redirects the browser back; the
 *     code is exchanged (the user token is revoked at once by the authorizer)
 *     and a one-time confirmation code is shown to the person in the browser.
 *  3. confirmHostIdentityLink: the SAME principal that started the link
 *     submits the code (at most 5 tries). Only then is the identity stored.
 *
 * Step 3 is what stops an attacker from sending a victim their own authorize
 * URL: the host skips its consent screen for users who already authorized the
 * App, so one click would otherwise bind the victim's identity to the
 * attacker's principal. The code is shown only in the victim's browser.
 * A host user belongs to at most one principal.
 */
import { Prisma, type PrismaClient } from "#prisma";
import {
  HOST_ACCOUNT_PROVIDERS,
  type HostUserAuthorizer,
  type ReviewHostProvider,
} from "../providers/review-host/types.js";
import {
  completeOAuthCallback,
  confirmOAuthLink,
  OAUTH_CALLBACK_PATH,
  OAuthLinkError,
  startOAuthLink,
  type OAuthLinkAdapter,
} from "./oauth-link.js";

export type HostLinkDb = Pick<PrismaClient, "hostIdentity" | "oAuthLinkRequest" | "$transaction">;

type HostUser = { hostUserId: string; login: string };

export class HostLinkError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 502,
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

/** The shared flow's purpose for a host's account link. */
export function hostIdentityPurpose(provider: ReviewHostProvider): string {
  return `host-identity:${provider}`;
}

/**
 * The callback path a purpose's authorize URL carries: a host account link
 * keeps its App's registered Callback URL (which cannot change); every other
 * purpose uses OAUTH_CALLBACK_PATH.
 */
export function oauthRedirectPath(purpose: string): string {
  const provider = HOST_ACCOUNT_PROVIDERS.find((p) => hostIdentityPurpose(p) === purpose);
  return provider ? userCallbackPath(provider) : OAUTH_CALLBACK_PATH;
}

const PROVIDER_NAMES: Partial<Record<string, string>> = { github: "GitHub" };

export function hostIdentityAdapter(authorizer: HostUserAuthorizer) {
  return {
    purpose: hostIdentityPurpose(authorizer.provider),
    authorizeUrl: ({ state, codeChallenge, redirectUri }) =>
      authorizer.authorizeUrl({ state, codeChallenge, redirectUri }),
    complete: async ({ code, codeVerifier, redirectUri }) => ({
      result: await authorizer.complete({ code, codeVerifier, redirectUri }),
    }),
    describe: (r) => ({
      signedInAs: `@${r.login}`,
      target: PROVIDER_NAMES[authorizer.provider] ?? authorizer.provider,
      tool: "link_host_account",
    }),
  } satisfies OAuthLinkAdapter<{ provider: ReviewHostProvider }, HostUser>;
}

/** Host links carry no secret payload, so their cipher is never asked to work. */
const NO_PAYLOAD = () => Promise.reject(new Error("host account links carry no payload"));

function asHostLinkError(err: unknown): unknown {
  if (!(err instanceof OAuthLinkError)) return err;
  // Keep the account-link wording operators already know.
  if (err.status === 429) {
    return new HostLinkError(429, "Too many account links in progress; finish one or wait 10 minutes.");
  }
  return new HostLinkError(err.status, err.message);
}

export async function startHostIdentityLink(input: {
  db: HostLinkDb;
  authorizer: HostUserAuthorizer;
  principalId: string;
  redirectUri: string;
  now?: Date;
}): Promise<{ authorizeUrl: string; expiresAt: Date }> {
  try {
    return await startOAuthLink({
      db: input.db,
      adapter: hostIdentityAdapter(input.authorizer),
      principalId: input.principalId,
      context: { provider: input.authorizer.provider },
      redirectUri: input.redirectUri,
      now: input.now,
    });
  } catch (err) {
    throw asHostLinkError(err);
  }
}

export type CallbackOutcome =
  | { kind: "confirm"; code: string; login: string; subject: string }
  /** Unknown, used, or expired state: nothing was sent to the host. */
  | { kind: "invalid" }
  /** The host refused the exchange or the user lookup; the request is spent. */
  | { kind: "failed" };

export async function completeHostIdentityCallback(input: {
  db: Pick<PrismaClient, "oAuthLinkRequest">;
  authorizer: HostUserAuthorizer;
  state: string | null;
  code: string | null;
  redirectUri: string;
  now?: Date;
}): Promise<CallbackOutcome> {
  const adapter = hostIdentityAdapter(input.authorizer);
  const outcome = await completeOAuthCallback({
    db: input.db,
    adapters: new Map([[adapter.purpose, adapter]]),
    cipher: { encrypt: NO_PAYLOAD },
    state: input.state,
    code: input.code,
    redirectUri: input.redirectUri,
    now: input.now,
  });
  if (outcome.kind !== "confirm") return outcome;
  // The adapter shows the login as `@login`.
  return { kind: "confirm", code: outcome.code, login: outcome.signedInAs.slice(1), subject: outcome.subject };
}

export async function confirmHostIdentityLink(input: {
  db: HostLinkDb;
  principalId: string;
  provider: ReviewHostProvider;
  confirmationCode: string;
  now?: Date;
}): Promise<HostUser> {
  const now = input.now ?? new Date();
  try {
    return await confirmOAuthLink<HostUser, undefined, HostUser>({
      db: input.db,
      purpose: hostIdentityPurpose(input.provider),
      principalId: input.principalId,
      confirmationCode: input.confirmationCode,
      cipher: { decrypt: NO_PAYLOAD },
      messages: {
        noPending:
          "No account link is waiting for a confirmation code from you. Start again with link_host_account (no code).",
        usedUp:
          "That confirmation code is not right, and this link attempt is used up. Start again with link_host_account.",
      },
      now,
      finish: async (tx, { result: { hostUserId, login } }) => {
        const holder = await tx.hostIdentity.findUnique({
          where: { provider_hostUserId: { provider: input.provider, hostUserId } },
        });
        if (holder && holder.principalId !== input.principalId) throw alreadyLinked();
        await tx.hostIdentity.upsert({
          where: { principalId_provider: { principalId: input.principalId, provider: input.provider } },
          create: { principalId: input.principalId, provider: input.provider, hostUserId, login },
          update: { hostUserId, login, linkedAt: now },
        });
        return { hostUserId, login };
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw alreadyLinked();
    throw asHostLinkError(err);
  }
}

function alreadyLinked(): HostLinkError {
  return new HostLinkError(
    409,
    "That GitHub account is already linked to another wardby account. An operator can unlink it " +
      "(`wardby auth host-account unlink --subject <subject>`) if it should move to you.",
  );
}
