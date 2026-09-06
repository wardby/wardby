/**
 * Out-of-band secret entry: `create_secret` called without a `value`
 * mints a signed token (server.ts's mintRequestState/verifyRequestState)
 * and hands the caller a one-time browser-form URL instead. The browser
 * form writes the secret directly via `createSecret` — this module's
 * `outcomes` map is how the retried `tools/call` learns whether that
 * write has happened yet. In-memory and per-process only: nothing outside
 * this same running server ever needs to read it, matching
 * mintRequestState's own per-process key.
 */
import type { PrismaClient } from "@prisma/client";
import { createSecret, type SecretMetadata } from "../../core/secrets.js";
import type { SecretCipher } from "../../providers/secrets/types.js";

export interface SecretElicitationPayload {
  ownerId: string;
  secretName: string;
}

export type SecretElicitationOutcome = { ok: true; secret: SecretMetadata } | { ok: false; error: string };

const outcomes = new Map<string, SecretElicitationOutcome>();

/** Deterministic on (ownerId, secretName) — every call for the same pending secret, protocol-mode or polling-mode, looks up the same entry. */
function outcomeKey(ownerId: string, secretName: string): string {
  return `${ownerId}\0${secretName}`;
}

export function getSecretElicitationOutcome(ownerId: string, secretName: string): SecretElicitationOutcome | undefined {
  return outcomes.get(outcomeKey(ownerId, secretName));
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
  const key = outcomeKey(payload.ownerId, payload.secretName);
  const existing = outcomes.get(key);
  if (existing) return existing;
  try {
    const secret = await createSecret(payload.secretName, value, payload.ownerId, cipher, db);
    const outcome: SecretElicitationOutcome = {
      ok: true,
      secret: { id: secret.id, name: secret.name, keyId: secret.keyId, ownerId: secret.ownerId, createdAt: secret.createdAt, updatedAt: secret.updatedAt },
    };
    outcomes.set(key, outcome);
    return outcome;
  } catch (err) {
    const outcome: SecretElicitationOutcome = { ok: false, error: err instanceof Error ? err.message : String(err) };
    outcomes.set(key, outcome);
    return outcome;
  }
}
