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
 *
 * A "create" outcome is read once: the create_secret call that returns it
 * marks it consumed, so the next call mints a fresh link and a wrong value
 * can be re-entered straight away. delete_secret leaves a consumed marker
 * too. The row stays until it expires so a link minted before the last
 * submission (or delete) is refused instead of overwriting a newer value;
 * resubmitting the link that was used just answers its recorded outcome.
 */
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "#prisma";
import {
  createSecret,
  hostProvidersUsingSecret,
  listSecrets,
  setSecretBroker,
  type SecretMetadata,
} from "../../core/secrets.js";
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
  /** The caller passed the hosts:admin check when the link was minted. */
  hostManager?: boolean;
  /**
   * "create" only: identifies this link, so resubmitting it answers its own recorded outcome.
   * Links minted before this field existed have none and are answered as they always were.
   */
  linkId?: string;
  /**
   * "create" only: the name's entry generation when the link was minted. Every submission
   * and every delete moves it on, so a link minted before one is refused.
   */
  generation?: number;
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

/**
 * What the table stores for a "create": the outcome plus how it was reached. Rows written
 * before these fields existed have none of them.
 */
type StoredCreateOutcome = SecretElicitationOutcome & {
  /** The link that was submitted; absent on a delete marker. */
  linkId?: string;
  /** Counts submissions and deletes of this name; a link carrying a lower one is refused. */
  generation?: number;
  /** A create_secret call has returned this outcome, or the secret was deleted. */
  consumed?: boolean;
};

const SECRET_LINK_SUPERSEDED =
  "secret_link_superseded: this link was replaced by a later entry or delete of this secret; call create_secret again for a new link";

/** The outcome alone, without the bookkeeping fields. */
function bareOutcome(stored: StoredCreateOutcome): SecretElicitationOutcome {
  const { linkId: _linkId, generation: _generation, consumed: _consumed, ...outcome } = stored;
  return outcome;
}

/** A stored outcome's kind; one written before `kind` existed is a "create". */
function kindOf(outcome: unknown): SecretElicitationKind {
  return (outcome as { kind?: SecretElicitationKind }).kind ?? "create";
}

const ELICITATION_TTL_MS = 600_000;
const HOST_PROVIDER_LINK_STALE =
  "host_provider_secret_link_stale: a host provider now uses this secret; request a new link with hosts:admin";

/**
 * A link minted before the secret joined a host provider carries no hosts:admin check.
 * Refused without recording an outcome, so a fresh link from a host manager still works.
 */
async function isStaleForHostProvider(db: PrismaClient, payload: SecretElicitationPayload): Promise<boolean> {
  if (payload.hostManager) return false;
  const { ownerId, secretName: name } = payload;
  const secret = await db.secret.findUnique({ where: { ownerId_name: { ownerId, name } }, select: { id: true } });
  return secret !== null && (await hostProvidersUsingSecret(db, secret.id)).providers.length > 0;
}

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
  if (kind === "create" && (row.outcome as StoredCreateOutcome).consumed) return undefined;
  return kind === "create"
    ? bareOutcome(row.outcome as StoredCreateOutcome)
    : (row.outcome as SecretElicitationOutcome);
}

/**
 * Returns a submitted "create" outcome once and marks it consumed, so the next create_secret
 * with this name mints a fresh link (the person can re-enter a wrong value straight away).
 */
export async function consumeSecretElicitationOutcome(
  ownerId: string,
  secretName: string,
  db: PrismaClient,
): Promise<SecretElicitationOutcome | undefined> {
  const outcome = await getSecretElicitationOutcome(ownerId, secretName, db, "create");
  if (!outcome) return undefined;
  const row = await db.secretElicitationOutcome.findUnique({ where: { ownerId_secretName: { ownerId, secretName } } });
  if (row) {
    await db.secretElicitationOutcome.update({
      where: { ownerId_secretName: { ownerId, secretName } },
      data: { outcome: { ...(row.outcome as StoredCreateOutcome), consumed: true } },
    });
  }
  return outcome;
}

/** The stored "create" row for a name, if there is one (an unbroker outcome is not). */
async function storedCreate(
  db: PrismaClient,
  ownerId: string,
  secretName: string,
): Promise<StoredCreateOutcome | undefined> {
  const row = await db.secretElicitationOutcome.findUnique({ where: { ownerId_secretName: { ownerId, secretName } } });
  return row && kindOf(row.outcome) === "create" ? (row.outcome as StoredCreateOutcome) : undefined;
}

/** The fields a new "create" link carries: see SecretElicitationPayload.linkId and generation. */
export async function newCreateLink(
  ownerId: string,
  secretName: string,
  db: PrismaClient,
): Promise<{ linkId: string; generation: number }> {
  const stored = await storedCreate(db, ownerId, secretName);
  if (stored) {
    // The row outlives every link minted from it, so the generation can't reset while one is open.
    await db.secretElicitationOutcome.updateMany({
      where: { ownerId, secretName },
      data: { expiresAt: new Date(Date.now() + ELICITATION_TTL_MS) },
    });
  }
  return { linkId: randomUUID(), generation: stored?.generation ?? 0 };
}

/**
 * Called when a secret is deleted: forgets any outcome for its name and refuses every
 * browser link minted before now, so an open form can't bring the deleted secret back.
 */
export async function clearSecretElicitationOutcome(
  ownerId: string,
  secretName: string,
  db: PrismaClient,
  now: Date = new Date(),
): Promise<void> {
  const marker: StoredCreateOutcome = {
    ok: false,
    kind: "create",
    error: "secret_deleted",
    generation: ((await storedCreate(db, ownerId, secretName))?.generation ?? 0) + 1,
    consumed: true,
  };
  await recordOutcome(db, ownerId, secretName, marker, now);
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
  const previous =
    existing && kindOf(existing.outcome) === "create" ? (existing.outcome as StoredCreateOutcome) : undefined;
  if (previous) {
    // A link or row from before links carried an id: answered as before, without writing.
    if (payload.linkId === undefined || previous.generation === undefined) return bareOutcome(previous);
    // This link was the one submitted: answer what it did, without writing again.
    if (previous.linkId === payload.linkId) return bareOutcome(previous);
    // Minted before the last submission or delete: refused (not recorded), so it can't overwrite.
    if ((payload.generation ?? 0) < previous.generation) {
      return { ok: false, kind: "create", error: SECRET_LINK_SUPERSEDED };
    }
  }
  if (await isStaleForHostProvider(db, payload)) {
    return { ok: false, kind: "create", error: HOST_PROVIDER_LINK_STALE };
  }

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
        kind: "value", // createSecret refuses an OAuth secret
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

  const stored: StoredCreateOutcome = {
    ...outcome,
    ...(payload.linkId !== undefined
      ? { linkId: payload.linkId, generation: Math.max(previous?.generation ?? 0, payload.generation ?? 0) + 1 }
      : {}),
  };
  await recordOutcome(db, ownerId, secretName, stored, now);
  return outcome;
}

const CORRECTABLE_ERRORS = [
  "secret_broker_value_invalid",
  "secret_broker_config_invalid",
  "bridge_input_limit",
  "host_provider_webhook_secret_short",
];

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
  if (await isStaleForHostProvider(db, payload)) {
    return { ok: false, kind: "unbroker", error: HOST_PROVIDER_LINK_STALE };
  }

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
