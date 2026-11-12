/**
 * Secrets: encrypted-at-rest values, attached to an agent by name, readable
 * only inside the sandbox at point-of-use (never by any read/list tool).
 * `Secret.name` is unique per owner (`@@unique([ownerId, name])`), so two
 * owners can each have their own "API_KEY" without collision — attach/get
 * always resolve a name within one owner's (or, at get-time, one agent's)
 * scope, never globally.
 */
import { Prisma, type PrismaClient, type Secret } from "#prisma";
import type { SecretCipher } from "../providers/secrets/types.js";
import { boundedString } from "../sandbox/bounded-json.js";
import type { safeFetch, SafeFetchOptions } from "../sandbox/safe-fetch.js";
import {
  currentOAuthPayload,
  OAuthSecretFlowError,
  OAuthSecretMetaSchema,
  revokeOAuthSecretTokens,
  SECRET_OAUTH_MANAGED,
  SECRET_OAUTH_REFRESH_FAILED,
  storedSecretRedactionValues,
  type OAuthResolveOptions,
} from "./oauth-secrets.js";
import {
  assertBrokerableValue,
  brokerConfigHash,
  parseSecretBrokerConfig,
  SECRET_BROKER_CHANGED,
  type SecretBrokerConfig,
} from "./secret-broker-config.js";

export type BrokerChangeVia = "mcp" | "browser";
export type SecretMetadata = Pick<Secret, "id" | "name" | "keyId" | "ownerId" | "createdAt" | "updatedAt"> & {
  broker: SecretBrokerConfig | null;
  kind: "value" | "oauth";
  /** An OAuth secret only; never a client id, issuer, endpoint or token. */
  oauth?: {
    resource: string;
    status: "connected" | "reauth_required";
    expiresAt: string | null;
    connectedAt: string;
    reauthReason?: string;
  };
};
export interface SecretEntry {
  value: string;
  broker: SecretBrokerConfig | null;
  /** Set for an OAuth secret: every value that must be redacted (access, refresh, client secret). */
  oauth?: { redact: string[] };
}
export interface SecretsAccessor {
  /** Readable secrets only: a brokered secret throws `secret_brokered`. */
  get(name: string): Promise<string | undefined>;
  /** Host-internal: value and broker config, brokered or not. Never exposed to tool code. */
  resolve?(name: string): Promise<SecretEntry | undefined>;
  /** OAuth only: refresh now unless another caller already replaced `usedValue`; resolves the fresh entry. */
  refresh?(name: string, usedValue: string): Promise<SecretEntry | undefined>;
  /**
   * For redaction lists only: the entry as stored, never refreshed and never refused for its OAuth
   * status (a reauth_required secret's tokens are still listed). Its value is not for sending.
   */
  storedEntry?(name: string): Promise<SecretEntry | undefined>;
}

/** The fetch policy an OAuth refresh uses: what the caller's brokered fetches already use. */
export interface SecretFetchSettings {
  options?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
}

/** A stored secret as the loaders read it. */
export interface StoredSecretRow {
  id: string;
  name: string;
  ciphertext: string;
  broker: unknown;
  oauth: unknown;
}

function brokerOf(secret: Pick<Secret, "broker">): SecretBrokerConfig | null {
  return secret.broker === null || secret.broker === undefined ? null : parseSecretBrokerConfig(secret.broker);
}
const BROKERED_GET_MESSAGE =
  'secret_brokered: this secret is brokered; send it with fetch(url, { secrets: ["NAME"] }) instead of reading it';

/** A webhook secret signs what a host sends us, so a short one is refused at registration and at rotation. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;
export const WEBHOOK_SECRET_SHORT = `host_provider_webhook_secret_short: a host provider's webhook secret needs at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`;
export const WEBHOOK_SECRET_ATTACHED =
  "host_provider_webhook_secret_attached: this secret is a host provider's webhook secret and can't be attached to an agent";

/** The host providers using a secret, by name, and whether it's the webhook secret of any. */
export async function hostProvidersUsingSecret(
  db: Pick<PrismaClient, "hostProvider" | "hostProviderCredential">,
  secretId: string,
): Promise<{ providers: string[]; webhook: boolean }> {
  const credentials = await db.hostProviderCredential.findMany({ where: { secretId }, select: { provider: true } });
  const rows = await db.hostProvider.findMany({
    where: { OR: [{ webhookSecretId: secretId }, { permissionSecretId: secretId }] },
    select: { name: true, webhookSecretId: true },
  });
  return {
    providers: [...new Set([...credentials.map((c) => c.provider), ...rows.map((r) => r.name)])].sort(),
    webhook: rows.some((r) => r.webhookSecretId === secretId),
  };
}

/**
 * Encrypts and stores a secret value. Upserts on (ownerId, name) — calling
 * this again for a name the owner already has rotates its value in place
 * (same id) rather than failing on the unique constraint. The plaintext is
 * never logged or returned. With `options.broker`, the config is validated
 * against the value, saved, and audited in the same transaction.
 */
export async function createSecret(
  name: string,
  value: string,
  ownerId: string,
  cipher: SecretCipher,
  db: PrismaClient,
  options: { broker?: SecretBrokerConfig; via?: BrokerChangeVia } = {},
): Promise<Secret> {
  boundedString(name, 1024);
  boundedString(value, 65_536);
  const broker = options.broker ? parseSecretBrokerConfig(options.broker) : undefined;
  if (broker) assertBrokerableValue(broker, value);
  const ciphertext = await cipher.encrypt(value);
  const keyId = cipher.keyId();
  if (!broker) {
    // One transaction: the OAuth check, the brokerable check and the write see the same row, which is
    // locked so a connect finishing at the same moment cannot be overwritten by a plain value.
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Secret" WHERE "ownerId" = ${ownerId} AND "name" = ${name} FOR UPDATE`;
      const existing = await tx.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
      if (existing?.oauth != null) throw new Error(SECRET_OAUTH_MANAGED);
      if (value.length < MIN_WEBHOOK_SECRET_LENGTH && existing) {
        if ((await tx.hostProvider.count({ where: { webhookSecretId: existing.id } })) > 0) {
          throw new Error(WEBHOOK_SECRET_SHORT);
        }
      }
      // A rotation that omits `broker` keeps the stored config, so the new value must still be brokerable.
      if (existing?.broker) assertBrokerableValue(brokerOf(existing)!, value);
      return tx.secret.upsert({
        where: { ownerId_name: { ownerId, name } },
        create: { name, ciphertext, keyId, ownerId },
        update: { ciphertext, keyId },
      });
    });
  }
  return db.$transaction(async (tx) => {
    const existing = await tx.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
    if (existing?.oauth != null) throw new Error(SECRET_OAUTH_MANAGED);
    if (existing && value.length < MIN_WEBHOOK_SECRET_LENGTH) {
      if ((await tx.hostProvider.count({ where: { webhookSecretId: existing.id } })) > 0) {
        throw new Error(WEBHOOK_SECRET_SHORT);
      }
    }
    const before = existing ? brokerOf(existing) : null;
    const secret = await tx.secret.upsert({
      where: { ownerId_name: { ownerId, name } },
      create: { name, ciphertext, keyId, ownerId, broker },
      update: { ciphertext, keyId, broker },
    });
    if (JSON.stringify(before) !== JSON.stringify(broker)) {
      await tx.secretBrokerChange.create({
        data: {
          secretId: secret.id,
          ownerId,
          secretName: name,
          actorId: ownerId,
          before: before ?? Prisma.JsonNull,
          after: broker,
          via: options.via ?? "mcp",
        },
      });
    }
    return secret;
  });
}

/**
 * Sets, changes, or (broker: null) removes a secret's broker config, with one audit
 * row per actual change. `expectedBrokerHash` (brokerConfigHash of the config the
 * caller confirmed) makes the change conditional, checked inside the transaction:
 * if the secret is no longer brokered with exactly that config, it throws
 * secret_broker_changed and changes nothing.
 */
export async function setSecretBroker(
  db: PrismaClient,
  cipher: SecretCipher,
  input: {
    ownerId: string;
    name: string;
    broker: SecretBrokerConfig | null;
    actorId: string;
    via: BrokerChangeVia;
    expectedBrokerHash?: string;
  },
): Promise<{ before: SecretBrokerConfig | null; after: SecretBrokerConfig | null }> {
  const after = input.broker === null ? null : parseSecretBrokerConfig(input.broker);
  return db.$transaction(async (tx) => {
    const secret = await tx.secret.findUnique({
      where: { ownerId_name: { ownerId: input.ownerId, name: input.name } },
    });
    if (!secret) throw new Error(`secret_not_found: no secret named "${input.name}"`);
    if (secret.oauth != null) throw new Error(SECRET_OAUTH_MANAGED);
    const before = brokerOf(secret);
    if (input.expectedBrokerHash !== undefined && (!before || brokerConfigHash(before) !== input.expectedBrokerHash)) {
      throw new Error(SECRET_BROKER_CHANGED);
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return { before, after };
    if (after) assertBrokerableValue(after, await cipher.decrypt(secret.ciphertext));
    await tx.secret.update({ where: { id: secret.id }, data: { broker: after ?? Prisma.DbNull } });
    await tx.secretBrokerChange.create({
      data: {
        secretId: secret.id,
        ownerId: input.ownerId,
        secretName: secret.name,
        actorId: input.actorId,
        before: before ?? Prisma.JsonNull,
        after: after ?? Prisma.JsonNull,
        via: input.via,
      },
    });
    return { before, after };
  });
}

/** Names/metadata only — never a value or ciphertext. */
export async function listSecrets(ownerId: string, db: PrismaClient): Promise<SecretMetadata[]> {
  const secrets = await db.secret.findMany({ where: { ownerId } });
  return secrets.map((s) => ({
    id: s.id,
    name: s.name,
    keyId: s.keyId,
    ownerId: s.ownerId,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    broker: brokerOf(s),
    ...oauthListing(s.oauth),
  }));
}

/** What a listing says about a secret's kind: an OAuth secret's status and expiry, nothing else of it. */
function oauthListing(oauth: unknown): Pick<SecretMetadata, "kind" | "oauth"> {
  if (oauth === null || oauth === undefined) return { kind: "value" };
  const meta = OAuthSecretMetaSchema.safeParse(oauth);
  if (!meta.success) {
    return { kind: "oauth", oauth: { resource: "", status: "reauth_required", expiresAt: null, connectedAt: "" } };
  }
  const m = meta.data;
  return {
    kind: "oauth",
    oauth: {
      resource: m.resource,
      status: m.status,
      expiresAt: m.expiresAt,
      connectedAt: m.connectedAt,
      ...(m.reauthReason ? { reauthReason: m.reauthReason } : {}),
    },
  };
}

async function findOwnedSecretByName(db: PrismaClient, ownerId: string, name: string): Promise<Secret | null> {
  return db.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
}

/** Attaches one of the owner's own secrets (by canonical name) to an agent,
 *  under `boundName` — the point-of-use name the agent's tools resolve
 *  (`secrets.get(boundName)`). Defaults to the secret's own name. A host
 *  provider's webhook secret is kept off every agent, so no tool can read it. */
export async function attachSecret(
  agentId: string,
  name: string,
  ownerId: string,
  db: PrismaClient,
  boundName: string = name,
): Promise<void> {
  const secret = await findOwnedSecretByName(db, ownerId, name);
  if (!secret) throw new Error(`No secret named "${name}" owned by this caller.`);
  if ((await db.hostProvider.count({ where: { webhookSecretId: secret.id } })) > 0) {
    throw new Error(WEBHOOK_SECRET_ATTACHED);
  }
  await db.agentSecret.create({ data: { agentId, secretId: secret.id, boundName } });
}

/** Detaches by point-of-use name — the pair (agentId, boundName) uniquely
 *  identifies the edge — falling back to the secret's own name when no edge
 *  has that point-of-use name, since a secret attached under an alias is
 *  otherwise easy to "detach" by its real name without effect. Returns how
 *  many edges were removed; agent ownership is enforced by the caller. */
export async function detachSecret(agentId: string, name: string, db: PrismaClient): Promise<number> {
  const byBoundName = await db.agentSecret.deleteMany({ where: { agentId, boundName: name } });
  if (byBoundName.count > 0) return byBoundName.count;
  const bySecretName = await db.agentSecret.deleteMany({ where: { agentId, secret: { name } } });
  return bySecretName.count;
}

export interface DeleteSecretOptions {
  /** Decrypts an OAuth secret's tokens for revocation. Without it nothing is revoked. */
  cipher?: Pick<SecretCipher, "decrypt">;
  /** The fetch policy the MCP server path uses. */
  options?: SafeFetchOptions;
  fetchImpl?: typeof safeFetch;
  /** Who disconnected it, for the audit row; defaults to the owner. */
  actorId?: string;
}

/**
 * Deletes a secret. An OAuth secret is first revoked at its provider (best effort: any failure is
 * logged with a fixed reason and the delete goes on), and its disconnect is audited in the same
 * transaction as the delete.
 */
export async function deleteSecret(
  secretId: string,
  db: PrismaClient,
  options: DeleteSecretOptions = {},
): Promise<void> {
  const row = await db.secret.findUnique({ where: { id: secretId } });
  if (!row || row.oauth == null) {
    await db.secret.delete({ where: { id: secretId } });
    return;
  }
  if (options.cipher) {
    await revokeOAuthSecretTokens({
      secretId,
      ciphertext: row.ciphertext,
      oauth: row.oauth,
      cipher: options.cipher,
      options: options.options,
      fetchImpl: options.fetchImpl,
    });
  }
  const status = OAuthSecretMetaSchema.safeParse(row.oauth);
  const broker = brokerOf(row);
  await db.$transaction(async (tx) => {
    await tx.secretBrokerChange.create({
      data: {
        secretId,
        ownerId: row.ownerId ?? "",
        secretName: row.name,
        actorId: options.actorId ?? row.ownerId ?? "",
        before: { ...(broker ?? {}), oauthStatus: status.success ? status.data.status : "unknown" },
        after: Prisma.JsonNull,
        via: "mcp",
      },
    });
    await tx.secret.delete({ where: { id: secretId } });
  });
}

/**
 * The one place a stored secret becomes an entry. A non-OAuth secret decrypts as it always has;
 * an OAuth secret resolves to its current access token, refreshed first when due (or when
 * `forceRefreshIfStill` is still the stored token), and lists its tokens for redaction.
 */
export async function decryptEntry(
  db: Pick<PrismaClient, "$transaction" | "secret">,
  cipher: SecretCipher,
  row: StoredSecretRow,
  opts?: OAuthResolveOptions,
): Promise<SecretEntry> {
  const broker = brokerOf({ broker: row.broker as Secret["broker"] });
  if (row.oauth === null || row.oauth === undefined) return { value: await cipher.decrypt(row.ciphertext), broker };
  const p = await currentOAuthPayload(db, cipher, row, opts);
  return {
    value: p.accessToken,
    broker,
    oauth: { redact: [p.accessToken, p.refreshToken, p.clientSecret].filter((v): v is string => v !== undefined) },
  };
}

/**
 * A stored secret as an entry for redaction: decrypted, an OAuth secret's tokens and client secret
 * listed, with no refresh and no status check. Only a failed decrypt rejects (callers fail closed).
 */
export async function storedEntry(cipher: Pick<SecretCipher, "decrypt">, row: StoredSecretRow): Promise<SecretEntry> {
  const broker = brokerOf({ broker: row.broker as Secret["broker"] });
  const plaintext = await cipher.decrypt(row.ciphertext);
  if (row.oauth === null || row.oauth === undefined) return { value: plaintext, broker };
  const [value, ...rest] = storedSecretRedactionValues(plaintext, row.oauth);
  return { value, broker, oauth: { redact: [value, ...rest] } };
}

/**
 * Decrypt-on-demand: only the ONE secret actually requested by name is
 * decrypted, never the agent's whole attached set eagerly — a lookup
 * that returns nothing (unattached name) is indistinguishable from one
 * that was never created, both `undefined`.
 *
 * Owner rule (resource-sharing grants spec §3.4.1): a binding resolves only
 * while the secret's owner is the agent's CURRENT owner, both non-null. A
 * binding written before that rule, left behind by make_owner, or on an
 * owner-less agent behaves exactly like an unattached name, so one owner's
 * secret never reaches another owner's agent (A2/S2-2, R2-1).
 *
 * A brokered secret's `get` throws `secret_brokered`; only the privileged host's `resolve` sees its value.
 */
export function buildSecretsAccessor(
  agentId: string,
  cipher: SecretCipher,
  db: Pick<PrismaClient, "agentSecret"> & Partial<Pick<PrismaClient, "$queryRaw" | "$transaction" | "secret">>,
  fetch: SecretFetchSettings = {},
): SecretsAccessor {
  async function load(name: string): Promise<StoredSecretRow | undefined> {
    boundedString(name, 1024);
    if (db.$queryRaw) {
      // NULL-safe: "=" is never true when either owner is NULL.
      const rows = await db.$queryRaw<
        { id: string; name: string; ciphertext: string | null; broker: unknown; oauth: unknown }[]
      >`
        SELECT s."id" AS "id", s."name" AS "name",
               CASE WHEN octet_length(s."ciphertext") <= 262144 THEN s."ciphertext" ELSE NULL END AS "ciphertext",
               s."broker" AS "broker", s."oauth" AS "oauth"
        FROM "Secret" s
        JOIN "AgentSecret" a ON a."secretId" = s."id"
        JOIN "Agent" g ON g."id" = a."agentId"
        WHERE a."agentId" = ${agentId} AND a."boundName" = ${name} AND s."ownerId" = g."ownerId" LIMIT 1`;
      if (!rows.length) return undefined;
      const row = rows[0];
      if (row.ciphertext === null) throw new Error("secret_value_limit");
      return { ...row, ciphertext: row.ciphertext };
    }
    // Lightweight provider doubles use the same post-read bound; production Prisma filters in SQL.
    const attachment = await db.agentSecret.findFirst({
      where: { agentId, boundName: name },
      include: { secret: true, agent: { select: { ownerId: true } } },
    });
    if (!attachment) return undefined;
    const owner = attachment.agent.ownerId;
    if (owner === null || attachment.secret.ownerId !== owner) return undefined;
    boundedString(attachment.secret.ciphertext, 256 * 1024);
    const { id, name: secretName, ciphertext, broker, oauth } = attachment.secret;
    return { id, name: secretName, ciphertext, broker: broker ?? null, oauth: oauth ?? null };
  }
  function entryOf(row: StoredSecretRow, forceRefreshIfStill?: string): Promise<SecretEntry> {
    const isOAuth = row.oauth !== null && row.oauth !== undefined;
    // Refreshing needs a transaction; only a provider double lacks one.
    if (isOAuth && (!db.$transaction || !db.secret)) {
      throw new OAuthSecretFlowError("refresh_failed", SECRET_OAUTH_REFRESH_FAILED);
    }
    return decryptEntry(db as Pick<PrismaClient, "$transaction" | "secret">, cipher, row, {
      ...fetch,
      ...(forceRefreshIfStill !== undefined ? { forceRefreshIfStill } : {}),
    });
  }
  async function resolve(name: string): Promise<SecretEntry | undefined> {
    const row = await load(name);
    return row ? entryOf(row) : undefined;
  }
  return {
    resolve,
    async get(name: string): Promise<string | undefined> {
      const row = await load(name);
      if (!row) return undefined;
      // An OAuth secret is brokered by definition: refusing before resolve keeps get from refreshing it.
      if (row.oauth !== null && row.oauth !== undefined) throw new Error(BROKERED_GET_MESSAGE);
      const entry = await entryOf(row);
      if (entry?.broker) throw new Error(BROKERED_GET_MESSAGE);
      return entry?.value;
    },
    async refresh(name: string, usedValue: string): Promise<SecretEntry | undefined> {
      const row = await load(name);
      if (!row || row.oauth === null || row.oauth === undefined) return undefined;
      return entryOf(row, usedValue);
    },
    async storedEntry(name: string): Promise<SecretEntry | undefined> {
      const row = await load(name);
      return row ? storedEntry(cipher, row) : undefined;
    },
  };
}

/**
 * Wraps a `SecretsAccessor` so `get()` only ever resolves a name the caller
 * has declared this specific tool attachment may read — every other name
 * behaves exactly like one that was never attached (`undefined`), never a
 * throw, matching the existing "unattached name" convention. The underlying
 * accessor is never even called for a disallowed name.
 */
export function scopeSecretsAccessor(accessor: SecretsAccessor, allowedNames: readonly string[]): SecretsAccessor {
  const allowed = new Set(allowedNames);
  return {
    async get(name: string): Promise<string | undefined> {
      if (!allowed.has(name)) return undefined;
      return accessor.get(name);
    },
    ...(accessor.resolve && {
      resolve: async (name: string) => (allowed.has(name) ? accessor.resolve!(name) : undefined),
    }),
    ...(accessor.refresh && {
      refresh: async (name: string, usedValue: string) =>
        allowed.has(name) ? accessor.refresh!(name, usedValue) : undefined,
    }),
    ...(accessor.storedEntry && {
      storedEntry: async (name: string) => (allowed.has(name) ? accessor.storedEntry!(name) : undefined),
    }),
  };
}
