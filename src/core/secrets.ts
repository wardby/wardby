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
};
export interface SecretEntry {
  value: string;
  broker: SecretBrokerConfig | null;
}
export interface SecretsAccessor {
  /** Readable secrets only: a brokered secret throws `secret_brokered`. */
  get(name: string): Promise<string | undefined>;
  /** Host-internal: value and broker config, brokered or not. Never exposed to tool code. */
  resolve?(name: string): Promise<SecretEntry | undefined>;
}

function brokerOf(secret: Pick<Secret, "broker">): SecretBrokerConfig | null {
  return secret.broker === null || secret.broker === undefined ? null : parseSecretBrokerConfig(secret.broker);
}
const BROKERED_GET_MESSAGE =
  'secret_brokered: this secret is brokered; send it with fetch(url, { secrets: ["NAME"] }) instead of reading it';

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
    // A rotation that omits `broker` keeps the stored config, so the new value must still be brokerable.
    const existing = await db.secret.findUnique({
      where: { ownerId_name: { ownerId, name } },
      select: { broker: true },
    });
    if (existing?.broker) assertBrokerableValue(brokerOf(existing)!, value);
    return db.secret.upsert({
      where: { ownerId_name: { ownerId, name } },
      create: { name, ciphertext, keyId, ownerId },
      update: { ciphertext, keyId },
    });
  }
  return db.$transaction(async (tx) => {
    const existing = await tx.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
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
    const before = brokerOf(secret);
    if (input.expectedBrokerHash !== undefined && (!before || brokerConfigHash(before) !== input.expectedBrokerHash)) {
      throw new Error(SECRET_BROKER_CHANGED);
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return { before, after };
    if (after) assertBrokerableValue(after, await cipher.decrypt(secret.ciphertext));
    await tx.secret.update({ where: { id: secret.id }, data: { broker: after ?? Prisma.JsonNull } });
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
  }));
}

async function findOwnedSecretByName(db: PrismaClient, ownerId: string, name: string): Promise<Secret | null> {
  return db.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
}

/** Attaches one of the owner's own secrets (by canonical name) to an agent,
 *  under `boundName` — the point-of-use name the agent's tools resolve
 *  (`secrets.get(boundName)`). Defaults to the secret's own name. */
export async function attachSecret(
  agentId: string,
  name: string,
  ownerId: string,
  db: PrismaClient,
  boundName: string = name,
): Promise<void> {
  const secret = await findOwnedSecretByName(db, ownerId, name);
  if (!secret) throw new Error(`No secret named "${name}" owned by this caller.`);
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

export async function deleteSecret(secretId: string, db: PrismaClient): Promise<void> {
  await db.secret.delete({ where: { id: secretId } });
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
  db: Pick<PrismaClient, "agentSecret"> & Partial<Pick<PrismaClient, "$queryRaw">>,
): SecretsAccessor {
  async function resolve(name: string): Promise<SecretEntry | undefined> {
    boundedString(name, 1024);
    if (db.$queryRaw) {
      // NULL-safe: "=" is never true when either owner is NULL.
      const rows = await db.$queryRaw<{ ciphertext: string | null; broker: unknown }[]>`
        SELECT CASE WHEN octet_length(s."ciphertext") <= 262144 THEN s."ciphertext" ELSE NULL END AS "ciphertext",
               s."broker" AS "broker"
        FROM "Secret" s
        JOIN "AgentSecret" a ON a."secretId" = s."id"
        JOIN "Agent" g ON g."id" = a."agentId"
        WHERE a."agentId" = ${agentId} AND a."boundName" = ${name} AND s."ownerId" = g."ownerId" LIMIT 1`;
      if (!rows.length) return undefined;
      if (rows[0].ciphertext === null) throw new Error("secret_value_limit");
      return {
        value: await cipher.decrypt(rows[0].ciphertext),
        broker: brokerOf({ broker: rows[0].broker as Secret["broker"] }),
      };
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
    return {
      value: await cipher.decrypt(attachment.secret.ciphertext),
      broker: brokerOf({ broker: attachment.secret.broker ?? null }),
    };
  }
  return {
    resolve,
    async get(name: string): Promise<string | undefined> {
      const entry = await resolve(name);
      if (entry?.broker) throw new Error(BROKERED_GET_MESSAGE);
      return entry?.value;
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
  };
}
