/**
 * A brokered secret's owner-set config: where its value may be sent and how it is
 * placed. Validated on every write; the privileged host (sandbox/secret-broker.ts)
 * trusts it at request time.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const MIN_BROKERED_VALUE_LENGTH = 6;

const FORBIDDEN_HEADERS = ["host", "connection", "transfer-encoding", "content-length", "upgrade", "proxy-connection"];
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** False for a name a resolver could read as an IPv4 address ("127.1", "0x7f.0.0.1") or with a label ending in "-". */
function isExactHostname(h: string): boolean {
  if (!HOSTNAME.test(h) || IPV4.test(h)) return false;
  const labels = h.split(".");
  const last = labels[labels.length - 1];
  return !/^\d+$/.test(last) && !last.startsWith("0x") && !labels.some((l) => l.endsWith("-"));
}

const host = z
  .string()
  .transform((h) => h.toLowerCase())
  .refine(isExactHostname, "hosts must be exact hostnames (no scheme, port, wildcard, or IP)");

const pathPrefix = z
  .string()
  .max(512)
  .startsWith("/")
  .refine(
    // eslint-disable-next-line no-control-regex
    (p) => !/[?#\\\x00-\x1f\x7f]/.test(p) && !/%2f|%5c/i.test(p),
    "path prefixes must not contain ?, #, a backslash, control characters, or an encoded / or \\",
  );

const placement = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("header"),
      name: z
        .string()
        .regex(TOKEN, "header name must be an HTTP token")
        .refine((n) => !FORBIDDEN_HEADERS.includes(n.toLowerCase()), "that header cannot be set"),
      format: z
        .string()
        .max(256)
        .refine((f) => f.split("{value}").length === 2, 'format must contain "{value}" exactly once')
        .refine((f) => !/[\r\n]/.test(f), "format must not contain line breaks"),
    })
    .strict(),
  z.object({ kind: z.literal("query"), name: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal("body"), field: z.string().min(1).max(128) }).strict(),
  z
    .object({
      kind: z.literal("aws-sigv4"),
      region: z.string().regex(/^[a-z0-9-]{1,32}$/),
      service: z.string().regex(/^[a-z0-9-]{1,64}$/),
    })
    .strict(),
]);

export const SecretBrokerConfigSchema = z
  .object({
    hosts: z.array(host).min(1).max(20),
    pathPrefixes: z.array(pathPrefix).max(20).optional(),
    placement,
  })
  .strict();

export type SecretBrokerConfig = z.infer<typeof SecretBrokerConfigSchema>;
export type SecretBrokerPlacement = SecretBrokerConfig["placement"];

export function parseSecretBrokerConfig(input: unknown): SecretBrokerConfig {
  const parsed = SecretBrokerConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`secret_broker_config_invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  return parsed.data;
}

/**
 * A fingerprint of one broker config (sha256 hex of its parsed JSON): an unbroker
 * link carries the hash of the config it was minted for, so it can't remove a
 * config that has changed since.
 */
export function brokerConfigHash(config: SecretBrokerConfig): string {
  return createHash("sha256")
    .update(JSON.stringify(parseSecretBrokerConfig(config)))
    .digest("hex");
}

export const SECRET_BROKER_CHANGED =
  "secret_broker_changed: brokering changed since this link was created; request a new link";

export type SigV4Credentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

const SigV4ValueSchema = z
  .object({
    accessKeyId: z.string().min(1).max(256),
    secretAccessKey: z.string().min(MIN_BROKERED_VALUE_LENGTH).max(1024),
    sessionToken: z.string().min(MIN_BROKERED_VALUE_LENGTH).max(8192).optional(),
  })
  .strict();

export function parseSigV4Value(value: string): SigV4Credentials {
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch {
    throw new Error(
      "secret_broker_value_invalid: an AWS SigV4 secret's value must be JSON {accessKeyId, secretAccessKey, sessionToken?}",
    );
  }
  const parsed = SigV4ValueSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      "secret_broker_value_invalid: an AWS SigV4 secret's value must be JSON {accessKeyId, secretAccessKey, sessionToken?}",
    );
  }
  return parsed.data;
}

/** Throws unless `value` can be brokered under `config` (and later scrubbed from responses). */
export function assertBrokerableValue(config: SecretBrokerConfig, value: string): void {
  if (config.placement.kind === "aws-sigv4") {
    parseSigV4Value(value);
    return;
  }
  if (value.length < MIN_BROKERED_VALUE_LENGTH) {
    throw new Error(
      `secret_broker_value_invalid: a brokered value must be at least ${MIN_BROKERED_VALUE_LENGTH} characters`,
    );
  }
}
