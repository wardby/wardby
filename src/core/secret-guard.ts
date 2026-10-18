import type { PrismaClient } from "#prisma";
import { MIN_REDACTABLE_SECRET_LENGTH, redactExactSecretValues, withEscapedForms } from "./secret-spans.js";
import { buildSecretsAccessor } from "./secrets.js";
import { consoleRedactionValues } from "../sandbox/secret-broker.js";

export interface NamedSecretValues {
  name: string;
  values: string[];
}

type SecretGuardCipher = Parameters<typeof buildSecretsAccessor>[1];
type SecretGuardDb = Parameters<typeof buildSecretsAccessor>[2] & Pick<PrismaClient, "agentSecret">;

/** Every secret attached to the agent (readable and brokered), with every form to look for. Rejects if any read fails. */
export async function loadAgentSecretValues(
  db: SecretGuardDb,
  cipher: SecretGuardCipher,
  agentId: string,
): Promise<NamedSecretValues[]> {
  const rows = await db.agentSecret.findMany({ where: { agentId }, select: { boundName: true } });
  if (rows.length === 0) return [];
  const accessor = buildSecretsAccessor(agentId, cipher, db);
  return Promise.all(
    rows.map(async ({ boundName }) => {
      const entry = await accessor.resolve!(boundName);
      return { name: boundName, values: entry ? withEscapedForms(consoleRedactionValues(entry)) : [] };
    }),
  );
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** The sorted, unique names of the secrets whose value occurs anywhere in `value`. */
export function secretNamesIn(value: unknown, named: readonly NamedSecretValues[]): string[] {
  const text = textOf(value);
  const hits = new Set<string>();
  for (const { name, values } of named) {
    if (values.some((v) => v.length >= MIN_REDACTABLE_SECRET_LENGTH && text.includes(v))) hits.add(name);
  }
  return [...hits].sort();
}

const MAX_MESSAGE_LENGTH = 1000;

function refusal(names: readonly string[], listed: number): string {
  const shown = names.slice(0, listed).map((n) => JSON.stringify(n));
  const more = names.length - listed;
  const list = shown.join(", ") + (more > 0 ? `, and ${more} more` : "");
  const noun = names.length > 1 ? "secrets" : "secret";
  const first = JSON.stringify(names[0]);
  return `secret_in_value: not stored. The value contains the value of ${noun} ${list} attached to this agent, and secret values are never stored. Store the secret's name instead and read it when you need it: secrets.get(${first}), or fetch(url, { secrets: [${first}] }) if it is brokered.`;
}

/** The agent-visible refusal: names the secrets, never a value. At most 1000 characters. */
export function secretInValueMessage(names: readonly string[]): string {
  let listed = names.length;
  while (listed > 1 && refusal(names, listed).length > MAX_MESSAGE_LENGTH) listed--;
  return refusal(names, listed);
}

export const SECRET_CHECK_UNAVAILABLE_MESSAGE =
  "secret_check_unavailable: not stored. The agent's secrets could not be read to check this value; try again.";

export const WITHHELD_TEXT_NOTICE = "[withheld: this text could not be checked for secret values]";

export class SecretInValueError extends Error {
  readonly code = "secret_in_value";
  readonly secretNames: string[];
  constructor(names: readonly string[]) {
    super(secretInValueMessage(names));
    this.name = "SecretInValueError";
    this.secretNames = [...names];
  }
}

export class SecretCheckUnavailableError extends Error {
  readonly code = "secret_check_unavailable";
  constructor() {
    super(SECRET_CHECK_UNAVAILABLE_MESSAGE);
    this.name = "SecretCheckUnavailableError";
  }
}

/** `text` with every value of every named secret masked. */
export function maskNamedSecrets(text: string, named: readonly NamedSecretValues[]): string {
  return redactExactSecretValues(
    text,
    named.flatMap((n) => n.values),
  );
}

export interface SecretWriteGuard {
  assertNoSecrets(agentId: string, value: unknown): Promise<void>;
}

/** Refuses a value holding an attached secret's value; fails closed when the secrets cannot be read. */
export function createSecretWriteGuard(source: {
  load(agentId: string): Promise<NamedSecretValues[]>;
}): SecretWriteGuard {
  return {
    async assertNoSecrets(agentId, value) {
      let named: NamedSecretValues[];
      try {
        named = await source.load(agentId);
      } catch {
        throw new SecretCheckUnavailableError();
      }
      const names = secretNamesIn(value, named);
      if (names.length > 0) throw new SecretInValueError(names);
    },
  };
}

export function createDbSecretWriteGuard(db: SecretGuardDb, cipher: SecretGuardCipher): SecretWriteGuard {
  return createSecretWriteGuard({ load: (id) => loadAgentSecretValues(db, cipher, id) });
}
