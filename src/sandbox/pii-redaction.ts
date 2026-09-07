/**
 * Best-effort, pattern-based PII redaction for sandboxed tool console
 * output before it reaches the shared pino logger. Unlike host-functions.ts's
 * `redactSecrets` (exact-match against values the tool actually fetched via
 * secrets.get()), PII surfaces in arbitrary fetched web/datastore content —
 * there is no known value to match against, only common structured formats.
 * NOT exhaustive: free-text names, addresses, and anything not matching one
 * of these formats passes through unredacted.
 */
const PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "EMAIL", pattern: /\b[\w.+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/gi },
  { name: "SSN", pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  // `(?<!\d)` rather than a leading `\b`: a leading "+" is a non-word char,
  // so `\b` fails to match right before it and the country code gets left
  // behind unredacted.
  { name: "PHONE", pattern: /(?<!\d)(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g },
  // Contiguous or grouped (e.g. 4-4-4-4) digit runs in the credit-card
  // length range. Digits-only, so it never touches alphanumeric ids/tokens.
  // Always ends on a digit (not the optional separator) so it can't eat a
  // trailing space/dash that isn't part of the number.
  { name: "CREDIT_CARD", pattern: /\b\d(?:[ -]?\d){12,18}\b/g },
];

export function redactPii(text: string): string {
  let out = text;
  for (const { name, pattern } of PATTERNS) {
    out = out.replace(pattern, `[REDACTED_${name}]`);
  }
  return out;
}
