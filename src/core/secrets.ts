/**
 * Secrets: encrypted-at-rest values, attached to an agent by name, readable
 * only inside the sandbox at point-of-use (never by any read/list tool).
 * `Secret.name` is unique per owner (`@@unique([ownerId, name])`), so two
 * owners can each have their own "API_KEY" without collision — attach/get
 * always resolve a name within one owner's (or, at get-time, one agent's)
 * scope, never globally.
 */
import type { PrismaClient, Secret } from "@prisma/client";
import type { SecretCipher } from "../providers/secrets/types.js";
import { boundedString } from "../sandbox/bounded-json.js";

export type SecretMetadata = Pick<Secret, "id" | "name" | "keyId" | "ownerId" | "createdAt" | "updatedAt">;

export interface SecretsAccessor {
  get(name: string): Promise<string | undefined>;
}

/**
 * Encrypts and stores a secret value. Upserts on (ownerId, name) — calling
 * this again for a name the owner already has rotates its value in place
 * (same id) rather than failing on the unique constraint. The plaintext is
 * never logged or returned.
 */
export async function createSecret(
  name: string,
  value: string,
  ownerId: string,
  cipher: SecretCipher,
  db: PrismaClient,
): Promise<Secret> {
  boundedString(name, 1024);
  boundedString(value, 65_536);
  const ciphertext = await cipher.encrypt(value);
  const keyId = cipher.keyId();
  return db.secret.upsert({
    where: { ownerId_name: { ownerId, name } },
    create: { name, ciphertext, keyId, ownerId },
    update: { ciphertext, keyId },
  });
}

/** Names/metadata only — never a value or ciphertext. */
export async function listSecrets(ownerId: string, db: PrismaClient): Promise<SecretMetadata[]> {
  const secrets = await db.secret.findMany({ where: { ownerId } });
  return secrets.map(({ id, name, keyId, ownerId: owner, createdAt, updatedAt }) => ({
    id,
    name,
    keyId,
    ownerId: owner,
    createdAt,
    updatedAt,
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
 *  identifies the edge; agent ownership is enforced by the caller. */
export async function detachSecret(agentId: string, boundName: string, db: PrismaClient): Promise<void> {
  await db.agentSecret.deleteMany({ where: { agentId, boundName } });
}

export async function deleteSecret(secretId: string, db: PrismaClient): Promise<void> {
  await db.secret.delete({ where: { id: secretId } });
}

/**
 * Decrypt-on-demand: only the ONE secret actually requested by name is
 * decrypted, never the agent's whole attached set eagerly — a lookup
 * that returns nothing (unattached name) is indistinguishable from one
 * that was never created, both `undefined`.
 */
export function buildSecretsAccessor(
  agentId: string,
  cipher: SecretCipher,
  db: Pick<PrismaClient, "agentSecret"> & Partial<Pick<PrismaClient, "$queryRaw">>,
): SecretsAccessor {
  return {
    async get(name: string): Promise<string | undefined> {
      boundedString(name, 1024);
      if (db.$queryRaw) {
        const rows = await db.$queryRaw<{ ciphertext: string | null }[]>`
          SELECT CASE WHEN octet_length(s."ciphertext") <= 262144 THEN s."ciphertext" ELSE NULL END AS "ciphertext"
          FROM "Secret" s JOIN "AgentSecret" a ON a."secretId" = s."id"
          WHERE a."agentId" = ${agentId} AND a."boundName" = ${name} LIMIT 1`;
        if (!rows.length) return undefined;
        if (rows[0].ciphertext === null) throw new Error("secret_value_limit");
        return cipher.decrypt(rows[0].ciphertext);
      }
      // Lightweight provider doubles use the same post-read bound; production Prisma filters in SQL.
      const attachment = await db.agentSecret.findFirst({
        where: { agentId, boundName: name },
        include: { secret: true },
      });
      if (!attachment) return undefined;
      boundedString(attachment.secret.ciphertext, 256 * 1024);
      return cipher.decrypt(attachment.secret.ciphertext);
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
  };
}
