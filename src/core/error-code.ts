/**
 * The code a wardby error message leads with (`some_code` or `some_code: detail`), or undefined.
 * Worker-safe: the native sandbox worker image ships this module.
 */
export function errorCodeOf(message: string | null | undefined): string | undefined {
  return message ? /^([a-z][a-z0-9_]*)(:|$)/.exec(message)?.[1] : undefined;
}
