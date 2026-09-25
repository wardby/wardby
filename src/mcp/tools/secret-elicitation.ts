/**
 * Out-of-band secret entry: `create_secret` called without a `value`
 * mints a signed token (server.ts's mintRequestState/verifyRequestState)
 * and hands the caller a one-time browser-form URL instead. The browser
 * form writes the secret directly via `createSecret` — this module's
 * `SecretElicitationOutcome` table is how the retried `tools/call` learns
 * whether that write has happened yet.
 *
 * Backed by Postgres, not an in-process Map: a multi-instance HTTP
 * deployment can serve the mint, the browser-form POST, and the polling
 * retry from three different processes (see server.ts's `REQUEST_STATE_KEY`
 * doc comment for the matching fix on the token side). Entries expire after
 * ELICITATION_TTL_MS (matches server.ts's mintRequestState ttlSeconds: an
 * elicitation nobody completes or polls within that window is abandoned).
 * Expiry is swept lazily on every read and write via a `deleteMany` rather
 * than a timer, so an idle process holds no interval.
 */
import type { PrismaClient } from "#prisma";
import { createSecret, type SecretMetadata } from "../../core/secrets.js";
import type { SecretCipher } from "../../providers/secrets/types.js";

export interface SecretElicitationPayload {
  ownerId: string;
  secretName: string;
}

export type SecretElicitationOutcome = { ok: true; secret: SecretMetadata } | { ok: false; error: string };

const ELICITATION_TTL_MS = 600_000;

/** Sweeps every expired entry, not just the one being looked up, so a set-and-never-polled-again entry doesn't linger forever. */
async function pruneExpired(db: PrismaClient, now: Date): Promise<void> {
  await db.secretElicitationOutcome.deleteMany({ where: { expiresAt: { lte: now } } });
}

export async function getSecretElicitationOutcome(
  ownerId: string,
  secretName: string,
  db: PrismaClient,
): Promise<SecretElicitationOutcome | undefined> {
  const now = new Date();
  await pruneExpired(db, now);
  const row = await db.secretElicitationOutcome.findUnique({ where: { ownerId_secretName: { ownerId, secretName } } });
  return row?.outcome as SecretElicitationOutcome | undefined;
}

/**
 * Called by the browser form's POST handler. Idempotent — a resubmit for
 * the same (ownerId, secretName) that's already fulfilled returns the
 * recorded outcome rather than writing again.
 */
export async function fulfillSecretElicitation(
  payload: SecretElicitationPayload,
  value: string,
  cipher: SecretCipher,
  db: PrismaClient,
): Promise<SecretElicitationOutcome> {
  const now = new Date();
  await pruneExpired(db, now);
  const { ownerId, secretName } = payload;
  const existing = await db.secretElicitationOutcome.findUnique({
    where: { ownerId_secretName: { ownerId, secretName } },
  });
  if (existing) return existing.outcome as SecretElicitationOutcome;

  let outcome: SecretElicitationOutcome;
  try {
    const secret = await createSecret(secretName, value, ownerId, cipher, db);
    outcome = {
      ok: true,
      secret: {
        id: secret.id,
        name: secret.name,
        keyId: secret.keyId,
        ownerId: secret.ownerId,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
      },
    };
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const expiresAt = new Date(now.getTime() + ELICITATION_TTL_MS);
  await db.secretElicitationOutcome.upsert({
    where: { ownerId_secretName: { ownerId, secretName } },
    create: { ownerId, secretName, outcome, expiresAt },
    update: { outcome, expiresAt },
  });
  return outcome;
}
