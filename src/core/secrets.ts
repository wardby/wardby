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

export type SecretMetadata = Pick<Secret, "id" | "name" | "keyId" | "ownerId" | "createdAt" | "updatedAt">;

export interface SecretsAccessor {
  get(name: string): Promise<string | undefined>;
}

/** Encrypts and stores a secret value. The plaintext is never logged or returned. */
export async function createSecret(
  name: string,
  value: string,
  ownerId: string,
  cipher: SecretCipher,
  db: PrismaClient,
): Promise<Secret> {
  const ciphertext = await cipher.encrypt(value);
  return db.secret.create({ data: { name, ciphertext, keyId: cipher.keyId(), ownerId } });
}

/** Names/metadata only — never a value or ciphertext. */
export async function listSecrets(ownerId: string, db: PrismaClient): Promise<SecretMetadata[]> {
  const secrets = await db.secret.findMany({ where: { ownerId } });
  return secrets.map(({ id, name, keyId, ownerId: owner, createdAt, updatedAt }) => ({ id, name, keyId, ownerId: owner, createdAt, updatedAt }));
}

async function findOwnedSecretByName(db: PrismaClient, ownerId: string, name: string): Promise<Secret | null> {
  return db.secret.findUnique({ where: { ownerId_name: { ownerId, name } } });
}

/** Attaches one of the owner's own secrets (by name) to an agent. */
export async function attachSecret(agentId: string, name: string, ownerId: string, db: PrismaClient): Promise<void> {
  const secret = await findOwnedSecretByName(db, ownerId, name);
  if (!secret) throw new Error(`No secret named "${name}" owned by this caller.`);
  await db.agentSecret.create({ data: { agentId, secretId: secret.id } });
}

export async function detachSecret(agentId: string, name: string, ownerId: string, db: PrismaClient): Promise<void> {
  const secret = await findOwnedSecretByName(db, ownerId, name);
  if (!secret) return;
  await db.agentSecret.deleteMany({ where: { agentId, secretId: secret.id } });
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
  db: Pick<PrismaClient, "agentSecret">,
): SecretsAccessor {
  return {
    async get(name: string): Promise<string | undefined> {
      const attachment = await db.agentSecret.findFirst({ where: { agentId, secret: { name } }, include: { secret: true } });
      if (!attachment) return undefined;
      return cipher.decrypt(attachment.secret.ciphertext);
    },
  };
}
