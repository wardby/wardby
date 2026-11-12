/**
 * OAuth secrets: a brokered Secret whose value is an OAuth access token, got by
 * signing in to the provider of an OAuth-protected resource (an MCP server).
 * Connecting runs through the shared OAuth link flow (core/oauth-link.ts) with
 * purpose OAUTH_SECRET_PURPOSE, and speaks OAuth only through
 * core/oauth-client:
 *
 *  1. startOAuthSecretConnect: discovers the resource's OAuth metadata,
 *     registers a client when none is given, and starts a link request whose
 *     context holds only non-secret metadata (a registered client secret is
 *     kept there as ciphertext).
 *  2. The callback (oauthSecretAdapter.complete): exchanges the code; the
 *     token payload is encrypted by the shared flow before it is stored.
 *  3. finishOAuthSecretConnect: the same owner confirms the code; the tokens
 *     become the Secret's ciphertext (encrypted before the transaction), and
 *     the row, its broker config and an audit row are written in one
 *     transaction. A reconnect updates the row in place, so attachments stay.
 *  4. currentOAuthPayload (through secrets.ts decryptEntry): the stored tokens, refreshed first
 *     under a row lock when the access token is due, or when a caller saw it refused.
 *
 * Secret values (tokens, a client secret) are never in the `oauth` JSON, the
 * link request's context or result, an error message, or a log line.
 */
import { z } from "zod";
import { Prisma, type PrismaClient } from "#prisma";
import type { SecretCipher } from "../providers/secrets/types.js";
import { boundedString } from "../sandbox/bounded-json.js";
import type { safeFetch, SafeFetchOptions } from "../sandbox/safe-fetch.js";
import { normaliseServerUrl } from "./resource-url.js";
import { discoverOAuth } from "./oauth-client/discovery.js";
import { isAllowedEndpoint, OAuthProtocolError } from "./oauth-client/http.js";
import {
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  registerClient,
  revokeToken,
  type OAuthClient,
  type OAuthTokens,
} from "./oauth-client/tokens.js";
import { logger } from "./logger.js";
import { confirmOAuthLink, startOAuthLink, type OAuthLinkAdapter, type OAuthLinkDb } from "./oauth-link.js";
import { parseSecretBrokerConfig, type SecretBrokerConfig } from "./secret-broker-config.js";

export const OAUTH_SECRET_PURPOSE = "oauth-secret";
export const SECRET_OAUTH_MANAGED =
  "secret_oauth_managed: this secret is managed by its OAuth connection; connect again with create_secret and oauth";
export const SECRET_REAUTH_REQUIRED = (name: string) =>
  `secret_reauth_required: secret "${name}" needs connecting again (create_secret with oauth)`;
export const SECRET_OAUTH_DISCOVERY_FAILED =
  "secret_oauth_discovery_failed: the resource has no usable OAuth metadata (it needs protected-resource and authorization-server metadata with PKCE S256)";
/** The counterpart of SECRET_OAUTH_MANAGED: connecting under a name a non-OAuth secret already uses. */
export const SECRET_NOT_OAUTH =
  "secret_oauth_name_taken: a secret with this name already exists and is not an OAuth secret; choose another name";
export const SECRET_OAUTH_CLIENT_ID_REQUIRED =
  "secret_oauth_client_id_required: the provider does not offer dynamic client registration; pass oauth.clientId (a client registered with the provider)";
/** The resource is not a URL wardby can connect to and send a token to. */
export const SECRET_OAUTH_RESOURCE_INVALID =
  "secret_oauth_resource_invalid: the OAuth resource must be an https URL with a host name";
/** A name, scope or clientId over its length limit. */
export const SECRET_OAUTH_INPUT_TOO_LONG =
  "secret_oauth_input_too_long: the secret name, oauth.scope or oauth.clientId is too long";
/** Any cipher (KMS) failure on the OAuth path; the cause's text is never carried. */
export const SECRET_OAUTH_CIPHER_FAILED =
  "secret_oauth_encryption_failed: the OAuth secret could not be encrypted or decrypted; try again";

/** Connecting (discovery, registration, start or finish) could not reach the provider: nothing changed. */
export const SECRET_OAUTH_PROVIDER_UNAVAILABLE =
  "secret_oauth_provider_unavailable: the OAuth provider could not be reached; try again";
/** A refresh the provider could not answer (network, 5xx, 429), or the store failed: nothing changed. */
export const SECRET_OAUTH_REFRESH_UNAVAILABLE =
  "secret_oauth_refresh_unavailable: the OAuth provider could not be reached to refresh the token; try again";
/** A refresh the provider answered with something unusable: nothing changed. */
export const SECRET_OAUTH_REFRESH_FAILED =
  "secret_oauth_refresh_failed: the OAuth provider did not refresh the token; try again, or connect again with create_secret and oauth";

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;
/** The token request's own limit; the transaction holding the row lock allows a little more. */
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_TRANSACTION_TIMEOUT_MS = 20_000;
/** How long a caller waits for another caller's row lock before giving up (retryable). */
const REFRESH_LOCK_TIMEOUT = "4s";
/** Kept free at the end of the transaction, so a refreshed (rotated) token is always committed. */
const REFRESH_COMMIT_MARGIN_MS = 3_000;
/** A token request given less time than this is not sent. */
const REFRESH_MIN_REQUEST_MS = 3_000;

const log = logger.child({ module: "oauth-secrets" });

export interface OAuthSecretMeta {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  /** How the token endpoint authenticates the client; absent for a client the owner gave. */
  authMethod?: (typeof AUTH_METHODS)[number];
  /** The requested scope, space-separated. */
  scope?: string;
  /** ISO time the access token expires; null when the provider gave none. */
  expiresAt: string | null;
  status: "connected" | "reauth_required";
  connectedAt: string;
  /**
   * A fixed code, never provider text. `expired`: past expiresAt with no refresh token. `rejected`:
   * the resource refused (401) the access token before its expiry, and there is no refresh token.
   */
  reauthReason?: ReauthReason;
}

type ReauthReason = "invalid_grant" | "invalid_client" | "expired" | "rejected";

/** The `oauth` JSON of a Secret: what is not secret about the connection. */
export const OAuthSecretMetaSchema: z.ZodType<OAuthSecretMeta> = z
  .object({
    resource: z.string(),
    issuer: z.string(),
    authorizationEndpoint: z.string(),
    tokenEndpoint: z.string(),
    revocationEndpoint: z.string().optional(),
    clientId: z.string(),
    authMethod: z.enum(AUTH_METHODS).optional(),
    scope: z.string().optional(),
    expiresAt: z.string().nullable(),
    status: z.enum(["connected", "reauth_required"]),
    connectedAt: z.string(),
    reauthReason: z.enum(["invalid_grant", "invalid_client", "expired", "rejected"]).optional(),
  })
  .strict();

/** Ciphertext JSON of an OAuth secret. */
export interface OAuthSecretPayload {
  accessToken: string;
  refreshToken?: string;
  clientSecret?: string;
}

const PayloadSchema: z.ZodType<OAuthSecretPayload> = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    clientSecret: z.string().min(1).optional(),
  })
  .strict();

const ContextSchema = z
  .object({
    ownerId: z.string(),
    name: z.string(),
    meta: z
      .object({
        resource: z.string(),
        issuer: z.string(),
        authorizationEndpoint: z.string(),
        tokenEndpoint: z.string(),
        registrationEndpoint: z.string().optional(),
        revocationEndpoint: z.string().optional(),
        scopesSupported: z.array(z.string()).optional(),
      })
      .strict(),
    client: z.object({ clientId: z.string(), authMethod: z.enum(AUTH_METHODS).optional() }).strict(),
    /** A registered client secret, encrypted: the context is stored as plain JSON. */
    clientSecretCiphertext: z.string().optional(),
    scope: z.string().optional(),
  })
  .strict();

/** The link request's context for an OAuth secret. Holds no secret value in the clear. */
export type OAuthSecretContext = z.infer<typeof ContextSchema>;

/** The link request's result: shown on the callback page and carried to the confirm. */
export interface OAuthSecretResult {
  resourceHost: string;
  name: string;
  expiresAt: string | null;
  scope?: string;
}

/** A failure with a fixed reason and message, safe to log and to return. It never has a cause. */
export class OAuthSecretFlowError extends Error {
  constructor(
    readonly reason:
      | "issuer_mismatch"
      | "bad_context"
      | "cipher_failed"
      | "reauth_required"
      | "refresh_unavailable"
      | "refresh_failed",
    message: string,
    /** Trying the same call again may work: nothing about the secret changed. */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OAuthSecretFlowError";
  }
}

function cipherFailed(): OAuthSecretFlowError {
  return new OAuthSecretFlowError("cipher_failed", SECRET_OAUTH_CIPHER_FAILED, true);
}

function reauthRequired(name: string): OAuthSecretFlowError {
  return new OAuthSecretFlowError("reauth_required", SECRET_REAUTH_REQUIRED(name));
}

async function encrypt(cipher: Pick<SecretCipher, "encrypt">, plaintext: string): Promise<string> {
  try {
    return await cipher.encrypt(plaintext);
  } catch {
    // The cause may echo the plaintext or KMS detail: never carried.
    throw cipherFailed();
  }
}

async function decrypt(cipher: Pick<SecretCipher, "decrypt">, ciphertext: string): Promise<string> {
  try {
    return await cipher.decrypt(ciphertext);
  } catch {
    throw cipherFailed();
  }
}

function parseContext(context: unknown): OAuthSecretContext {
  const parsed = ContextSchema.safeParse(context);
  if (!parsed.success)
    throw new OAuthSecretFlowError("bad_context", "This sign-in's request is not valid; start again.");
  return parsed.data;
}

/** The broker config Wardby sets on an OAuth secret: the access token as a Bearer header to the resource's host. */
export function oauthBroker(resource: string): SecretBrokerConfig {
  return {
    hosts: [new URL(resource).hostname.toLowerCase()],
    placement: { kind: "header", name: "authorization", format: "Bearer {value}" },
  };
}

/**
 * The MCP server URL rules (normaliseServerUrl). The one other form is an http URL that
 * isAllowedEndpoint (the OAuth client's own scheme rule: no userinfo, host in the operator's
 * `privateHostAllowlist`) permits, with no fragment. The broker is validated separately.
 */
function normaliseResource(raw: string, options: SafeFetchOptions): string {
  if (URL.canParse(raw)) {
    const url = new URL(raw);
    if (url.protocol === "http:" && url.hash === "" && isAllowedEndpoint(raw, options)) return url.href;
  }
  return normaliseServerUrl(raw);
}

/** The broker for a resource, always validated (an IP-literal or otherwise unsendable host is refused). */
function validatedBroker(resource: string): SecretBrokerConfig {
  return parseSecretBrokerConfig(oauthBroker(resource));
}

export async function startOAuthSecretConnect(input: {
  db: OAuthLinkDb & Pick<PrismaClient, "secret">;
  /** Encrypts a registered client secret into the link request's context. */
  cipher: SecretCipher;
  ownerId: string;
  name: string;
  resource: string;
  scope?: string;
  clientId?: string;
  /** The callback URI for OAUTH_SECRET_PURPOSE (oauthRedirectUri). */
  redirectUri: string;
  /** The fetch policy of the MCP server path; tests allow-list their local fake. */
  options?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
  now?: Date;
}): Promise<{ authorizeUrl: string; expiresAt: Date }> {
  const options = input.options ?? {};
  try {
    boundedString(input.name, 1024);
    if (input.scope !== undefined) boundedString(input.scope, 1024);
    if (input.clientId !== undefined) boundedString(input.clientId, 512);
  } catch {
    throw new Error(SECRET_OAUTH_INPUT_TOO_LONG);
  }
  let resource: string;
  try {
    resource = normaliseResource(input.resource, options);
    // Refuse a host the broker could not send to (an IP address) before asking it anything.
    validatedBroker(resource);
  } catch {
    // Fixed wording: the URL rule's own sentence names the MCP server, not this flow.
    throw new Error(SECRET_OAUTH_RESOURCE_INVALID);
  }

  const existing = await input.db.secret.findUnique({
    where: { ownerId_name: { ownerId: input.ownerId, name: input.name } },
    select: { oauth: true },
  });
  if (existing && existing.oauth === null) throw new Error(SECRET_NOT_OAUTH);

  let meta;
  try {
    meta = await discoverOAuth(resource, options, input.fetchImpl);
  } catch (err) {
    if (err instanceof OAuthProtocolError && err.code === "discovery_failed") {
      // The cause is an OAuthProtocolError, whose message is a fixed sentence: safe to keep.
      throw new Error(SECRET_OAUTH_DISCOVERY_FAILED, { cause: err });
    }
    throw err; // Every OAuthProtocolError message is a fixed sentence.
  }
  // Fail now, not at confirm, on a resource the broker could not send to (e.g. an IP address).
  try {
    validatedBroker(meta.resource);
  } catch {
    throw new Error(SECRET_OAUTH_RESOURCE_INVALID);
  }

  let client: OAuthClient;
  if (input.clientId !== undefined) {
    client = { clientId: input.clientId };
  } else if (!meta.registrationEndpoint) {
    throw new Error(SECRET_OAUTH_CLIENT_ID_REQUIRED);
  } else {
    client = await registerClient(meta, input.redirectUri, options, input.fetchImpl);
  }
  const context: OAuthSecretContext = {
    ownerId: input.ownerId,
    name: input.name,
    meta,
    client: { clientId: client.clientId, ...(client.authMethod ? { authMethod: client.authMethod } : {}) },
    ...(client.clientSecret ? { clientSecretCiphertext: await encrypt(input.cipher, client.clientSecret) } : {}),
    ...(input.scope ? { scope: input.scope } : {}),
  };
  return startOAuthLink({
    db: input.db,
    adapter: oauthSecretAdapter(input.cipher, options, input.fetchImpl),
    principalId: input.ownerId,
    context,
    redirectUri: input.redirectUri,
    now: input.now,
  });
}

export function oauthSecretAdapter(
  cipher: Pick<SecretCipher, "decrypt">,
  options: SafeFetchOptions = {},
  fetchImpl?: typeof safeFetch,
): OAuthLinkAdapter<OAuthSecretContext, OAuthSecretResult> {
  return {
    purpose: OAUTH_SECRET_PURPOSE,
    authorizeUrl: ({ state, codeChallenge, redirectUri, context }) =>
      buildAuthorizeUrl(context.meta, context.client, {
        state,
        codeChallenge,
        redirectUri,
        ...(context.scope ? { scope: context.scope } : {}),
      }),
    complete: async ({ code, codeVerifier, redirectUri, context, iss }) => {
      const ctx = parseContext(context);
      // RFC 9207: when the provider names the issuer, it must be the one discovered.
      if (iss != null && iss !== ctx.meta.issuer) {
        throw new OAuthSecretFlowError("issuer_mismatch", "The sign-in came back from a different issuer.");
      }
      const clientSecret = ctx.clientSecretCiphertext ? await decrypt(cipher, ctx.clientSecretCiphertext) : undefined;
      const tokens = await exchangeCode(
        ctx.meta,
        { ...ctx.client, ...(clientSecret ? { clientSecret } : {}) },
        { code, codeVerifier, redirectUri },
        options,
        fetchImpl,
      );
      const payload: OAuthSecretPayload = {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      };
      const scope = tokens.scope ?? ctx.scope;
      return {
        payload: JSON.stringify(payload),
        result: {
          resourceHost: new URL(ctx.meta.resource).hostname,
          name: ctx.name,
          expiresAt: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
          ...(scope ? { scope } : {}),
        },
      };
    },
    // Only fixed codes: an OAuthProtocolError's code, or this module's own reason.
    safeReason: (err) =>
      err instanceof OAuthProtocolError ? err.code : err instanceof OAuthSecretFlowError ? err.reason : "unknown",
    describe: (r) => ({ target: r.resourceHost, tool: "create_secret" }),
  };
}

interface Prepared {
  ciphertext: string;
  keyId: string;
  broker: SecretBrokerConfig;
  oauth: OAuthSecretMeta;
}

export async function finishOAuthSecretConnect(input: {
  db: OAuthLinkDb;
  cipher: SecretCipher;
  ownerId: string;
  name: string;
  confirmationCode: string;
  now?: Date;
}): Promise<{ name: string; kind: "oauth"; status: "connected"; expiresAt: string | null }> {
  const now = input.now ?? new Date();
  const { ownerId, name, cipher } = input;
  return confirmOAuthLink<OAuthSecretResult, Prepared, Awaited<ReturnType<typeof finishOAuthSecretConnect>>>({
    db: input.db,
    purpose: OAUTH_SECRET_PURPOSE,
    principalId: ownerId,
    confirmationCode: input.confirmationCode,
    cipher: { decrypt: (c) => decrypt(cipher, c) },
    contextMatch: (c) => {
      const ctx = c as Partial<OAuthSecretContext> | null;
      return ctx?.ownerId === ownerId && ctx?.name === name;
    },
    messages: {
      noPending: `No OAuth sign-in for secret "${name}" is waiting for a confirmation code; start again with create_secret and oauth.`,
      usedUp: `That confirmation code is not right and no attempts are left; start again with create_secret and oauth.`,
    },
    now,
    // Runs once, before the transaction: all cipher work happens here.
    prepare: async (done) => {
      const ctx = parseContext(done.context);
      // The broker is written on every connect: it must pass the schema (the context is only a string).
      let broker: SecretBrokerConfig;
      try {
        broker = validatedBroker(ctx.meta.resource);
      } catch {
        throw new OAuthSecretFlowError("bad_context", "This sign-in's request is not valid; start again.");
      }
      let raw: unknown;
      try {
        raw = done.payload === undefined ? undefined : JSON.parse(done.payload);
      } catch {
        raw = undefined; // A SyntaxError quotes its input: never carried.
      }
      const parsed = PayloadSchema.safeParse(raw);
      if (!parsed.success)
        throw new OAuthSecretFlowError("bad_context", "This sign-in's request is not valid; start again.");
      const ciphertext = await encrypt(cipher, JSON.stringify(parsed.data));
      const oauth: OAuthSecretMeta = {
        resource: ctx.meta.resource,
        issuer: ctx.meta.issuer,
        authorizationEndpoint: ctx.meta.authorizationEndpoint,
        tokenEndpoint: ctx.meta.tokenEndpoint,
        ...(ctx.meta.revocationEndpoint ? { revocationEndpoint: ctx.meta.revocationEndpoint } : {}),
        clientId: ctx.client.clientId,
        ...(ctx.client.authMethod ? { authMethod: ctx.client.authMethod } : {}),
        ...(ctx.scope ? { scope: ctx.scope } : {}),
        expiresAt: done.result.expiresAt,
        status: "connected",
        connectedAt: now.toISOString(),
      };
      return { ciphertext, keyId: cipher.keyId(), broker, oauth };
    },
    // May run more than once: only `tx` reads and writes.
    finish: async (tx, _done, prepared) => {
      const p = prepared!;
      const existing = await tx.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
      // Re-checked here: a plain secret may have taken the name while the sign-in was pending.
      if (existing && existing.oauth === null) throw new Error(SECRET_NOT_OAUTH);
      const priorStatus = existing ? OAuthSecretMetaSchema.safeParse(existing.oauth) : undefined;
      const before =
        existing && existing.broker !== null && typeof existing.broker === "object"
          ? { ...(existing.broker as Record<string, unknown>), oauthStatus: priorStatus?.data?.status ?? null }
          : null;
      const data = {
        ciphertext: p.ciphertext,
        keyId: p.keyId,
        broker: p.broker as Prisma.InputJsonValue,
        oauth: p.oauth as unknown as Prisma.InputJsonValue,
      };
      const secret = await tx.secret.upsert({
        where: { ownerId_name: { ownerId, name } },
        create: { name, ownerId, ...data },
        update: data,
      });
      await tx.secretBrokerChange.create({
        data: {
          secretId: secret.id,
          ownerId,
          secretName: name,
          actorId: ownerId,
          before: before ?? Prisma.JsonNull,
          after: { ...p.broker, oauthStatus: "connected" },
          via: "mcp",
        },
      });
      return { name, kind: "oauth", status: "connected", expiresAt: p.oauth.expiresAt };
    },
  });
}

/** A stored OAuth secret, as both secret loaders read it. */
export interface StoredOAuthSecret {
  id: string;
  name: string;
  ciphertext: string;
  oauth: unknown;
}

export interface OAuthResolveOptions {
  /** Refresh even when not due, unless the stored access token is no longer this one (another caller refreshed). */
  forceRefreshIfStill?: string;
  /**
   * With `forceRefreshIfStill`: the refusal is this secret's own (sole OAuth secret in the request,
   * RFC 6750 `invalid_token`). Only then is a secret with no refresh token marked `rejected`; a
   * forced refresh without it leaves such a secret unchanged and returns its current token.
   */
  attributable?: boolean;
  /** The fetch policy the caller's brokered fetches use; the refresh adds its own 15 s timeout. */
  options?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
  now?: Date;
  /** Milliseconds on a monotonic clock, for the transaction's time budget; tests replace it. */
  clock?: () => number;
  /**
   * The caller's stop signal (`options.signal` counts too). An aborted caller stops waiting at once
   * with the retryable error. Once no caller still waits, a shared refresh that has not yet sent its
   * token request rolls back and releases the row lock; one already sent runs to the end and is stored.
   */
  signal?: AbortSignal;
  /** The single-flight table; defaults to this process's. Tests give separate tables to act as separate processes. */
  flights?: RefreshFlights;
}

/** One refresh in flight, shared by every caller in this process that wants the same secret refreshed. */
interface RefreshFlight {
  promise: Promise<OAuthSecretPayload>;
  /** Stops the refresh before its token request is sent, so the transaction rolls back; never cuts a sent request. */
  controller: AbortController;
  /** Callers still waiting that can abort; a caller with no signal pins the flight for good. */
  abortable: number;
  pinned: boolean;
}
export type RefreshFlights = Map<string, RefreshFlight>;

/** Per process, so only one database connection here waits on a secret's row lock at a time. */
const processFlights: RefreshFlights = new Map();

/** The connected meta; reauth_required (or meta that can't be read) throws SECRET_REAUTH_REQUIRED. */
function connectedMeta(oauth: unknown, name: string): OAuthSecretMeta {
  const parsed = OAuthSecretMetaSchema.safeParse(oauth);
  if (!parsed.success || parsed.data.status !== "connected") throw reauthRequired(name);
  return parsed.data;
}

async function storedPayload(cipher: Pick<SecretCipher, "decrypt">, ciphertext: string): Promise<OAuthSecretPayload> {
  const plaintext = await decrypt(cipher, ciphertext);
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    raw = undefined; // A SyntaxError quotes its input: never carried.
  }
  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) throw cipherFailed();
  return parsed.data;
}

/** The caller saw the stored access token refused (a 401) and asks for a new one. */
function isForced(payload: OAuthSecretPayload, opts: OAuthResolveOptions): boolean {
  return opts.forceRefreshIfStill !== undefined && payload.accessToken === opts.forceRefreshIfStill;
}

/** A forced refresh whose 401 is attributable to this secret alone: the only case `rejected` is marked. */
function isAttributablyRejected(payload: OAuthSecretPayload, opts: OAuthResolveOptions): boolean {
  return opts.attributable === true && isForced(payload, opts);
}

function wantsRefresh(
  meta: OAuthSecretMeta,
  payload: OAuthSecretPayload,
  opts: OAuthResolveOptions,
  now: Date,
): boolean {
  if (isForced(payload, opts)) return true;
  return meta.expiresAt !== null && Date.parse(meta.expiresAt) - now.getTime() <= REFRESH_EARLY_MS;
}

/** Past expiresAt, not merely inside the early-refresh window. */
function isExpired(meta: OAuthSecretMeta, now: Date): boolean {
  return meta.expiresAt !== null && Date.parse(meta.expiresAt) <= now.getTime();
}

/**
 * The OAuth secret's current tokens. When the access token is due (expires within 60 s) or is the
 * one `forceRefreshIfStill` names, it is refreshed first, under a row lock, so concurrent callers
 * spend a refresh token once. A provider that refuses the grant or the client marks the secret
 * reauth_required, and so does an access token past its expiry with no refresh token (`expired`) or
 * one the resource refused with no refresh token to replace it (`rejected`: a forced refresh whose
 * 401 is attributable, see `attributable`); a forced refresh that is not attributable leaves a
 * secret with no refresh token unchanged. One inside the early window with no refresh token is sent as is. Every error is an
 * OAuthSecretFlowError with a fixed message and no cause.
 */
export async function currentOAuthPayload(
  db: Pick<PrismaClient, "$transaction" | "secret">,
  cipher: SecretCipher,
  row: StoredOAuthSecret,
  opts: OAuthResolveOptions = {},
): Promise<OAuthSecretPayload> {
  const now = opts.now ?? new Date();
  const meta = connectedMeta(row.oauth, row.name);
  const payload = await storedPayload(cipher, row.ciphertext);
  if (!wantsRefresh(meta, payload, opts, now)) return payload;
  if (!payload.refreshToken && !isExpired(meta, now) && !isAttributablyRejected(payload, opts)) return payload;
  return refreshShared(db, cipher, row, opts, now);
}

/** The caller's signal and its fetch policy's, as one; undefined when it gave neither. */
function callerSignal(opts: OAuthResolveOptions): AbortSignal | undefined {
  const signals = [opts.signal, opts.options?.signal].filter((s): s is AbortSignal => s !== undefined);
  return signals.length > 1 ? AbortSignal.any(signals) : signals[0];
}

/**
 * Single-flight in front of refreshLocked: concurrent callers in this process that want the same
 * secret refreshed share one transaction and one token request. The key is the secret id, plus the
 * refused token for a forced refresh (a forced caller must not take an unforced caller's answer,
 * which might be the very token it saw refused). The entry goes when the refresh settles, success
 * or failure, so a failure is never handed to a later caller. The row lock stays, for other processes.
 * A caller that joins a flight gets the first caller's fetch settings (policy, fetchImpl, clock);
 * every caller in this process passes the same ones in production (Ruling OS-5).
 */
function refreshShared(
  db: Pick<PrismaClient, "$transaction">,
  cipher: SecretCipher,
  row: StoredOAuthSecret,
  opts: OAuthResolveOptions,
  now: Date,
): Promise<OAuthSecretPayload> {
  const signal = callerSignal(opts);
  // No transaction is opened for a caller that has already stopped.
  if (signal?.aborted) return Promise.reject(refreshUnavailable());
  const flights = opts.flights ?? processFlights;
  // An attributable forced caller may mark `rejected`; one that is not must never share its flight.
  const key =
    opts.forceRefreshIfStill === undefined
      ? row.id
      : `${row.id}\n${opts.forceRefreshIfStill}\n${opts.attributable === true ? "a" : "-"}`;
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const promise = refreshLocked(db, cipher, row, opts, now, controller.signal).finally(() => {
      if (flights.get(key) === started) flights.delete(key);
    });
    const started: RefreshFlight = { promise, controller, abortable: 0, pinned: false };
    // Every caller may have stopped waiting: the outcome is then nobody's, and not unhandled.
    started.promise.catch(() => {});
    flights.set(key, started);
    flight = started;
  }
  if (!signal) {
    flight.pinned = true;
    return flight.promise;
  }
  const joined = flight;
  joined.abortable += 1;
  return new Promise<OAuthSecretPayload>((resolve, reject) => {
    let waiting = true;
    const onAbort = () => {
      if (!waiting) return;
      waiting = false;
      joined.abortable -= 1;
      if (joined.abortable === 0 && !joined.pinned) {
        // Nobody waits any more: a new caller starts afresh rather than joining a stopping refresh.
        if (flights.get(key) === joined) flights.delete(key);
        joined.controller.abort();
      }
      reject(refreshUnavailable());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    // An abort that lands after the flight settled changes nothing: the promise has already settled.
    void joined.promise.then(resolve, reject).finally(() => {
      waiting = false;
      signal.removeEventListener("abort", onAbort);
    });
  });
}

type LockedOutcome =
  | { kind: "current"; payload: OAuthSecretPayload }
  | { kind: "refreshed"; payload: OAuthSecretPayload }
  | { kind: "reauth"; reason: ReauthReason };

type LockedRow = { ciphertext: string; oauth: unknown; broker: unknown; ownerId: string };

/** Marks the locked secret reauth_required, with its audit row; both commit with the transaction. */
async function markReauth(
  tx: Prisma.TransactionClient,
  row: StoredOAuthSecret,
  locked: LockedRow,
  meta: OAuthSecretMeta,
  reason: ReauthReason,
): Promise<LockedOutcome> {
  const reauth: OAuthSecretMeta = { ...meta, status: "reauth_required", reauthReason: reason };
  await tx.secret.update({ where: { id: row.id }, data: { oauth: reauth as unknown as Prisma.InputJsonValue } });
  const broker =
    locked.broker !== null && typeof locked.broker === "object" ? (locked.broker as Record<string, unknown>) : {};
  await tx.secretBrokerChange.create({
    data: {
      secretId: row.id,
      ownerId: locked.ownerId,
      secretName: row.name,
      actorId: locked.ownerId,
      before: { ...broker, oauthStatus: "connected" },
      after: { ...broker, oauthStatus: "reauth_required" },
      via: "mcp",
    },
  });
  return { kind: "reauth", reason };
}

function refreshUnavailable(): OAuthSecretFlowError {
  return new OAuthSecretFlowError("refresh_unavailable", SECRET_OAUTH_REFRESH_UNAVAILABLE, true);
}

/** Postgres lock_not_available (55P03): the lock_timeout ran out. Only the code is read, never logged text. */
function isLockTimeout(err: unknown): boolean {
  const seen = new Set<unknown>();
  for (let e: unknown = err; e && typeof e === "object" && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const o = e as { code?: unknown; meta?: { code?: unknown } };
    if (o.code === "55P03" || o.meta?.code === "55P03") return true;
    if (e instanceof Error && /\b55P03\b|lock timeout/.test(e.message)) return true;
  }
  return false;
}

/** Thrown inside the transaction when the flight stopped before its token request was sent. */
class StoppedBeforeSend extends Error {}

async function refreshLocked(
  db: Pick<PrismaClient, "$transaction">,
  cipher: SecretCipher,
  row: StoredOAuthSecret,
  opts: OAuthResolveOptions,
  now: Date,
  signal: AbortSignal,
): Promise<OAuthSecretPayload> {
  let outcome: LockedOutcome;
  // Set once the provider has answered with new tokens: a failure after that loses a rotation.
  let rotated = false;
  const clock = opts.clock ?? (() => performance.now());
  // Measured from before the transaction starts, so the budget errs short, never long.
  const startedAt = clock();
  try {
    // The token request runs inside the transaction on purpose: the row lock must cover it, so a
    // rotating refresh token is spent once however many callers found the access token due.
    outcome = await db.$transaction(
      async (tx): Promise<LockedOutcome> => {
        // A caller waits a bounded time for another's lock, so the wait can't eat the refresh's budget.
        await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${REFRESH_LOCK_TIMEOUT}'`);
        const locked = await tx.$queryRaw<LockedRow[]>`
          SELECT "ciphertext", "oauth", "broker", "ownerId" FROM "Secret" WHERE "id" = ${row.id} FOR UPDATE`;
        if (!locked.length) throw reauthRequired(row.name);
        const meta = connectedMeta(locked[0].oauth, row.name);
        const payload = await storedPayload(cipher, locked[0].ciphertext);
        // Another caller may have refreshed while this one waited for the lock.
        if (!wantsRefresh(meta, payload, opts, now)) return { kind: "current", payload };
        if (!payload.refreshToken) {
          if (isExpired(meta, now)) return markReauth(tx, row, locked[0], meta, "expired");
          // The resource refused the token, and there is nothing to replace it with.
          // Only when the 401 is this secret's own; any other 401 changes nothing.
          if (isAttributablyRejected(payload, opts)) return markReauth(tx, row, locked[0], meta, "rejected");
          return { kind: "current", payload };
        }
        // The request gets what is left of the transaction less a margin to commit what it returns,
        // so a rotated refresh token is never spent by a request whose result can't be stored.
        const left = REFRESH_TRANSACTION_TIMEOUT_MS - (clock() - startedAt);
        const timeoutMs = Math.min(REFRESH_TIMEOUT_MS, left - REFRESH_COMMIT_MARGIN_MS);
        if (timeoutMs < REFRESH_MIN_REQUEST_MS) throw refreshUnavailable();
        // Stopped while waiting for the lock: roll back now rather than spend the refresh token.
        if (signal.aborted) throw new StoppedBeforeSend();
        const client: OAuthClient = {
          clientId: meta.clientId,
          ...(payload.clientSecret ? { clientSecret: payload.clientSecret } : {}),
          ...(meta.authMethod ? { authMethod: meta.authMethod } : {}),
        };
        let tokens: OAuthTokens;
        try {
          tokens = await refreshTokens(
            meta,
            client,
            payload.refreshToken,
            // No stop signal once sent, the flight's or a caller's: the provider may spend a rotating
            // refresh token as soon as it has the request, so the request runs to its timeout and
            // whatever it returns is stored. Callers that stopped were already released.
            { ...sendOptions(opts.options), timeoutMs },
            opts.fetchImpl,
            now,
          );
        } catch (err) {
          // Only the fixed code is read: an OAuthProtocolError's message is fixed, anything else is dropped.
          const code = err instanceof OAuthProtocolError ? err.code : "unknown";
          if (code === "invalid_grant" || code === "invalid_client") return markReauth(tx, row, locked[0], meta, code);
          throw code === "provider_unavailable"
            ? refreshUnavailable()
            : new OAuthSecretFlowError("refresh_failed", SECRET_OAUTH_REFRESH_FAILED);
        }
        rotated = true;
        const next: OAuthSecretPayload = {
          accessToken: tokens.accessToken,
          // A provider that doesn't rotate leaves refresh_token out: the old one stays good.
          refreshToken: tokens.refreshToken ?? payload.refreshToken,
          ...(payload.clientSecret ? { clientSecret: payload.clientSecret } : {}),
        };
        const ciphertext = await encrypt(cipher, JSON.stringify(next));
        const refreshed: OAuthSecretMeta = {
          ...meta,
          expiresAt: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
        };
        await tx.secret.update({
          where: { id: row.id },
          data: { ciphertext, keyId: cipher.keyId(), oauth: refreshed as unknown as Prisma.InputJsonValue },
        });
        return { kind: "refreshed", payload: next };
      },
      { timeout: REFRESH_TRANSACTION_TIMEOUT_MS },
    );
  } catch (err) {
    if (rotated) {
      // The provider refreshed, but the new tokens were not stored (encrypt or commit failed): a
      // rotating provider may have spent the stored refresh token. The caller's error is unchanged.
      log.warn({ secretId: row.id, reason: "rotated_unsaved" }, "OAuth secret refresh failed");
      throw err instanceof OAuthSecretFlowError ? err : refreshUnavailable();
    }
    if (err instanceof StoppedBeforeSend) {
      // Every caller stopped before the token request was sent: rolled back, lock released, nothing changed.
      log.info({ secretId: row.id, reason: "aborted" }, "OAuth secret refresh stopped");
      throw refreshUnavailable();
    }
    if (err instanceof OAuthSecretFlowError) {
      if (err.reason !== "reauth_required")
        log.warn({ secretId: row.id, reason: err.reason }, "OAuth secret refresh failed");
      throw err;
    }
    // A database or transaction error (a lock wait that ran out among them): its message may quote
    // query arguments, so it is dropped.
    log.warn(
      { secretId: row.id, reason: isLockTimeout(err) ? "lock_timeout" : "store_failed" },
      "OAuth secret refresh failed",
    );
    throw refreshUnavailable();
  }
  if (outcome.kind === "reauth") {
    log.warn({ secretId: row.id, reason: outcome.reason }, "OAuth secret needs connecting again");
    throw reauthRequired(row.name);
  }
  if (outcome.kind === "refreshed") log.info({ secretId: row.id }, "OAuth secret refreshed");
  return outcome.payload;
}

/** The fetch policy for the token request, without any stop signal (see refreshLocked). */
function sendOptions(options: SafeFetchOptions | undefined): SafeFetchOptions {
  if (!options) return {};
  const { signal: _signal, ...rest } = options;
  return rest;
}

/**
 * Redaction values of a stored secret, read without refreshing: an OAuth secret's tokens and client
 * secret, or `[plaintext]` for any other. For redaction lists only: it never sends anything.
 */
export function storedSecretRedactionValues(plaintext: string, oauth: unknown): string[] {
  if (oauth === null || oauth === undefined) return [plaintext];
  let raw: unknown;
  try {
    raw = JSON.parse(plaintext);
  } catch {
    return [plaintext];
  }
  const parsed = PayloadSchema.safeParse(raw);
  if (!parsed.success) return [plaintext];
  const p = parsed.data;
  return [p.accessToken, p.refreshToken, p.clientSecret].filter((v): v is string => v !== undefined);
}

/**
 * Best effort: asks the provider to revoke an OAuth secret's tokens (the refresh token first, then
 * the access token) before the secret is deleted. It never throws and never logs a token, an error
 * or its message: only `{ secretId, reason }` with a fixed reason. Nothing is sent without a
 * revocation endpoint.
 */
export async function revokeOAuthSecretTokens(input: {
  secretId: string;
  ciphertext: string;
  oauth: unknown;
  cipher: Pick<SecretCipher, "decrypt">;
  options?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
}): Promise<void> {
  const meta = OAuthSecretMetaSchema.safeParse(input.oauth);
  if (!meta.success || !meta.data.revocationEndpoint) return;
  let payload: OAuthSecretPayload;
  try {
    payload = await storedPayload(input.cipher, input.ciphertext);
  } catch {
    log.warn({ secretId: input.secretId, reason: "cipher_failed" }, "OAuth secret not revoked at the provider");
    return;
  }
  const client: OAuthClient = {
    clientId: meta.data.clientId,
    ...(payload.clientSecret !== undefined ? { clientSecret: payload.clientSecret } : {}),
    ...(meta.data.authMethod ? { authMethod: meta.data.authMethod } : {}),
  };
  const tokens: [string, "refresh_token" | "access_token"][] = [];
  if (payload.refreshToken !== undefined) tokens.push([payload.refreshToken, "refresh_token"]);
  tokens.push([payload.accessToken, "access_token"]);
  for (const [token, hint] of tokens) {
    try {
      await revokeToken(meta.data, client, token, hint, input.options, input.fetchImpl);
    } catch {
      log.warn({ secretId: input.secretId, reason: "revoke_failed" }, "OAuth secret not revoked at the provider");
    }
  }
}
