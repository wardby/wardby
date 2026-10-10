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
 *
 * Two kinds share the table: "create" (enter a secret's value, optionally
 * brokered) and "unbroker" (a person confirms removing a secret's broker
 * config: `set_secret_broker { broker: null }` never removes it directly).
 * Payloads and outcomes written before `kind` existed have none and count as
 * "create".
 */
import type { PrismaClient } from "#prisma";
import { createSecret, listSecrets, setSecretBroker, type SecretMetadata } from "../../core/secrets.js";
import {
  parseSecretBrokerConfig,
  SECRET_BROKER_CHANGED,
  type SecretBrokerConfig,
} from "../../core/secret-broker-config.js";
import type { SecretCipher } from "../../providers/secrets/types.js";

export type SecretElicitationKind = "create" | "unbroker";

export interface SecretElicitationPayload {
  ownerId: string;
  secretName: string;
  /** Missing on links minted before brokered secrets: those are "create". */
  kind?: SecretElicitationKind;
  /** "create" only: the broker config to save with the value (the form pre-fills it). */
  broker?: SecretBrokerConfig;
  /**
   * "unbroker" only: brokerConfigHash of the config the link was minted for. The
   * removal is refused if the secret's config has changed since (or the link has none).
   */
  brokerHash?: string;
}

export type SecretElicitationOutcome =
  | { ok: true; kind: SecretElicitationKind; secret: SecretMetadata }
  | { ok: false; kind: SecretElicitationKind; error: string };

/**
 * A link only does what it was minted for: a create link can't confirm an
 * unbroker, nor the reverse. Refused without recording an outcome.
 */
function kindMismatch(payload: SecretElicitationPayload, expected: SecretElicitationKind) {
  const actual = payload.kind ?? "create";
  if (actual === expected) return undefined;
  return {
    ok: false as const,
    kind: expected,
    error: `elicitation_kind_mismatch: this link is for a "${actual}" request, not "${expected}"`,
  };
}

/** A stored outcome's kind; one written before `kind` existed is a "create". */
function kindOf(outcome: unknown): SecretElicitationKind {
  return (outcome as { kind?: SecretElicitationKind }).kind ?? "create";
}

const ELICITATION_TTL_MS = 600_000;

/** Sweeps every expired entry, not just the one being looked up, so a set-and-never-polled-again entry doesn't linger forever. */
async function pruneExpired(db: PrismaClient, now: Date): Promise<void> {
  await db.secretElicitationOutcome.deleteMany({ where: { expiresAt: { lte: now } } });
}

export async function getSecretElicitationOutcome(
  ownerId: string,
  secretName: string,
  db: PrismaClient,
  kind: SecretElicitationKind = "create",
): Promise<SecretElicitationOutcome | undefined> {
  const now = new Date();
  await pruneExpired(db, now);
  const row = await db.secretElicitationOutcome.findUnique({ where: { ownerId_secretName: { ownerId, secretName } } });
  if (!row || kindOf(row.outcome) !== kind) return undefined;
  return row.outcome as SecretElicitationOutcome;
}

async function recordOutcome(
  db: PrismaClient,
  ownerId: string,
  secretName: string,
  outcome: SecretElicitationOutcome,
  now: Date,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + ELICITATION_TTL_MS);
  await db.secretElicitationOutcome.upsert({
    where: { ownerId_secretName: { ownerId, secretName } },
    create: { ownerId, secretName, outcome, expiresAt },
    update: { outcome, expiresAt },
  });
}

/**
 * Called by the browser form's POST handler. Idempotent — a resubmit for
 * the same (ownerId, secretName) that's already fulfilled returns the
 * recorded outcome rather than writing again. A value or broker config that
 * fails validation is returned but not recorded, so the person can correct it. `broker` (the form's,
 * pre-filled from the payload) makes the new secret brokered.
 */
export async function fulfillSecretElicitation(
  payload: SecretElicitationPayload,
  value: string,
  cipher: SecretCipher,
  db: PrismaClient,
  broker?: SecretBrokerConfig | null,
): Promise<SecretElicitationOutcome> {
  const mismatch = kindMismatch(payload, "create");
  if (mismatch) return mismatch;
  const now = new Date();
  await pruneExpired(db, now);
  const { ownerId, secretName } = payload;
  const existing = await db.secretElicitationOutcome.findUnique({
    where: { ownerId_secretName: { ownerId, secretName } },
  });
  if (existing && kindOf(existing.outcome) === "create") return existing.outcome as SecretElicitationOutcome;

  let outcome: SecretElicitationOutcome;
  try {
    const secret = await createSecret(secretName, value, ownerId, cipher, db, {
      broker: broker ?? undefined,
      via: "browser",
    });
    outcome = {
      ok: true,
      kind: "create",
      secret: {
        id: secret.id,
        name: secret.name,
        keyId: secret.keyId,
        ownerId: secret.ownerId,
        createdAt: secret.createdAt,
        updatedAt: secret.updatedAt,
        // A rotation without a broker keeps the stored config, so report what was saved.
        broker: secret.broker === null || secret.broker === undefined ? null : parseSecretBrokerConfig(secret.broker),
      },
    };
  } catch (err) {
    outcome = { ok: false, kind: "create", error: err instanceof Error ? err.message : String(err) };
    // A value or config the person can fix: not recorded, so the same link takes a corrected
    // submission and create_secret keeps waiting rather than replaying this error.
    if (isCorrectableInput(outcome.error)) return outcome;
  }

  await recordOutcome(db, ownerId, secretName, outcome, now);
  return outcome;
}

const CORRECTABLE_ERRORS = ["secret_broker_value_invalid", "secret_broker_config_invalid", "bridge_input_limit"];

function isCorrectableInput(message: string): boolean {
  return CORRECTABLE_ERRORS.some((code) => message.startsWith(code));
}

/**
 * Called by the unbroker form's POST: removes brokering (audited, via
 * "browser", the owner as actor). Idempotent like fulfillSecretElicitation.
 * A link only removes the config it was minted for: if brokering changed
 * since (or the link carries no brokerHash) it is refused without recording
 * an outcome, so a fresh link for the current config still works.
 */
export async function fulfillUnbrokerElicitation(
  payload: SecretElicitationPayload,
  cipher: SecretCipher,
  db: PrismaClient,
): Promise<SecretElicitationOutcome> {
  const mismatch = kindMismatch(payload, "unbroker");
  if (mismatch) return mismatch;
  const changed = { ok: false as const, kind: "unbroker" as const, error: SECRET_BROKER_CHANGED };
  if (!payload.brokerHash) return changed;
  const now = new Date();
  await pruneExpired(db, now);
  const { ownerId, secretName } = payload;
  const existing = await db.secretElicitationOutcome.findUnique({
    where: { ownerId_secretName: { ownerId, secretName } },
  });
  if (existing && kindOf(existing.outcome) === "unbroker") return existing.outcome as SecretElicitationOutcome;

  let outcome: SecretElicitationOutcome;
  try {
    await setSecretBroker(db, cipher, {
      ownerId,
      name: secretName,
      broker: null,
      actorId: ownerId,
      via: "browser",
      expectedBrokerHash: payload.brokerHash,
    });
    const secret = (await listSecrets(ownerId, db)).find((s) => s.name === secretName);
    if (!secret) throw new Error(`secret_not_found: no secret named "${secretName}"`);
    outcome = { ok: true, kind: "unbroker", secret };
  } catch (err) {
    if (err instanceof Error && err.message === SECRET_BROKER_CHANGED) return changed;
    outcome = { ok: false, kind: "unbroker", error: err instanceof Error ? err.message : String(err) };
  }

  await recordOutcome(db, ownerId, secretName, outcome, now);
  return outcome;
}

/**
 * Forgets a recorded unbroker outcome for this secret: called when brokering
 * is set again, so a removal confirmed earlier can't answer (or short-circuit)
 * a later removal request.
 */
export async function clearUnbrokerOutcome(ownerId: string, secretName: string, db: PrismaClient): Promise<void> {
  await db.secretElicitationOutcome.deleteMany({
    where: { ownerId, secretName, outcome: { path: ["kind"], equals: "unbroker" } },
  });
}
