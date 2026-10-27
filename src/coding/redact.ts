import { redactExactSecretValues } from "../core/secret-spans.js";
import { redactTokenShapedValues } from "./protocol.js";

export const REDACTED = "[REDACTED]";

/** Shapes protocol.ts's list does not cover, or covers only at longer lengths. */
const EXTRA_TOKEN_PATTERNS = [/rrp_[A-Za-z0-9_-]{8,}/g, /rrg_[A-Za-z0-9_-]{8,}/g, /\bBearer\s+[^\s"',;]+/gi];

/** Redacts the given exact secrets, then every token-shaped value. */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  // The shared span-union redactor; any non-empty value counts here, as it always has.
  let redacted = redactExactSecretValues(text, secrets, { marker: REDACTED, minLength: 1 });
  redacted = redactTokenShapedValues(redacted);
  return EXTRA_TOKEN_PATTERNS.reduce((value, pattern) => value.replace(pattern, REDACTED), redacted);
}
