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
/** Any cipher (KMS) failure on the OAuth path; the cause's text is never carried. */
export const SECRET_OAUTH_CIPHER_FAILED =
  "secret_oauth_encryption_failed: the OAuth secret could not be encrypted or decrypted; try again";

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
  /** A fixed code, never provider text. */
  reauthReason?: "invalid_grant" | "invalid_client";
}

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
    reauthReason: z.enum(["invalid_grant", "invalid_client"]).optional(),
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
  boundedString(input.name, 1024);
  if (input.scope !== undefined) boundedString(input.scope, 1024);
  if (input.clientId !== undefined) boundedString(input.clientId, 512);
  const resource = normaliseResource(input.resource, options);

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
  validatedBroker(meta.resource);

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
      if (iss !== undefined && iss !== ctx.meta.issuer) {
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
    describe: (r) => ({ signedInAs: "the account you signed in with", target: r.resourceHost, tool: "create_secret" }),
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
  /** The fetch policy the caller's brokered fetches use; the refresh adds its own 15 s timeout. */
  options?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
  now?: Date;
}

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

function wantsRefresh(
  meta: OAuthSecretMeta,
  payload: OAuthSecretPayload,
  opts: OAuthResolveOptions,
  now: Date,
): boolean {
  if (opts.forceRefreshIfStill !== undefined && payload.accessToken === opts.forceRefreshIfStill) return true;
  return meta.expiresAt !== null && Date.parse(meta.expiresAt) - now.getTime() <= REFRESH_EARLY_MS;
}

/**
 * The OAuth secret's current tokens. When the access token is due (expires within 60 s) or is the
 * one `forceRefreshIfStill` names, it is refreshed first, under a row lock, so concurrent callers
 * spend a refresh token once. A provider that refuses the grant or the client marks the secret
 * reauth_required. Every error is an OAuthSecretFlowError with a fixed message and no cause.
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
  if (!wantsRefresh(meta, payload, opts, now) || !payload.refreshToken) return payload;
  return refreshLocked(db, cipher, row, opts, now);
}

type LockedOutcome =
  | { kind: "current"; payload: OAuthSecretPayload }
  | { kind: "refreshed"; payload: OAuthSecretPayload }
  | { kind: "reauth"; reason: "invalid_grant" | "invalid_client" };

async function refreshLocked(
  db: Pick<PrismaClient, "$transaction">,
  cipher: SecretCipher,
  row: StoredOAuthSecret,
  opts: OAuthResolveOptions,
  now: Date,
): Promise<OAuthSecretPayload> {
  let outcome: LockedOutcome;
  try {
    // The token request runs inside the transaction on purpose: the row lock must cover it, so a
    // rotating refresh token is spent once however many callers found the access token due.
    outcome = await db.$transaction(
      async (tx): Promise<LockedOutcome> => {
        const locked = await tx.$queryRaw<{ ciphertext: string; oauth: unknown; broker: unknown; ownerId: string }[]>`
          SELECT "ciphertext", "oauth", "broker", "ownerId" FROM "Secret" WHERE "id" = ${row.id} FOR UPDATE`;
        if (!locked.length) throw reauthRequired(row.name);
        const meta = connectedMeta(locked[0].oauth, row.name);
        const payload = await storedPayload(cipher, locked[0].ciphertext);
        // Another caller may have refreshed while this one waited for the lock.
        if (!wantsRefresh(meta, payload, opts, now) || !payload.refreshToken) return { kind: "current", payload };
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
            { ...opts.options, timeoutMs: REFRESH_TIMEOUT_MS },
            opts.fetchImpl,
            now,
          );
        } catch (err) {
          // Only the fixed code is read: an OAuthProtocolError's message is fixed, anything else is dropped.
          const code = err instanceof OAuthProtocolError ? err.code : "unknown";
          if (code === "invalid_grant" || code === "invalid_client") {
            const reauth: OAuthSecretMeta = { ...meta, status: "reauth_required", reauthReason: code };
            await tx.secret.update({
              where: { id: row.id },
              data: { oauth: reauth as unknown as Prisma.InputJsonValue },
            });
            const broker =
              locked[0].broker !== null && typeof locked[0].broker === "object"
                ? (locked[0].broker as Record<string, unknown>)
                : {};
            await tx.secretBrokerChange.create({
              data: {
                secretId: row.id,
                ownerId: locked[0].ownerId,
                secretName: row.name,
                actorId: locked[0].ownerId,
                before: { ...broker, oauthStatus: "connected" },
                after: { ...broker, oauthStatus: "reauth_required" },
                via: "mcp",
              },
            });
            return { kind: "reauth", reason: code };
          }
          throw code === "provider_unavailable"
            ? new OAuthSecretFlowError("refresh_unavailable", SECRET_OAUTH_REFRESH_UNAVAILABLE, true)
            : new OAuthSecretFlowError("refresh_failed", SECRET_OAUTH_REFRESH_FAILED);
        }
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
    if (err instanceof OAuthSecretFlowError) {
      if (err.reason !== "reauth_required")
        log.warn({ secretId: row.id, reason: err.reason }, "OAuth secret refresh failed");
      throw err;
    }
    // A database or transaction error: its message may quote query arguments, so it is dropped.
    log.warn({ secretId: row.id, reason: "store_failed" }, "OAuth secret refresh failed");
    throw new OAuthSecretFlowError("refresh_unavailable", SECRET_OAUTH_REFRESH_UNAVAILABLE, true);
  }
  if (outcome.kind === "reauth") {
    log.warn({ secretId: row.id, reason: outcome.reason }, "OAuth secret needs connecting again");
    throw reauthRequired(row.name);
  }
  if (outcome.kind === "refreshed") log.info({ secretId: row.id }, "OAuth secret refreshed");
  return outcome.payload;
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
