/**
 * A brokered secret's owner-set config: where its value may be sent and how it is
 * placed. Validated on every write; the privileged host (sandbox/secret-broker.ts)
 * trusts it at request time.
 */
import { z } from "zod";

export const MIN_BROKERED_VALUE_LENGTH = 6;

const FORBIDDEN_HEADERS = ["host", "connection", "transfer-encoding", "content-length", "upgrade", "proxy-connection"];
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const HOSTNAME = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?:\.(?!-)[a-z0-9-]{1,63})+$/;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const host = z
  .string()
  .transform((h) => h.toLowerCase())
  .refine((h) => HOSTNAME.test(h) && !IPV4.test(h), "hosts must be exact hostnames (no scheme, port, wildcard, or IP)");

const placement = z.discriminatedUnion("kind", [
  z.object({
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
  }),
  z.object({ kind: z.literal("query"), name: z.string().min(1).max(128) }),
  z.object({ kind: z.literal("body"), field: z.string().min(1).max(128) }),
  z.object({
    kind: z.literal("aws-sigv4"),
    region: z.string().regex(/^[a-z0-9-]{1,32}$/),
    service: z.string().regex(/^[a-z0-9-]{1,64}$/),
  }),
]);

export const SecretBrokerConfigSchema = z
  .object({
    hosts: z.array(host).min(1).max(20),
    pathPrefixes: z.array(z.string().max(512).startsWith("/")).max(20).optional(),
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
