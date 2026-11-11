/**
 * The shared browser OAuth link flow: a wardby principal signs in to a
 * provider in a browser and proves it is the same person at the keyboard.
 * Generalised from the GitHub account link; each kind of link is an
 * OAuthLinkAdapter keyed by `purpose`.
 *
 *  1. startOAuthLink: a single-use OAuth state and a PKCE verifier are stored
 *     (the state only as a hash) for 10 minutes; the caller gets the
 *     provider's authorize URL.
 *  2. completeOAuthCallback: the provider redirects the browser back with the
 *     state; it is consumed atomically, the adapter exchanges the code, any
 *     secret payload is encrypted, and a one-time confirmation code is shown
 *     in the browser.
 *  3. confirmOAuthLink: the SAME principal that started the link submits the
 *     code (at most 5 tries). Only then does `finish` run, in the same
 *     Serializable transaction that consumes the request.
 *
 * Step 3 stops an attacker from sending a victim an authorize URL: the code is
 * shown only in the victim's browser. Secret values never reach a log: only
 * `{ purpose }` is logged on failure.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Prisma, type PrismaClient } from "#prisma";
import type { SecretCipher } from "../providers/secrets/types.js";
import { logger } from "./logger.js";

const log = logger.child({ module: "oauth-link" });

export const OAUTH_LINK_TTL_MS = 10 * 60_000;
export const OAUTH_LINK_MAX_ATTEMPTS = 5;
export const OAUTH_LINK_MAX_PENDING = 5;
export const OAUTH_CALLBACK_PATH = "/oauth/callback";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CODE_LENGTH = 8;

export class OAuthLinkError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 429 | 502,
    message: string,
  ) {
    super(message);
    this.name = "OAuthLinkError";
  }
}

/** What one kind of link does at each end. Context, result and payload are the adapter's own. */
export interface OAuthLinkAdapter<Ctx, Result> {
  readonly purpose: string;
  /** The provider's authorize URL for this request. */
  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string; context: Ctx }): string;
  /** At the callback: exchanges the code. `payload` (optional) is encrypted before it is stored. */
  complete(input: { code: string; codeVerifier: string; redirectUri: string; context: Ctx }): Promise<{
    result: Result;
    payload?: string;
  }>;
  /** Shown on the callback page: what was signed in to, never a token. */
  describe(result: Result): { signedInAs: string; target: string; tool: string };
}

export type OAuthLinkDb = Pick<PrismaClient, "oAuthLinkRequest" | "$transaction">;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function confirmationCode(): string {
  // 5 bits per character from a uniformly random byte's low bits (256 % 32 === 0: no bias).
  return [...randomBytes(CODE_LENGTH)].map((b) => BASE32[b & 31]).join("");
}

export async function startOAuthLink<Ctx>(input: {
  db: OAuthLinkDb;
  adapter: OAuthLinkAdapter<Ctx, unknown>;
  principalId: string;
  context: Ctx;
  redirectUri: string;
  now?: Date;
}): Promise<{ authorizeUrl: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const purpose = input.adapter.purpose;
  await input.db.oAuthLinkRequest.deleteMany({ where: { expiresAt: { lte: now } } });
  const pending = await input.db.oAuthLinkRequest.count({ where: { principalId: input.principalId, purpose } });
  if (pending >= OAUTH_LINK_MAX_PENDING) {
    throw new OAuthLinkError(429, "Too many sign-ins in progress; finish one or wait 10 minutes.");
  }
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const expiresAt = new Date(now.getTime() + OAUTH_LINK_TTL_MS);
  await input.db.oAuthLinkRequest.create({
    data: {
      principalId: input.principalId,
      purpose,
      context: input.context ?? {},
      stateHash: sha256(state),
      codeVerifier,
      expiresAt,
    },
  });
  return {
    authorizeUrl: input.adapter.authorizeUrl({
      state,
      codeChallenge,
      redirectUri: input.redirectUri,
      context: input.context,
    }),
    expiresAt,
  };
}

export type OAuthCallbackOutcome =
  | { kind: "confirm"; code: string; signedInAs: string; target: string; tool: string; subject: string }
  /** Unknown, used, or expired state: nothing was sent to the provider. */
  | { kind: "invalid" }
  /** The provider refused the exchange; the request is spent. */
  | { kind: "failed" };

export async function completeOAuthCallback(input: {
  db: Pick<PrismaClient, "oAuthLinkRequest">;
  adapters: ReadonlyMap<string, OAuthLinkAdapter<unknown, unknown>>;
  cipher: Pick<SecretCipher, "encrypt">;
  state: string | null;
  code: string | null;
  redirectUri: string;
  now?: Date;
}): Promise<OAuthCallbackOutcome> {
  const now = input.now ?? new Date();
  if (!input.state || !input.code || input.state.length > 256 || input.code.length > 256) return { kind: "invalid" };
  const stateHash = sha256(input.state);
  // Single use: only the first callback for a live state wins.
  const { count } = await input.db.oAuthLinkRequest.updateMany({
    where: { stateHash, callbackAt: null, expiresAt: { gt: now } },
    data: { callbackAt: now },
  });
  if (count !== 1) return { kind: "invalid" };
  const request = await input.db.oAuthLinkRequest.findUnique({
    where: { stateHash },
    include: { principal: { select: { subject: true } } },
  });
  if (!request) return { kind: "invalid" };
  const adapter = input.adapters.get(request.purpose);
  if (!adapter) return { kind: "invalid" };

  // Everything after the provider has been asked fails closed: the request is
  // spent (its verifier with it) and the route sees `failed`, never a raw error.
  try {
    const done = await adapter.complete({
      code: input.code,
      codeVerifier: request.codeVerifier,
      redirectUri: input.redirectUri,
      context: request.context,
    });
    const code = confirmationCode();
    const payloadCiphertext = done.payload ? await input.cipher.encrypt(done.payload) : null;
    const described = adapter.describe(done.result);
    await input.db.oAuthLinkRequest.update({
      where: { id: request.id },
      data: {
        result: done.result as Prisma.InputJsonValue,
        payloadCiphertext,
        confirmHash: sha256(code),
        // The verifier has done its job; keep nothing reusable.
        codeVerifier: "",
      },
    });
    return {
      kind: "confirm",
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      ...described,
      subject: request.principal.subject,
    };
  } catch {
    // Never log the error: an adapter's or a KMS message may echo a token.
    log.warn({ purpose: request.purpose }, "oauth link: the callback failed; the request is spent");
    await input.db.oAuthLinkRequest.delete({ where: { id: request.id } }).catch(() => undefined);
    return { kind: "failed" };
  }
}

/** Checks the code for the principal's newest pending request of `purpose`, consumes it, then runs `finish` in the same transaction. */
export async function confirmOAuthLink<Result, P, T>(input: {
  db: OAuthLinkDb;
  purpose: string;
  principalId: string;
  confirmationCode: string;
  cipher: Pick<SecretCipher, "decrypt">;
  /** Runs after the code is right and before the transaction opens, so slow work never holds it. */
  prepare?: (done: { result: Result; payload: string | undefined; context: unknown }) => Promise<P>;
  finish: (
    tx: Prisma.TransactionClient,
    done: { result: Result; payload: string | undefined; context: unknown },
    prepared: P | undefined,
  ) => Promise<T>;
  /** Wording for "no pending link" and "used up", so each tool keeps its own text. */
  messages: { noPending: string; usedUp: string };
  /** Narrows which pending request: e.g. the OAuth secret's name. */
  contextMatch?: (context: unknown) => boolean;
  now?: Date;
}): Promise<T> {
  const now = input.now ?? new Date();
  const code = input.confirmationCode.toUpperCase().replace(/[\s-]/g, "");
  if (!new RegExp(`^[${BASE32}]{${CODE_LENGTH}}$`).test(code)) {
    throw new OAuthLinkError(400, "The confirmation code is 8 letters and digits, as shown on the page (XXXX-XXXX).");
  }
  const candidates = await input.db.oAuthLinkRequest.findMany({
    where: {
      principalId: input.principalId,
      purpose: input.purpose,
      confirmHash: { not: null },
      attempts: { lt: OAUTH_LINK_MAX_ATTEMPTS },
      expiresAt: { gt: now },
    },
    orderBy: { callbackAt: "desc" },
  });
  const request = candidates.find((c) => !input.contextMatch || input.contextMatch(c.context));
  if (!request?.confirmHash) throw new OAuthLinkError(404, input.messages.noPending);
  // Spend an attempt BEFORE comparing, atomically: concurrent guesses can't
  // each get a comparison before the counter saturates.
  const claimed = await input.db.oAuthLinkRequest.updateMany({
    where: { id: request.id, attempts: { lt: OAUTH_LINK_MAX_ATTEMPTS }, expiresAt: { gt: now } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new OAuthLinkError(404, input.messages.noPending);
  const presented = Buffer.from(sha256(code), "hex");
  const expected = Buffer.from(request.confirmHash, "hex");
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
    const after = await input.db.oAuthLinkRequest.findUnique({ where: { id: request.id } });
    const left = Math.max(0, OAUTH_LINK_MAX_ATTEMPTS - (after?.attempts ?? OAUTH_LINK_MAX_ATTEMPTS));
    throw new OAuthLinkError(
      400,
      left > 0
        ? `That confirmation code is not right; ${left} attempt${left === 1 ? "" : "s"} left.`
        : input.messages.usedUp,
    );
  }
  const payload = request.payloadCiphertext ? await input.cipher.decrypt(request.payloadCiphertext) : undefined;
  const done = { result: request.result as Result, payload, context: request.context as unknown };
  const prepared = input.prepare ? await input.prepare(done) : undefined;
  return input.db.$transaction(
    async (tx) => {
      // Consume the request first: a concurrent confirmation of the same code loses here.
      // (Its attempt was already spent above, so attempts may now equal the limit.)
      const consumed = await tx.oAuthLinkRequest.deleteMany({ where: { id: request.id, expiresAt: { gt: now } } });
      if (consumed.count !== 1) throw new OAuthLinkError(404, "This link attempt is no longer valid; start again.");
      return input.finish(tx, done, prepared);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
