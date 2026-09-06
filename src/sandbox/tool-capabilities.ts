/**
 * Per-attachment capability scoping for sandboxed tools (OWASP LLM08 —
 * Excessive Agency fix): which secrets, datastore key prefixes, and fetch
 * hosts a tool may touch, declared once at `attach_tool` time and persisted
 * as `Json` on `AgentTool`. Mirrors the coding-agent profile's own
 * bounded-array + zod-schema convention (`src/coding/profile.ts`) rather
 * than a native Postgres array column.
 */
import { z } from "zod";
import { normalizeHost } from "./fetch-policy.js";

export const MAX_ALLOWED_SECRETS = 64;
export const MAX_ALLOWED_DATASTORE_PREFIXES = 64;
export const MAX_ALLOWED_HOSTS = 64;

const MAX_SECRET_NAME_BYTES = 1024;
const MAX_DATASTORE_PREFIX_BYTES = 1024;

/** Element that lifts the fetch allowlist entirely for a tool (existing SSRF protection against private/link-local addresses still applies). */
export const FETCH_WILDCARD = "*";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isValidHostToken(value: string): boolean {
  if (value === FETCH_WILDCARD) return true;
  try {
    normalizeHost(value);
    return true;
  } catch {
    return false;
  }
}

const secretNameSchema = z
  .string()
  .refine((v) => byteLength(v) <= MAX_SECRET_NAME_BYTES, `must be at most ${MAX_SECRET_NAME_BYTES} UTF-8 bytes`);

const datastorePrefixSchema = z
  .string()
  .refine((v) => byteLength(v) <= MAX_DATASTORE_PREFIX_BYTES, `must be at most ${MAX_DATASTORE_PREFIX_BYTES} UTF-8 bytes`);

const fetchHostSchema = z
  .string()
  .refine(isValidHostToken, `must be "${FETCH_WILDCARD}" or a normalizable hostname`)
  .transform((v) => (v === FETCH_WILDCARD ? FETCH_WILDCARD : normalizeHost(v)));

const toolCapabilityFields = {
  allowedSecrets: z.array(secretNameSchema).max(MAX_ALLOWED_SECRETS).transform((v) => [...new Set(v)]),
  allowedDatastorePrefixes: z.array(datastorePrefixSchema).max(MAX_ALLOWED_DATASTORE_PREFIXES).transform((v) => [...new Set(v)]),
  allowedHosts: z.array(fetchHostSchema).max(MAX_ALLOWED_HOSTS).transform((v) => [...new Set(v)]),
};

/** Full capability set — used when creating a brand-new attachment (unset fields default to deny-all). */
export const ToolCapabilitiesSchema = z
  .object({
    allowedSecrets: toolCapabilityFields.allowedSecrets.default([]),
    allowedDatastorePrefixes: toolCapabilityFields.allowedDatastorePrefixes.default([]),
    allowedHosts: toolCapabilityFields.allowedHosts.default([]),
  })
  .strict();

/** Partial capability set — used when re-declaring capabilities on an attachment that already exists; an omitted field leaves that field untouched. */
export const ToolCapabilitiesPatchSchema = z
  .object({
    allowedSecrets: toolCapabilityFields.allowedSecrets.optional(),
    allowedDatastorePrefixes: toolCapabilityFields.allowedDatastorePrefixes.optional(),
    allowedHosts: toolCapabilityFields.allowedHosts.optional(),
  })
  .strict();

export type ToolCapabilities = z.infer<typeof ToolCapabilitiesSchema>;
export type ToolCapabilitiesPatch = z.infer<typeof ToolCapabilitiesPatchSchema>;

/**
 * Coerces a Prisma `Json` column back into a string[]. Only
 * `ToolCapabilitiesSchema`-validated data is ever written to these columns,
 * but a DB read is never trusted blindly — malformed/foreign data degrades
 * to "no capability" rather than throwing mid-run.
 */
export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
